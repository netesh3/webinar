"use client";

import {
  ConnectionQuality,
  RoomEvent,
  Track,
  VideoPreset,
  type LocalVideoTrack,
  type RemoteVideoTrack,
  type Room,
} from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  SHARE_KEEP_RESOLUTION,
  SHARE_MODE_FPS,
  isSvcShareCodec,
  liveShareMode,
  shareDegradation,
  shareEncoderHint,
  shareLayout,
  shareLayoutOfEncodings,
  shareScalabilityMode,
  type ShareCodec,
  type ShareLayout,
  type ShareMode,
} from "./share-mode.ts";
import {
  cpuLimitedShare,
  governorStep,
  initialGovernor,
  logAdapt,
  type GovernorConfig,
  type GovernorState,
  type Signals,
} from "./adapt-governor.ts";
import { effectsPausedForCpu, effectsWanted, setEffectsPausedForCpu } from "./cpu-relief.ts";
import { demoteAv1 } from "./codec-policy.ts";

/* Watching the connection, and doing something about it.
 *
 * LiveKit already adapts in two directions on its own: adaptiveStream picks a smaller
 * layer for a small tile on the receive side, and the browser's own congestion control
 * throttles the publisher's encoders when the uplink is congested. Both are good and
 * neither is enough on its own, for one reason — they react to what the pipe is doing,
 * not to what the person is experiencing. A publisher whose uplink has collapsed will
 * keep trying to send three simulcast layers, with the encoders starved, producing a
 * stuttering high layer and two broken ones. Stepping the ladder DOWN removes work the
 * connection cannot do rather than doing it badly.
 *
 * So this reads getStats directly and makes one decision: which rung of the publish
 * ladder this connection can actually sustain.
 *
 *   step down  fast, on sustained loss or RTT. Being slow here is the lag.
 *   step up    slow, and only after a clear run. Being fast here is an oscillation —
 *              the step up causes the congestion that causes the next step down, and the
 *              audience watches the resolution pump.
 *
 * Audio is never touched. It is protected by RED, DTX and a raised network priority (see
 * media.ts and prioritiseAudio), and reducing it to save bandwidth would be giving up the
 * one thing the session cannot do without.
 */

/** What the connection looks like right now. */
export type NetworkHealth = {
  /** LiveKit's own summary, which folds in signal and media health. */
  quality: ConnectionQuality;
  /** Percentage of outbound packets lost, averaged over the sample window. */
  lossPercent: number;
  /** Round trip time in milliseconds, from the selected candidate pair. */
  rttMs: number;
  /* The best round trip seen in the last minute — this route with no queue in it.
   *
   * Reported because the difference between the two numbers is the whole diagnosis. A floor of
   * 280 ms is distance to the SFU and nothing a viewer can do anything about; 280 ms of EXCESS
   * over a 30 ms floor is a queue somewhere on their own connection. The ladder is judged on
   * the second, and showing both is what stops somebody chasing their router over the first. */
  rttFloorMs: number;
  jitterMs: number;
  /* How long incoming video sat in the receiver's jitter buffer before it was played,
   * averaged over the sample window.
   *
   * The single largest term in what a viewer experiences as delay, and the reason it is
   * measured rather than assumed: latency.ts asks the browser for a low playout target,
   * and this is the browser's answer. Zero means nothing is arriving yet, or that this
   * browser does not report the counters. */
  playoutMs: number;
  /** Browser availableOutgoingBitrate in kbps. Display-only — never used by the ladder. */
  availableOutgoingKbps: number;
  /** Which rung of the ladder is being published, for the indicator. */
  tier: PublishTier;
  /** True while quality is being held below the chosen setting. */
  degraded: boolean;
};

/* The ladder.
 *
 * Deliberately coarse. Fine-grained steps sound better and behave worse: each change
 * republishes encodings, which costs a keyframe and a visible hitch, so a ladder with
 * eight rungs spends its time hitching. Three rungs and a floor is enough to get from a
 * good office connection to a phone on a train.
 */
export type PublishTier = "full" | "reduced" | "minimal";

const TIERS: PublishTier[] = ["full", "reduced", "minimal"];

/* ==========================================================================================
 * ADAPT — every threshold that moves a publisher's quality, in one table.
 *
 * Three ladders, each run by the same governor (lib/adapt-governor.ts: hold, clean window,
 * hysteresis, cool-down, one step per sample, oscillation hold):
 *
 *   camera  full → reduced → minimal (LADDER): drops simulcast layers.
 *   share   full → reduced → minimal (shareLadder): drops fps and bitrate, never resolution.
 *   cpu     none → fps → effects → codec → layer (CPU_STEPS): the device, not the network.
 *
 * Signals, per 2 s sample (all from getStats on the publisher's own senders):
 *   loss        % of outbound video packets the SFU reports lost, over this window.
 *   rttExcess   ms of round trip ABOVE this route's 1-minute floor — queueing, not distance
 *               (see the RTT note below; an absolute RTT never steps anything).
 *   jitter      ms, the SFU's interarrival jitter for our packets (remote-inbound-rtp).
 *   headroom    (availableOutgoingBitrate − what the current rungs send) / what they send.
 *               Step-UP gate only. Never a step-down signal: on India→EU the browser's estimate
 *               reads a few Mbps on a 100 Mbps line and stepped healthy presenters down (see
 *               the bandwidth note below). Judged against the CURRENT rung, so a stepped-down
 *               sender — app-limited, estimate pinned near its own rate — is not locked out.
 *   cpu         share of the window the encoder spent qualityLimitationReason "cpu", 0..1,
 *               from qualityLimitationDurations (worst sender).
 *
 * Down triggers fire after `forMs` continuously at or above `atLeast`; a `severe` one also
 * ignores the cool-down and the oscillation hold. Up needs every `up` condition for `cleanMs`.
 * The two sets are far apart on purpose (hysteresis): a link sitting on one number holds still.
 *
 *              down (any, held)                          up (all, for cleanMs)
 *   camera     loss ≥ 2% 4s | ≥ 10% 2s (severe)          loss ≤ 0.5%, rttExcess ≤ 80 ms,
 *              rttExcess ≥ 200 ms 4s | jitter ≥ 100 ms 6s jitter ≤ 30 ms, headroom ≥ 30%  — 20 s
 *   share      loss ≥ 5% 4s | ≥ 15% 2s (severe)          loss ≤ 1%, rttExcess ≤ 80 ms,
 *              rttExcess ≥ 400 ms 4s | jitter ≥ 150 ms 6s jitter ≤ 50 ms, headroom ≥ 30%  — 20 s
 *   cpu        cpu ≥ 50% 6s | ≥ 90% 4s (severe)          cpu ≤ 5%                           — 30 s
 *   all        cool-down 10 s after any move; 3 moves in 2 min → no step-up for 2 min.
 *
 * "RTT < 250 ms" as a clean condition is deliberately expressed as rttExcess ≤ 80 ms instead:
 * the EU SFU's floor from India is 200–250 ms, so an absolute 250 would make recovery a coin
 * toss on distance alone — the one-way ratchet described at RTT_EXCESS_BAD_MS.
 * ========================================================================================== */
export const ADAPT = {
  sampleMs: 2000,
  camera: {
    maxLevel: 2,
    down: [
      // Two percent is roughly where camera video visibly breaks up.
      { signal: "loss", atLeast: 2, forMs: 4000 },
      { signal: "loss", atLeast: 10, forMs: 2000, severe: true },
      { signal: "rttExcess", atLeast: 200, forMs: 4000 },
      // RTP jitter this high is a queue flapping, even when the mean RTT looks fine.
      { signal: "jitter", atLeast: 100, forMs: 6000 },
    ],
    up: [
      { signal: "loss", atMost: 0.5 },
      { signal: "rttExcess", atMost: 80 },
      { signal: "jitter", atMost: 30 },
      { signal: "headroom", atLeast: 0.3 },
    ],
    // The step up is itself a bandwidth increase; doing it eagerly recreates the congestion.
    cleanMs: 20_000,
    cooldownMs: 10_000,
    oscillation: { changes: 3, windowMs: 120_000, holdMs: 120_000 },
  },
  share: {
    maxLevel: 2,
    // A higher bar than the camera: long-haul jitter must not cost slides frames.
    down: [
      { signal: "loss", atLeast: 5, forMs: 4000 },
      { signal: "loss", atLeast: 15, forMs: 2000, severe: true },
      { signal: "rttExcess", atLeast: 400, forMs: 4000 },
      { signal: "jitter", atLeast: 150, forMs: 6000 },
    ],
    up: [
      { signal: "loss", atMost: 1 },
      { signal: "rttExcess", atMost: 80 },
      { signal: "jitter", atMost: 50 },
      { signal: "headroom", atLeast: 0.3 },
    ],
    cleanMs: 20_000,
    cooldownMs: 10_000,
    oscillation: { changes: 3, windowMs: 120_000, holdMs: 120_000 },
  },
  cpu: {
    maxLevel: 4,
    down: [
      // Half of each window CPU-limited, held 6 s: the encoder is not keeping up.
      { signal: "cpu", atLeast: 0.5, forMs: 6000 },
      { signal: "cpu", atLeast: 0.9, forMs: 4000, severe: true },
    ],
    up: [{ signal: "cpu", atMost: 0.05 }],
    // Slower than the network: every CPU rung back up re-adds work that was just too much.
    cleanMs: 30_000,
    cooldownMs: 10_000,
    oscillation: { changes: 3, windowMs: 120_000, holdMs: 120_000 },
    /* Frame-rate caps per CPU level (index = level), per track kind. Cameras cut fps first
     * and only drop a layer at "layer"; shares keep resolution at every level. */
    cameraFps: [30, 20, 20, 20, 15],
    shareFps: { sharp: [15, 10, 10, 10, 8], video: [30, 20, 20, 20, 15] } as Record<ShareMode, number[]>,
  },
} as const satisfies {
  sampleMs: number;
  camera: GovernorConfig;
  share: GovernorConfig;
  cpu: GovernorConfig & { cameraFps: readonly number[]; shareFps: Record<ShareMode, readonly number[]> };
};

