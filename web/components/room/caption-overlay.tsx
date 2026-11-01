"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Track } from "livekit-client";
import { useLocalParticipant } from "@livekit/components-react";
import { api } from "@/lib/api";
import type { ControlsPatch } from "@/lib/api-types";
import { captionEngine, captionsStatus } from "@/lib/ai-session";
import {
  edgeHoldMs,
  getEdgeVideoDelay,
  subscribeEdgeVideoDelay,
  type CaptionLine,
} from "@/lib/caption-sync";
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
 *
 * Where the server caption agent is deployed (deploy/captions) the host's switch
 * asks for it first, and while it reports itself live (controls.serverCaptions)
 * the browsers stop recognising: the lines arrive as the same "caption" packets,
 * from the server, so this overlay does not know the difference. On-device
 * Whisper stays as the fallback whenever server captions are not live.
 */

/** How long a caption stays up after the last packet for it.
 *
 *  Without this the final sentence of every answer hangs over the stage until
 *  somebody speaks again — which reads as the captions having frozen rather than
 *  the room having gone quiet. Scaled by length so a long line is not pulled away
 *  mid-read, and capped low enough that the audience's last line clears promptly
 *  once the host switches captions off. */
function holdMs(line: CaptionLine): number {
  // Interim text is refreshed every second or so and replaced by its final: if neither
  // comes, it was noise, and it should not hang about as long as a real line.
  if (line.partial) return 3_000;
  return Math.min(8_000, 2_500 + line.text.length * 55);
}

const noDelay = () => null;

/* An edge viewer's video is seconds behind the room; their captions are not. Each line is
 * held until the video reaches it (lib/caption-sync.ts edgeHoldMs), each on its own timer —
 * a newer line arriving does not cancel an older one still due, so interim text grows in
 * step with the video. Everywhere else (no edge player measuring) lines show on arrival. */
function useVideoSyncedCaption(line: CaptionLine | null): CaptionLine | null {
  const delaySec = useSyncExternalStore(subscribeEdgeVideoDelay, getEdgeVideoDelay, noDelay);
  const [held, setHeld] = useState<CaptionLine | null>(null);
  const delayRef = useRef(delaySec);
  useEffect(() => {
    delayRef.current = delaySec;
  }, [delaySec]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    if (!line || delayRef.current == null) return;
    const pending = timers.current;
    const timer = setTimeout(() => {
      pending.delete(timer);
      // Never step back to an older line than the one showing.
      setHeld((current) => (current && current.at > line.at ? current : line));
    }, edgeHoldMs(delayRef.current, line.lagMs));
    pending.add(timer);
  }, [line]);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, []);
  return delaySec == null ? line : held;
}

export function CaptionOverlay() {
  const { realtime, controls } = useRoomUI();
  const on = controls.captionsEnabled;
  const line = useVideoSyncedCaption(realtime.captions);

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
    const timer = setTimeout(() => setStale(line), holdMs(line));
    return () => clearTimeout(timer);
  }, [line]);

  const text = on && line && line !== stale && line !== ignored ? line.text : "";
  // Interim text (the server's guess at a line still being spoken) is a shade lighter,
  // and settles to full white when its final replaces it, in the same box, so nothing jumps.
  const interim = Boolean(line?.partial);

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
        data-interim={interim || undefined}
        className={`max-w-[min(100%,46rem)] rounded-xl bg-black/80 px-4 py-2.5 text-center text-[16px] leading-[1.45] font-medium tracking-[0.005em] shadow-lg backdrop-blur-sm transition-colors duration-200 [text-wrap:pretty] sm:text-[19px] sm:leading-[1.5] ${interim ? "text-white/75" : "text-white"}`}
        style={{ textShadow: "0 1px 2px rgb(0 0 0 / 0.6)" }}
      >
        {text}
      </p>
    </div>
  );
}

/** Keeps on-device recognition running for every publisher while captions are
 *  on, or while the room's AI switch wants a transcript (silently: stored for the
 *  AI recap, not shown — lib/ai-session.ts). Mount once in the control bar — not
 *  inside More — so closing the menu never tears the recogniser down. Renders
 *  nothing. */
export function CaptionsSession() {
  const { permissions, slug, joinKey, realtime, controls } = useRoomUI();
  const { notify } = useToast();

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
  // microphone published from this tab. Stands down while the server is
  // captioning the room (controls.serverCaptions: the caption agent on the
  // egress host, English only, has said it is live) and takes over again the
  // moment it is not — switched off, never picked up, or paused because the
  // box needed the CPU for video.
  // One engine for both: captions shown is the same recogniser as the AI's silent
  // capture, with its lines broadcast as well as stored.
  const engine = captionEngine(controls, permissions.canPublish);
  useLocalCaptions({
    active: engine.run,
    display: engine.display,
    track: mic,
    slug,
    joinKey,
    send: realtime.sendCaption,
    report,
  });

  return null;
}

/** Host-only More-menu action. Undefined for everyone else — same gate as
 *  RecordButton: the audience never sees a captions control of their own. */
export function useCaptionsMoreAction():
  | {
      label: string;
      icon: ReactNode;
      active: boolean;
      busy: boolean;
      title: string;
      onClick: () => void;
    }
  | undefined {
  const { recording, slug, isHost, controls, join } = useRoomUI();
  const { notify } = useToast();
  const on = controls.captionsEnabled;
  const [busy, setBusy] = useState(false);
  // Why server captions were not used the last time this switch asked for them.
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const toggle = useCallback(async () => {
    setBusy(true);
    try {
      // Written to the API, which persists it and mirrors it into room metadata.
      // Nothing local is set: this control reacts to the same broadcast as every
      // other browser, which is what keeps them in agreement.
      //
      // On asks for server captions first (English, and no speaker's laptop
      // doing the work). Where none are deployed, the host does not have them,
      // or the agent could not be dispatched, the host is told why and the
      // ordinary switch turns on on-device captions instead. Off is the
      // ordinary switch, which also removes the agent.
      if (!on) {
        try {
          await api.setServerCaptions(slug, { on: true });
          setUnavailable(null);
          return;
        } catch (err) {
          const why = err instanceof Error && err.message ? err.message : "AI Live captions didn't start.";
          setUnavailable(why);
          notify(`${why} Captions are on, made on each speaker's device.`, "info");
        }
      }
      await api.updateControls(slug, { captionsEnabled: !on } satisfies ControlsPatch);
    } catch (err) {
      notify(err instanceof Error ? err.message : "That didn't apply.", "error");
    } finally {
      setBusy(false);
    }
  }, [slug, on, notify]);

  /* Never for a simulive: it plays a recording, nobody speaks into its room, and its CC
   * is the original session's captions. Nor once it carries on live with the host team:
   * the API never sends the caption agent into a simulive's room. */
  if (!isHost || join.simulive || join.simuliveLive) return undefined;

  const status = captionsStatus(controls, recording, unavailable);
  return {
    label: status.label,
    icon: (
      <span className="grid size-5 place-items-center text-[11px] font-semibold leading-none">
        CC
      </span>
    ),
    active: on,
    busy,
    title: status.title,
    onClick: () => void toggle(),
  };
}
