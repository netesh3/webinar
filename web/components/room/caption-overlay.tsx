"use client";

import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { useRoomUI } from "./context";

let captionsVisible = true;
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
    () => true,
  );
}

export function setShowCaptions(on: boolean) {
  captionsVisible = on;
  listeners.forEach((fn) => fn());
}

export function CaptionOverlay() {
  const { realtime } = useRoomUI();
  const on = useShowCaptions();
  const line = realtime.captions;
  if (!on || !line?.text) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-16 z-20 flex justify-center px-4 sm:bottom-20">
      <p className="max-w-xl rounded-md bg-black/70 px-3 py-1.5 text-center text-[13px] leading-snug text-white">
        {line.text}
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
      aria-label={on ? "Hide captions" : "Show captions"}
      onClick={() => setShowCaptions(!on)}
      className={`flex h-10 min-w-10 items-center justify-center rounded-lg px-2 text-[11px] font-semibold ${
        on ? "bg-brand-soft text-brand" : "text-ink-3 hover:bg-white/10 hover:text-white"
      }`}
      title={
        recording && on
          ? "Captions are on. This session is being recorded."
          : "Captions"
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
    let last = "";
    let lastAt = 0;
    rec.onresult = (ev: SpeechRecognitionEventLike) => {
      let text = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        text += ev.results[i][0].transcript;
      }
      const clean = text.trim();
      if (!clean || clean === last) return;
      last = clean;
      void sendCaption(clean);
      const now = Date.now();
      if (now - lastAt > 2500) {
        lastAt = now;
        void api.appendCaption(slug, { joinKey, text: clean }).catch(() => undefined);
      }
    };
    rec.onerror = () => undefined;
    try {
      rec.start();
    } catch {
      return;
    }
    return () => {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    };
  }, [active, joinKey, sendCaption, slug]);
}

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: { length: number; [i: number]: { 0: { transcript: string } } };
};