/* The CPU ladder's rungs, in the order they are taken (index = level). A rung with nothing to
 * do on this device — no effect on, no AV1 track — is skipped in the same move, so it costs no
 * interval:
 *   fps      camera top layer 30 → 20 fps, share 15 → 10 (sharp) / 30 → 20 (video)
 *   effects  pause blur / virtual background (cpu-relief.ts), with a toast
 *   codec    AV1 → VP8 camera, republished once; sticky for the tab (codec-policy demoteAv1).
 *            A live share is not republished (that would cut every viewer's slides and
 *            re-run the share lock); later shares go out VP9.
 *   layer    camera held off its 1080p rung; camera 15 fps; share 8 (sharp) / 15 (video) fps */
export const CPU_STEPS = ["none", "fps", "effects", "codec", "layer"] as const;
export type CpuStep = (typeof CPU_STEPS)[number];

const SAMPLE_MS = ADAPT.sampleMs;

/* What counts as trouble for a single sample (judge / describeQuality): the lowest camera
 * loss trigger in ADAPT. */
const BAD_LOSS_PERCENT = ADAPT.camera.down[0].atLeast;

/* Round trip is judged by how far it is ABOVE this route's own floor, never by an absolute
 * number. This is the correction to a real bug, and the bug is worth writing down because the
 * absolute version looked completely reasonable.
 *
 * It was `bad: rtt >= 300` and `good: rtt <= 180`. The SFU is on Hetzner EU and the audience
 * is in India: steady round trip is ~200–250 ms (was 276–285 ms on the older us-east-1 seat;
 * see e2e/probe-latency.mjs). So:
 *
 *   - 250 ms sat under an absolute 300 ms trigger. Ordinary long-haul jitter crossed it, and
 *     two samples four seconds apart stepped the publisher down.
 *   - recovery required 180 ms, which on that route is PHYSICALLY IMPOSSIBLE. Light does not
 *     go that fast.
 *
 * The ladder was therefore a one-way ratchet: full → reduced → minimal within the first
 * minute of a second person joining, and never back. The presenter ended up sending a single
 * 180p layer for the rest of the session, which is what "there is lag now and there wasn't
 * before" actually looked like. Nothing in the UI said why beyond a "Reduced quality" badge.
 *
 * The fix is to measure the thing that is actually a symptom. Propagation delay is a constant
 * of distance and no bitrate change affects it; QUEUEING delay is congestion, and sending less
 * does drain it. Delay-based congestion control has worked this way for thirty years — the
 * signal is the excess over the minimum, not the minimum itself.
 *
 * There is deliberately NO absolute ceiling that steps the ladder. A 400 ms route is a bad
 * seat, not a bad connection, and degrading video on it would cost picture while saving no
 * latency at all. A saturated or broken uplink shows up as packet loss and/or queueing
 * excess — not as the browser's `availableOutgoingBitrate`, which on India→EU paths often
 * reports a few Mbps (or under 1 Mbps) on a 100 Mbps ISP plan and must not drive the ladder.
 * ~500 ms+ of *queueing* (excess) still degrades — see the bad threshold below — which is
 * the truly congested link, not the EU↔IN topology.
 *
 * Excess thresholds are deliberately loose for this topology: long-haul jitter of ~100–150 ms
 * on a 200–250 ms floor must not count as congestion.
 */
const RTT_EXCESS_BAD_MS = ADAPT.camera.down[2].atLeast; // 200 ms
/** And what counts as drained. Asymmetric like every other pair here, so a connection sitting
 *  on one number does not thrash. */
const RTT_EXCESS_GOOD_MS = ADAPT.camera.up[1].atMost; // 80 ms
/** Absolute RTT that is still a healthy seat here. EU SFU + India clients land ~200–250 ms;
 *  the UI must treat that as good, not as LiveKit's middling/poor grade. */
const RTT_OK_MS = 300;

/* How many recent samples the floor is taken from — 30 at 2 s each, so a minute.
 *
 * A window rather than an all-time minimum. An all-time minimum never rises, so somebody who
 * moves from wifi to a hotspot mid-call would be judged for the rest of the session against a
 * floor their new route cannot reach, and the ladder would sit at the bottom for the same
 * reason it did before. A minute is long enough to see between bursts of congestion and short
 * enough to follow a genuine route change.
 */
const RTT_WINDOW_SAMPLES = 30;

/* What a simulcast sender is putting on the wire, from its outbound-rtp reports.
 *
 * There is one outbound-rtp per encoding. Telemetry used to keep whichever came last, so a
 * share with its 1080p layer switched off and one with it on could log the same 1280x720 —
 * which is exactly the difference between sharp and blurry for every viewer. This reads all of
 * them: the top layer actually being sent, every layer's size and frame rate, and the limit
 * the browser reports (any encoding's, preferring one that is limited). */
export type OutboundSummary = {
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  qualityLimitationReason: string;
  /** "1920x1080@15,1280x720@15", top first; only encodings sending frames. */
  layers: string;
  /** The top encoding's, e.g. "L1T3" for a keep-resolution VP9 share. Absent if not reported. */
  scalabilityMode?: string;
  /** How many encodings the sender has: 1 is the keep-resolution single layout. */
  encodings: number;
};

export function summariseOutbound(reports: readonly Record<string, unknown>[]): OutboundSummary {
  const n = (v: unknown) => (typeof v === "number" ? v : undefined);
  const sending = reports
    .filter((r) => r.active !== false && (n(r.frameHeight) ?? 0) > 0)
    .sort((a, b) => (n(b.frameHeight) ?? 0) - (n(a.frameHeight) ?? 0));
  const top = sending[0];
  const limited = reports.map((r) => r.qualityLimitationReason).find((q) => typeof q === "string" && q !== "none");
  return {
    frameWidth: n(top?.frameWidth),
    frameHeight: n(top?.frameHeight),
    framesPerSecond: n(top?.framesPerSecond),
    qualityLimitationReason: typeof limited === "string" ? limited : "none",
    layers: sending
      .map((r) => `${n(r.frameWidth)}x${n(r.frameHeight)}@${Math.round(n(r.framesPerSecond) ?? 0)}`)
      .join(","),
    ...(typeof top?.scalabilityMode === "string" ? { scalabilityMode: top.scalabilityMode } : {}),
    encodings: reports.length,
  };
}

/**
 * floorFrom is the best round trip seen recently — this route with no queue in it.
 *
 * Zero when there is nothing to go on, which callers must read as "unknown" and not as "no
 * latency". Readings of zero are dropped rather than treated as a floor of zero: the stats API
 * reports 0 for "not measured yet", and taking that literally would make every subsequent
 * sample look like 280 ms of queueing.
 */
export function floorFrom(window: readonly number[]): number {
  let floor = 0;
  for (const rtt of window) {
    if (rtt <= 0) continue;
    if (floor === 0 || rtt < floor) floor = rtt;
  }
  return floor;
}

/* Bandwidth estimate is intentionally NOT a ladder signal.
 *
 * `availableOutgoingBitrate` is the browser's own guess of what it can send. On India→EU
 * it routinely reports a few Mbps — or under 1 Mbps — on a 100 Mbps+ ISP plan (it tracks
 * congestion-control headroom / current send rate, not a speedtest). Using it to step the
 * ladder produced false "Reduced quality" with 0% loss and ~2 ms of queueing. The browser's
 * own encoder backoff already handles a merely narrow clean uplink; we only step down on
 * real damage: sustained loss or queueing excess.
 *
 * The estimate is still sampled for the settings readout (labeled as unused) so support can
 * see what the browser claimed — it must never feed judge / judgeShare. */
/* And what counts as recovered. Lower than the trouble thresholds on purpose: a single
 * band would have the state flapping around one number. */
const GOOD_LOSS_PERCENT = ADAPT.camera.up[0].atMost; // 0.5%

const IDLE: NetworkHealth = {
  quality: ConnectionQuality.Unknown,
  lossPercent: 0,
  rttMs: 0,
  jitterMs: 0,
  playoutMs: 0,
  rttFloorMs: 0,
  availableOutgoingKbps: 0,
  tier: "full",
  degraded: false,
};

/* The encodings for each rung, applied to the live sender.
 *
 * Set through RTCRtpSender.setParameters rather than by republishing the track. That is
 * the whole reason this is fast enough to be worth doing: republishing means an unpublish,
 * a renegotiation and a fresh keyframe, which the audience sees as the video cutting out
 * for half a second — during the moment the connection is already struggling. Changing
 * the parameters keeps the same sender and the same SSRCs.
 */
/* Camera publish ladder — bitrates live HERE with the share ladder so applyLadder cannot
 * drift from what media.ts publishes.
 *
 * WHY 1080p top (not stock 720p). Zoom's *common* Group HD path is 720p for the active
 * speaker; Full HD 1080p is gated (Business/Enterprise-class plans, often Support-enabled,
 * i7-class CPU, fullscreen speaker mode — see Zoom KB "Enabling HD video for Zoom Meetings").
 * Our speaker tile on a desktop stage regularly exceeds 720 CSS px (and more on retina), so
 * a 1080p top layer is not empty pixels for the featured face.
 *
 * WHY 180p at the bottom (2026-10-22). Simulcast has three layers at most, and they used to
 * be 360p / 720p / 1080p, so the smallest anything could be was 360p at 600 kbps — a 50-person
 * grid pulled ~5 Mbps per viewer where Zoom's gallery (90p–180p tiles, ~100–250 kbps) pulls
 * ~1.5–2. Big grids and filmstrips now get a real thumbnail layer; 3–9 tiles get 360p; the
 * speaker keeps HD. The price is the 720p rung: a tile between 360p and 1080p gets one of
 * those two (qualityFor, adaptiveStream).
 *
 *            180p@15   360p@20   1080p@30   total
 *   full     200       640       3200       4040 kbps
 *   reduced  200       640       off         840 kbps   ← while sharing / mild congestion
 *   minimal  off       640       off         640 kbps   ← a weak uplink keeps 360p, not 180p
 *
 * The bitrates keep each step at 5x or less (network.test.mts: no cliff between layers), so a
 * congested subscriber steps down one layer rather than falling from 1080p to a thumbnail.
 * 1080p ~3.2 Mbps sits under Zoom's documented ~3.8 Mbps Full HD send. maintain-framerate
 * still applies: faces prefer motion over a sharp slideshow.
 *
 * A device that should not encode 1080 (canCaptureCamera1080) captures 720p and publishes
 * CAMERA_720 as its top layer, so its speaker tile is 720p rather than 360p.
 */
