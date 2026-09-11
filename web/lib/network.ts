"use client";

import {
  ConnectionQuality,
  RoomEvent,
  Track,
  ScreenSharePresets,
  VideoPreset,
  VideoPresets,
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
  /** What the browser thinks it can send, in kbps. Zero when unknown. */
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
 * latency at all. The cases an absolute threshold was standing in for are covered better by
 * the other two signals: a saturated uplink shows up in `availableOutgoingBitrate`, and a
 * broken one loses packets. ~500 ms+ of *queueing* (excess) still degrades — see the bad
 * threshold below — which is the truly congested link, not the EU↔IN topology.
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

/* And the third signal, which is the one the user actually meant by "internet speed".
 *
 * Loss and RTT catch a connection that is breaking. They do NOT catch one that is merely
 * small: when the uplink is narrow but clean, the browser's congestion control simply
 * starves the encoders and nothing is lost or delayed — the picture is just soft, the frame
 * rate sags, and every threshold above stays green. That was a real gap, because a narrow
 * uplink is the common case on domestic wifi and a phone hotspot.
 *
 * `availableOutgoingBitrate` is the browser's own estimate of what it can send. Comparing it
 * against what the current rung of the ladder actually asks for turns the ladder into a
 * bandwidth decision rather than only a damage-control one.
 *
 * The margins are asymmetric on purpose, and it is the same asymmetry as everywhere else
 * here: step down when the estimate falls below 80% of what the rung needs, step up only
 * when it clears 140% of the rung above. A single band would have the tier oscillating
 * around one number, and the audience watching the resolution pump. */
const NEED_MARGIN_DOWN = 0.8;
const NEED_MARGIN_UP = 1.4;
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
/* Exported for one test, which pins the property that matters and cannot be read off the
 * page: that no two adjacent layers are so far apart that a subscriber falls through the gap
 * between them. See network.test.mts. */
export const LADDER: Record<
  PublishTier,
  { maxBitrate: number; scaleDown: number }[]
> = {
  // Three layers as published. The SFU chooses between them per subscriber.
  full: [
    { maxBitrate: VideoPresets.h180.encoding.maxBitrate, scaleDown: 4 },
    { maxBitrate: VideoPresets.h360.encoding.maxBitrate, scaleDown: 2 },
    { maxBitrate: VideoPresets.h720.encoding.maxBitrate, scaleDown: 1 },
  ],
  // The top layer goes. Two layers at a quarter of the bitrate, which is what a
  // struggling uplink can actually deliver — and the SFU still has a choice to make.
  reduced: [
    { maxBitrate: VideoPresets.h180.encoding.maxBitrate, scaleDown: 4 },
    { maxBitrate: VideoPresets.h360.encoding.maxBitrate, scaleDown: 2 },
    { maxBitrate: 0, scaleDown: 1 },
  ],
  // One small layer. Everything left goes to keeping a recognisable moving picture and
  // to protecting the audio, which is untouched at every rung.
  minimal: [
    { maxBitrate: VideoPresets.h180.encoding.maxBitrate, scaleDown: 4 },
    { maxBitrate: 0, scaleDown: 2 },
    { maxBitrate: 0, scaleDown: 1 },
  ],
};

/* The same three tiers, for a SCREEN SHARE — and a different policy from the camera.
 *
 * Camera under pressure: maintain-framerate, drop layers, accept blur.
 * Share under pressure: maintain-resolution / contentHint "detail", hold pixels, drop frames.
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
 * The rungs, per layer (desktop floor = 720p always active at full bitrate):
 *
 *            360p@3    720p        1080p@15   total
 *   full     200        800@15      2500      3500 kbps
 *   reduced  200        800@15      off       1000 kbps
 *   minimal  200        800@8       off       1000 kbps   ← fps down, not bitrate/resolution
 *
 * WHAT CHANGED (mid-session blur). Camera and share used to share ONE tier decision. Sharing
 * triples needKbps; on EU SFU + IN RTT the browser's availableOutgoingBitrate is often
 * pessimistic, so tooNarrow fired within seconds, both tracks stepped to minimal, and the
 * share's 720p rung was starved to 500 kbps — soft slides for the rest of the session.
 * Share now has its own judge (severe loss / extreme queueing / critically thin uplink only)
 * and minimal holds 720p@800k while cutting maxFramerate.
 *
 * Layers and ladder live HERE (not media.ts) so applyLadder's positional index cannot drift
 * from the published encodings. SHARE_TOP is separate because the SDK takes top encoding
 * apart from screenShareSimulcastLayers.
 */
/** Desktop publisher must not encode share content below this. */
export const SHARE_FLOOR_DESKTOP = { width: 1280, height: 720 } as const;
/** Mobile publisher capture/encode floor (360p equivalent). */
export const SHARE_FLOOR_MOBILE = { width: 640, height: 360 } as const;

/** Bitrate floor for the 720p share layer — never starve it into blur. */
export const SHARE_720_MIN_BITRATE = 800_000;

export const SHARE_LAYERS = [
  // Subscriber convenience for small phone tiles — not a desktop content floor.
  ScreenSharePresets.h360fps3,
  // Constructed: stock h720fps5 caps fps too hard; h720fps15 asks 1500 kbps.
  new VideoPreset(
    SHARE_FLOOR_DESKTOP.width,
    SHARE_FLOOR_DESKTOP.height,
    SHARE_720_MIN_BITRATE,
    15,
  ),
];

export const SHARE_TOP = ScreenSharePresets.h1080fps15;

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
  // Hold 720p bitrate; cut fps. Never drop the desktop floor layer or starve it below 800k.
  minimal: [
    { maxBitrate: SHARE_LAYERS[0].encoding.maxBitrate },
    {
      maxBitrate: SHARE_720_MIN_BITRATE,
      maxFramerate: 8,
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

/* `sharing` is not optional decoration: it roughly triples the answer.
 *
 * A camera at `full` needs ~2.3 Mbps; a camera plus a 1080p share needs ~5. Judging a
 * presenter's uplink against the camera figure alone while they are sharing meant tooNarrow
 * stayed false on a link that was already saturated — the ladder saw plenty of headroom and
 * never stepped down, which is precisely the case a screen share creates. Defaults to false so
 * every existing caller keeps its old meaning.
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
 * every way of getting it wrong is invisible in a browser. A missing bandwidth estimate read
 * as zero steps a healthy presenter to the floor; a margin pair that overlaps oscillates and
 * the audience watches the resolution pump. Neither shows up in a screenshot.
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
  /** Zero means the browser did not tell us — NOT that there is no bandwidth. */
  availableOutgoingKbps: number;
  /** True while a screen share is being published, which roughly triples the budget. */
  sharing?: boolean;
}): Verdict {
  const { tier, lossPercent, rttMs, rttFloorMs, availableOutgoingKbps } =
    sample;
  const sharing = sample.sharing === true;
  const at = TIERS.indexOf(tier);
  const haveEstimate = availableOutgoingKbps > 0;

  /* Queueing delay: how much worse than this route's best. Only meaningful once both numbers
   * exist, and until then latency has no vote — a presenter must not be stepped down by the
   * first reading after connecting, which is taken while the connection is still ramping and
   * is routinely the worst one of the whole session. */
  const measuredLatency = rttMs > 0 && rttFloorMs > 0;
  const excessMs = measuredLatency ? rttMs - rttFloorMs : 0;

  /* A narrow uplink, which is the case loss and RTT both miss: when there is not enough
   * room, congestion control starves the encoders rather than dropping packets, so the
   * picture goes soft while every other threshold stays green. */
  const tooNarrow =
    haveEstimate &&
    availableOutgoingKbps < needKbps(tier, sharing) * NEED_MARGIN_DOWN;

  /* Somewhere to grow, and something to grow into. Without an estimate this falls back to
   * "the rest of the signals look clean", which is how it behaved before bandwidth was a
   * signal at all — a subscriber-shaped sample must not be able to hold a presenter down. */
  const roomToGrow =
    at > 0 &&
    (!haveEstimate ||
      availableOutgoingKbps >=
        needKbps(TIERS[at - 1], sharing) * NEED_MARGIN_UP);

  return {
    bad:
      lossPercent >= BAD_LOSS_PERCENT ||
      excessMs >= RTT_EXCESS_BAD_MS ||
      tooNarrow,
    good:
      lossPercent <= GOOD_LOSS_PERCENT &&
      // Unknown latency does not block recovery. It used to be able to, and on a distant
      // route that meant the ladder could only ever go down.
      excessMs <= RTT_EXCESS_GOOD_MS &&
      roomToGrow,
  };
}

/* Screen-share degradation is NOT the camera ladder.
 *
 * Same sample, different bar. Ordinary long-haul jitter and a mildly pessimistic
 * availableOutgoingBitrate must not blur slides. Only severe loss, extreme queueing, or a
 * link that cannot carry the share floor itself steps the share down — and recovery is
 * willing once those clear. Camera still uses judge() with sharing:true so the face track
 * absorbs bandwidth pressure first.
 */
const SHARE_BAD_LOSS_PERCENT = 5;
const SHARE_RTT_EXCESS_BAD_MS = 400;
const SHARE_NEED_MARGIN_DOWN = 0.55;
const SHARE_NEED_MARGIN_UP = 1.25;
const SHARE_GOOD_LOSS_PERCENT = 1;

/**
 * judgeShare: step the share ladder only on severe damage, not on camera-shaped RTT noise.
 */
export function judgeShare(sample: {
  tier: PublishTier;
  lossPercent: number;
  rttMs: number;
  rttFloorMs: number;
  availableOutgoingKbps: number;
}): Verdict {
  const { tier, lossPercent, rttMs, rttFloorMs, availableOutgoingKbps } =
    sample;
  const at = TIERS.indexOf(tier);
  const haveEstimate = availableOutgoingKbps > 0;
  const measuredLatency = rttMs > 0 && rttFloorMs > 0;
  const excessMs = measuredLatency ? rttMs - rttFloorMs : 0;

  const tooNarrow =
    haveEstimate &&
    availableOutgoingKbps < shareNeedKbps(tier) * SHARE_NEED_MARGIN_DOWN;

  const roomToGrow =
    at > 0 &&
    (!haveEstimate ||
      availableOutgoingKbps >=
        shareNeedKbps(TIERS[at - 1]) * SHARE_NEED_MARGIN_UP);

  return {
    bad:
      lossPercent >= SHARE_BAD_LOSS_PERCENT ||
      excessMs >= SHARE_RTT_EXCESS_BAD_MS ||
      tooNarrow,
    good:
      lossPercent <= SHARE_GOOD_LOSS_PERCENT &&
      excessMs <= RTT_EXCESS_GOOD_MS &&
      roomToGrow,
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
          }
          // Never increase scaleResolutionDownBy — that would drop below the floor.
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

      /* Camera still budgets for the share when one is up — the uplink is shared — so the
       * face track absorbs pressure first. Share uses judgeShare and will often stay at
       * full while the camera alone steps down. */
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
        if (
          badSamples.current >= DEGRADE_AFTER_SAMPLES &&
          at < TIERS.length - 1
        ) {
          badSamples.current = 0;
          await applyCameraTier(TIERS[at + 1], camera);
        } else if (goodSamples.current >= RECOVER_AFTER_SAMPLES && at > 0) {
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
