"use client";

import { ConnectionState, RoomEvent, Track, type RemoteAudioTrack, type RemoteParticipant, type Room } from "livekit-client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { softLimitCurve } from "./noise-suppression-policy";
import {
  BOOST_HEADROOM,
  BOOST_MIN,
  HEALTHY,
  boostBlocker,
  clampBoost,
  isIOSLike,
  judgeBoost,
  readSource,
  rendererVolume,
  talking,
  type BoostBlocker,
  type BoostHealth,
  type StreamReading,
} from "./volume-boost-policy";

/* The attendee volume boost: up to 200% on everything the room plays, for somebody whose
 * host is too quiet on their speakers. The rules — who gets it, the watchdog, why the
 * elements go to 0 rather than muted — are in lib/volume-boost-policy.ts.
 *
 * Three parts:
 *   - a small store the settings panel reads and writes (the slider);
 *   - the graph: every remote audio track → one gain → a soft limiter → the speakers;
 *   - useVolumeBoostEngine, mounted by the live room, which decides whether the boost may
 *     run, runs it, watches it, and returns the volume for RoomAudioRenderer.
 *
 * Nothing is created until somebody moves the slider above 100%, and back at 100% the graph
 * is gone and the elements play at 1 exactly as before.
 */

// ------------------------------------------------------------------ store

type BoostState = {
  /** The live room has mounted the engine. The slider is hidden otherwise (the large-audience
   *  HLS rooms have no engine). */
  mounted: boolean;
  level: number;
  blocker: BoostBlocker | null;
  /** The slider has been above 100% since the room mounted: from then on RoomAudioRenderer is
   *  given an explicit 1 rather than undefined (see rendererVolume). */
  everBoosted: boolean;
};

let state: BoostState = { mounted: false, level: BOOST_MIN, blocker: null, everBoosted: false };
const listeners = new Set<() => void>();
function setState(next: Partial<BoostState>): void {
  const merged = { ...state, ...next };
  if (
    merged.mounted === state.mounted &&
    merged.level === state.level &&
    merged.blocker === state.blocker &&
    merged.everBoosted === state.everBoosted
  ) {
    return;
  }
  state = merged;
  for (const l of listeners) l();
}
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const read = () => state;
const SERVER_STATE: BoostState = { mounted: false, level: BOOST_MIN, blocker: null, everBoosted: false };
const readOnServer = () => SERVER_STATE;

/** Set once the boost has failed in this page: not offered again until a reload. */
let failedThisPage = false;

/* The context, made inside the slider's own input event. Chrome lets a context start any
 * time after the page has had a gesture, Safari only from inside one; creating and resuming
 * it synchronously here satisfies both. */
let ctx: AudioContext | null = null;
function primeContext(): void {
  if (typeof AudioContext === "undefined") return;
  if (!ctx || ctx.state === "closed") {
    try {
      // The default ("interactive") latency: a larger playback buffer would put the room's
      // sound behind its video.
      ctx = new AudioContext();
    } catch {
      ctx = null;
      return;
    }
    ctx.addEventListener("statechange", notifyContext);
    notifyContext();
  }
  void ctx.resume().catch(() => {});
}

/* Whether the context is running, as a store: the engine reads it rather than mirroring it
 * into React state from an effect. */
const contextListeners = new Set<() => void>();
function notifyContext(): void {
  for (const l of contextListeners) l();
}
const subscribeContext = (cb: () => void) => {
  contextListeners.add(cb);
  return () => contextListeners.delete(cb);
};
const readContextRunning = () => ctx?.state === "running";
const readContextRunningOnServer = () => false;

function closeContext(): void {
  const c = ctx;
  ctx = null;
  if (c && c.state !== "closed") {
    c.removeEventListener("statechange", notifyContext);
    void c.close().catch(() => {});
  }
  notifyContext();
}

/** The slider's side: what to show, and how to change it. */
export function useVolumeBoost(): BoostState & { setLevel: (v: number) => void } {
  const s = useSyncExternalStore(subscribe, read, readOnServer);
  const setLevel = useCallback((v: number) => {
    const level = clampBoost(v);
    // Inside the input event: see primeContext.
    if (level > BOOST_MIN) primeContext();
    setState(level > BOOST_MIN ? { level, everBoosted: true } : { level });
  }, []);
  return { ...s, setLevel };
}

// ------------------------------------------------------------------ graph

/** The sources RoomAudioRenderer plays: the same set, so the boost covers exactly what is
 *  heard. */
const SOURCES = new Set<Track.Source>([Track.Source.Microphone, Track.Source.ScreenShareAudio, Track.Source.Unknown]);

type Stream = { track: RemoteAudioTrack; participant: RemoteParticipant };

function remoteAudioStreams(room: Room): Stream[] {
  const out: Stream[] = [];
  room.remoteParticipants.forEach((participant) => {
    participant.audioTrackPublications.forEach((pub) => {
      // Audio publications carry audio tracks; the map is typed with the general RemoteTrack.
      if (pub.isSubscribed && pub.track && SOURCES.has(pub.source)) {
        out.push({ track: pub.track as RemoteAudioTrack, participant });
      }
    });
  });
  return out;
}