/** Thumbnail rung: large grids, filmstrips. In Zoom's gallery range. */
export const CAMERA_180_BITRATE = 200_000;
/** Mid rung: grids of 3–9, spotlight beside content. */
export const CAMERA_360_BITRATE = 640_000;
/** The top layer of a device that captures 720p instead of 1080p. */
export const CAMERA_720_BITRATE = 2_000_000;
/** Featured-speaker 1080p — under Zoom's ~3.8 Mbps Full HD send floor. */
export const CAMERA_1080_BITRATE = 3_200_000;

export const CAMERA_LAYERS = [
  new VideoPreset(320, 180, CAMERA_180_BITRATE, 15),
  new VideoPreset(640, 360, CAMERA_360_BITRATE, 20),
];

export const CAMERA_TOP = new VideoPreset(1920, 1080, CAMERA_1080_BITRATE, 30);
export const CAMERA_720 = new VideoPreset(1280, 720, CAMERA_720_BITRATE, 30);

/**
 * Coarse Zoom-like Full HD gate: phones skip 1080 capture; machines with fewer than
 * eight logical cores (proxy for Zoom's i7 Quad Core send requirement) publish the same
 * ladder but start with the 1080 rung off so they encode 360+720 only.
 */
export function canCaptureCamera1080(): boolean {
  if (typeof navigator === "undefined") return true;
  if (typeof navigator.userAgent === "string") {
    const ua = navigator.userAgent;
    if (/android|iphone|ipod|ipad/i.test(ua)) return false;
    const maxTouch =
      typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0;
    if (/macintosh/i.test(ua) && maxTouch > 1) return false;
  }
  const cores = navigator.hardwareConcurrency ?? 0;
  if (cores > 0 && cores < 8) return false;
  return true;
}

/** Capture resolution and top encoding — 1080 when allowed, else 720. */
export function cameraCapturePreset(): VideoPreset {
  return canCaptureCamera1080() ? CAMERA_TOP : CAMERA_720;
}

/* AV1: the same picture for ~30% fewer bits.
 *
 * Every AV1 rung is the codec it replaces times AV1_SAVING — VP8 for cameras, VP9 for shares
 * (lib/codec-policy.ts says who gets AV1 at all). Without this AV1 would just be a sharper
 * picture at the same uplink cost, and the uplink is what is short. libaom realtime at these
 * resolutions measures roughly 30–40% under VP8 and 20–30% under VP9 for equal quality; 0.7 is
 * the conservative end for cameras and slightly generous for shares, where VP9 sharp at 1080p
 * already had a wide margin (48.6 dB on a still slide at 1.5 Mbps, share-mode.ts).
 *
 *   camera (AV1)  180p 140  360p 448  1080p 2240 (720p 1400)   full 2828 kbps (VP8 4040, -30%)
 *   share sharp   single 1080p@15  1750                          (VP9 2500, -30%)
 *   share video   single 1080p@30  2800                          (VP9 4000, -30%)
 */
export const AV1_SAVING = 0.7;

/** The camera codecs: VP8 everywhere, AV1 where codec-policy.ts allows it. */
export type CameraCodec = "vp8" | "av1";

export function cameraCodecOfTrack(codec: string | undefined): CameraCodec {
  return codec?.toLowerCase() === "av1" ? "av1" : "vp8";
}

/* How a camera is published, per codec — spread into publishDefaults (media.ts roomOptions)
 * and re-applied to a live room when the AV1 probe resolves or the CPU ladder demotes it.
 *
 * AV1 goes out as rid SIMULCAST with L1T3 on every encoding (livekit-client isSVCSimulcast;
 * the SFU takes it from 1.13.7, we run 1.13.10), not L3T3_KEY SVC. Same three encodings as
 * VP8, so LADDER's positional rungs, the 180p thumbnail layer qualityFor budgets, and the
 * no-cliff property all hold unchanged; KEY-mode SVC only shares bits on keyframes, so it is
 * no cheaper than simulcast on the wire. The temporal layers (T3) give the SFU fps steps per
 * viewer through the AV1 dependency descriptor. If the server version is unknown livekit-client
 * falls back to one L1T3 encoding, and applyCameraLadder handles that shape too.
 *
 * The published layer bitrates stay VP8's: livekit-client builds the VP8 BACKUP's simulcast
 * from the same videoSimulcastLayers, so they must be VP8's numbers. The AV1 primary's are set
 * right after publish on its own sender (applyCameraLadder, cameraLadder("av1")). */
export function cameraPublishDefaults(
  codec: CameraCodec,
  top: VideoPreset = cameraCapturePreset(),
): {
  videoCodec: CameraCodec;
  scalabilityMode: "L1T3" | undefined;
  backupCodec: false | { codec: "vp8"; encoding: VideoPreset["encoding"] };
} {
  if (codec === "av1") {
    return { videoCodec: "av1", scalabilityMode: "L1T3", backupCodec: { codec: "vp8", encoding: top.encoding } };
  }
  return { videoCodec: "vp8", scalabilityMode: undefined, backupCodec: false };
}

/* Exported for one test, which pins the property that matters and cannot be read off the
 * page: that no two adjacent layers are so far apart that a subscriber falls through the gap
 * between them. See network.test.mts. */
export const LADDER: Record<
  PublishTier,
  { maxBitrate: number; scaleDown: number }[]
> = {
  // Three layers as published. The SFU chooses between them per subscriber.
  full: [
    { maxBitrate: CAMERA_LAYERS[0].encoding.maxBitrate, scaleDown: 6 },
    { maxBitrate: CAMERA_LAYERS[1].encoding.maxBitrate, scaleDown: 3 },
    { maxBitrate: CAMERA_TOP.encoding.maxBitrate, scaleDown: 1 },
  ],
  // The top layer goes; the thumbnail and 360p stay.
  reduced: [
    { maxBitrate: CAMERA_LAYERS[0].encoding.maxBitrate, scaleDown: 6 },
    { maxBitrate: CAMERA_LAYERS[1].encoding.maxBitrate, scaleDown: 3 },
    { maxBitrate: 0, scaleDown: 1 },
  ],
  // One layer, and it is 360p, not the thumbnail: a weak presenter is still somebody's
  // speaker tile. Everything left goes to keeping a recognisable moving picture and to
  // protecting the audio, which is untouched at every rung.
  minimal: [
    { maxBitrate: 0, scaleDown: 6 },
    { maxBitrate: CAMERA_LAYERS[1].encoding.maxBitrate, scaleDown: 3 },
    { maxBitrate: 0, scaleDown: 1 },
  ],
};

/** The camera ladder for a codec: LADDER for VP8, every rung × AV1_SAVING for AV1. */
export function cameraLadder(codec: CameraCodec = "vp8"): typeof LADDER {
  if (codec === "vp8") return LADDER;
  const scale = (rungs: (typeof LADDER)[PublishTier]) =>
    rungs.map((r) => ({ ...r, maxBitrate: Math.round(r.maxBitrate * AV1_SAVING) }));
  return { full: scale(LADDER.full), reduced: scale(LADDER.reduced), minimal: scale(LADDER.minimal) };
}

/* What each rung's encodings should be on the live camera sender: bitrate, active, fps.
 *
 * Pure so the shapes can be tested: three encodings (180/360/1080, the published simulcast),
 * two (a capture under 960 px gets [low, original]), or one (AV1 fallen back to a single L1T3
 * encoding, see cameraPublishDefaults). One encoding cannot drop a layer, so it takes the
 * rung's TOTAL as its cap; libwebrtc's rate allocator then spends it on that one stream.
 * `fpsCap` is the CPU ladder's (ADAPT.cpu.cameraFps); a layer never goes above its own fps. */
export function cameraEncodingPlan(
  tier: PublishTier,
  codec: CameraCodec,
  encodings: number,
  topBitrate: number,
  fpsCap = 30,
): { active: boolean; maxBitrate?: number; maxFramerate: number }[] {
  const scale = codec === "av1" ? AV1_SAVING : 1;
  const top = Math.round(topBitrate * scale);
  const wanted = cameraLadder(codec)[tier];
  const fpsOf = (i: number, last: boolean) =>
    Math.min(fpsCap, last ? CAMERA_TOP.encoding.maxFramerate ?? 30 : CAMERA_LAYERS[i]?.encoding.maxFramerate ?? 30);
  if (encodings === 1) {
    const total = wanted.reduce((s, r, i) => s + (i === wanted.length - 1 ? Math.min(r.maxBitrate, top) : r.maxBitrate), 0);
    return [{ active: true, maxBitrate: total, maxFramerate: fpsOf(0, true) }];
  }
  return Array.from({ length: encodings }, (_, i) => {
    const last = i === encodings - 1;
    // Positional, as published: LADDER's rungs are [180, 360, top].
    const rung = wanted[i] ?? wanted[wanted.length - 1];
    if (rung.maxBitrate <= 0) return { active: false, maxFramerate: fpsOf(i, last) };
    return {
      active: true,
      maxBitrate: last ? Math.min(rung.maxBitrate, top) : rung.maxBitrate,
      maxFramerate: fpsOf(i, last),
    };
  });
}

