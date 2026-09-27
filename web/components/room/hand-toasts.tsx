"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveParticipant, LiveRoom } from "@/lib/api-types";
import {
  HAND_INFO_MS,
  HAND_TOAST_MS,
  HandTracker,
  handActions,
  handPersonText,
  handSummaryText,
  type HandAudience,
  type HandEntry,
  type HandPerson,
  type HandRole,
  type HandToastView,
} from "@/lib/hand-toasts";
import type { RaisedHand, Realtime } from "@/lib/realtime";
import { rosterBadge } from "@/lib/roster";
import { Spinner } from "../controls";
import { CloseIcon, HandIcon } from "../icons";
import { useToast } from "../providers";
import { SenderAvatar } from "../sender-avatar";
import { Pill } from "./chat-badges";
import { setStageSettlingHand } from "./participants";

/* The raised-hand toasts: "Asha wants to speak · Allow to speak / Lower hand / View".
 *
 * The lifecycle lives in lib/hand-toasts.ts; this file feeds it `realtime.hands` — the
 * same list the Participants panel's queue is drawn from — and draws what it says.
 * Because it reads the list rather than the packets, a toast goes the moment the hand
 * does, whoever lowered it: this host, another co-host in the panel, or the attendee.
 *
 * The buttons call exactly what the roster row calls (setStageSettlingHand and
 * realtime.lowerHand), and say the same thing afterwards, so the two cannot disagree.
 *
 * No sound. Hands never had one, and a chime per hand in a large room is the kind of
 * noise that gets notifications turned off wholesale.
 */

export type HandToastDeps = {
  slug: string;
  selfIdentity: string;
  audience: HandAudience;
  hands: readonly RaisedHand[];
  /** The host's roster, for roles and pills. Null for a panelist, who has none. */
  live: LiveRoom | null;
  /** The role LiveKit's own connection knows, for when the roster has not caught up. */
  roleOf: (identity: string) => HandRole | null;
  lowerHand: Realtime["lowerHand"];
  reloadRoster: () => Promise<void> | void;
  openParticipants: () => void;
  /** The Participants panel is open in front of this viewer — the queue is already on
   *  screen, so a toast about it is noise. */
  panelVisible: boolean;
};

export function useHandToasts(deps: HandToastDeps): void {
  const { audience, selfIdentity, hands, live, panelVisible } = deps;
  const { upsert, dismissKey, notify } = useToast();
  const tracker = useRef<HandTracker | null>(null);
  const shown = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const syncRef = useRef<() => void>(() => {});

  // Everything a button needs, read at click time rather than captured when the toast
  // was drawn — a toast can sit for fifteen seconds while the roster moves on.
  const latest = useRef(deps);
  useEffect(() => {
    latest.current = deps;
  });

  const act = useCallback(
    async (entry: HandEntry, kind: "allow" | "lower") => {
      const d = latest.current;
      try {
        if (kind === "allow") {
          const outcome = await setStageSettlingHand(d.slug, d.lowerHand, entry.identity, "panelist", true, true);
          if (outcome === "invited") {
            tracker.current?.invited(entry.identity, Date.now());
            syncRef.current();
          }
          notify(`Waiting for ${entry.name} to accept`, "ok");
        } else {
          await d.lowerHand(entry.identity, "dismissed");
          notify(`Dismissed ${entry.name}'s request`, "ok");
        }
        await d.reloadRoster();
      } catch (err) {
        notify(err instanceof Error ? err.message : "That didn't work.", "error");
        throw err;
      }
    },
    [notify],
  );

  const sync = useCallback(() => {
    const t = tracker.current;
    clearTimeout(timer.current);
    const views = t ? t.view() : [];
    const next = new Set<string>();
    for (const view of views) {
      next.add(view.key);
      const identities = identitiesOf(view);
      const hide = () => {
        tracker.current?.dismiss(identities);
        syncRef.current();
      };
      const interactive = audience === "act";
      upsert(view.key, {
        message: handToastMessage(view, audience),
        tone: "info",
        interactive,
        node: (
          <HandToastCard
            view={view}
            audience={audience}
            onAllow={(e) => act(e, "allow")}
            onLower={(e) => act(e, "lower")}
            onView={() => {
              latest.current.openParticipants();
              const all = tracker.current?.view().flatMap(identitiesOf) ?? [];
              tracker.current?.dismiss(all);
              syncRef.current();
            }}
            onHide={hide}
            onHold={(held) => {
              tracker.current?.hold(identities, held, Date.now());
              syncRef.current();
            }}
          />
        ),
        onDismiss: () => {
          tracker.current?.dismiss(identities);
          shown.current.delete(view.key);
        },
      });
    }
    for (const key of shown.current) if (!next.has(key)) dismissKey(key);
    shown.current.clear();
    for (const key of next) shown.current.add(key);

    const deadline = t?.nextDeadline();
    if (t && deadline != null) {
      timer.current = setTimeout(() => {
        t.tick(Date.now());
        syncRef.current();
      }, Math.max(0, deadline - Date.now()));
    }
  }, [audience, upsert, dismissKey, act]);
  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  // A fresh tracker whenever who is watching changes. Its first reading of the list is
  // the baseline, so becoming a co-host mid-queue does not announce the whole queue.
  useEffect(() => {
    if (!audience) return;
    const shownNow = shown.current;
    tracker.current = new HandTracker(selfIdentity, audience === "act" ? HAND_TOAST_MS : HAND_INFO_MS);
    return () => {
      tracker.current = null;
      clearTimeout(timer.current);
      for (const key of shownNow) dismissKey(key);
      shownNow.clear();
    };
  }, [audience, selfIdentity, dismissKey]);

  useEffect(() => {
    const t = tracker.current;
    if (!audience || !t) return;
    const byIdentity = new Map<string, LiveParticipant>();
    for (const p of live?.participants ?? []) byIdentity.set(p.identity, p);
    const roleOf = latest.current.roleOf;
    t.hands(
      hands.map((h) => toPerson(h, byIdentity.get(h.identity), roleOf(h.identity))),
      Date.now(),
    );
    if (panelVisible) t.dismiss(t.view().flatMap(identitiesOf));
    sync();
  }, [audience, hands, live, panelVisible, sync]);
}