type Input = { node: MediaStreamAudioSourceNode; meter: AnalyserNode; buf: Float32Array<ArrayBuffer> };

/** Exported so the graph can be checked in a real browser against a live WebRTC stream. */
export class BoostGraph {
  private readonly gain: GainNode;
  private readonly shaper: WaveShaperNode;
  private readonly inputs = new Map<MediaStreamTrack, Input>();
  private started = false;

  constructor(private readonly context: AudioContext) {
    this.gain = context.createGain();
    // Silent until setLevel: the elements have gone down to 0 by then.
    this.gain.gain.value = 0;
    this.shaper = context.createWaveShaper();
    // Exactly `gain` below the knee, a soft roll-off above it, never full scale: the same
    // limiter the presenter's own leveller uses (lib/noise-suppression-policy.ts).
    this.shaper.curve = softLimitCurve(BOOST_HEADROOM);
    this.gain.connect(this.shaper);
    this.shaper.connect(context.destination);
  }

  /** Makes the graph's inputs exactly these tracks, each with its own meter so the watchdog
   *  can tell one speaker's missing audio from another's being there. */
  sync(tracks: MediaStreamTrack[]): void {
    const want = new Set(tracks.filter((t) => t.readyState === "live"));
    for (const [t, input] of this.inputs) {
      if (want.has(t)) continue;
      input.node.disconnect();
      input.meter.disconnect();
      this.inputs.delete(t);
    }
    for (const t of want) {
      if (this.inputs.has(t)) continue;
      try {
        const node = this.context.createMediaStreamSource(new MediaStream([t]));
        const meter = this.context.createAnalyser();
        meter.fftSize = 2048;
        node.connect(this.gain);
        node.connect(meter);
        this.inputs.set(t, { node, meter, buf: new Float32Array(meter.fftSize) });
      } catch {
        // A track this browser will not take: the watchdog sees that speaker go missing.
      }
    }
  }

  /** The level: at once the first time (the elements have just gone to 0, and a fade-in would
   *  be a dip), gliding after that, as the slider moves. */
  setLevel(level: number): void {
    // The curve multiplies by BOOST_HEADROOM back; see softLimitCurve.
    const value = level / BOOST_HEADROOM;
    const now = this.context.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    if (this.started) this.gain.gain.setTargetAtTime(value, now, 0.05);
    else this.gain.gain.setValueAtTime(value, now);
    this.started = true;
  }

  /** Silent at once: the elements are coming back up to 1 in this same commit, and a fade
   *  here would play both together, louder than either. */
  cut(): void {
    const now = this.context.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(0, now);
  }

  /** RMS of one track's audio as it reaches the graph; 0 for a track not in it. */
  inputRms(track: MediaStreamTrack): number {
    const input = this.inputs.get(track);
    if (!input) return 0;
    input.meter.getFloatTimeDomainData(input.buf);
    let sum = 0;
    for (let i = 0; i < input.buf.length; i++) sum += input.buf[i] * input.buf[i];
    return Math.sqrt(sum / input.buf.length);
  }

  destroy(): void {
    for (const input of this.inputs.values()) {
      input.node.disconnect();
      input.meter.disconnect();
    }
    this.inputs.clear();
    this.gain.disconnect();
    this.shaper.disconnect();
  }
}

/** The loudest source on a receiver right now, as the browser reports it — or, where none
 *  carries a level, any source, for its RTP timestamp (see readSource). Exported for the browser
 *  check. */
export function loudestSource(receiver: RTCRtpReceiver | undefined): { audioLevel?: number; rtpTimestamp?: number } | undefined {
  let best: RTCRtpSynchronizationSource | undefined;
  for (const s of receiver?.getSynchronizationSources?.() ?? []) {
    if (!best) best = s;
    else if (typeof s.audioLevel === "number" && s.audioLevel > (best.audioLevel ?? -1)) best = s;
  }
  return best;
}

function boostSupported(): boolean {
  return (
    typeof AudioContext !== "undefined" &&
    typeof RTCRtpReceiver !== "undefined" &&
    typeof RTCRtpReceiver.prototype.getSynchronizationSources === "function"
  );
}

function contextSinkSupported(): boolean {
  return typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;
}

/** How often the watchdog compares the network with the graph. */
const WATCH_MS = 1000;

// ------------------------------------------------------------------ engine

/**
 * Runs the boost for the live room and returns the volume for RoomAudioRenderer.
 *
 * `publisher` is anyone with a microphone (canPublish or canSpeak); `lockScreen` is the
 * Android keep-alive owning the element volume; `speakerId` is the chosen output device ("" or
 * undefined for the system default).
 */