/* The same three tiers, for a SCREEN SHARE — and a different policy from the camera.
 *
 * Camera under pressure: maintain-framerate, drop layers, accept blur.
 * Share under pressure, in the default "sharp" mode (lib/share-mode.ts): maintain-resolution
 * and contentHint "detail" — hold pixels, drop frames. Reading the slide IS the content; a
 * sharp 720p at 8fps beats a soft 360p at 30. A presenter playing a video can switch the
 * share to "video" mode (motion + maintain-framerate, 30 fps) and accept softer text.
 *
 * Encode floors (publisher):
 *   desktop  never scale share content below 1280×720
 *   mobile   never below 640×360 (capture floor; getDisplayMedia is rare on phones)
 *
 * Two layers, both readable: 720p (the desktop floor) and the 1080p capture. There used
 * to be a 360p@5fps layer under them for phone tiles, and production showed what it cost:
 * a presenter with 33 Mbps of upload but ~200 ms to the EU SFU spent 64 of 111 samples
 * bandwidth-limited, and every time the browser's estimate dipped the top layer paused and
 * EVERY viewer fell to 360p@5 at once — the "goes blurry in between". Now the worst a
 * viewer can land on is 720p.
 *
 * The rungs, per layer (fps is the share mode's: 15 sharp, 30 video), H264 / VP9 sharp
 * (VP9 video mode spends what H264 does):
 *
 *            720p          1080p        total
 *   full     1500 / 700    4000 / 2500  5500 / 3200 kbps
 *   reduced  1500 / 700    off          1500 / 700 kbps
 *   minimal  same @8 fps   off                       ← fps down, not bitrate/resolution
 *
 * (SHARE_BITRATES says why VP9 spends less.)
 *
 * Under bandwidth pressure the share is also given priority over the camera
 * (prioritiseShare): share encodings "high", camera "very-low", so the browser's pacer
 * and bandwidth estimator starve the face before the slides. The structural fix for the
 * India→EU round trip is an SFU nearer India; this keeps the share readable until then.
 *
 * WHY 1.5 / 4 Mbps (H264). Desktop content needs bitrate more than faces — H.264 spends a thin
 * budget on motion and leaves text muddy — but a top layer the uplink cannot sustain is
 * worse than a slightly softer one it can: at ~200 ms RTT the estimator backs off hard and
 * often, and a 5–7.5 Mbps top layer (the old 1080p/1440p values) was paused more than it
 * was sent. 4 Mbps 1080p at 15 fps keeps text crisp; 1.5 Mbps holds 720p readable.
 *
 * WHAT CHANGED (mid-session blur / false Reduced). Camera and share used to share ONE tier
 * decision driven partly by availableOutgoingBitrate. On EU SFU + IN that estimate is often
 * a few Mbps (or <1 Mbps) on fat ISP plans, so tooNarrow fired, both tracks stepped down,
 * and the share's 720p rung was starved. Share now has its own judge on severe loss /
 * extreme queueing only — never on the bitrate estimate. Minimal holds 720p@floor while
 * cutting maxFramerate. Camera uses the same loss/queueing policy (stricter thresholds).
 * While sharing, the camera ladder is also capped at `reduced` so the face does not steal
 * the uplink the slides need.
 *
 * Layers and ladder live HERE (not media.ts) so applyLadder's positional index cannot drift
 * from the published encodings. SHARE_TOP is separate because the SDK takes top encoding
 * apart from screenShareSimulcastLayers.
 */
/** Desktop publisher must not encode share content below this. */
export const SHARE_FLOOR_DESKTOP = { width: 1280, height: 720 } as const;
/** Mobile publisher capture/encode floor (360p equivalent). */
export const SHARE_FLOOR_MOBILE = { width: 640, height: 360 } as const;

/** The 720p share layer: the lowest any viewer gets, still readable. H264's value. */
export const SHARE_720_BITRATE = 1_500_000;

/** The 1080p top layer (the capture itself) for fullscreen desktop viewers. H264's value. */
export const SHARE_1080_BITRATE = 4_000_000;

/* What each share layer may spend, by codec.
 *
 * H264 keeps the 1.5 / 4 Mbps it was tuned at: Chrome's H264 spends a new slide's first frame
 * and then barely refines it (share-mode.ts, shareCodec), so it needs the headroom.
 *
 * VP9 (desktop Chromium, most presenters) does not, and the H264 numbers were costing it the
 * top layer. libwebrtc fills simulcast layers bottom up: the 1080p layer is only switched on
 * once the estimate covers the 720p layer's TARGET (its maxBitrate) plus the 1080p layer's
 * minimum (~800 kbps, x1.35 hysteresis for screen content). At 1.5 Mbps that is ~2.6 Mbps of
 * uplink before anyone sees 1080p; below it the browser sends 720p only, reports
 * qualityLimitationReason "bandwidth", and every viewer drops to 1280x720 at once. Production,
 * 2026-10-22 (instant-webinar-4277, edge, three panelists): a panelist's 1728x1080 share went
 * "bandwidth" ten seconds in, with 14 ms RTT, and the host and a panelist both received
 * 1152x720 for the next minute and a half. Across the week, 22% of share samples were bandwidth
 * limited.
 *
 * Only the sharp mode (slides, the default) changes. VP9 at 1080p on a still slide measured
 * 48.6 dB PSNR at 1.5 Mbps (share-mode.ts), so 2.5 Mbps is ample for 15 fps text, and a 720p
 * slide at 700 kbps has about three times the bits per pixel that measurement had at 500 kbps. Now 1080p is on from ~1.8 Mbps of uplink, and the
 * whole share tops out at 3.2 Mbps instead of 5.5, which also lets more subscribers' downlinks
 * carry the 1080p layer (the SFU drops a viewer to 720p when it does not fit). */
export const SHARE_BITRATES: Record<ShareCodec, Record<ShareMode, { floor: number; top: number }>> = {
  h264: {
    sharp: { floor: SHARE_720_BITRATE, top: SHARE_1080_BITRATE },
    video: { floor: SHARE_720_BITRATE, top: SHARE_1080_BITRATE },
  },
  vp9: {
    sharp: { floor: 700_000, top: 2_500_000 },
    // A played clip is motion at 30 fps, which does need the bits: video mode keeps H264's.
    video: { floor: SHARE_720_BITRATE, top: SHARE_1080_BITRATE },
  },
  // VP9 × AV1_SAVING: 490 / 1750 kbps sharp, 1050 / 2800 video.
  av1: {
    sharp: { floor: Math.round(700_000 * AV1_SAVING), top: Math.round(2_500_000 * AV1_SAVING) },
    video: {
      floor: Math.round(SHARE_720_BITRATE * AV1_SAVING),
      top: Math.round(SHARE_1080_BITRATE * AV1_SAVING),
    },
  },
};

/** Which share codec a published track is in: track.codec, set by livekit-client at publish. */
export function shareCodecOfTrack(codec: string | undefined): ShareCodec {
  const c = codec?.toLowerCase();
  return c === "vp9" ? "vp9" : c === "av1" ? "av1" : "h264";
}

/* Two encodings.
 *
 * livekit-client publishes the simulcast layers plus the original (computeVideoEncodings:
 * [low, original] for one layer), and the SFU maps its LOW/MEDIUM/HIGH qualities onto
 * whatever exists. So the share goes out as the 720p floor and the 1080p capture — no
 * layer below 720p for a congested moment to drop everybody onto. Capture is 1080p at most
 * (SHARE_CAPTURE_MAX); the top layer is the first thing the ladder turns off.
 *
 * The "single" layout (a sharp share, share-mode.ts SHARE_KEEP_RESOLUTION) has no layers
 * under the capture at all: one encoding, full resolution, fewer fps under pressure.
 */
export function shareLayers(
  mode: ShareMode,
  codec: ShareCodec = "h264",
  layout: ShareLayout = "simulcast",
): VideoPreset[] {
  if (layout === "single") return [];
  return [
    new VideoPreset(
      SHARE_FLOOR_DESKTOP.width,
      SHARE_FLOOR_DESKTOP.height,
      SHARE_BITRATES[codec][mode].floor,
      SHARE_MODE_FPS[mode],
    ),
  ];
}

/* What the single full-resolution share encoding (SHARE_KEEP_RESOLUTION) may spend at 1080p.
 *
 * Sharp keeps the simulcast top layer's numbers (VP9 2.5 / H264 4 Mbps at 15 fps). Video mode
 * (a played clip, a file share) is 30 fps of motion on ONE encoding that must not drop to 720p,
 * so it gets more: VP9 4 Mbps, H264 5 Mbps. Under pressure the ladder (shareLadder) cuts fps
 * and bitrate on it, never resolution. */
export const SHARE_SINGLE_BITRATES: Record<ShareCodec, Record<ShareMode, number>> = {
  vp9: { sharp: 2_500_000, video: 4_000_000 },
  h264: { sharp: SHARE_1080_BITRATE, video: 5_000_000 },
  // VP9 × AV1_SAVING: 1.75 / 2.8 Mbps.
  av1: { sharp: Math.round(2_500_000 * AV1_SAVING), video: Math.round(4_000_000 * AV1_SAVING) },
};

export function shareTop(
  mode: ShareMode,
  codec: ShareCodec = "h264",
  layout: ShareLayout = "simulcast",
): VideoPreset {
  const bitrate = layout === "single" ? SHARE_SINGLE_BITRATES[codec][mode] : SHARE_BITRATES[codec][mode].top;
  return new VideoPreset(1920, 1080, bitrate, SHARE_MODE_FPS[mode]);
}

