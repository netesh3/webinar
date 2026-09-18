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

/** How long a bad patch has to last before quality drops. Two samples: one is a
 *  hiccup, and reacting to a hiccup is how the picture ends up pumping. */
const DEGRADE_AFTER_SAMPLES = 2;
/** How long it has to be clear before quality climbs. Six samples — twelve seconds —
 *  because the step up is itself a bandwidth increase, and doing it eagerly recreates
 *  the congestion that caused the step down. */
const RECOVER_AFTER_SAMPLES = 6;
const SAMPLE_MS = 2000;

/* What counts as trouble.
 *
 * Two percent loss is roughly where video starts to visibly break up.
 */
const BAD_LOSS_PERCENT = 2;

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
const RTT_EXCESS_BAD_MS = 200;
/** And what counts as drained. Asymmetric like every other pair here, so a connection sitting
 *  on one number does not thrash. */
const RTT_EXCESS_GOOD_MS = 80;
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
const GOOD_LOSS_PERCENT = 0.5;

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
 * a 1080p top layer is not empty pixels for the featured face. Grids and filmstrips stay on
 * 720p / 360p via subscriber quality selection + dynacast.
 *
 *            360p     720p@30    1080p@30   total
 *   full     600      2000        3200       5800 kbps
 *   reduced  600      2000        off        2600 kbps   ← while sharing / mild congestion
 *   minimal  600      off         off         600 kbps
 *
 * 1080p maxBitrate ~3.2 Mbps sits under Zoom's documented ~3.8 Mbps send requirement for
 * Full HD; 720p mid stays in Zoom's common HD band. maintain-framerate still applies: faces
 * prefer motion over a sharp slideshow.
 */
/** Mid simulcast rung — Zoom-comparable 720p when the tile is not large enough for 1080. */
export const CAMERA_720_BITRATE = 2_000_000;
/** Featured-speaker 1080p — under Zoom's ~3.8 Mbps Full HD send floor. */
export const CAMERA_1080_BITRATE = 3_200_000;

export const CAMERA_LAYERS = [
  new VideoPreset(640, 360, 600_000, 20),
  new VideoPreset(1280, 720, CAMERA_720_BITRATE, 30),
];

export const CAMERA_TOP = new VideoPreset(1920, 1080, CAMERA_1080_BITRATE, 30);

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

/** Capture resolution/encoding for getUserMedia — 1080 when allowed, else the 720 mid rung. */
export function cameraCapturePreset(): VideoPreset {
  return canCaptureCamera1080() ? CAMERA_TOP : CAMERA_LAYERS[1];
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
    { maxBitrate: CAMERA_LAYERS[0].encoding.maxBitrate, scaleDown: 3 },
    { maxBitrate: CAMERA_LAYERS[1].encoding.maxBitrate, scaleDown: 2 },
    { maxBitrate: CAMERA_TOP.encoding.maxBitrate, scaleDown: 1 },
  ],
  // The top (1080p) layer goes. 720p remains so a large tile does not fall to 360p.
  reduced: [
    { maxBitrate: CAMERA_LAYERS[0].encoding.maxBitrate, scaleDown: 3 },
    { maxBitrate: CAMERA_LAYERS[1].encoding.maxBitrate, scaleDown: 2 },
    { maxBitrate: 0, scaleDown: 1 },
  ],
  // One small layer. Everything left goes to keeping a recognisable moving picture and
  // to protecting the audio, which is untouched at every rung.
  minimal: [
    { maxBitrate: CAMERA_LAYERS[0].encoding.maxBitrate, scaleDown: 3 },
    { maxBitrate: 0, scaleDown: 2 },
    { maxBitrate: 0, scaleDown: 1 },
  ],
};

/* The same three tiers, for a SCREEN SHARE — and a different policy from the camera.
 *
 * Camera under pressure: maintain-framerate, drop layers, accept blur.
 * Share under pressure: maintain-resolution / contentHint "text", hold pixels, drop frames.
 * Reading the slide IS the content; a sharp 720p at 8fps beats a soft 360p at 30.
 *
 * Encode floors (publisher):
 *   desktop  never scale share content below 1280×720
 *   mobile   never below 640×360 (capture floor; getDisplayMedia is rare on phones)
 *
 * The 360p simulcast layer stays published for tiny mobile *subscriber* tiles via
 * adaptiveStream. It is not the presenter's fallback and must never become the only live
 * layer a desktop viewer of a fullscreen share can land on when the ladder panics.
 *
 * The rungs, per layer (desktop floor = 720p always active at a text-readable bitrate):
 *
 *            360p@3    720p         1080p@15   total
 *   full     700       3000@15       5000      8700 kbps
 *   reduced  700       3000@15       off       3700 kbps
 *   minimal  700       3000@8        off       3700 kbps   ← fps down, not bitrate/resolution
 *
 * WHY ~3 Mbps / ~5 Mbps (not 2 / 3.5). Desktop content needs bitrate more than faces —
 * H.264 spends a thin budget on motion and leaves text muddy. Zoom content share is
 * typically several Mbps at high resolution and low fps; we close that encode gap while
 * accepting we cannot erase India→EU path RTT vs Zoom's nearby PoPs.
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

/** Bitrate floor for the 720p share layer — text needs ~3 Mbps, not a camera-like 800k. */
export const SHARE_720_MIN_BITRATE = 3_000_000;

