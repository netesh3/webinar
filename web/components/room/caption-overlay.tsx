"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { ControlsPatch } from "@/lib/api-types";
import { useToast } from "../providers";
import { useRoomUI } from "./context";

/* Live captions.
 *
 * The host's switch, and nobody else's — but it is a SESSION CONTROL, not a flag
 * in the host's own browser. Recognition runs against each speaker's own
 * microphone, so every publisher has to know captions are on; when the switch
 * lived in one tab, a panelist answering a question was never transcribed and the
 * feature looked broken to everyone who was not the host talking.
 *
 * The control reaches the room through LiveKit metadata, the same path chat and
 * polls use, so it also applies to someone who joins ten minutes later and it
 * survives the host reloading. The audience gets no toggle of their own: what
 * stops the captions is the same switch that stops them being produced.
 */

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
  const { realtime, controls } = useRoomUI();
  const on = controls.captionsEnabled;
  const line = realtime.captions;

  /* The line that was mid-air when the switch last came on, so it is not
   * replayed: without this, switching captions off and straight back on flashes
   * whatever was on screen when they went off.
   *
   * Held by identity rather than by timestamp — every packet is a fresh object,
   * so "the one that was already there" is exactly what identity says, and it
   * needs no clock read during render. Adjusted from the previous value here
   * rather than in an effect, which would show the stale line for a frame. */
  const [ignored, setIgnored] = useState<object | null>(null);
  const [wasOn, setWasOn] = useState(on);
  if (wasOn !== on) {
    setWasOn(on);
    if (on) setIgnored(line);
  }

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

  const text = on && line && line !== stale && line !== ignored ? line.text : "";

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
  const { permissions, recording, slug, joinKey, realtime, isHost, controls } = useRoomUI();
  const { notify } = useToast();
  const on = controls.captionsEnabled;
  const [busy, setBusy] = useState(false);

  /* Trouble is reported to whoever it happened to, because it is their machine
   * that has to be fixed — a host cannot grant a panelist's microphone from
   * here. Each distinct problem is said once: the recogniser can fail several
   * times a minute and a toast per failure would bury the room. */
  const told = useRef(new Set<string>());
  const report = useCallback(
    (key: string, message: string) => {
      if (told.current.has(key)) return;
      told.current.add(key);
      notify(message, "error");
    },
    [notify],
  );

  // Runs for every publisher, not just the host: the recogniser only ever hears
  // the microphone it is running next to.
  useCaptionsPublisher(on && permissions.canPublish, slug, joinKey, realtime.sendCaption, report);

  // Renders nothing for the audience, the way RecordButton beside it renders
  // nothing for anyone who may not record. Called after the hooks above so the
  // order is the same on every render.
  if (!isHost) return null;

  async function toggle() {
    setBusy(true);
    try {
      // Written to the API, which persists it and mirrors it into room metadata.
      // Nothing local is set: this button reacts to the same broadcast as every
      // other browser, which is what keeps them in agreement.
      await api.updateControls(slug, { captionsEnabled: !on } satisfies ControlsPatch);
    } catch (err) {
      notify(err instanceof Error ? err.message : "That didn't apply.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={busy}
      aria-label={on ? "Turn captions off for everyone" : "Turn captions on for everyone"}
      onClick={() => void toggle()}
      className={`flex h-10 min-w-10 items-center justify-center rounded-lg px-2 text-[11px] font-semibold disabled:opacity-60 ${
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

/** Errors the recogniser will never recover from on its own. Retrying these is
 *  what turned a denied microphone into a request every 400ms for the rest of
 *  the session, with nothing on screen to say why captions never appeared. */
const FATAL: Record<string, string> = {
  "not-allowed":
    "Captions need microphone access for speech recognition. Allow it in your browser's site settings, then switch captions off and on.",
  "service-not-allowed":
    "This browser has speech recognition turned off, so your speech can't be captioned.",
  "language-not-supported": "Speech recognition doesn't support this language.",
};

/** Consecutive failures with nothing recognised in between before giving up.
 *  A recogniser that cannot start is not going to start on the ninth try, and a
 *  loop that never ends is worse than an honest message. */
const MAX_RETRIES = 8;

function useCaptionsPublisher(
  active: boolean,
  slug: string,
  joinKey: string | undefined,
  sendCaption: (text: string) => Promise<void>,
  report: (key: string, message: string) => void,
) {
  // Through refs so a new callback identity does not tear down a running
  // recogniser and lose the sentence in progress.
  const send = useRef(sendCaption);
  useEffect(() => {
    send.current = sendCaption;
  }, [sendCaption]);
  const trouble = useRef(report);
  useEffect(() => {
    trouble.current = report;
  }, [report]);

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
    if (!Speech) {
      /* Silent before this. The button lit up, no recogniser existed, and nobody
       * was told — which is most of "captions are not coming". Firefox has it
       * behind a flag and Chromium builds without Google's speech keys do
       * nothing at all, not even raise an error. */
      trouble.current(
        "unsupported",
        "This browser can't do live captions. Chrome, Edge or Safari can.",
      );
      return;
    }

    const rec = new Speech();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    let stopped = false;
    let restart: ReturnType<typeof setTimeout> | undefined;
    let last = "";
    let lastPersistedAt = 0;
    let failures = 0;

    rec.onresult = (ev: SpeechRecognitionEventLike) => {
      // Something came back, so whatever went wrong before has passed.
      failures = 0;
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
     * toggle actually goes off.
     *
     * The delay backs off, because the failures that repeat are the ones no delay
     * fixes, and start() throwing must reschedule rather than fall through: a bare
     * catch here left the recogniser dead for the rest of the session, since no
     * further `end` event could arrive to try again. */
    const revive = () => {
      if (stopped) return;
      clearTimeout(restart);
      if (failures >= MAX_RETRIES) {
        trouble.current(
          "gave-up",
          "Speech recognition keeps dropping, so captions have stopped. Switching captions off and on will try again.",
        );
        return;
      }
      const wait = Math.min(8_000, 400 * 2 ** Math.max(0, failures - 1));
      restart = setTimeout(() => {
        if (stopped) return;
        try {
          rec.start();
        } catch {
          // Already running: start() throws rather than no-oping. Also thrown when
          // the previous session has not finished closing, which is recoverable —
          // so count it and come back rather than giving up here.
          failures++;
          revive();
        }
      }, wait);
    };

    rec.onend = () => {
      failures++;
      revive();
    };
    rec.onerror = (ev: SpeechRecognitionErrorLike) => {
      const fatal = FATAL[ev?.error ?? ""];
      if (fatal) {
        stopped = true;
        clearTimeout(restart);
        trouble.current(ev.error, fatal);
        return;
      }
      if (ev?.error === "network") {
        trouble.current(
          "network",
          "Speech recognition couldn't reach its service, so captions may be patchy.",
        );
      }
      failures++;
      revive();
    };

    try {
      rec.start();
    } catch {
      failures++;
      revive();
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
  onerror: ((ev: SpeechRecognitionErrorLike) => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: { length: number; [i: number]: { 0: { transcript: string } } };
};

type SpeechRecognitionErrorLike = { error: string };