/* Everything codec-, mode- and layout-dependent about publishing a share, in one pure place
 * so it can be tested per browser (sharePublishOptions in media.ts spreads it). */
export type ShareEncodingPlan = {
  layout: ShareLayout;
  videoCodec: ShareCodec;
  /** Undefined: inherit publishDefaults (simulcast on). */
  simulcast?: boolean;
  scalabilityMode?: "L1T3" | "L1T1";
  backupCodec: "h264" | "vp8";
  /** The backup codec's own top encoding (livekit-client otherwise picks a stock preset). */
  backupEncoding: VideoPreset["encoding"];
  degradationPreference: "maintain-resolution" | "maintain-framerate";
  /** What the encoder is told: VP9 L1T3 has to be "motion" (share-mode.ts). */
  encoderHint: "detail" | "motion";
  screenShareEncoding: VideoPreset["encoding"];
  screenShareSimulcastLayers: VideoPreset[];
};

export function shareEncodingPlan(
  mode: ShareMode,
  codec: ShareCodec,
  keepResolution: boolean = SHARE_KEEP_RESOLUTION,
): ShareEncodingPlan {
  // Every mode, every room kind: one full-resolution encoding unless the switch is off.
  const layout = shareLayout(keepResolution);
  return {
    layout,
    videoCodec: codec,
    /* VP9 simulcast: simulcast + an L1T* mode is what makes livekit-client publish VP9 as rid
     * encodings rather than SVC (isSVCSimulcast); the SFU (>= 1.13.7) takes it.
     * VP9 single: simulcast off + L1T3 is one SVC encoding, temporal layers only.
     * H264 single: simulcast off is one encoding at the capture's size (computeVideoEncodings). */
    simulcast: layout === "single" ? false : isSvcShareCodec(codec) ? true : undefined,
    scalabilityMode: shareScalabilityMode(codec, layout),
    // AV1 is published exactly like VP9 (rid L1T* or one L1T3), with the same H264 backup for
    // Safari / iOS / anything that cannot decode it — at H264's own share bitrate.
    backupCodec: isSvcShareCodec(codec) ? "h264" : "vp8",
    backupEncoding: shareTop(mode, isSvcShareCodec(codec) ? "h264" : codec, layout).encoding,
    // maintain-resolution in both modes on the single layout (share-mode.ts).
    degradationPreference: shareDegradation(mode, layout),
    encoderHint: shareEncoderHint(mode, codec, layout),
    // The codec's own bitrates (SHARE_BITRATES / SHARE_SINGLE_BITRATES): VP9 needs far less
    // than H264 for sharp text; video mode's single encoding gets more for 30 fps of motion.
    screenShareEncoding: shareTop(mode, codec, layout).encoding,
    screenShareSimulcastLayers: shareLayers(mode, codec, layout),
  };
}

/** The publish defaults (roomOptions): the sharp mode, H264's bitrates. */
export const SHARE_LAYERS = shareLayers("sharp");
export const SHARE_TOP = shareTop("sharp");

/** One share-ladder rung: bitrate, optional fps cap, never a resolution drop below the floor. */
export type ShareRung = {
  maxBitrate: number;
  /** When set, prefer dropping frames over starving bitrate (detail / text). */
  maxFramerate?: number;
};

/* The rungs for a codec and mode. applyShareLadder re-applies them on every sample, so they
 * have to be the published codec's own numbers: H264's here would put a sharp VP9 share
 * straight back on the 1.5 / 4 Mbps that kept its 1080p layer off. And because it runs every
 * sample, a mid-share switch to video (or back) moves the bitrates within a few seconds.
 *
 * The single layout has one rung per tier, and no rung ever turns it off or scales it: under
 * severe loss / queueing a share keeps its full resolution and gives up frames, with a smaller
 * bitrate that maintain-resolution spends on the same pixels. Sharp: 15 -> 8 -> 4 fps. Video
 * (a played clip, a file share): 30 -> 15 -> 8 fps. Resolution is never a step. */
export const SHARE_SINGLE_RUNGS: Record<
  ShareMode,
  Record<"reduced" | "minimal", { bitrate: number; fps: number }>
> = {
  sharp: { reduced: { bitrate: 0.6, fps: 8 }, minimal: { bitrate: 0.4, fps: 4 } },
  video: { reduced: { bitrate: 0.6, fps: 15 }, minimal: { bitrate: 0.4, fps: 8 } },
};

export function shareLadder(
  codec: ShareCodec = "h264",
  mode: ShareMode = "sharp",
  layout: ShareLayout = "simulcast",
): Record<PublishTier, ShareRung[]> {
  const { floor, top } = SHARE_BITRATES[codec][mode];
  if (layout === "single") {
    const single = SHARE_SINGLE_BITRATES[codec][mode];
    const rung = (r: { bitrate: number; fps: number }): ShareRung => ({
      maxBitrate: Math.round(single * r.bitrate),
      maxFramerate: r.fps,
    });
    return {
      full: [{ maxBitrate: single }],
      reduced: [rung(SHARE_SINGLE_RUNGS[mode].reduced)],
      minimal: [rung(SHARE_SINGLE_RUNGS[mode].minimal)],
    };
  }
  return {
    full: [{ maxBitrate: floor }, { maxBitrate: top }],
    reduced: [{ maxBitrate: floor }, { maxBitrate: 0 }],
    // Hold 720p and its bitrate; cut fps. The floor layer is never dropped or starved.
    minimal: [{ maxBitrate: floor, maxFramerate: 8 }, { maxBitrate: 0 }],
  };
}

export const SHARE_LADDER: Record<PublishTier, ShareRung[]> = shareLadder("h264");

/* What a rung costs, in kbps, derived from the rungs themselves.
 *
 * Derived rather than written down, because a hardcoded table is a second source of truth
 * that goes stale the first time a preset changes — and it would go stale silently, which is
 * the worst kind. Sums the active layers and adds a small allowance for the audio, which is
 * never stepped down and therefore always in the budget.
 */
const AUDIO_KBPS = 60;

/* Ladder cost helpers — documentation and tests only. Not used by judge / judgeShare.
 *
 * Kept so the rung tables stay honest (a preset change moves these rather than going stale)
 * and so share floors can be asserted without hardcoding kbps in every test.
 */
export function needKbps(tier: PublishTier, sharing = false): number {
  let bits = LADDER[tier].reduce((total, rung) => total + rung.maxBitrate, 0);
  if (sharing) {
    bits += shareNeedBits(tier);
  }
  return Math.round(bits / 1000) + AUDIO_KBPS;
}

/** What the share alone costs at a tier, in bits/sec (no audio). */
export function shareNeedBits(tier: PublishTier, codec: ShareCodec = "h264"): number {
  return shareLadder(codec)[tier].reduce((total, rung) => total + rung.maxBitrate, 0);
}

/** Share-only budget in kbps (includes the same audio allowance as needKbps). */
export function shareNeedKbps(tier: PublishTier, codec: ShareCodec = "h264"): number {
  return Math.round(shareNeedBits(tier, codec) / 1000) + AUDIO_KBPS;
}

/** What a sample says about whether the ladder should move. */
export type Verdict = { bad: boolean; good: boolean };

/**
 * judge turns one sample into a step-down / step-up opinion.
 *
 * Pure and exported so it can be tested, and it needs testing more than most things here:
 * removing the quality picker made this the ONLY thing deciding what a presenter sends, and
 * every way of getting it wrong is invisible in a browser.
 *
 * Decisions use packet loss and RTT queueing excess only. `availableOutgoingKbps` is accepted
 * for call-site compatibility and ignored — see the bandwidth comment above.
 *
 * `bad` and `good` are deliberately not opposites. Between them is a hysteresis band where
 * nothing happens, which is what stops a connection sitting on a threshold from thrashing.
 */
export function judge(sample: {
  tier: PublishTier;
  lossPercent: number;
  rttMs: number;
  /** The best round trip seen recently on this route. Zero means unknown, which is read as
   *  "no opinion about latency" rather than as a floor of zero — see floorFrom. */
  rttFloorMs: number;
  /** Ignored. Kept so callers can pass the sampled estimate without branching. */
  availableOutgoingKbps?: number;
  /** Ignored for decisions. Kept for call-site compatibility. */
  sharing?: boolean;
}): Verdict {
  const { tier, lossPercent, rttMs, rttFloorMs } = sample;
  const at = TIERS.indexOf(tier);

  /* Queueing delay: how much worse than this route's best. Only meaningful once both numbers
   * exist, and until then latency has no vote — a presenter must not be stepped down by the
   * first reading after connecting, which is taken while the connection is still ramping and
   * is routinely the worst one of the whole session. */
  const measuredLatency = rttMs > 0 && rttFloorMs > 0;
  const excessMs = measuredLatency ? rttMs - rttFloorMs : 0;

  return {
    bad:
      lossPercent >= BAD_LOSS_PERCENT || excessMs >= RTT_EXCESS_BAD_MS,
    good:
      lossPercent <= GOOD_LOSS_PERCENT &&
      // Unknown latency does not block recovery. It used to be able to, and on a distant
      // route that meant the ladder could only ever go down.
      excessMs <= RTT_EXCESS_GOOD_MS &&
      at > 0,
  };
}

/* Screen-share degradation is NOT the camera ladder.
 *
 * Same sample, higher bar. Ordinary long-haul jitter must not blur slides. Only severe loss
 * or extreme queueing steps the share down — never the browser bitrate estimate. Recovery
 * is willing once those clear. Camera still uses the stricter loss/queueing thresholds.
 */
const SHARE_BAD_LOSS_PERCENT = ADAPT.share.down[0].atLeast; // 5%
const SHARE_RTT_EXCESS_BAD_MS = ADAPT.share.down[2].atLeast; // 400 ms
const SHARE_GOOD_LOSS_PERCENT = ADAPT.share.up[0].atMost; // 1%

