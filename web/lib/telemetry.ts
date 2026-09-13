"use client";

import { useEffect, useRef } from "react";
import {
  ConnectionState,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type LocalTrack,
  type RemoteTrack,
} from "livekit-client";
import type { TelemetryEvent } from "./api-types";
import { API_BASE } from "./api";

/* A temporary telemetry path for one performance-test window — see
 * api/internal/api/telemetry.go for the backend half and why it logs the
 * way it does. Built as a fully independent observer rather than woven into
 * lib/network.ts's own getStats() sampling (which drives real, tuned
 * quality-adaptation decisions) or lib/recovery.ts's retry ladder: this only
 * ever reads state, never changes a decision either of those makes, so it
 * can be deleted — this file, the one hook call in webinar-room.tsx, and
 * the backend endpoint — without touching anything load-bearing.
 *
 * Correction from the original spec worth recording: `room.getStats()` is
 * not a real method — livekit-client exposes stats per RTCRtpSender/Receiver
 * on each track (LocalTrack.sender, RemoteTrack.receiver), the same way
 * lib/network.ts already reads them. And jitterBufferDelay/concealedSamples
 * live on the RECEIVING side's own `inbound-rtp` report, not on
 * `remote-inbound-rtp` (which is the SENDER's view of what the far end
 * reported back, and carries roundTripTime/jitter/packetsLost but not
 * jitter-buffer or concealment stats — those only exist where the audio is
 * actually being played out). This samples both sides correctly instead of
 * asking one report for fields it cannot have.
 */

const QUALITY_POLL_MS = 10_000;
const FLUSH_MS = 10_000;
const MAX_BATCH = 50;
// Jitter/loss thresholds live server-side, in severityFor — the client only
// ever reports raw numbers, so there is exactly one place a WARNING is
// decided rather than two that could disagree.

type Ctx = { userId: string; roomName: string };

let queue: TelemetryEvent[] = [];
let ctxRef: Ctx = { userId: "", roomName: "" };

function push(event: string, payload: Record<string, unknown> = {}): void {
  queue.push({
    event,
    timestamp: Date.now(),
    payload: { userId: ctxRef.userId, roomName: ctxRef.roomName, ...payload },
  });
  if (queue.length >= MAX_BATCH) flush();
}

/** `beacon: true` is for the unload path — sendBeacon survives the page
 *  actually closing, which a normal fetch is not guaranteed to. */
function flush(beacon = false): void {
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  const url = `${API_BASE}/api/telemetry`;
  const body = JSON.stringify(batch);

  if (beacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
    const ok = navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
    if (ok) return;
    // Fall through to fetch if the beacon queue itself refused it (rare —
    // oversized payload, or the browser out of beacon quota).
  }
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {
    // Best-effort by design: a dropped telemetry batch must never surface to
    // the person in the webinar. See the file comment.
  });
}

type StatsMap = Map<string, Record<string, unknown>>;