function toPerson(hand: RaisedHand, row: LiveParticipant | undefined, known: HandRole | null): HandPerson {
  const role: HandRole =
    row && (row.role === "host" || row.role === "panelist" || row.role === "attendee")
      ? row.role
      : // Somebody the host's own connection cannot see is somebody the room is hiding,
        // and only the audience is ever hidden.
        (known ?? "attendee");
  return {
    identity: hand.identity,
    name: row?.name || hand.name || "Someone",
    role,
    coHost: row?.coHost,
    audioOnly: row?.audioOnly,
    raisedAt: hand.at,
  };
}

function identitiesOf(view: HandToastView): string[] {
  return view.kind === "person" ? [view.entry.identity] : view.entries.map((e) => e.identity);
}

export function handToastMessage(view: HandToastView, audience: HandAudience): string {
  if (view.kind === "summary") {
    const { title, detail } = handSummaryText(view.entries);
    return `${title}: ${detail}`;
  }
  return handPersonText(view.entry, audience);
}

// ------------------------------------------------------------------ the card

type CardProps = {
  view: HandToastView;
  audience: HandAudience;
  onAllow: (entry: HandEntry) => Promise<void>;
  onLower: (entry: HandEntry) => Promise<void>;
  onView: () => void;
  onHide: () => void;
  /** Pointer or focus inside: the tracker stops the clock until it leaves. */
  onHold: (held: boolean) => void;
};

/** One hand toast. Dark whatever page it floats over, like the join card beside it.
 *  Exported for the visual harness; the room only reaches it through the hook. */