/**
 * judgeShare: step the share ladder only on severe damage, not on camera-shaped RTT noise
 * or unreliable availableOutgoingBitrate.
 */
export function judgeShare(sample: {
  tier: PublishTier;
  lossPercent: number;
  rttMs: number;
  rttFloorMs: number;
  /** Ignored. Kept so callers can pass the sampled estimate without branching. */
  availableOutgoingKbps?: number;
}): Verdict {
  const { tier, lossPercent, rttMs, rttFloorMs } = sample;
  const at = TIERS.indexOf(tier);
  const measuredLatency = rttMs > 0 && rttFloorMs > 0;
  const excessMs = measuredLatency ? rttMs - rttFloorMs : 0;

  return {
    bad:
      lossPercent >= SHARE_BAD_LOSS_PERCENT ||
      excessMs >= SHARE_RTT_EXCESS_BAD_MS,
    good:
      lossPercent <= SHARE_GOOD_LOSS_PERCENT &&
      excessMs <= RTT_EXCESS_GOOD_MS &&
      at > 0,
  };
}

/** Worse (more degraded) of two tiers — for the UI readout when camera and share differ. */
export function worseTier(a: PublishTier, b: PublishTier): PublishTier {
  return TIERS.indexOf(a) >= TIERS.indexOf(b) ? a : b;
}

/**
 * Raises the audio sender's network priority.
 *
 * The last line of defence for voice. When a connection is saturated, the browser's
 * pacer decides which of its own streams to send first, and by default audio and video
 * compete on equal terms — so the thing nobody can do without loses packets to the thing
 * they can. `networkPriority: "high"` puts audio at the front of that queue, and on
 * platforms that map it to DSCP it asks the network to do the same.
 *
 * Applied to the sender after publishing, because there is no publish option for it.
 * Best-effort: an unsupported browser ignores the field rather than failing, which is
 * why the result is not checked.
 */
export async function prioritiseAudio(room: Room | null): Promise<void> {
  const publication = room?.localParticipant?.getTrackPublication(
    Track.Source.Microphone,
  );
  const sender = publication?.audioTrack?.sender;
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    for (const encoding of params.encodings) {
      encoding.networkPriority = "high";
      encoding.priority = "high";
    }
    await sender.setParameters(params);
  } catch {
    // Older Safari rejects setParameters for fields it does not know. Audio still has
    // RED and DTX, which is most of the protection.
  }
}

/* While a screen is shared, the share outranks the camera on the wire.
 *
 * RTCRtpEncodingParameters.priority / networkPriority decide how the browser's pacer and
 * bandwidth estimator split a congested uplink between its own streams. By default every
 * video stream is "low" (the spec default), so when the estimate dips the share and the
 * face lose bits equally — and a presenter's slides, which five hundred people are reading,
 * matter more than their thumbnail. So: share "high", camera "very-low" while sharing,
 * camera back to "low" afterwards. Every encoding of a track gets the same value, which is
 * what Chrome requires.
 *
 * Idempotent and cheap: setParameters is called only when a value has to change. */
export async function prioritiseShare(
  camera: LocalVideoTrack | undefined,
  share: LocalVideoTrack | undefined,
): Promise<void> {
  await setPriority(share?.sender, "high");
  await setPriority(camera?.sender, share ? "very-low" : "low");
}

async function setPriority(sender: RTCRtpSender | undefined, priority: RTCPriorityType) {
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    if (params.encodings.every((e) => e.priority === priority && e.networkPriority === priority)) {
      return;
    }
    for (const encoding of params.encodings) {
      encoding.priority = priority;
      encoding.networkPriority = priority;
    }
    await sender.setParameters(params);
  } catch {
    // Unsupported field or a sender mid-renegotiation; the next sample tries again.
  }
}

/* Which CPU rungs would do anything on this device right now. A rung that would not is skipped
 * in the same move, so an idle rung never costs an interval (CPU_STEPS). */
export function cpuStepApplies(
  step: CpuStep,
  ctx: { camera: boolean; share: boolean; effects: boolean; cameraAv1: boolean },
): boolean {
  switch (step) {
    case "none":
      return true;
    case "fps":
    case "layer":
      return ctx.camera || ctx.share;
    case "effects":
      return ctx.camera && ctx.effects;
    case "codec":
      return ctx.camera && ctx.cameraAv1;
  }
}

/* Releasing a rung that holds nothing (effects not paused; the codec, which is sticky) is also
 * skipped on the way back up. */
export function cpuReleaseIsNoop(step: CpuStep, ctx: { effectsPaused: boolean }): boolean {
  if (step === "codec") return true;
  if (step === "effects") return !ctx.effectsPaused;
  return false;
}

/** Where a CPU move lands once rungs with nothing to do are skipped. null: nothing to do at all. */
export function cpuLanding(
  from: number,
  to: number,
  applies: (step: CpuStep) => boolean,
  releaseNoop: (step: CpuStep) => boolean,
): number | null {
  const max = CPU_STEPS.length - 1;
  if (to > from) {
    let at = to;
    while (at < max && !applies(CPU_STEPS[at])) at++;
    return applies(CPU_STEPS[at]) ? at : null;
  }
  let at = to;
  while (at > 0 && releaseNoop(CPU_STEPS[at])) at--;
  return at;
}

/** The current rungs' total, bits/s, for the headroom signal. */
function sendingBits(
  cameraTier: PublishTier | null,
  cameraCodec: CameraCodec,
  shareTier: PublishTier | null,
  share: { codec: ShareCodec; mode: ShareMode; layout: ShareLayout } | null,
): number {
  let bits = AUDIO_KBPS * 1000;
  if (cameraTier) {
    const top = cameraCapturePreset().encoding.maxBitrate;
    bits += cameraEncodingPlan(cameraTier, cameraCodec, 3, top).reduce((s, e) => s + (e.active ? e.maxBitrate ?? 0 : 0), 0);
  }
  if (shareTier && share) {
    bits += shareLadder(share.codec, share.mode, share.layout)[shareTier].reduce((s, r) => s + r.maxBitrate, 0);
  }
  return bits;
}

/** Headroom over what is being sent; undefined when the browser gives no estimate. */
export function headroomOf(availableOutgoingKbps: number, sendingBitsPerSec: number): number | undefined {
  if (!(availableOutgoingKbps > 0) || !(sendingBitsPerSec > 0)) return undefined;
  return (availableOutgoingKbps * 1000 - sendingBitsPerSec) / sendingBitsPerSec;
}

/* Sets each encoding to its plan, and calls setParameters only if something differs — so it is
 * cheap to run every sample. `touchActive` false leaves `active` alone except to switch a layer
 * OFF: dynacast pauses layers nobody watches, and a routine re-apply must not wake them. */
async function applyEncodings(
  sender: RTCRtpSender | undefined,
  plan: (encodings: number) => { active: boolean; maxBitrate?: number; maxFramerate?: number }[],
  touchActive: boolean,
): Promise<void> {
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    const wanted = plan(params.encodings.length);
    let changed = false;
    params.encodings.forEach((encoding, i) => {
      const p = wanted[i];
      if (!p) return;
      if ((touchActive || !p.active) && encoding.active !== p.active) {
        encoding.active = p.active;
        changed = true;
      }
      // An encoding off (by this rung, or by dynacast) keeps whatever it was paused with.
      if (!p.active || encoding.active === false) return;
      if (p.maxBitrate !== undefined && encoding.maxBitrate !== p.maxBitrate) {
        encoding.maxBitrate = p.maxBitrate;
        changed = true;
      }
      if (p.maxFramerate !== undefined && encoding.maxFramerate !== p.maxFramerate) {
        encoding.maxFramerate = p.maxFramerate;
        changed = true;
      }
    });
    if (changed) await sender.setParameters(params);
  } catch {
    // A browser that refuses leaves the encodings where they were; the next sample retries.
  }
}

/** Points the room's camera publish defaults at a codec (the AV1 probe's answer, or a demotion). */
export function applyCameraCodec(room: Room, codec: CameraCodec): void {
  Object.assign(room.options.publishDefaults ?? {}, cameraPublishDefaults(codec));
}

/* The CPU ladder's "codec" rung: AV1 camera → VP8, once.
 *
 * There is no way to change a live sender's codec without renegotiating, so the camera is
 * unpublished (track kept running, processor and all) and published again as VP8. Viewers see
 * the camera blink for about a second — once per session, because the demotion is sticky
 * (codec-policy.ts demoteAv1) and every later camera publish uses VP8 too. */
async function downgradeCameraFromAv1(room: Room): Promise<boolean> {
  demoteAv1();
  applyCameraCodec(room, "vp8");
  const lp = room.localParticipant;
  const track = lp.getTrackPublication(Track.Source.Camera)?.videoTrack as LocalVideoTrack | undefined;
  if (!track || cameraCodecOfTrack(track.codec) !== "av1") return false;
  try {
    await lp.unpublishTrack(track, false);
    await lp.publishTrack(track, { source: Track.Source.Camera, ...cameraPublishDefaults("vp8") });
    return true;
  } catch {
    return false;
  }
}

/**
 * Samples the connection and holds the publish ladders where they belong.
 *
 * Returns what it sees, so the UI can show it. The stepping happens as a side effect
 * because it has to happen whether or not anything is rendering an indicator — a
 * presenter with the settings dialog closed is exactly who needs it.
 *
 * Three governors (ADAPT): the camera's and the share's network ladders, and the device's
 * CPU ladder. Every move is logged with its reason (logAdapt → telemetry "adapt_decision").
 */