export function useVolumeBoostEngine(
  room: Room,
  o: { publisher: boolean; lockScreen: boolean; speakerId?: string },
): number | undefined {
  const { level, everBoosted } = useSyncExternalStore(subscribe, read, readOnServer);
  const contextRunning = useSyncExternalStore(subscribeContext, readContextRunning, readContextRunningOnServer);
  const [ios] = useState(
    () => typeof navigator !== "undefined" && isIOSLike(navigator.userAgent, navigator.maxTouchPoints ?? 0),
  );
  const [supported] = useState(() => typeof window !== "undefined" && boostSupported());
  const [failed, setFailed] = useState(() => failedThisPage);
  const [sinkFailed, setSinkFailed] = useState(false);
  // The speaker the context was last moved to, once that move has landed.
  const [sinkSet, setSinkSet] = useState<string | null>(null);
  const speakerChosen = !!o.speakerId && o.speakerId !== "default";

  const blocker = boostBlocker({
    publisher: o.publisher,
    ios,
    lockScreen: o.lockScreen,
    speakerChosen,
    contextSinkSupported: contextSinkSupported() && !sinkFailed,
    supported,
    failed,
  });
  const want = blocker === null && level > BOOST_MIN;
  // With a speaker chosen, not before the context plays to it: boosted audio must not come
  // out of a different device first.
  const sinkReady = !speakerChosen || sinkSet === o.speakerId;
  // Not running means not boosting: the elements go straight back to 1, so a context the
  // browser stopped is never silence.
  const active = want && contextRunning && sinkReady;

  // The store, for the settings panel. A blocker takes the level back to 100%: promoted to
  // the stage, a speaker chosen that the boost cannot reach, a failure.
  useEffect(() => {
    setState({ mounted: true, blocker, ...(blocker !== null ? { level: BOOST_MIN } : {}) });
  }, [blocker]);
  useEffect(
    () => () => {
      setState({ mounted: false, level: BOOST_MIN, blocker: null, everBoosted: false });
      closeContext();
    },
    [],
  );

  // The context, while wanted: started (normally already, by the slider's own gesture) and
  // brought back with the page if a phone stopped it. Idle otherwise — suspended, not closed,
  // so the next move of the slider resumes it inside its own gesture.
  useEffect(() => {
    if (!want) {
      if (ctx && ctx.state === "running") void ctx.suspend().catch(() => {});
      return;
    }
    if (!ctx) primeContext();
    const c = ctx;
    if (!c) return;
    if (c.state !== "running") void c.resume().catch(() => {});
    const onVisible = () => {
      if (document.visibilityState === "visible" && c.state !== "running" && c.state !== "closed") {
        void c.resume().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [want]);

  // The speaker: the context plays where the elements would. A browser that cannot follow a
  // chosen speaker never gets this far (blocker "speaker").
  useEffect(() => {
    const c = ctx;
    if (!want || !c || !contextSinkSupported()) return;
    const target = speakerChosen ? (o.speakerId as string) : "";
    const sink = (c as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId;
    void sink.call(c, target).then(
      () => setSinkSet(target),
      () => setSinkFailed(true),
    );
  }, [want, contextRunning, speakerChosen, o.speakerId]);

  // The graph, while boosting: built, fed every remote audio track, watched. Its gain starts
  // at 0 and rises to the level only once this render has turned the elements down to 0 (the
  // effect below), so the two never play together at full strength.
  const graph = useRef<BoostGraph | null>(null);
  useEffect(() => {
    const c = ctx;
    if (!active || !c) return;
    const g = new BoostGraph(c);
    graph.current = g;
    const resync = () => g.sync(remoteAudioStreams(room).map((st) => st.track.mediaStreamTrack));
    resync();
    const events = [
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.Reconnected,
      RoomEvent.Connected,
    ] as const;
    for (const e of events) room.on(e, resync);

    let health: BoostHealth = HEALTHY;
    // Each stream's RTP timestamp at the previous check, so a stream that stopped arriving is
    // "can't tell", not speech (readSource).
    let lastRtp = new Map<MediaStreamTrack, number>();
    const watch = setInterval(() => {
      resync();
      const nextRtp = new Map<MediaStreamTrack, number>();
      const readings: StreamReading[] = remoteAudioStreams(room).map(({ track, participant }) => {
        const mst = track.mediaStreamTrack;
        const src = loudestSource(track.receiver);
        if (typeof src?.rtpTimestamp === "number") nextRtp.set(mst, src.rtpTimestamp);
        return {
          talking: talking(readSource(src, lastRtp.get(mst)), participant.isSpeaking),
          rms: g.inputRms(mst),
        };
      });
      lastRtp = nextRtp;
      health = judgeBoost(health, readings, room.state === ConnectionState.Connected);
      if (health.verdict === "failed") {
        console.warn("[volume boost] speech on the network but none in the boost; back to normal playback");
        failedThisPage = true;
        setFailed(true);
      }
    }, WATCH_MS);

    return () => {
      clearInterval(watch);
      for (const e of events) room.off(e, resync);
      if (graph.current === g) graph.current = null;
      g.cut();
      g.destroy();
    };
  }, [active, room]);

  // The level, on the graph this commit built (or the live one when only the level moved).
  useEffect(() => {
    if (active) graph.current?.setLevel(level);
  }, [active, level]);

  return rendererVolume({ active, everActive: everBoosted });
}