async function readStats(target: RTCRtpSender | RTCRtpReceiver | undefined): Promise<StatsMap> {
  if (!target) return new Map();
  try {
    const report = await target.getStats();
    const out: StatsMap = new Map();
    report.forEach((r) => out.set(r.type, r as Record<string, unknown>));
    // getStats() can carry more than one report of the same type (e.g. two
    // remote-inbound-rtp entries during a codec switch); last one wins here,
    // which is fine for a sampled snapshot rather than a precise accounting.
    return out;
  } catch {
    return new Map();
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** One local (published) track's outbound view: our own upload quality, plus
 *  what the far end reports back about receiving it. */
async function sampleLocalTrack(track: LocalTrack): Promise<void> {
  const stats = await readStats(track.sender);
  if (stats.size === 0) return;

  const out = stats.get("outbound-rtp");
  const remoteIn = stats.get("remote-inbound-rtp");
  const payload: Record<string, unknown> = {
    direction: "outbound",
    kind: track.kind,
    source: track.source,
  };
  if (remoteIn) {
    payload.jitterMs = round1(num(remoteIn.jitter) ? num(remoteIn.jitter)! * 1000 : undefined);
    payload.roundTripTimeMs = round1(
      num(remoteIn.roundTripTime) ? num(remoteIn.roundTripTime)! * 1000 : undefined,
    );
    payload.packetsLost = num(remoteIn.packetsLost);
  }
  if (out) {
    payload.frameWidth = num(out.frameWidth);
    payload.frameHeight = num(out.frameHeight);
    payload.framesPerSecond = num(out.framesPerSecond);
    payload.qualityLimitationReason = out.qualityLimitationReason ?? "none";
  }
  push("quality_sample", payload);
}

/** One remote (subscribed) track's inbound view: what we are actually
 *  receiving and playing — the side that carries jitter buffer and
 *  concealment stats, since those only exist where audio is played out. */
async function sampleRemoteTrack(track: RemoteTrack): Promise<void> {
  const stats = await readStats(track.receiver);
  if (stats.size === 0) return;

  const inb = stats.get("inbound-rtp");
  if (!inb) return;
  const payload: Record<string, unknown> = {
    direction: "inbound",
    kind: track.kind,
    source: track.source,
    jitterMs: round1(num(inb.jitter) ? num(inb.jitter)! * 1000 : undefined),
    packetsLost: num(inb.packetsLost),
    packetsReceived: num(inb.packetsReceived),
  };
  if (track.kind === Track.Kind.Audio) {
    // Cumulative seconds/count — see lib/network.ts's own readPlayoutMs for
    // the same fields turned into a per-interval delta, which this sampler
    // does not attempt: a raw snapshot is enough for a performance-test log.
    payload.jitterBufferDelaySec = num(inb.jitterBufferDelay);
    payload.jitterBufferEmittedCount = num(inb.jitterBufferEmittedCount);
    payload.concealedSamples = num(inb.concealedSamples);
  } else {
    payload.frameWidth = num(inb.frameWidth);
    payload.frameHeight = num(inb.frameHeight);
    payload.framesPerSecond = num(inb.framesPerSecond);
  }
  push("quality_sample", payload);
}

function round1(v: number | undefined): number | undefined {
  return v === undefined ? undefined : Math.round(v * 10) / 10;
}

async function sampleQuality(room: Room): Promise<void> {
  const local = room.localParticipant;
  for (const pub of local.trackPublications.values()) {
    const track = pub.track;
    if (track) await sampleLocalTrack(track as LocalTrack);
  }
  for (const participant of room.remoteParticipants.values()) {
    for (const pub of participant.trackPublications.values()) {
      const track = pub.track;
      if (track) await sampleRemoteTrack(track as RemoteTrack);
    }
  }
}

/** Attached once per room session. Gate this on AppConfig.telemetryEnabled at
 *  the call site — see webinar-room.tsx — rather than here, so a disabled
 *  flag means this hook is never even called, not called-and-no-oping. */
export function useTelemetry(room: Room | null, ctx: Ctx): void {
  // 0 rather than Date.now(): reading the clock belongs in an effect, not in
  // the render path (React requires renders to stay pure), and the real
  // value is written at the top of the connect effect below before anything
  // reads it.
  const joinStartedAt = useRef(0);
  const reportedJoin = useRef(false);
  const attempts = useRef(0);

  useEffect(() => {
    ctxRef = ctx;
    // Depends on the two primitive fields, not `ctx` itself: the object
    // passed in is a fresh literal every render at the call site, so keying
    // this effect on referential identity would resync every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.userId, ctx.roomName]);

  useEffect(() => {
    if (!room) return;

    joinStartedAt.current = Date.now();
    reportedJoin.current = false;
    attempts.current = 0;
    // Mounting this hook is the closest observable proxy for "the room
    // screen started trying to join" available from outside the connect
    // effect in webinar-room.tsx — see the file comment on why this stays
    // a separate observer rather than reading connect()'s own timestamp.
    push("join_attempt");

    const onConnectionStateChanged = (state: ConnectionState) => {
      push("connection_state_changed", { state });
      if (state === ConnectionState.Connected && !reportedJoin.current) {
        reportedJoin.current = true;
        push("join_success", { ttiMs: Date.now() - joinStartedAt.current });
      }
      if (state === ConnectionState.Disconnected || state === ConnectionState.Reconnecting) {
        // Real-time visibility during a test — a WARNING-worthy line lands
        // immediately rather than waiting for the next 10s flush.
        flush();
      }
    };
    const onReconnecting = () => {
      attempts.current += 1;
      push("reconnecting", { attempt: attempts.current });
      flush();
    };
    const onReconnected = () => {
      push("reconnected", { attempt: attempts.current });
    };
    const onDisconnected = (reason?: DisconnectReason) => {
      push("disconnected", {
        reason: reason !== undefined ? DisconnectReason[reason] : "unknown",
      });
      flush();
    };

    room.on(RoomEvent.ConnectionStateChanged, onConnectionStateChanged);
    room.on(RoomEvent.Reconnecting, onReconnecting);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.Disconnected, onDisconnected);

    const qualityTimer = setInterval(() => void sampleQuality(room), QUALITY_POLL_MS);
    const flushTimer = setInterval(() => flush(), FLUSH_MS);
    const onBeforeUnload = () => flush(true);
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      room.off(RoomEvent.ConnectionStateChanged, onConnectionStateChanged);
      room.off(RoomEvent.Reconnecting, onReconnecting);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
      clearInterval(qualityTimer);
      clearInterval(flushTimer);
      window.removeEventListener("beforeunload", onBeforeUnload);
      flush(true);
    };
    // ctx is read through ctxRef (updated in the effect above) rather than
    // listed here, so a display-name change mid-session does not tear down
    // and reattach every listener — only room identity should do that.
  }, [room]);
}