export function useNetworkHealth(
  room: Room | null,
  publishing: boolean,
): NetworkHealth {
  const [health, setHealth] = useState<NetworkHealth>(IDLE);

  // The decision state, in refs: it changes every two seconds and nothing renders from it.
  const cameraGov = useRef<GovernorState>(initialGovernor(ADAPT.camera));
  const shareGov = useRef<GovernorState>(initialGovernor(ADAPT.share));
  const cpuGov = useRef<GovernorState>(initialGovernor(ADAPT.cpu));
  // Cumulative counters, so loss is measured over the window rather than for all time.
  const previous = useRef({ packets: 0, lost: 0 });
  /* jitterBufferDelay is cumulative seconds and jitterBufferEmittedCount cumulative
   * frames, so the average over a window is a ratio of the two deltas. The lifetime
   * ratio would be dominated by the first few seconds after joining, when the buffer is
   * still filling and the number is meaningless.
   *
   * `seeded` is what makes that true of the FIRST sample as well. Without it the first
   * delta is taken against zero, which is the lifetime average — so the one reading the
   * comment above exists to avoid would be the first one anybody sees. */
  const previousPlayout = useRef({ delay: 0, count: 0, seeded: false });
  /* The last minute of round trips, for the floor the ladder is judged against. A ring
   * buffer's worth of numbers rather than a running minimum, so the floor can RISE when
   * somebody's route genuinely changes — see RTT_WINDOW_SAMPLES. */
  const rttWindow = useRef<number[]>([]);
  // qualityLimitationDurations at the last sample, per outbound-rtp id (cpuLimitedShare).
  const cpuWindow = useRef(new Map<string, { cpu: number; total: number }>());

  const tierOf = (gov: GovernorState): PublishTier => TIERS[gov.level];

  /* The camera's encodings: tier, codec (AV1 rungs are AV1_SAVING of VP8's), the CPU ladder's
   * fps cap. The VP8 backup sender of an AV1 camera gets the same rung in VP8 numbers. */
  const applyCamera = useCallback(async (track: LocalVideoTrack, touchActive: boolean) => {
    const tier = TIERS[cameraGov.current.level];
    const fps = ADAPT.cpu.cameraFps[cpuGov.current.level] ?? 30;
    // A 720p device's top layer is CAMERA_720, not the 1080p the table assumes.
    const top = cameraCapturePreset().encoding.maxBitrate ?? CAMERA_1080_BITRATE;
    await applyEncodings(
      track.sender,
      (n) => cameraEncodingPlan(tier, cameraCodecOfTrack(track.codec), n, top, fps),
      touchActive,
    );
    for (const [codec, sc] of track.simulcastCodecs) {
      if (codec === track.codec) continue;
      await applyEncodings(sc.sender, (n) => cameraEncodingPlan(tier, cameraCodecOfTrack(codec), n, top, fps), touchActive);
    }
  }, []);

  /* The share's: per codec, mode and layout (shareLadder), the CPU ladder's fps cap, and never
   * a congestion-era scaleResolutionDownBy that left text soft. */
  const applyShare = useCallback(async (track: LocalVideoTrack, touchActive: boolean) => {
    const sender = track.sender;
    if (!sender) return;
    const tier = TIERS[shareGov.current.level];
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) return;
      // The published codec's rungs: VP9 / AV1 and H264 shares spend differently (SHARE_BITRATES).
      const codec = shareCodecOfTrack(track.codec);
      // One encoding = the keep-resolution layout (share-mode.ts): one rung, never scaled.
      const layout = shareLayoutOfEncodings(params.encodings.length);
      // Read back off the track, so a mid-share mode switch is honoured here too.
      const mode = liveShareMode(track.mediaStreamTrack, layout === "single" && isSvcShareCodec(codec));
      const wanted = shareLadder(codec, mode, layout)[tier];
      const layers = shareLayers(mode, codec, layout);
      const top = shareTop(mode, codec, layout);
      const cpuFps = ADAPT.cpu.shareFps[mode][cpuGov.current.level] ?? SHARE_MODE_FPS[mode];
      const sourceH = track.mediaStreamTrack?.getSettings?.().height || SHARE_TOP.height;
      let changed = false;
      const set = <K extends keyof RTCRtpEncodingParameters>(e: RTCRtpEncodingParameters, k: K, v: RTCRtpEncodingParameters[K]) => {
        if (e[k] !== v) {
          e[k] = v;
          changed = true;
        }
      };
      params.encodings.forEach((encoding, i) => {
        const rung = wanted[i] ?? wanted[wanted.length - 1];
        const active = rung.maxBitrate > 0;
        if (touchActive || !active) set(encoding, "active", active);
        if (!active || encoding.active === false) return;
        const isTop = i >= layers.length;
        set(encoding, "maxBitrate", rung.maxBitrate);
        // The rung's fps if it has one, else the mode's (restores a capped rung, follows a
        // mode switch) — and never above the CPU ladder's cap.
        const layerFps = (isTop ? top : layers[i]).encoding.maxFramerate ?? SHARE_MODE_FPS[mode];
        set(encoding, "maxFramerate", Math.min(rung.maxFramerate ?? layerFps, cpuFps));
        const targetH = isTop ? sourceH : layers[i].height;
        const designed = Math.max(1, sourceH / targetH);
        const current = encoding.scaleResolutionDownBy ?? designed;
        // Clamp upscales-of-downscale only — never soft-blur past the designed rung.
        if (current > designed + 0.05) set(encoding, "scaleResolutionDownBy", designed);
      });
      if (changed) await sender.setParameters(params);
    } catch {
      // Leave the tier recorded; the next sample retries.
    }
  }, []);

  useEffect(() => {
    if (!room) return;

    let cancelled = false;
    let downgrading = false;

    const tracks = () => {
      const local = room.localParticipant;
      return {
        camera: local?.getTrackPublication(Track.Source.Camera)?.videoTrack as LocalVideoTrack | undefined,
        share: local?.getTrackPublication(Track.Source.ScreenShare)?.videoTrack as LocalVideoTrack | undefined,
      };
    };

    const log = (ladder: string, from: string, to: string, direction: "down" | "up", reason: string, signals: Signals) =>
      logAdapt({ ladder, from, to, direction, reason, signals });

    const sample = async () => {
      const local = room.localParticipant;
      const { camera, share } = tracks();
      if (publishing) void prioritiseShare(camera, share);

      // A subscriber has no outbound video to measure, so the inbound side is read
      // instead: their experience is decided by what is arriving.
      const target = camera?.sender ?? share?.sender ?? null;
      let lossPercent = 0;
      let rttMs = 0;
      let jitterMs = 0;
      let jitterKnown = false;
      let playoutMs = 0;
      let availableOutgoingKbps = 0;
      const outbound: Record<string, unknown>[] = [];

      try {
        /* Read regardless of role. A host watches the panel too, and the playout delay
         * is the one number in here that a publisher cannot get from their own sender —
         * sender stats have no inbound-rtp in them at all. */
        const inbound = await readInbound(room);
        const stats = target ? await target.getStats() : inbound;
        if (!stats) return;

        if (inbound)
          playoutMs = readPlayoutMs(inbound, previousPlayout.current);

        let packets = 0;
        let lost = 0;
        stats.forEach((report) => {
          if (report.type === "outbound-rtp" && report.kind === "video") {
            packets += (report as { packetsSent?: number }).packetsSent ?? 0;
            outbound.push(report as Record<string, unknown>);
          }
          if (report.type === "remote-inbound-rtp") {
            const r = report as {
              packetsLost?: number;
              roundTripTime?: number;
              jitter?: number;
            };
            lost += r.packetsLost ?? 0;
            if (r.roundTripTime)
              rttMs = Math.max(rttMs, r.roundTripTime * 1000);
            if (typeof r.jitter === "number") {
              jitterKnown = true;
              jitterMs = Math.max(jitterMs, r.jitter * 1000);
            }
          }
          if (report.type === "inbound-rtp" && report.kind === "video") {
            const r = report as {
              packetsReceived?: number;
              packetsLost?: number;
              jitter?: number;
            };
            packets += r.packetsReceived ?? 0;
            lost += r.packetsLost ?? 0;
            if (r.jitter) jitterMs = Math.max(jitterMs, r.jitter * 1000);
          }
          if (
            report.type === "candidate-pair" &&
            (report as { nominated?: boolean }).nominated
          ) {
            const r = report as {
              currentRoundTripTime?: number;
              availableOutgoingBitrate?: number;
            };
            if (r.currentRoundTripTime)
              rttMs = Math.max(rttMs, r.currentRoundTripTime * 1000);
            if (r.availableOutgoingBitrate) {
              availableOutgoingKbps = Math.round(
                r.availableOutgoingBitrate / 1000,
              );
            }
          }
        });

        // The share's encoder is a separate CPU consumer; its limitation counts too.
        if (camera?.sender && share?.sender) {
          const shareStats = await share.sender.getStats();
          shareStats.forEach((report) => {
            if (report.type === "outbound-rtp" && report.kind === "video") outbound.push(report as Record<string, unknown>);
          });
        }

        // Loss over THIS window. Cumulative counters would average a bad patch away
        // over an hour and the step-down would never fire.
        const deltaPackets = packets - previous.current.packets;
        const deltaLost = lost - previous.current.lost;
        previous.current = { packets, lost };
        if (deltaPackets > 0) {
          lossPercent = Math.max(
            0,
            (deltaLost / (deltaPackets + deltaLost)) * 100,
          );
        }
      } catch {
        return;
      }

      if (cancelled) return;

      /* Record this round trip, then judge against the window's minimum — including this
       * sample, so the very first reading becomes its own floor and has an excess of zero.
       * That is what stops the connection's noisiest moment, the seconds just after joining,
       * from being read as congestion and stepping a healthy presenter down. */
      if (rttMs > 0) {
        rttWindow.current.push(rttMs);
        if (rttWindow.current.length > RTT_WINDOW_SAMPLES)
          rttWindow.current.shift();
      }
      const rttFloorMs = floorFrom(rttWindow.current);
      const now = Date.now();

      const shareInfo = share
        ? (() => {
            const codec = shareCodecOfTrack(share.codec);
            const layout = shareLayoutOfEncodings(share.sender?.getParameters().encodings?.length);
            const mode = liveShareMode(share.mediaStreamTrack, layout === "single" && isSvcShareCodec(codec));
            return { codec, layout, mode };
          })()
        : null;
      const signals: Signals = {
        loss: target ? lossPercent : undefined,
        // Only once both numbers exist: until then latency has no vote (see judge).
        rttExcess: rttMs > 0 && rttFloorMs > 0 ? rttMs - rttFloorMs : undefined,
        jitter: jitterKnown ? jitterMs : undefined,
        headroom: headroomOf(
          availableOutgoingKbps,
          sendingBits(
            camera ? tierOf(cameraGov.current) : null,
            cameraCodecOfTrack(camera?.codec),
            share ? tierOf(shareGov.current) : null,
            shareInfo,
          ),
        ),
        cpu: cpuLimitedShare(outbound, cpuWindow.current),
      };

      /* CPU first: its "layer" rung sets the camera's floor, and its fps caps are read by both
       * apply paths below. */
      if (publishing && (camera || share)) {
        const before = cpuGov.current.level;
        const { state, decision } = governorStep(ADAPT.cpu, cpuGov.current, signals, now);
        cpuGov.current = state;
        if (decision) {
          const ctx = {
            camera: Boolean(camera),
            share: Boolean(share),
            effects: effectsWanted(),
            cameraAv1: cameraCodecOfTrack(camera?.codec) === "av1",
          };
          const landing = cpuLanding(
            before,
            decision.to,
            (s) => cpuStepApplies(s, ctx),
            (s) => cpuReleaseIsNoop(s, { effectsPaused: effectsPausedForCpu() }),
          );
          if (landing === null) {
            // Nothing left to take off this device: stay, and let the hold timers restart.
            cpuGov.current = { ...state, level: before };
          } else {
            cpuGov.current = { ...state, level: landing };
            const engaged = (s: CpuStep) => CPU_STEPS.indexOf(s) <= landing;
            if (!engaged("effects") && effectsPausedForCpu()) setEffectsPausedForCpu(false);
            if (engaged("effects") && landing > before && ctx.effects && !effectsPausedForCpu()) {
              setEffectsPausedForCpu(true);
            }
            log("cpu", CPU_STEPS[before], CPU_STEPS[landing], decision.direction, decision.reason, signals);
            // AV1 off for every later publish too; a live AV1 share is not republished.
            if (engaged("codec") && landing > before && (ctx.cameraAv1 || shareInfo?.codec === "av1")) {
              demoteAv1();
              if (ctx.cameraAv1 && !downgrading) {
                downgrading = true;
                void downgradeCameraFromAv1(room).then((done) => {
                  downgrading = false;
                  log("codec", "av1", done ? "vp8" : "av1", "down", done ? "cpu: camera republished as VP8" : "cpu: camera republish failed", signals);
                });
              }
            }
          }
        }
      }

      if (publishing && camera) {
        /* While screen-sharing, keep the camera off the top rung: next to a share it is a
         * thumbnail. And on the CPU ladder's "layer" rung, the same. */
        const floor = share || cpuGov.current.level >= CPU_STEPS.indexOf("layer") ? 1 : 0;
        const before = tierOf(cameraGov.current);
        const { state, decision } = governorStep(ADAPT.camera, cameraGov.current, signals, now, floor);
        cameraGov.current = state;
        if (decision) log("camera", before, tierOf(state), decision.direction, decision.reason, signals);
        await applyCamera(camera, Boolean(decision));
      }

      if (share) {
        if (publishing) {
          const before = tierOf(shareGov.current);
          const { state, decision } = governorStep(ADAPT.share, shareGov.current, signals, now);
          shareGov.current = state;
          if (decision) log("share", before, tierOf(state), decision.direction, decision.reason, signals);
          await applyShare(share, Boolean(decision));
        }
      } else {
        // Next share starts clean rather than inheriting a previous share's rung.
        shareGov.current = initialGovernor(ADAPT.share);
      }

      if (cancelled) return;
      const publishedTier = share
        ? worseTier(tierOf(cameraGov.current), tierOf(shareGov.current))
        : tierOf(cameraGov.current);
      setHealth({
        quality: local?.connectionQuality ?? ConnectionQuality.Unknown,
        lossPercent: Math.round(lossPercent * 10) / 10,
        rttMs: Math.round(rttMs),
        rttFloorMs: Math.round(rttFloorMs),
        jitterMs: Math.round(jitterMs),
        playoutMs: Math.round(playoutMs),
        availableOutgoingKbps,
        tier: publishedTier,
        degraded: publishedTier !== "full",
      });
    };

    void sample();
    const timer = setInterval(() => void sample(), SAMPLE_MS);

    // LiveKit's own summary is event-driven and cheaper than a stats read, so it
    // updates the indicator between samples.
    const onQuality = () =>
      setHealth((current) => ({
        ...current,
        quality: room.localParticipant?.connectionQuality ?? current.quality,
      }));
    room.on(RoomEvent.ConnectionQualityChanged, onQuality);

    /* A reconnect renegotiates, which resets the senders, and a newly published track starts
     * at the publish defaults (VP8 bitrates on an AV1 camera, no CPU fps cap). Both are
     * re-asserted at once rather than at the next sample. */
    const reassert = () => {
      if (!publishing) return;
      const { camera, share } = tracks();
      if (camera) void applyCamera(camera, true);
      if (share) void applyShare(share, true);
    };
    const onReconnected = () => {
      reassert();
      void prioritiseAudio(room);
      /* And forget the old route's floor.
       *
       * A reconnect renegotiates ICE and can land on a different candidate pair — a TURN relay
       * instead of a direct path, or TCP instead of UDP — whose honest floor is far higher.
       * Judging the new route against the old one's minimum would read the difference as two
       * hundred milliseconds of queueing and step the publisher down immediately, which is the
       * same mistake as the absolute threshold in a different costume. */
      rttWindow.current = [];
    };
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.LocalTrackPublished, reassert);

    return () => {
      cancelled = true;
      clearInterval(timer);
      room.off(RoomEvent.ConnectionQualityChanged, onQuality);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.LocalTrackPublished, reassert);
    };
  }, [room, publishing, applyCamera, applyShare]);

  return health;
}

