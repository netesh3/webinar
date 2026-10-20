/* Keeping a webinar audible on Android with the screen locked: the parts that can be checked
 * without a browser. components/room/lock-screen-audio.tsx is the rest.
 *
 * Safari on an iPhone keeps a webinar playing when the screen locks. Chrome on Android stopped
 * it at once, and it came back by itself on unlock (tested on a Standard-delivery webinar,
 * 2026-10-20): the connection survives and only the playing stops. Chrome keeps a hidden
 * page's sound going for media it can put on the lock screen — music, a podcast — and live
 * WebRTC audio is not that kind of media.
 *
 * So the room offers it some: an inaudible clip on loop, which Chrome does count as media,
 * with the webinar's title on the lock-screen card. Whether that is enough to keep WebRTC's
 * own playout going is what this is testing. The background_audio report in lib/telemetry.ts
 * measures what Chrome did, with or without it.
 *
 * Off unless asked for while it is an experiment. ?bg=1 on the room link turns it on in that
 * browser, and is remembered, so later joins need no flag; ?bg=0 turns it off again.
 *
 * No imports, so lib/lock-screen-audio.test.mts can load it.
 */

export const LOCK_SCREEN_KEY = "webcast.lockScreenAudio.v1";

/** Android, from the user agent. Chrome's reduced user agent still names the platform; every
 *  browser there says it, and the clip is harmless in any of them. */
export function isAndroid(userAgent: string): boolean {
  return /android/i.test(userAgent);
}

/** Whether to run, from the page's query string and the remembered choice, and what to
 *  remember now: "1" to store, null to forget, undefined to leave as it is. */
export function lockScreenChoice(
  search: string,
  stored: string | null,
): { on: boolean; store?: "1" | null } {
  const asked = new URLSearchParams(search).get("bg");
  if (asked === "1") return { on: true, store: "1" };
  if (asked === "0") return { on: false, store: null };
  return { on: stored === "1" };
}

/** Seconds in the clip. Over Chrome's five-second floor for media it treats as content —
 *  anything shorter is a sound effect and gets no lock-screen card — and small in memory. */
export const CLIP_SECONDS = 10;
const CLIP_RATE = 8_000;

/**
 * A mono 16-bit WAV of nearly nothing: every sample ±1 of 32767, about −90 dBFS, which no
 * speaker turns into anything audible.
 *
 * Not exact zeros. A run of zeros is the one kind of quiet an audio path can recognise and
 * skip — Chromium's SilentSinkSuspender does exactly that for Web Audio — and this clip's
 * whole job is to look like something playing.
 */
export function silentWav(seconds = CLIP_SECONDS, rate = CLIP_RATE): ArrayBuffer {
  const samples = Math.round(seconds * rate);
  const bytes = samples * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const v = new DataView(buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  v.setUint32(4, 36 + bytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // bytes per second
  v.setUint16(32, 2, true); // bytes per frame
  v.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  v.setUint32(40, bytes, true);
  for (let i = 0; i < samples; i++) v.setInt16(44 + i * 2, i % 2 === 0 ? 1 : -1, true);
  return buffer;
}

/** What the keep-alive is doing, for the background_audio report. */
export type LockScreenState =
  | "off" // not running in this browser
  | "waiting" // running, but the browser has not let the clip play yet: it needs a tap
  | "playing"
  | "paused"; // from the lock-screen card, or by the system (a call, another app's audio)

let state: LockScreenState = "off";

export function lockScreenState(): LockScreenState {
  return state;
}

export function setLockScreenState(next: LockScreenState): void {
  state = next;
}
