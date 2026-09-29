"use client";

import { RoomEvent, type Participant, type RemoteParticipant, type Room } from "livekit-client";
import { useCallback, useEffect, useRef } from "react";
import type { LiveParticipant, LiveRoom } from "@/lib/api-types";
import {
  JoinTracker,
  summaryText,
  type JoinEntry,
  type JoinPerson,
  type JoinToastView,
} from "@/lib/join-toasts";
import type { Sender } from "@/lib/realtime";
import { isBotOrEgress, rosterBadge } from "@/lib/roster";
import { CheckIcon } from "../icons";
import { useToast } from "../providers";
import { SenderAvatar } from "../sender-avatar";
import { Pill } from "./chat-badges";
import { participantRole } from "./participants";

/* The host's "X is joining…" → "X joined" toasts.
 *
 * The lifecycle lives in lib/join-toasts.ts; this file feeds it the two signals and
 * draws what it says:
 *
 *  - joining: the server's "joined" packet (sent when it issues an attendee's token)
 *    and LiveKit's ParticipantConnected, whichever comes first;
 *  - joined: the person being in `roster.live` — the list the Participants panel
 *    draws — so a toast never names somebody the panel does not show.
 *
 * Host and co-host only, as before: they are the ones with the roster (useHostRoster
 * runs for nobody else), and the ones the old "X joined" line was for.
 */

export function useJoinToasts(
  room: Room,
  selfIdentity: string,
  enabled: boolean,
  live: LiveRoom | null,
): (from: Sender) => void {
  const { upsert, dismissKey } = useToast();
  const tracker = useRef<JoinTracker | null>(null);
  const shown = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The expiry timer re-enters sync through this, as a callback cannot name itself.
  const syncRef = useRef<() => void>(() => {});

  const sync = useCallback(() => {
    const t = tracker.current;
    clearTimeout(timer.current);
    const views = t ? t.view() : [];
    const next = new Set<string>();
    for (const view of views) {
      next.add(view.key);
      const identities =
        view.kind === "person" ? [view.entry.identity] : [...view.joined, ...view.joining].map((e) => e.identity);
      upsert(view.key, {
        message: joinToastMessage(view),
        tone: isDone(view) ? "ok" : "info",
        node: <JoinToastCard view={view} />,
        onDismiss: () => {
          tracker.current?.dismiss(identities);
          shown.current.delete(view.key);
        },
      });
    }
    for (const key of shown.current) if (!next.has(key)) dismissKey(key);
    // Mutated in place rather than replaced, so the cleanup below clears the live set.
    shown.current.clear();
    for (const key of next) shown.current.add(key);

    const deadline = t?.nextDeadline();
    if (t && deadline != null) {
      timer.current = setTimeout(() => {
        t.tick(Date.now());
        syncRef.current();
      }, Math.max(0, deadline - Date.now()));
    }
  }, [upsert, dismissKey]);
  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  // A fresh tracker whenever who is watching changes. Its first roster reading is the
  // baseline, so turning into a co-host mid-session does not announce the whole room.
  useEffect(() => {
    if (!enabled) return;
    const shownNow = shown.current;
    tracker.current = new JoinTracker(selfIdentity);
    return () => {
      tracker.current = null;
      clearTimeout(timer.current);
      for (const key of shownNow) dismissKey(key);
      shownNow.clear();
    };
  }, [enabled, selfIdentity, dismissKey]);

  useEffect(() => {
    if (!enabled || !live || !tracker.current) return;
    tracker.current.roster(
      live.participants.filter((p) => !isBotOrEgress(p.identity)).map(fromRoster),
      Date.now(),
    );
    sync();
  }, [enabled, live, sync]);

  useEffect(() => {
    if (!enabled) return;
    const onConnected = (p: RemoteParticipant) => {
      if (isBotOrEgress(p.identity)) return;
      tracker.current?.joining(fromLiveKit(p), Date.now());
      sync();
    };
    const onDisconnected = (p: RemoteParticipant) => {
      tracker.current?.left(p.identity);
      sync();
    };
    room.on(RoomEvent.ParticipantConnected, onConnected);
    room.on(RoomEvent.ParticipantDisconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.ParticipantConnected, onConnected);
      room.off(RoomEvent.ParticipantDisconnected, onDisconnected);
    };
  }, [enabled, room, sync]);

  return useCallback(
    (from: Sender) => {
      if (!enabled || isBotOrEgress(from.identity)) return;
      tracker.current?.joining(
        { identity: from.identity, name: from.name || "Someone", role: asJoinRole(from.role) },
        Date.now(),
      );
      sync();
    },
    [enabled, sync],
  );
}

