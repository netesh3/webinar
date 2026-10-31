/* Calling (31 Oct 2026, docs/calling.md): the decisions, pure so node can test them
 * (lib/calls.test.mts).
 *
 * Everything that arrives here is untrusted in the way room packets are: an event from the
 * account's stream, a push's data, a payload a service worker handed over. parseCallEvent is
 * the only way one becomes something the card renders, and it refuses anything off-contract
 * (a joinUrl that is not a path on this site, above all: Accept navigates to it).
 *
 * The browser side is components/incoming-call.tsx (the card, the ringtone, the stream) and
 * components/room/call-someone.tsx (ringing somebody from a meeting). */

import type { CallEndedEvent, CallState, IncomingCallEvent } from "./api-types.ts";

/** The two events, told apart by type (the generated types say only string). */
export type IncomingCall = IncomingCallEvent & { type: "incoming_call" };
export type CallEnded = CallEndedEvent & { type: "call_ended" };
export type CallEvent = IncomingCall | CallEnded;

/** The window event the account's stream re-dispatches every call event on, so the room's
 *  "Call someone" hears its own call end without opening a second stream. */
export const CALL_WINDOW_EVENT = "webinarliv:call";

const MAX_NAME = 80;
const MAX_TOPIC = 120;
const ENDED_STATES: readonly CallState[] = ["accepted", "declined", "cancelled", "missed"];

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A path on this site, never another origin: "/x", not "//x", "http:" or "javascript:". */
export function isSitePath(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !url.includes("\\");
}

/** A photo URL the card may load: https only, else none (initials). */
export function avatarOrNull(url: unknown): string | null {
  return typeof url === "string" && /^https:\/\//.test(url) ? url : null;
}

/** An event from the stream (JSON text or parsed), or a push's data (all strings, "" for null).
 *  Null when it is not one of the two call events. */
export function parseCallEvent(raw: unknown): CallEvent | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const callId = str(o.callId, 64);
  if (!callId) return null;
  if (o.type === "call_ended") {
    const state = o.state as CallState;
    if (!ENDED_STATES.includes(state)) return null;
    return { type: "call_ended", callId, state };
  }
  if (o.type !== "incoming_call") return null;
  const expiresAt = str(o.expiresAt, 40);
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt)) || !isSitePath(o.joinUrl)) return null;
  return {
    type: "incoming_call",
    callId,
    callerName: str(o.callerName, MAX_NAME) || "Someone",
    callerAvatarUrl: avatarOrNull(o.callerAvatarUrl),
    meetingSlug: str(o.meetingSlug, 120) ?? "",
    topic: str(o.topic, MAX_TOPIC) ?? "",
    joinUrl: o.joinUrl,
    expiresAt,
  };
}

/** Whole seconds a ring has left (0 once over). */
export function secondsLeft(expiresAt: string, now: number = Date.now()): number {
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** The rings to show: unexpired, newest last, one per call, ended ones removed. */
export function applyCallEvent(
  ringing: readonly IncomingCallEvent[],
  ev: CallEvent,
  now: number = Date.now(),
): IncomingCallEvent[] {
  const rest = ringing.filter((c) => c.callId !== ev.callId && secondsLeft(c.expiresAt, now) > 0);
  if (ev.type === "incoming_call" && secondsLeft(ev.expiresAt, now) > 0) rest.push(ev);
  return rest;
}

/** What the caller's row says about a call they placed. */
export function callerStatusLabel(state: CallState | "placing", secs = 0): string {
  switch (state) {
    case "placing":
      return "Calling…";
    case "ringing":
      return secs > 0 ? `Ringing… ${secs}s` : "Ringing…";
    case "accepted":
      return "Joining";
    case "declined":
      return "Declined";
    case "cancelled":
      return "Cancelled";
    case "missed":
      return "No answer";
  }
  return "";
}

/** Phones get the whole screen; anything wider a card in the corner. */
export function callCardLayout(width: number, coarsePointer: boolean): "fullscreen" | "corner" {
  return width < 640 || (coarsePointer && width < 900) ? "fullscreen" : "corner";
}

/** What a contacts search will match, mirroring the server: a whole address, or a name. */
export function contactQueryKind(q: string): "empty" | "email" | "name" {
  const t = q.trim();
  if (!t) return "empty";
  const at = t.lastIndexOf("@");
  if (at >= 1 && at < t.length - 1 && !/[\s,;]/.test(t) && t.slice(at + 1).includes(".")) return "email";
  return "name";
}

/* The ringtone: a classic two-tone ring (440 + 480 Hz, as a phone line's ringback), two short
 * bursts then a pause, repeating. Generated with WebAudio from these numbers, so there is no
 * audio file and nothing to license. */
export type RingTone = { at: number; duration: number; freqs: readonly [number, number] };
export const RING_PERIOD_S = 3;
export const RING_GAIN = 0.12;

export function ringSchedule(): RingTone[] {
  return [
    { at: 0, duration: 0.4, freqs: [440, 480] },
    { at: 0.6, duration: 0.4, freqs: [440, 480] },
  ];
}

/** navigator.vibrate's pattern for one ring period. */
export const RING_VIBRATION: number[] = [400, 200, 400, 2000];
