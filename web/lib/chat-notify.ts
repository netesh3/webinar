"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { ChatMessage } from "./realtime";

/* Chat that arrives while the panel is shut.
 *
 * The unread badge already says how MUCH has arrived — see the `seen` watermark in
 * webinar-room.tsx, which this file deliberately does not duplicate or replace. What a
 * number cannot say is who said what, and that is the difference between a host
 * noticing a question worth answering and a host noticing that a badge went up.
 *
 * So: one card, over the stage, next to the button the badge is on. Everything that
 * decides what it says is a pure function here, because a burst of chat during a live
 * session is not something anybody can test by hand — and the failure it guards against
 * (three people typing at once becoming three cards over the video) only shows up under
 * exactly that burst.
 *
 * Two side channels come with it. A sound nobody hears unless they asked for one, and a
 * "open the panel at this message" request that has to cross from an overlay on the stage
 * to whichever copy of the chat panel happens to be mounted.
 */

/** How much of a message the card shows. Enough to tell a question from a "thanks",
 *  short enough to stay two lines over somebody's video. */
export const PREVIEW_CHARS = 90;

export type ChatPreview = {
  /* The message the panel is asked to scroll to.
   *
   * The OLDEST of the run, not the newest. A card reading "3 new messages" is an
   * invitation to read those three, and the newest is where an already-scrolled panel
   * lands by itself — so anchoring on the newest would make the click do nothing you
   * could see. */
  anchorId: string;
  /** The latest sender in the run, whose name is on the card. */
  sender: string;
  /** That sender's message, shortened. */
  text: string;
  /** How many messages this one card stands for. */
  count: number;
};

/** One message, as a single line of preview text. */
export function previewText(message: ChatMessage): string {
  // Collapsed rather than trimmed: a pasted paragraph with newlines in it would
  // otherwise make the card as tall as the message.
  const text = message.text.replace(/\s+/g, " ").trim();
  // An image with no caption is still worth announcing.
  if (!text) return message.media ? "Sent an image" : "";
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
}

/* Which messages have not been turned into a notification yet.
 *
 * Keyed on id, not counted. The conversation is not append-only: a reconnect merges a
 * backlog into the middle of it (see mergeChat in realtime.ts), so a cursor that was an
 * index or a length would announce a page of history as new — and the moment that
 * happens is the moment somebody's connection dropped, which is already a bad enough
 * minute for them.
 *
 * `since` is the second half of that, and it is about joining rather than reconnecting.
 * The backlog fetch resolves a moment AFTER the room mounts, so an id-only cursor sees
 * twenty lines of conversation appear out of nowhere and announces all of them. Every
 * message carries the time it was said — `Date.now()` on receipt for a live packet, the
 * stored stamp for history (see decodeBacklog) — so anything predating this browser's
 * arrival is history, whenever it happens to turn up.
 */
export function freshMessages(
  chat: readonly ChatMessage[],
  accounted: ReadonlySet<string>,
  myIdentity: string,
  since: number,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of chat) {
    if (accounted.has(message.id)) continue;
    if (message.at < since) continue;
    // Your own words are not news. They reach here either way: a publisher applies its
    // own echo optimistically, and an attendee's comes back from the server because the
    // relay includes the sender in the recipient list.
    if (message.from.identity === myIdentity) continue;
    out.push(message);
  }
  return out;
}

/** Folds a run of arrivals into the single card that stands for them. Returns
 *  `current` unchanged when there is nothing in the run worth showing. */
export function coalesce(
  current: ChatPreview | null,
  fresh: readonly ChatMessage[],
): ChatPreview | null {
  let next = current;
  for (const message of fresh) {
    const text = previewText(message);
    if (!text) continue;
    next = next
      ? { anchorId: next.anchorId, sender: message.from.name, text, count: next.count + 1 }
      : { anchorId: message.id, sender: message.from.name, text, count: 1 };
  }
  return next;
}

// ------------------------------------------------------------------ the sound cue

/* On by default, and remembered once somebody changes it.
 *
 * The risk this was originally off for — a host's laptop making a noise they did not
 * arrange, picked up and broadcast by a shared screen's audio track — is handled
 * independently: the cue is suppressed for whoever is sharing regardless of this
 * preference (see ChatNotifications' `sharing` check), so defaulting to on here does
 * not reopen it. The preference is per-browser rather than per-session.
 */