function asJoinRole(role: string): JoinPerson["role"] {
  return role === "host" || role === "panelist" ? role : "attendee";
}

function fromRoster(p: LiveParticipant): JoinPerson {
  return {
    identity: p.identity,
    name: p.name || "Someone",
    role: asJoinRole(p.role),
    coHost: p.coHost,
    audioOnly: p.audioOnly,
  };
}

function fromLiveKit(p: Participant): JoinPerson {
  return { identity: p.identity, name: p.name || "Someone", role: asJoinRole(participantRole(p)) };
}

function isDone(view: JoinToastView): boolean {
  return view.kind === "person" ? view.entry.phase === "joined" : view.joining.length === 0;
}

export function joinToastMessage(view: JoinToastView): string {
  if (view.kind === "summary") {
    const { title, detail } = summaryText(view);
    return detail ? `${title}. ${detail}` : title;
  }
  const { name, phase } = view.entry;
  return phase === "joined" ? `${name} joined` : `${name} is joining…`;
}

// ------------------------------------------------------------------ the card

/** One join toast. Dark whatever page it floats over, like the room it belongs to.
 *  Exported for the visual harness; the room only reaches it through the hook. */
export function JoinToastCard({ view }: { view: JoinToastView }) {
  const done = isDone(view);
  return (
    <div
      className={`join-card room-dark flex w-full items-center gap-3 rounded-xl border bg-surface/95 py-2.5 pr-3.5 pl-3 text-left shadow-xl backdrop-blur sm:w-[19rem] ${
        done ? "border-ok/35" : "border-line-2"
      }`}
    >
      {view.kind === "person" ? <PersonBody entry={view.entry} /> : <SummaryBody view={view} />}
    </div>
  );
}

function PersonBody({ entry }: { entry: JoinEntry }) {
  const badge = rosterBadge({ role: entry.role, coHost: entry.coHost ?? false, audioOnly: entry.audioOnly ?? false });
  const done = entry.phase === "joined";
  return (
    <>
      <JoinAvatar phase={entry.phase}>
        <SenderAvatar name={entry.name} identity={entry.identity} size="md" />
      </JoinAvatar>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-ink">{entry.name}</span>
          {badge && <Pill tone={badge.tone}>{badge.label}</Pill>}
        </div>
        <StatusLine done={done} joining="is joining" joined="joined · now in Participants" />
      </div>
    </>
  );
}

function SummaryBody({ view }: { view: Extract<JoinToastView, { kind: "summary" }> }) {
  const { title, detail } = summaryText(view);
  const everyone = [...view.joined, ...view.joining];
  const faces = everyone.slice(0, 2);
  const extra = everyone.length - faces.length;
  const done = view.joining.length === 0;
  return (
    <>
      <JoinAvatar phase={done ? "joined" : "joining"}>
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
      </JoinAvatar>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-[13px] leading-snug font-semibold text-ink">{title}</p>
        {detail ? (
          <StatusLine done={false} joining={detail.replace(/…$/, "")} joined="" />
        ) : (
          <StatusLine done={done} joining="Joining" joined="Now in Participants" />
        )}
      </div>
    </>
  );
}

function JoinAvatar({ phase, children }: { phase: "joining" | "joined"; children: React.ReactNode }) {
  return (
    <span className="join-avatar rounded-full" data-phase={phase}>
      {children}
      {phase === "joined" && (
        <span className="join-check" aria-hidden>
          <CheckIcon className="size-2.5" />
        </span>
      )}
    </span>
  );
}

function StatusLine({ done, joining, joined }: { done: boolean; joining: string; joined: string }) {
  if (done) {
    return <p className="mt-0.5 text-[12px] font-medium text-ok">{joined}</p>;
  }
  return (
    <p className="mt-0.5 text-[12px] text-ink-2">
      {joining}
      <span className="join-dots" aria-hidden>
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </p>
  );
}
