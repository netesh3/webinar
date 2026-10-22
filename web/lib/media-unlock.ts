"use client";

import { useEffect } from "react";
import { silentWav } from "./lock-screen-audio";

/* A <video> that Safari will let play with sound, made in the tap that leads to the room.
 *
 * Chrome, Edge and Firefox let a page play sound once anybody has clicked anything on it, for
 * as long as the document lives (sticky activation). Safari, macOS and iOS alike, decides
 * per media element: an element may play with sound once it has been played (or loaded)
 * inside a tap, and from then on whatever it plays. The room's player is created seconds
 * after the Join tap, on the next screen, so on Safari it is never that element, and every
 * attendee was asked to tap for sound.
 *
 * So the first tap or key on the way in (the webinar's page, the room's gate) plays a silent
 * clip on a spare element, and the room's player adopts it (takePrimedVideo in
 * StagePlayerChrome) instead of making its own. A same-tab, client-side navigation keeps this
 * module, and the element, alive. Harmless elsewhere: in Chrome the element is merely a video
 * the room uses.
 *
 * Feasible with hls.js: attachMedia takes any element, and the native-HLS path only sets src.
 * The well-known pattern (Howler's unlocked HTML5 audio pool) reuses unlocked elements with a
 * new src the same way. lib/autoplay-sound.ts is the decision it feeds. */

let primed: HTMLVideoElement | null = null;
let primedOk = false;

/** Inside a tap or key handler: make the spare element, played once with sound. */
export function primeMediaElement(): void {
  if (primed || typeof document === "undefined") return;
  const video = document.createElement("video");
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "true");
  const url = URL.createObjectURL(new Blob([silentWav(0.2)], { type: "audio/wav" }));
  video.src = url;
  video.muted = false;
  primed = video;
  primedOk = false;
  try {
    // load() inside the tap is what lifts Safari's gesture restriction on this element;
    // play() with sound is the part that proves it.
    video.load();
    video.play().then(
      () => {
        primedOk = true;
        video.pause();
        URL.revokeObjectURL(url);
      },
      () => {
        // Refused even in a tap (an in-app browser, say): the room makes its own element.
        if (primed === video) primed = null;
        URL.revokeObjectURL(url);
      },
    );
  } catch {
    primed = null;
    URL.revokeObjectURL(url);
  }
}

/** The unlocked element, once: the room's player takes it instead of making a new one. */
export function takePrimedVideo(): HTMLVideoElement | null {
  const video = primedOk ? primed : null;
  if (video) {
    primed = null;
    primedOk = false;
    video.removeAttribute("src");
  }
  return video;
}

/** Prime on this page's first tap or key (capture phase, before any handler can navigate):
 *  the webinar's page, where Join is pressed, and the room's gate. */
export function usePrimeMediaOnGesture(): void {
  useEffect(() => {
    // pointerup and touchend, not pointerdown: a touch's pointerdown is not a user
    // activation, so a play() there is refused on a phone.
    const events = ["pointerup", "touchend", "keydown"] as const;
    const prime = () => {
      primeMediaElement();
      if (primed) for (const e of events) document.removeEventListener(e, prime, true);
    };
    for (const e of events) document.addEventListener(e, prime, true);
    return () => {
      for (const e of events) document.removeEventListener(e, prime, true);
    };
  }, []);
}
