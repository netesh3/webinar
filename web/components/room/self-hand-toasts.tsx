"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  SELF_HAND_KEY,
  SelfHandTracker,
  selfHandActions,
  selfHandText,
  type SelfHandView,
  type StageArrival,
  type StageInvite,
} from "@/lib/self-hand-toasts";
import { Spinner } from "../controls";
import { CameraIcon, CheckIcon, CloseIcon, HandIcon, MicIcon, UsersIcon } from "../icons";
import { useToast } from "../providers";

/* The requester's side of raise-hand and the stage: "Your hand is raised · Lower hand",
 * "The host lowered your hand for now · Raise again", the stage invitation with Join
 * stage / Not now, "You're on stage", "You're back in the audience".
 *
 * What each state is and how long it stays is lib/self-hand-toasts.ts. This feeds it
 * realtime's own-hand flag and open invite, plus the events the rooms already reacted to
 * (the host lowering a hand, the permission changes), and draws the card in the join and
 * hand toasts' style.
 *
 * Presentation only. The buttons call what the toolbar and the old invite dialog called
 * — realtime.toggleHand, api.respondStageInvite then dismissStageInvite — so permissions
 * and the hand/invite mechanics are unchanged.
 */

export type SelfHandEvent =
  | { kind: "lowered"; reason: "dismissed" | "cleared" | "granted" }
  | { kind: "stage"; arrival: StageArrival }
  | { kind: "audience" };

export type SelfHandDeps = {
  slug: string;
  joinKey?: string;
  handRaised: boolean;
  invite: StageInvite | null;
  /** The room's recording flag, said on the invite alongside the invite's own. */
  recording: boolean;
  /** Raise hand is on for this session — "Raise again" is only offered when it is. */
  canRaise: boolean;
  toggleHand: () => Promise<void>;
  dismissInvite: () => void;
  onAccepted?: () => void;
};

/* Moving between the CDN audience and the WebRTC stage remounts the room, and with it
 * this hook — at exactly the moment it has just said "You're on stage" or "You're back in
 * the audience". The toast lives in the app-wide provider and outlives the room, so its
 * expiry is handed to a timer that does too, and cancelled if the next room's hook
 * shows something of its own under the same key first. */
let orphanExpiry: ReturnType<typeof setTimeout> | undefined;

export function useSelfHandToasts(deps: SelfHandDeps): (event: SelfHandEvent) => void {
  const { handRaised, invite } = deps;
  const { upsert, dismissKey, notify } = useToast();
  const [tracker] = useState(() => new SelfHandTracker());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shown = useRef(false);
  const syncRef = useRef<() => void>(() => {});

  // Read at click time: a card can sit for ten seconds while the room moves on.
  const latest = useRef(deps);
  useEffect(() => {
    latest.current = deps;
  });

  const toggle = useCallback(async () => {
    try {
      await latest.current.toggleHand();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Couldn't update your hand.", "error");
    }
  }, [notify]);

  const respond = useCallback(
    async (accept: boolean) => {
      const d = latest.current;
      try {
        await api.respondStageInvite(d.slug, { joinKey: d.joinKey, accept });
      } catch (err) {
        notify(err instanceof Error ? err.message : "Couldn't reach the host. Try again.", "error");
        return;
      }
      if (accept) {
        const current = tracker.view();
        const audioOnly = current?.phase === "invited" ? current.invite.audioOnly : false;
        tracker.accepted(Date.now(), d.onAccepted ? (audioOnly ? "speak" : "stage") : "joining");
      }
      d.dismissInvite();
      syncRef.current();
      if (accept) d.onAccepted?.();
    },
    [tracker, notify],
  );

  const sync = useCallback(() => {
    clearTimeout(timer.current);
    const view = tracker.view();
    if (!view) {
      if (shown.current) dismissKey(SELF_HAND_KEY);
      shown.current = false;
    } else {
      clearTimeout(orphanExpiry);
      shown.current = true;
      const d = latest.current;
      const text = selfHandText(view, { canRaise: d.canRaise, recording: d.recording });
      upsert(SELF_HAND_KEY, {
        message: `${text.title}. ${text.detail}`,
        tone: text.tone,
        interactive: true,
        node: (
          <SelfHandCard
            view={view}
            canRaise={d.canRaise}
            recording={d.recording}
            onToggleHand={toggle}
            onRespond={respond}
            onClose={() => {
              tracker.dismiss();
              syncRef.current();
            }}
            onHold={(held) => {
              tracker.hold(held, Date.now());
              syncRef.current();
            }}
          />
        ),
      });
    }
    const deadline = tracker.nextDeadline();
    if (deadline != null) {
      timer.current = setTimeout(() => {
        tracker.tick(Date.now());
        syncRef.current();
      }, Math.max(0, deadline - Date.now()));
    }
  }, [tracker, upsert, dismissKey, toggle, respond]);
  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  useEffect(() => {
    tracker.hand(handRaised, Date.now());
    syncRef.current();
  }, [tracker, handRaised]);

  useEffect(() => {
    tracker.invite(invite, Date.now());
    syncRef.current();
  }, [tracker, invite]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (!shown.current) return;
      const deadline = tracker.nextDeadline();
      const view = tracker.view();
      // An open invite belongs to this room's connection; anything timed is left to finish.
      if (!view || view.phase === "invited" || deadline == null) {
        dismissKey(SELF_HAND_KEY);
        return;
      }
      clearTimeout(orphanExpiry);
      orphanExpiry = setTimeout(() => dismissKey(SELF_HAND_KEY), Math.max(0, deadline - Date.now()));
    },
    [tracker, dismissKey],
  );

  return useCallback(
    (event: SelfHandEvent) => {
      const now = Date.now();
      if (event.kind === "lowered") tracker.lowered(event.reason, now);
      else if (event.kind === "stage") tracker.stage(event.arrival, now);
      else tracker.audience(now);
      syncRef.current();
    },
    [tracker],
  );
}

