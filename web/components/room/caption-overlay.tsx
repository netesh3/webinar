"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { useRoomUI } from "./context";

/* Live captions.
 *
 * The host's switch, and nobody else's. Captions are a transcript of what was
 * said, broadcast to the room and written to the session record — that is the
 * host's call to make, the same as recording, and an audience member has nothing
 * to turn on anyway: the recogniser runs against the speaker's own microphone, so
 * a viewer enabling it would transcribe their living room into the webinar.
 *
 * Off until the host asks for it. The audience then sees whatever arrives, with
 * no toggle of their own, because the switch that stops the captions is the same
 * one that stops them being produced.
 *
 * Module state rather than context because the control bar button and the overlay
 * sit in different subtrees of the room and both need the same answer.
 */

let captionsVisible = false;
/** When they were last switched on, so lines from before that are not replayed.
 *  Without it, switching off and straight back on flashes whatever was mid-air. */
let visibleSince = 0;
const listeners = new Set<() => void>();

function subscribeCaptions(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useShowCaptions() {
  return useSyncExternalStore(
    subscribeCaptions,
    () => captionsVisible,
    () => false,
  );
}

function useCaptionsSince() {
  return useSyncExternalStore(
    subscribeCaptions,
    () => visibleSince,
    () => 0,
  );
}

export function setShowCaptions(on: boolean) {
  captionsVisible = on;
  if (on) visibleSince = Date.now();
  listeners.forEach((fn) => fn());
}

/** How long a caption stays up after the last packet for it.
 *
 *  Without this the final sentence of every answer hangs over the stage until
 *  somebody speaks again — which reads as the captions having frozen rather than
 *  the room having gone quiet. Scaled by length so a long line is not pulled away
 *  mid-read, and capped low enough that the audience's last line clears promptly
 *  once the host switches captions off. */
function holdMs(text: string): number {
  return Math.min(8_000, 2_500 + text.length * 55);
}

export function CaptionOverlay() {
  const { realtime, isHost } = useRoomUI();
  const on = useShowCaptions();
  const since = useCaptionsSince();
  const line = realtime.captions;

  /* Expiry is state, and what is on screen is derived from it.
   *
   * The other way round — copying the line into state and clearing it on a timer
   * — means writing state the moment a caption arrives, which is a render for the
   * packet and another for the copy, on every interim result of every sentence.
   * Holding only "which line has timed out" keeps the timer as the sole writer,
   * and the timer fires once per line. */
  const [stale, setStale] = useState<object | null>(null);
  useEffect(() => {
    if (!line?.text) return;
    // `line` is a fresh object per packet, so a caption still being revised
    // restarts its own countdown instead of vanishing mid-sentence.
    const timer = setTimeout(() => setStale(line), holdMs(line.text));
    return () => clearTimeout(timer);
  }, [line]);

  // Only the host has a switch. Everyone else has nothing to gate on: captions
  // reaching them at all means the host has them on, and switching off stops the
  // packets, so their last line times out on its own.
  const text =
    line && line !== stale && (!isHost || (on && line.at >= since)) ? line.text : "";

  if (!text) return null;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-20 z-30 flex justify-center px-4 sm:bottom-24"
      aria-live="polite"
      aria-atomic="true"
    >
      <p
        // Sized and spaced like a caption track rather than body copy: broadcast
        // captions are read at a glance from across a room, and the 13px chip this
        // replaced was smaller than the chat it was competing with.
        className="max-w-[min(100%,46rem)] rounded-xl bg-black/80 px-4 py-2.5 text-center text-[16px] leading-[1.45] font-medium tracking-[0.005em] text-white shadow-lg backdrop-blur-sm [text-wrap:pretty] sm:text-[19px] sm:leading-[1.5]"
        style={{ textShadow: "0 1px 2px rgb(0 0 0 / 0.6)" }}
      >
        {text}
      </p>
    </div>
  );
}

export function CaptionsBarButton() {
  const on = useShowCaptions();
  const { permissions, recording, slug, joinKey, realtime, isHost } = useRoomUI();
  useCaptionsPublisher(
    on && isHost && permissions.canPublish,
    slug,
    joinKey,
    realtime.sendCaption,
  );

  // Renders nothing for the audience, the way RecordButton beside it renders
  // nothing for anyone who may not record. Called after the hooks above so the
  // order is the same on every render.
  if (!isHost) return null;

  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? "Turn captions off for everyone" : "Turn captions on for everyone"}
      onClick={() => setShowCaptions(!on)}
      className={`flex h-10 min-w-10 items-center justify-center rounded-lg px-2 text-[11px] font-semibold ${
        on ? "bg-brand-soft text-brand" : "text-ink-3 hover:bg-white/10 hover:text-white"
      }`}
      title={
        on && recording
          ? "Captions are on for everyone. This session is being recorded."
          : on
            ? "Captions are on for everyone"
            : "Turn on captions for everyone"
      }
    >
      CC
    </button>
  );
}

function useCaptionsPublisher(
  active: boolean,
  slug: string,
  joinKey: string | undefined,
  sendCaption: (text: string) => Promise<void>,
) {
  // Through a ref so a new callback identity does not tear down a running
  // recogniser and lose the sentence in progress.
  const send = useRef(sendCaption);
  useEffect(() => {
    send.current = sendCaption;
  }, [sendCaption]);

  useEffect(() => {
    if (!active) return;
    const Speech =
      typeof window !== "undefined"
        ? ((window as unknown as {
            SpeechRecognition?: new () => SpeechRecognitionLike;
            webkitSpeechRecognition?: new () => SpeechRecognitionLike;
          }).SpeechRecognition ??
          (window as unknown as {
            webkitSpeechRecognition?: new () => SpeechRecognitionLike;
          }).webkitSpeechRecognition)
        : undefined;
    if (!Speech) return;

    const rec = new Speech();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    let stopped = false;
    let restart: ReturnType<typeof setTimeout> | undefined;
    let last = "";
    let lastPersistedAt = 0;

    rec.onresult = (ev: SpeechRecognitionEventLike) => {
      let text = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        text += ev.results[i][0].transcript;
      }
      const clean = text.trim();
      if (!clean || clean === last) return;
      last = clean;
      void send.current(clean);
      const now = Date.now();
      if (now - lastPersistedAt > 2500) {
        lastPersistedAt = now;
        void api.appendCaption(slug, { joinKey, text: clean }).catch(() => undefined);
      }
    };

    /* Chrome ends a continuous session on its own — after a stretch of silence, and
     * on a `no-speech` error — and does not come back by itself. That is the whole
     * of "captions worked for a minute and then froze": the recogniser was gone
     * while the button still said CC was on. Restarting keeps it alive until the
     * toggle actually goes off. */
    const revive = () => {
      if (stopped) return;
      clearTimeout(restart);
      restart = setTimeout(() => {
        if (stopped) return;
        try {
          rec.start();
        } catch {
          /* Already running: start() throws rather than no-oping. */
        }
      }, 400);
    };
    rec.onend = revive;
    rec.onerror = revive;

    try {
      rec.start();
    } catch {
      return;
    }

    return () => {
      stopped = true;
      clearTimeout(restart);
      rec.onend = null;
      rec.onerror = null;
      rec.onresult = null;
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    };
  }, [active, joinKey, slug]);
}

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: { length: number; [i: number]: { 0: { transcript: string } } };
};
