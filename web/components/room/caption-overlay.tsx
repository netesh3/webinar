"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Track } from "livekit-client";
import { useLocalParticipant } from "@livekit/components-react";
import { api } from "@/lib/api";
import type { ControlsPatch } from "@/lib/api-types";
import { useLocalCaptions } from "@/lib/local-captions";
import { useToast } from "../providers";
import { useRoomUI } from "./context";

/* Live captions.
 *
 * The host's switch, and nobody else's — but it is a SESSION CONTROL, not a flag
 * in the host's own browser. Recognition runs against each speaker's own
 * microphone (Whisper tiny.en, in this tab — not a cloud speech API), so every
 * publisher has to know captions are on; when the switch
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
    (key: string, message: string, tone: "error" | "info" = "error") => {
      if (told.current.has(key)) return;
      told.current.add(key);
      notify(message, tone);
    },
    [notify],
  );

  const { localParticipant } = useLocalParticipant();
  const mic = localParticipant.getTrackPublication(Track.Source.Microphone)
    ?.audioTrack?.mediaStreamTrack;

  // Runs for every publisher, not just the host: Whisper only ever hears the
  // microphone published from this tab.
  useLocalCaptions({
    active: on && permissions.canPublish,
    track: mic,
    slug,
    joinKey,
    send: realtime.sendCaption,
    report,
  });

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