/** The receive side, for a subscriber. Read from the first remote video track that has
 *  a receiver — one sample is representative, and reading every track in a gallery of
 *  nine every two seconds is work for no extra information. */
async function readInbound(room: Room): Promise<RTCStatsReport | null> {
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.videoTrackPublications.values()) {
      // RemoteVideoTrack carries the receiver; the union with LocalVideoTrack does not,
      // and a remote participant's publications only ever hold remote tracks.
      const receiver = (publication.videoTrack as RemoteVideoTrack | undefined)
        ?.receiver;
      if (receiver) return receiver.getStats();
    }
  }
  return null;
}

/**
 * The receiver's own answer to "how much delay am I adding".
 *
 * Mutates the delta state it is handed, because the useRef holding it is the only place
 * a window boundary can live — the alternative is recomputing a lifetime average that
 * stops responding to the network after the first minute.
 */
export function readPlayoutMs(
  stats: RTCStatsReport,
  previous: { delay: number; count: number; seeded: boolean },
): number {
  let delay = 0;
  let count = 0;
  stats.forEach((report) => {
    if (report.type !== "inbound-rtp" || report.kind !== "video") return;
    const r = report as {
      jitterBufferDelay?: number;
      jitterBufferEmittedCount?: number;
    };
    delay += r.jitterBufferDelay ?? 0;
    count += r.jitterBufferEmittedCount ?? 0;
  });

  const deltaDelay = delay - previous.delay;
  const deltaCount = count - previous.count;
  const first = !previous.seeded;
  previous.delay = delay;
  previous.count = count;
  // Seeded once there is something to measure against. Doing it on a report with no
  // frames in it would burn the seed on nothing and delay the first real reading.
  if (count > 0) previous.seeded = true;

  /* The first sample only establishes the baseline. Its delta is against zero, which is
   * the lifetime average — the reading this whole function exists to avoid. */
  if (first) return 0;
  // A window with no frames in it says nothing; reporting 0 would read as "no delay".
  if (deltaCount <= 0 || deltaDelay < 0) return 0;
  return (deltaDelay / deltaCount) * 1000;
}

/** One word for the indicator. */
export function describeQuality(health: NetworkHealth): {
  label: string;
  tone: "ok" | "warn" | "bad";
} {
  const excessMs =
    health.rttMs > 0 && health.rttFloorMs > 0
      ? health.rttMs - health.rttFloorMs
      : 0;
  /* Distance is not damage. A steady ~250 ms to Hetzner EU is the topology; LiveKit's own
   * quality enum still grades that middling, and trusting Poor/Good alone put a permanent
   * warn/bad banner on every India viewer whose route is fine. */
  const expectedRoute =
    health.rttMs > 0 &&
    health.rttMs <= RTT_OK_MS &&
    excessMs < RTT_EXCESS_BAD_MS &&
    health.lossPercent < BAD_LOSS_PERCENT;

  if (
    health.lossPercent >= BAD_LOSS_PERCENT * 2 ||
    (health.quality === ConnectionQuality.Poor && !expectedRoute)
  ) {
    return { label: "Poor connection", tone: "bad" };
  }
  if (health.degraded) {
    return { label: "Reduced quality", tone: "warn" };
  }
  if (
    health.quality === ConnectionQuality.Excellent ||
    expectedRoute ||
    health.quality === ConnectionQuality.Good
  ) {
    return {
      label:
        health.quality === ConnectionQuality.Excellent
          ? "Strong connection"
          : "Good connection",
      tone: "ok",
    };
  }
  return { label: "Checking connection", tone: "warn" };
}