// ------------------------------------------------------------------ the card

const PRIMARY =
  "inline-flex h-7 items-center gap-1.5 rounded-lg bg-brand px-2.5 text-[12px] font-medium text-stage transition-colors outline-none hover:bg-brand-hover focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-60";
const SECONDARY =
  "inline-flex h-7 items-center gap-1.5 rounded-lg border border-line-2 px-2.5 text-[12px] font-medium text-ink transition-colors outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-60";

type CardProps = {
  view: SelfHandView;
  canRaise?: boolean;
  recording?: boolean;
  onToggleHand?: () => Promise<void>;
  onRespond?: (accept: boolean) => Promise<void>;
  onClose?: () => void;
  onHold?: (held: boolean) => void;
};

/** One card. Dark whatever page it floats over, like the room it belongs to.
 *  Exported for the visual harness; the room only reaches it through the hook. */
export function SelfHandCard({ view, canRaise = true, recording = false, onToggleHand, onRespond, onClose, onHold }: CardProps) {
  const text = selfHandText(view, { canRaise, recording });
  const actions = selfHandActions(view, { canRaise });
  const [busy, setBusy] = useState<"lower" | "raise" | "accept" | "decline" | null>(null);
  const run = (which: NonNullable<typeof busy>, fn?: () => Promise<void>) => {
    if (!fn) return;
    setBusy(which);
    void fn().finally(() => setBusy(null));
  };
  const phase = view.phase;
  const border =
    phase === "stage"
      ? "border-ok/35"
      : phase === "invited"
        ? "border-brand-line"
        : phase === "raised"
          ? "border-warn/30"
          : "border-line-2";

  return (
    <div
      data-phase={phase}
      className={`join-card self-card room-dark relative flex w-full items-start gap-3 rounded-xl border bg-surface/95 py-2.5 pl-3 text-left shadow-xl backdrop-blur sm:w-[22rem] ${
        actions.close ? "pr-9" : "pr-3"
      } ${border}`}
      onMouseEnter={() => onHold?.(true)}
      onMouseLeave={() => onHold?.(false)}
      onFocus={() => onHold?.(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onHold?.(false);
      }}
    >
      <SelfHandBadge view={view} />
      <div className="min-w-0 flex-1 pt-0.5">
        <p className={`text-[13px] leading-snug font-semibold ${phase === "stage" ? "text-ok" : "text-ink"}`}>
          {text.title}
        </p>
        <p className="mt-0.5 text-[12px] leading-snug text-ink-2">{text.detail}</p>
        {(actions.lower || actions.raise || actions.accept) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {actions.accept && (
              <button
                type="button"
                className={PRIMARY}
                disabled={busy !== null}
                aria-busy={busy === "accept"}
                onClick={() => run("accept", onRespond && (() => onRespond(true)))}
              >
                {busy === "accept" && <Spinner className="size-3" />}
                Join stage
              </button>
            )}
            {actions.decline && (
              <button
                type="button"
                className={SECONDARY}
                disabled={busy !== null}
                aria-busy={busy === "decline"}
                onClick={() => run("decline", onRespond && (() => onRespond(false)))}
              >
                {busy === "decline" && <Spinner className="size-3" />}
                Not now
              </button>
            )}
            {actions.lower && (
              <button
                type="button"
                className={SECONDARY}
                disabled={busy !== null}
                onClick={() => run("lower", onToggleHand)}
              >
                <HandIcon className="size-3.5" aria-hidden />
                Lower hand
              </button>
            )}
            {actions.raise && (
              <button
                type="button"
                className={SECONDARY}
                disabled={busy !== null}
                onClick={() => run("raise", onToggleHand)}
              >
                <HandIcon className="size-3.5" aria-hidden />
                Raise again
              </button>
            )}
          </div>
        )}
      </div>
      {actions.close && onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className="absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-md text-ink-3 transition-colors outline-none hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <CloseIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** The round badge: an amber hand that waves once when raised, a quiet grey hand once
 *  it is down, a breathing blue ring round a mic or camera while an invite is open, a
 *  green disc with a check that pops in on the stage, a grey audience icon off it. */
function SelfHandBadge({ view }: { view: SelfHandView }) {
  const phase = view.phase;
  const icon =
    phase === "raised" ? (
      <HandIcon className="hand-wave size-4" />
    ) : phase === "invited" ? (
      view.invite.audioOnly ? (
        <MicIcon className="size-4" />
      ) : (
        <CameraIcon className="size-4" />
      )
    ) : phase === "stage" ? (
      view.arrival === "joining" ? (
        <Spinner className="size-4" />
      ) : view.arrival === "speak" ? (
        <MicIcon className="size-4" />
      ) : (
        <CameraIcon className="size-4" />
      )
    ) : phase === "audience" ? (
      <UsersIcon className="size-4" />
    ) : (
      <HandIcon className="size-4" />
    );
  return (
    <span className="self-badge join-avatar mt-0.5 rounded-full" data-phase={phase} aria-hidden>
      <span className="self-disc grid size-8 place-items-center rounded-full">{icon}</span>
      {phase === "stage" && view.arrival !== "joining" && (
        <span className="join-check">
          <CheckIcon className="size-2.5" />
        </span>
      )}
    </span>
  );
}
