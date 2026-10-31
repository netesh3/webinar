"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { IncomingCallEvent } from "@/lib/api-types";
import { ApiError } from "@/lib/http";
import { callsApi } from "@/lib/calls-api";
import {
  applyCallEvent,
  CALL_WINDOW_EVENT,
  callCardLayout,
  parseCallEvent,
  secondsLeft,
  type CallEvent,
} from "@/lib/calls";
import { startRinging } from "@/lib/ringtone";
import { AccountAvatar } from "./account-avatar";
import { MaterialIcon } from "./icons";
import { useSession, useToast } from "./providers";

/* The incoming-call card, mounted once for the whole app (app/layout.tsx), on every page of a
 * signed-in account (31 Oct 2026, docs/calling.md).
 *
 * It holds the tab's one event stream, GET /api/me/events, and re-dispatches every call event
 * on window (CALL_WINDOW_EVENT) so the room's "Call someone" hears how its own calls end. A
 * ring shows the caller, the topic, Accept and Decline: the whole screen on a phone, a card in
 * the corner on a desktop. It rings (lib/ringtone.ts) until it is answered here, answered on
 * another device (call_ended), or its 45 seconds run out. Accept goes to the call's join link.
 *
 * The service worker shows the same ring as a notification when no tab is in front
 * (public/sw.js); its Accept and Decline call the same endpoints. */

function useAccountEvents(enabled: boolean, onEvent: (ev: CallEvent) => void) {
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    const es = new EventSource(callsApi.eventsUrl(), { withCredentials: true });
    const onCall = (e: MessageEvent) => {
      const ev = parseCallEvent(e.data);
      if (!ev) return;
      handler.current(ev);
      window.dispatchEvent(new CustomEvent(CALL_WINDOW_EVENT, { detail: ev }));
    };
    es.addEventListener("call", onCall as EventListener);
    // A stream the server ended with an error (signed out elsewhere) is not retried by the
    // browser; a dropped one is, by itself.
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) es.close();
    };
    return () => {
      es.removeEventListener("call", onCall as EventListener);
      es.close();
    };
  }, [enabled]);
}

const noSubscribe = () => () => {};

function subscribeResize(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

function useLayout(): "fullscreen" | "corner" {
  return useSyncExternalStore(
    subscribeResize,
    () => callCardLayout(window.innerWidth, window.matchMedia?.("(pointer: coarse)").matches ?? false),
    () => "corner",
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function IncomingCall() {
  const { status } = useSession();
  const router = useRouter();
  const { notify } = useToast();
  const [ringing, setRinging] = useState<IncomingCallEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const layout = useLayout();
  const mounted = useSyncExternalStore(noSubscribe, () => true, () => false);

  useAccountEvents(status === "signed-in", (ev) => setRinging((list) => applyCallEvent(list, ev)));

  const now = useNow(ringing.length > 0);
  const live = ringing.filter((c) => secondsLeft(c.expiresAt, now) > 0);
  const call = live.length > 0 ? live[live.length - 1] : null;
  const callId = call?.callId ?? null;

  // Ring while there is a call to answer; a new call restarts the ring.
  useEffect(() => {
    if (!callId) return;
    return startRinging();
  }, [callId]);

  // The service worker answered from the notification: the stream says so too, but this is
  // quicker and works while the stream reconnects.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const ev = parseCallEvent((e.data as { call?: unknown } | null)?.call);
      if (ev) setRinging((list) => applyCallEvent(list, ev));
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  if (!mounted || !call) return null;

  const drop = (id: string) => setRinging((list) => list.filter((c) => c.callId !== id));

  async function accept(c: IncomingCallEvent) {
    setBusy(true);
    try {
      const answered = await callsApi.accept(c.callId);
      drop(c.callId);
      router.push(answered.joinUrl || c.joinUrl);
    } catch (err) {
      drop(c.callId);
      notify(err instanceof ApiError ? err.message : "Could not answer the call.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function decline(c: IncomingCallEvent) {
    drop(c.callId);
    try {
      await callsApi.decline(c.callId);
    } catch {
      // Over already (hung up, answered elsewhere): nothing to undo.
    }
  }

  const secs = secondsLeft(call.expiresAt, now);
  const full = layout === "fullscreen";
  const initials =
    call.callerName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?";

  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label={`Incoming call from ${call.callerName}`}
      className={
        full
          ? "fixed inset-0 z-[1000] flex flex-col items-center justify-between bg-[#0b1220] px-6 pt-[max(4rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))] text-white"
          : "fixed right-4 bottom-4 z-[1000] w-[320px] rounded-2xl border border-line bg-surface p-4 shadow-2xl"
      }
    >
      <div className={full ? "flex flex-col items-center gap-4 text-center" : "flex items-center gap-3"}>
        <span className={full ? "animate-pulse rounded-full ring-8 ring-white/10" : ""}>
          <AccountAvatar
            initials={initials}
            hue="#0b5cff"
            photo={call.callerAvatarUrl ?? undefined}
            size={full ? 112 : 44}
          />
        </span>
        <div className="min-w-0">
          <p className={full ? "text-[15px] text-white/70" : "text-[12px] text-ink-3"}>Incoming call · {secs}s</p>
          <p className={full ? "mt-1 text-[28px] font-semibold" : "truncate text-[15px] font-semibold text-ink"}>
            {call.callerName}
          </p>
          {call.topic && (
            <p className={full ? "mt-1 text-[15px] text-white/80" : "truncate text-[12.5px] text-ink-2"}>
              {call.topic}
            </p>
          )}
        </div>
      </div>
      <div className={full ? "flex w-full max-w-xs justify-between" : "mt-4 grid grid-cols-2 gap-2"}>
        <CallButton full={full} tone="decline" disabled={busy} onClick={() => void decline(call)} />
        <CallButton full={full} tone="accept" disabled={busy} onClick={() => void accept(call)} />
      </div>
    </div>
  );
}

function CallButton({
  full,
  tone,
  disabled,
  onClick,
}: {
  full: boolean;
  tone: "accept" | "decline";
  disabled: boolean;
  onClick: () => void;
}) {
  const label = tone === "accept" ? "Accept" : "Decline";
  const color = tone === "accept" ? "bg-[#16a34a] hover:bg-[#15803d]" : "bg-[#dc2626] hover:bg-[#b91c1c]";
  if (full) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="flex flex-col items-center gap-2 text-[14px] font-medium text-white outline-none disabled:opacity-60"
      >
        <span className={`grid size-[72px] place-items-center rounded-full ${color} focus-visible:ring-4`}>
          <MaterialIcon name={tone === "accept" ? "call" : "call_end"} className="size-8" fill />
        </span>
        {label}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-10 items-center justify-center gap-2 rounded-lg text-[13.5px] font-medium text-white outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-60 ${color}`}
    >
      <MaterialIcon name={tone === "accept" ? "call" : "call_end"} className="size-5" fill />
      {label}
    </button>
  );
}
