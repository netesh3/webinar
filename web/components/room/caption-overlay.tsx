"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { useRoomUI } from "./context";

/* Live captions.
 *
 * Off until somebody asks for them, for everyone including the host. Captions are
 * a recording of what people said, published to the room — turning that on is a
 * decision, not a default, and on the publisher's side the toggle is also what
 * opens the microphone stream to speech recognition.
 *
 * Module state rather than context because the control bar button and the overlay
 * sit in different subtrees of the room and both need the same answer.
 */

let captionsVisible = false;
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

export function setShowCaptions(on: boolean) {
  captionsVisible = on;
  listeners.forEach((fn) => fn());
}

/** How long a caption stays up after the last packet for it.
 *
 *  Without this the final sentence of every answer hangs over the stage until
 *  somebody speaks again — which reads as the captions having frozen rather than
 *  the room having gone quiet. Scaled by length so a long line is not pulled away
 *  mid-read. */
function holdMs(text: string): number {
  return Math.min(12_000, 2_500 + text.length * 55);
}

export function CaptionOverlay() {
  const { realtime } = useRoomUI();
  const on = useShowCaptions();
  const line = realtime.captions;
  const [text, setText] = useState("");

  // Held locally, and cleared on a timer, so the overlay empties when the talking
  // stops. `line` is a fresh object per packet, so re-running on it also restarts
  // the countdown for a caption that is still being revised.
  useEffect(() => {
    if (!line?.text) return;
    setText(line.text);
    const timer = setTimeout(() => setText(""), holdMs(line.text));
    return () => clearTimeout(timer);
  }, [line]);

  // Toggling off should clear immediately, not leave the last line to expire
  // behind the scenes and reappear on the next toggle.
  useEffect(() => {
    if (!on) setText("");
  }, [on]);

  if (!on || !text) return null;

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
  const { permissions, recording, slug, joinKey, realtime } = useRoomUI();
  useCaptionsPublisher(on && permissions.canPublish, slug, joinKey, realtime.sendCaption);

  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? "Turn captions off" : "Turn captions on"}
      onClick={() => setShowCaptions(!on)}
      className={`flex h-10 min-w-10 items-center justify-center rounded-lg px-2 text-[11px] font-semibold ${
        on ? "bg-brand-soft text-brand" : "text-ink-3 hover:bg-white/10 hover:text-white"
      }`}
      title={
        on && recording
          ? "Captions are on. This session is being recorded."
          : on
            ? "Captions are on"
            : "Captions are off"
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