export function HandToastCard(props: CardProps) {
  const { view, audience, onHide, onHold } = props;
  const interactive = audience === "act";
  const invited = view.kind === "person" && view.entry.phase === "invited";
  return (
    <div
      className={`join-card room-dark relative flex w-full items-start gap-3 rounded-xl border bg-surface/95 py-2.5 pl-3 text-left shadow-xl backdrop-blur sm:w-[22rem] ${
        interactive ? "pr-3" : "pr-3.5"
      } ${invited ? "border-brand-line" : "border-warn/30"}`}
      onMouseEnter={interactive ? () => onHold(true) : undefined}
      onMouseLeave={interactive ? () => onHold(false) : undefined}
      onFocus={interactive ? () => onHold(true) : undefined}
      onBlur={
        interactive
          ? (e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onHold(false);
            }
          : undefined
      }
    >
      {view.kind === "person" ? <PersonBody {...props} entry={view.entry} /> : <SummaryBody {...props} entries={view.entries} />}
      {interactive && (
        // Hides the toast only. The hand stays up, in the queue and on the badge.
        <button
          type="button"
          onClick={onHide}
          aria-label="Hide notification"
          title="Hide — the hand stays in Participants"
          className="absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-md text-ink-3 transition-colors outline-none hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <CloseIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function PersonBody({ entry, audience, onAllow, onLower, onView }: CardProps & { entry: HandEntry }) {
  const badge = rosterBadge({ role: entry.role, coHost: entry.coHost ?? false, audioOnly: entry.audioOnly ?? false });
  const actions = handActions(audience, entry);
  const invited = entry.phase === "invited";
  const asking = audience === "act" && entry.role === "attendee";
  return (
    <>
      <HandAvatar invited={invited}>
        <SenderAvatar name={entry.name} identity={entry.identity} size="md" />
      </HandAvatar>
      <div className="min-w-0 flex-1">
        <div className={`flex min-w-0 items-center gap-1.5 ${audience === "act" ? "pr-7" : ""}`}>
          <span className="truncate text-[13px] font-semibold text-ink">{entry.name}</span>
          {badge && <Pill tone={badge.tone}>{badge.label}</Pill>}
        </div>
        {invited ? (
          <p className="mt-0.5 text-[12px] font-medium text-brand">Invite sent · waiting for them to accept</p>
        ) : (
          <p className="mt-0.5 flex items-center gap-1 text-[12px] font-medium text-warn">
            <HandIcon className="hand-wave size-3 shrink-0" aria-hidden />
            {asking ? "wants to speak" : "raised their hand"}
          </p>
        )}
        {(actions.allow || actions.lower || actions.view) && (
          <Actions
            allow={actions.allow ? () => onAllow(entry) : undefined}
            lower={actions.lower ? () => onLower(entry) : undefined}
            view={actions.view ? onView : undefined}
            name={entry.name}
          />
        )}
      </div>
    </>
  );
}

function SummaryBody({ entries, audience, onView }: CardProps & { entries: HandEntry[] }) {
  const { title, detail } = handSummaryText(entries);
  const faces = entries.slice(0, 2);
  const extra = entries.length - faces.length;
  return (
    <>
      <HandAvatar invited={false} group>
        <span className="flex items-center">
          {faces.map((e, i) => (
            <SenderAvatar
              key={e.identity}
              name={e.name}
              identity={e.identity}
              size="sm"
              className={`ring-2 ring-surface ${i > 0 ? "-ml-1.5" : ""}`}
            />
          ))}
          {extra > 0 && (
            <span className="relative -ml-1.5 grid h-6 min-w-6 place-items-center rounded-full bg-surface-2 px-1 text-[10px] font-semibold text-ink-2 ring-2 ring-surface">
              +{extra}
            </span>
          )}
        </span>
      </HandAvatar>
      <div className="min-w-0 flex-1">
        <p
          className={`flex items-center gap-1.5 text-[13px] leading-snug font-semibold text-ink ${audience === "act" ? "pr-7" : ""}`}
        >
          <HandIcon className="hand-wave size-3.5 shrink-0 text-warn" aria-hidden />
          {title}
        </p>
        <p className="mt-0.5 line-clamp-2 text-[12px] text-ink-2">{detail}</p>
        {audience === "act" && <Actions view={onView} viewLabel="View queue" viewProminent />}
      </div>
    </>
  );
}

const PRIMARY =
  "inline-flex h-7 items-center gap-1.5 rounded-lg bg-brand px-2.5 text-[12px] font-medium text-stage transition-colors outline-none hover:bg-brand-hover focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-60";
const SECONDARY =
  "inline-flex h-7 items-center gap-1.5 rounded-lg border border-line-2 px-2.5 text-[12px] font-medium text-ink transition-colors outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-60";
const QUIET =
  "inline-flex h-7 items-center rounded-lg px-2 text-[12px] font-medium text-ink-2 transition-colors outline-none hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40";

function Actions({
  allow,
  lower,
  view,
  name,
  viewLabel = "View",
  viewProminent = false,
}: {
  allow?: () => Promise<void>;
  lower?: () => Promise<void>;
  view?: () => void;
  name?: string;
  viewLabel?: string;
  /** The only button on the card, so it should look like one. */
  viewProminent?: boolean;
}) {
  // Local to the card: the toast is redrawn in place (same key, same component), so
  // this survives the tracker's updates. Cleared either way — a failure keeps the
  // toast, and an invite redraws it as "Invite sent".
  const [busy, setBusy] = useState<"allow" | "lower" | null>(null);
  const run = (which: "allow" | "lower", fn: () => Promise<void>) => {
    setBusy(which);
    fn()
      .catch(() => {})
      .finally(() => setBusy(null));
  };
  // Whose request, for a screen reader tabbing through the buttons; the visible label
  // stays first so voice control still matches what is on screen.
  const who = name ? <span className="sr-only"> — {name}</span> : null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {allow && (
        <button
          type="button"
          className={PRIMARY}
          disabled={busy !== null}
          aria-busy={busy === "allow"}
          onClick={() => run("allow", allow)}
        >
          {busy === "allow" && <Spinner className="size-3" />}
          Allow to speak
          {who}
        </button>
      )}
      {lower && (
        <button
          type="button"
          className={SECONDARY}
          disabled={busy !== null}
          aria-busy={busy === "lower"}
          onClick={() => run("lower", lower)}
        >
          {busy === "lower" && <Spinner className="size-3" />}
          Lower hand
          {who}
        </button>
      )}
      {view && (
        <button type="button" className={viewProminent ? SECONDARY : QUIET} onClick={view}>
          {viewLabel}
        </button>
      )}
    </div>
  );
}

function HandAvatar({
  invited,
  group = false,
  children,
}: {
  invited: boolean;
  /** A stack of faces: no ring, which around a row of avatars reads as a pill. */
  group?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className="join-avatar mt-0.5 rounded-full" data-phase={invited ? "invited" : group ? "hands" : "hand"}>
      {children}
      {!invited && !group && (
        <span className="hand-badge" aria-hidden>
          <HandIcon className="size-2.5" />
        </span>
      )}
    </span>
  );
}