const SOUND_KEY = "webcast.chatSound.v1";

const soundListeners = new Set<() => void>();
/** Cached so the snapshot is referentially stable, which useSyncExternalStore requires. */
let soundEnabled: boolean | null = null;

function readSoundPreference(): boolean {
  if (soundEnabled !== null) return soundEnabled;
  try {
    soundEnabled = window.localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    // Private browsing. The preference lasts the session.
    soundEnabled = true;
  }
  return soundEnabled;
}

function subscribeSound(listener: () => void): () => void {
  soundListeners.add(listener);
  return () => soundListeners.delete(listener);
}

function soundOnServer(): boolean {
  return false;
}

export function useChatSound(): {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
} {
  const enabled = useSyncExternalStore(
    subscribeSound,
    readSoundPreference,
    soundOnServer,
  );
  const setEnabled = useCallback((on: boolean) => {
    soundEnabled = on;
    try {
      window.localStorage.setItem(SOUND_KEY, on ? "on" : "off");
    } catch {
      // As above.
    }
    for (const listener of soundListeners) listener();
  }, []);
  return { enabled, setEnabled };
}

/** How long the cue waits before it may sound again. A run of messages gets one blip
 *  for the same reason it gets one card. */
export const SOUND_GAP_MS = 3000;

let lastCueAt = 0;
let cueContext: AudioContext | null = null;

/** A short, quiet two-note blip. Synthesised rather than loaded: no asset to fetch,
 *  nothing to decode, and nothing to get wrong on a browser that blocks autoplay. */
export function playChatCue(): void {
  if (typeof window === "undefined") return;
  const Ctor =
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;

  const now = Date.now();
  if (now - lastCueAt < SOUND_GAP_MS) return;
  lastCueAt = now;

  try {
    cueContext ??= new Ctor();
    const ctx = cueContext;
    // Held suspended until the page has had a gesture. Resuming is a no-op when it is
    // already running, and a refusal is swallowed rather than queued — a cue that fires
    // minutes later, out of context, is worse than one that never fired.
    void ctx.resume().catch(() => {});

    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    const start = ctx.currentTime;
    // Exponential in and out: a square-edged envelope clicks, and the tail is what keeps
    // this reading as a notification rather than an alarm.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.05, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);

    for (const [frequency, offset] of [
      [660, 0],
      [880, 0.09],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = frequency;
      osc.connect(gain);
      osc.start(start + offset);
      osc.stop(start + offset + 0.18);
    }
  } catch {
    // No output device, or a context the browser refused to create. The card is the
    // notification; the sound was only ever the optional half of it.
  }
}

// -------------------------------------------------- "open the panel at this message"

/* The card's click, delivered to a panel that may not be mounted yet.
 *
 * A module store rather than a prop or another context field, because the two ends are
 * in unrelated subtrees: the card is an overlay on the stage, and the panel it opens is
 * either the docked rail or a floating window, neither of which knows about the other.
 * One room per tab, so one store is enough.
 */
export type ChatFocusRequest = { id: string; nonce: number; at: number };

/** How long a request is worth acting on. The panel opens in the same commit as the
 *  click, so this is generous — it exists only so a panel opened by hand ten minutes
 *  later scrolls to the bottom like normal instead of jumping to an old message. */
export const FOCUS_TTL_MS = 10_000;

let focusRequest: ChatFocusRequest | null = null;
const focusListeners = new Set<() => void>();

export function requestChatFocus(id: string): void {
  // The nonce, not the id, is what the panel reacts to: two cards in a row about the
  // same message still have to scroll to it the second time.
  focusRequest = { id, nonce: (focusRequest?.nonce ?? 0) + 1, at: Date.now() };
  for (const listener of focusListeners) listener();
}

function subscribeFocus(listener: () => void): () => void {
  focusListeners.add(listener);
  return () => focusListeners.delete(listener);
}

function readFocus(): ChatFocusRequest | null {
  return focusRequest;
}

function focusOnServer(): ChatFocusRequest | null {
  return null;
}

export function useChatFocus(): ChatFocusRequest | null {
  return useSyncExternalStore(subscribeFocus, readFocus, focusOnServer);
}