/** Low share simulcast rung: enough that 360p→720p stays under a 5× SFU cliff. */
const SHARE_LOW_BITRATE = 700_000;

/** Sharp 1080p ceiling for fullscreen desktop viewers (Zoom-like content bitrate). */
const SHARE_1080_BITRATE = 5_000_000;

export const SHARE_LAYERS = [
  // Subscriber convenience for small phone tiles — not a desktop content floor.
  new VideoPreset(640, 360, SHARE_LOW_BITRATE, 5),
  // 720p@30fps for smooth motion & presentation clarity.
  new VideoPreset(
    SHARE_FLOOR_DESKTOP.width,
    SHARE_FLOOR_DESKTOP.height,
    SHARE_720_MIN_BITRATE,
    30,
  ),
];

export const SHARE_TOP = new VideoPreset(1920, 1080, SHARE_1080_BITRATE, 30);

/** One share-ladder rung: bitrate, optional fps cap, never a resolution drop below the floor. */
export type ShareRung = {
  maxBitrate: number;
  /** When set, prefer dropping frames over starving bitrate (detail / text). */
  maxFramerate?: number;
};

export const SHARE_LADDER: Record<PublishTier, ShareRung[]> = {
  full: [
    { maxBitrate: SHARE_LAYERS[0].encoding.maxBitrate },
    { maxBitrate: SHARE_LAYERS[1].encoding.maxBitrate },
    { maxBitrate: SHARE_TOP.encoding.maxBitrate },
  ],
  reduced: [
    { maxBitrate: SHARE_LAYERS[0].encoding.maxBitrate },
    { maxBitrate: SHARE_LAYERS[1].encoding.maxBitrate },
    { maxBitrate: 0 },
  ],
  // Hold 720p bitrate; cut fps. Never drop the desktop floor layer or starve it below 2 Mbps.
  minimal: [
    { maxBitrate: SHARE_LAYERS[0].encoding.maxBitrate },
    {
      maxBitrate: SHARE_720_MIN_BITRATE,
      maxFramerate: 20,
    },
    { maxBitrate: 0 },
  ],
};

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
export function shareNeedBits(tier: PublishTier): number {
  return SHARE_LADDER[tier].reduce((total, rung) => total + rung.maxBitrate, 0);
}

