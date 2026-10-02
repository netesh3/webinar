"use client";

import { ConnectionState, type Room } from "livekit-client";
import { useConnectionState } from "@livekit/components-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ConnectionToastTracker,
  connectionToastText,
  linkForRoom,
  type ConnectionToastView,
  type LinkState,
} from "@/lib/connection-toast";
import { CheckIcon, CloseIcon, RotateCwIcon, SpinnerIcon } from "../icons";
import { useToast } from "../providers";

/* The room's connection toast: "You're connected" when a presenter first reaches the stage,
 * "Reconnecting…" → "You're back online", or "Connection lost"
 * with Rejoin. When each shows is lib/connection-toast.ts; this feeds it the SDK's state and
 * the room's own retry ladder, and draws the card in the join toasts' style — the same dark
 * surface, a ring that breathes while something is in progress and a check that pops in when
 * it has worked.
 *
 * Presentation only. The ladder in webinar-room.tsx is untouched; Rejoin is the same page
 * reload the "You were disconnected" screen offers.
 */

const KEY = "connection";

function toLink(state: ConnectionState): LinkState {
  // signalReconnecting is a websocket resume with the peer connection still up.
  // Counting it here is what showed "Reconnecting…" during a healthy webinar.
  return linkForRoom(state);
}

const subscribeOnline = (cb: () => void) => {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
};
const readOffline = () => !navigator.onLine;
const readOfflineOnServer = () => false;

export function useConnectionToast(
  room: Room,
  recovering: number | null,
  attempts: number,
  publisher: boolean,
  /** The session is over (or being ended): say nothing more, and take down anything showing. */
  over = false,
): { greet: () => void } {
  const { upsert, dismissKey } = useToast();
  const state = useConnectionState(room);
  const offline = useSyncExternalStore(subscribeOnline, readOffline, readOfflineOnServer);

  const [tracker] = useState(() => new ConnectionToastTracker());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const syncRef = useRef<() => void>(() => {});

  const sync = useCallback(() => {
    clearTimeout(timer.current);
    const view = tracker.view();
    if (!view) {
      dismissKey(KEY);
    } else {
      const { title, detail } = connectionToastText(view, publisher);
      const onClose = () => {
        tracker.dismiss();
        syncRef.current();
      };
      upsert(KEY, {
        message: `${title} ${detail}`,
        tone: view.phase === "back" || view.phase === "connected" ? "ok" : view.phase === "lost" ? "error" : "info",
        node: <ConnectionToastCard view={view} publisher={publisher} onClose={onClose} />,
        interactive: true,
        urgent: view.phase === "lost",
      });
    }
    const deadline = tracker.nextDeadline();
    if (deadline != null) {
      timer.current = setTimeout(() => {
        tracker.tick(Date.now());
        syncRef.current();
      }, Math.max(0, deadline - Date.now()));
    }
  }, [tracker, upsert, dismissKey, publisher]);
  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  useEffect(() => {
    if (over) {
      // The room closing is what ending looks like from here. Not an outage, so no
      // "Reconnecting…" — the ended screen is the whole message.
      clearTimeout(timer.current);
      dismissKey(KEY);
      return;
    }
    tracker.update({ link: toLink(state), recovering, attempts, offline }, Date.now());
    sync();
  }, [tracker, state, recovering, attempts, offline, sync, over, dismissKey]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      dismissKey(KEY);
    },
    [dismissKey],
  );

  // Called by the room when a host or panelist first reaches the stage on joining.
  const overRef = useRef(over);
  useEffect(() => {
    overRef.current = over;
  }, [over]);
  const greet = useCallback(() => {
    if (!overRef.current && tracker.greet(Date.now())) syncRef.current();
  }, [tracker]);
  return { greet };
}

// ------------------------------------------------------------------ the card

/** One connection toast. Dark whatever page it floats over, like the room it belongs to.
 *  Exported for the visual harness; the room only reaches it through the hook. */
export function ConnectionToastCard({
  view,
  publisher = true,
  onClose,
}: {
  view: ConnectionToastView;
  publisher?: boolean;
  onClose?: () => void;
}) {
  const { title, detail } = connectionToastText(view, publisher);
  const tone = view.phase;
  // "You're connected" and "You're back online" are the same card: green, a check, done.
  const good = tone === "back" || tone === "connected";
  return (
    <div
      data-phase={tone}
      className={`join-card conn-card room-dark flex w-full items-start gap-3 rounded-xl border bg-surface/95 py-2.5 pr-2 pl-3 text-left shadow-xl backdrop-blur sm:w-[20rem] ${
        good ? "border-ok/35" : tone === "lost" ? "border-live/40" : "border-warn/35"
      }`}
    >
      <ConnectionBadge phase={tone} />
      <div className="min-w-0 flex-1 pt-0.5">
        <p className={`text-[13px] leading-snug font-semibold ${tone === "lost" ? "text-live" : "text-ink"}`}>
          {title}
        </p>
        <p className={`mt-0.5 text-[12px] leading-snug ${good ? "font-medium text-ok" : "text-ink-2"}`}>
          {detail}
        </p>
        {tone === "lost" && (
          <button
            type="button"
            onClick={() => location.reload()}
            className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md bg-white/10 px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-white/20 outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          >
            <RotateCwIcon className="size-3.5" />
            Rejoin
          </button>
        )}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-white/10 hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-white/50"
        >
          <CloseIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** The round badge on the left: a spinner in a breathing amber ring while reconnecting,
 *  a red ring with the rejoin arrow when lost, a green disc with a check when back or connected. */
function ConnectionBadge({ phase }: { phase: ConnectionToastView["phase"] }) {
  return (
    <span className="conn-badge join-avatar rounded-full" data-phase={phase} aria-hidden>
      <span className="conn-disc grid size-8 place-items-center rounded-full">
        {phase === "back" || phase === "connected" ? (
          <CheckIcon className="conn-check size-4" />
        ) : phase === "lost" ? (
          <RotateCwIcon className="size-4" />
        ) : (
          <SpinnerIcon className="conn-spin size-4" />
        )}
      </span>
    </span>
  );
}