/** Share-only budget in kbps (includes the same audio allowance as needKbps). */
export function shareNeedKbps(tier: PublishTier): number {
  return Math.round(shareNeedBits(tier) / 1000) + AUDIO_KBPS;
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
const SHARE_BAD_LOSS_PERCENT = 5;
const SHARE_RTT_EXCESS_BAD_MS = 400;
const SHARE_GOOD_LOSS_PERCENT = 1;

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

/**
 * Samples the connection and holds the publish ladder where it belongs.
 *
 * Returns what it sees, so the UI can show it. The stepping happens as a side effect
 * because it has to happen whether or not anything is rendering an indicator — a
 * presenter with the settings dialog closed is exactly who needs it.
 */
export function useNetworkHealth(
  room: Room | null,
  publishing: boolean,
): NetworkHealth {
  const [health, setHealth] = useState<NetworkHealth>(IDLE);

  // The decision state, in refs: it changes every two seconds and nothing renders from
  // it directly.
  const badSamples = useRef(0);
  const goodSamples = useRef(0);
  const tier = useRef<PublishTier>("full");
  // Share has its own counters and tier — same uplink, much higher bar to blur slides.
  const shareBadSamples = useRef(0);
  const shareGoodSamples = useRef(0);
  const shareTier = useRef<PublishTier>("full");
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

  /* Two ladders, two apply paths.
   *
   * Camera drops layers (and historically ignored scaleDown in the table — bitrate/active
   * only). Share also sets maxFramerate so minimal can hold 720p pixels while cutting fps,
   * and never raises scaleResolutionDownBy (that would violate the desktop floor).
   */
  const applyCameraLadder = useCallback(
    async (next: PublishTier, track: LocalVideoTrack) => {
      const sender = track.sender;
      if (!sender) return;
      try {
        const params = sender.getParameters();
        if (!params.encodings?.length) return;
        const wanted = LADDER[next];
        params.encodings.forEach((encoding, i) => {
          const rung = wanted[i] ?? wanted[wanted.length - 1];
          encoding.active = rung.maxBitrate > 0;
          if (rung.maxBitrate > 0) encoding.maxBitrate = rung.maxBitrate;
        });
        await sender.setParameters(params);
      } catch {
        // A browser that refuses leaves the tier where it was; the next sample retries.
      }
    },
    [],
  );

  const applyShareLadder = useCallback(
    async (next: PublishTier, track: LocalVideoTrack) => {
      const sender = track.sender;
      if (!sender) return;
      try {
        const params = sender.getParameters();
        if (!params.encodings?.length) return;
        const wanted = SHARE_LADDER[next];
        /* Capture is typically 1080p; mid (720p) and high (1080p) layers must not keep a
         * congestion-era scaleResolutionDownBy that left text soft. Low (360p) may stay
         * scaled for tiny subscriber tiles. */
        const sourceH =
          track.mediaStreamTrack?.getSettings?.().height ||
          SHARE_TOP.height;
        params.encodings.forEach((encoding, i) => {
          const rung = wanted[i] ?? wanted[wanted.length - 1];
          encoding.active = rung.maxBitrate > 0;
          if (rung.maxBitrate > 0) {
            encoding.maxBitrate = rung.maxBitrate;
            if (rung.maxFramerate != null) {
              encoding.maxFramerate = rung.maxFramerate;
            } else if (encoding.maxFramerate != null) {
              // Restore the published default when climbing off a fps-capped rung.
              const layer =
                i < SHARE_LAYERS.length ? SHARE_LAYERS[i] : SHARE_TOP;
              encoding.maxFramerate = layer.encoding.maxFramerate;
            }
            if (i >= 1) {
              const targetH =
                i < SHARE_LAYERS.length
                  ? SHARE_LAYERS[i].height
                  : SHARE_TOP.height;
              const designed = Math.max(1, sourceH / targetH);
              const current = encoding.scaleResolutionDownBy ?? designed;
              // Clamp upscales-of-downscale only — never soft-blur past the designed rung.
              if (current > designed + 0.05) {
                encoding.scaleResolutionDownBy = designed;
              }
            }
          }
        });
        await sender.setParameters(params);
      } catch {
        // Same as camera: leave tier recorded; retry next sample.
      }
    },
    [],
  );

  /* applyCamera / applyShare write their own tier refs. Camera first when both move: if the
   * share's setParameters throws, the camera has already freed uplink for audio.
   */
  const applyCameraTier = useCallback(
    async (next: PublishTier, camera?: LocalVideoTrack) => {
      if (camera) await applyCameraLadder(next, camera);
      tier.current = next;
    },
    [applyCameraLadder],
  );

  const applyShareTier = useCallback(
    async (next: PublishTier, share?: LocalVideoTrack) => {
      if (share) await applyShareLadder(next, share);
      shareTier.current = next;
    },
    [applyShareLadder],
  );

  const reassertTiers = useCallback(
    async (camera?: LocalVideoTrack, share?: LocalVideoTrack) => {
      if (camera && tier.current !== "full") {
        await applyCameraTier(tier.current, camera);
      }
      if (share && shareTier.current !== "full") {
        await applyShareTier(shareTier.current, share);
      }
    },
    [applyCameraTier, applyShareTier],
  );

  useEffect(() => {
    if (!room) return;

    let cancelled = false;

    const sample = async () => {
      const local = room.localParticipant;
      const camera = local?.getTrackPublication(Track.Source.Camera)
        ?.videoTrack as LocalVideoTrack | undefined;
      /* The share is sampled on the same schedule, but judged and stepped separately —
       * see judgeShare. */
      const share = local?.getTrackPublication(Track.Source.ScreenShare)
        ?.videoTrack as LocalVideoTrack | undefined;

      // A subscriber has no outbound video to measure, so the inbound side is read
      // instead: their experience is decided by what is arriving.
      const target = camera?.sender ?? share?.sender ?? null;
      let lossPercent = 0;
      let rttMs = 0;
      let jitterMs = 0;
      let playoutMs = 0;
      let availableOutgoingKbps = 0;

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
            if (r.jitter) jitterMs = Math.max(jitterMs, r.jitter * 1000);
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

      const sampleBase = {
        lossPercent,
        rttMs,
        rttFloorMs,
        availableOutgoingKbps,
      };

      /* Camera and share share the same loss/queueing sample but different bars —
       * see judge vs judgeShare. Bitrate estimate is sampled for the readout only. */
      const cameraVerdict = judge({
        tier: tier.current,
        ...sampleBase,
        sharing: Boolean(share),
      });

      if (cameraVerdict.bad) {
        goodSamples.current = 0;
        badSamples.current += 1;
      } else if (cameraVerdict.good) {
        badSamples.current = 0;
        goodSamples.current += 1;
      }

      if (publishing && camera) {
        const at = TIERS.indexOf(tier.current);
        /* While screen-sharing, or on a device that should not encode 1080, keep the
         * camera off the top rung. Thumbnails do not need 1080; low-power machines
         * should not encode it. Cap at `reduced` (360+720) and refuse to climb to
         * `full` until the share ends / the device is allowed 1080. */
        const cameraBest = share || !canCaptureCamera1080() ? 1 : 0;
        if (at < cameraBest) {
          badSamples.current = 0;
          goodSamples.current = 0;
          await applyCameraTier(TIERS[cameraBest], camera);
        } else if (
          badSamples.current >= DEGRADE_AFTER_SAMPLES &&
          at < TIERS.length - 1
        ) {
          badSamples.current = 0;
          await applyCameraTier(TIERS[at + 1], camera);
        } else if (
          goodSamples.current >= RECOVER_AFTER_SAMPLES &&
          at > cameraBest
        ) {
          goodSamples.current = 0;
          await applyCameraTier(TIERS[at - 1], camera);
        }
      }

      if (share) {
        const shareVerdict = judgeShare({
          tier: shareTier.current,
          ...sampleBase,
        });
        if (shareVerdict.bad) {
          shareGoodSamples.current = 0;
          shareBadSamples.current += 1;
        } else if (shareVerdict.good) {
          shareBadSamples.current = 0;
          shareGoodSamples.current += 1;
        }

        if (publishing) {
          const at = TIERS.indexOf(shareTier.current);
          if (
            shareBadSamples.current >= DEGRADE_AFTER_SAMPLES &&
            at < TIERS.length - 1
          ) {
            shareBadSamples.current = 0;
            await applyShareTier(TIERS[at + 1], share);
          } else if (
            shareGoodSamples.current >= RECOVER_AFTER_SAMPLES &&
            at > 0
          ) {
            shareGoodSamples.current = 0;
            await applyShareTier(TIERS[at - 1], share);
          }
        }
      } else {
        // Next share starts clean rather than inheriting a previous session's floor.
        shareTier.current = "full";
        shareBadSamples.current = 0;
        shareGoodSamples.current = 0;
      }

      if (cancelled) return;
      const publishedTier = share
        ? worseTier(tier.current, shareTier.current)
        : tier.current;
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

    // A reconnect renegotiates, which resets the senders. The ladder has to be
    // reasserted or a publisher silently returns to full after every blip.
    const onReconnected = () => {
      const local = room.localParticipant;
      const camera = local?.getTrackPublication(Track.Source.Camera)
        ?.videoTrack as LocalVideoTrack | undefined;
      const share = local?.getTrackPublication(Track.Source.ScreenShare)
        ?.videoTrack as LocalVideoTrack | undefined;
      if (publishing && (camera || share)) {
        void reassertTiers(camera, share);
      }
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

    /* A newly published track starts at the publish defaults, not at the current tier.
     *
     * So a presenter already stepped down who then starts sharing would publish that share
     * at full 1080p on a connection that may still be fine for share (judgeShare) — or, if
     * shareTier was somehow not full, reassert. Camera reassert closes the same window.
     */
    const onLocalPublished = () => {
      if (!publishing) return;
      const local = room.localParticipant;
      const camera = local?.getTrackPublication(Track.Source.Camera)
        ?.videoTrack as LocalVideoTrack | undefined;
      const share = local?.getTrackPublication(Track.Source.ScreenShare)
        ?.videoTrack as LocalVideoTrack | undefined;
      if (camera || share) void reassertTiers(camera, share);
    };
    room.on(RoomEvent.LocalTrackPublished, onLocalPublished);

    return () => {
      cancelled = true;
      clearInterval(timer);
      room.off(RoomEvent.ConnectionQualityChanged, onQuality);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.LocalTrackPublished, onLocalPublished);
    };
  }, [room, publishing, applyCameraTier, applyShareTier, reassertTiers]);

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
