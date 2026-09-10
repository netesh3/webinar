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
 * It was `bad: rtt >= 300` and `good: rtt <= 180`. On the deployment this runs on, the SFU is
 * in us-east-1 and the audience is in India: the measured round trip is 276-285 ms (see
 * e2e/probe-latency.mjs, which records exactly that). So:
 *
 *   - 280 ms sits 20 ms under the trigger. Any ordinary jitter spike crosses it, and two
 *     samples four seconds apart are enough to step the publisher down.
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
 * There is deliberately NO absolute ceiling left. A 400 ms route is a bad seat, not a bad
 * connection, and degrading video on it would cost picture while saving no latency at all.
 * The cases an absolute threshold was standing in for are covered better by the other two
 * signals: a saturated uplink shows up in `availableOutgoingBitrate`, and a broken one loses
 * packets.
 */
const RTT_EXCESS_BAD_MS = 120;
/** And what counts as drained. Asymmetric like every other pair here, so a connection sitting
 *  on one number does not thrash. */
const RTT_EXCESS_GOOD_MS = 50;

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

/* The same three tiers, for a SCREEN SHARE — three layers now, and the rungs mostly move
 * bitrate rather than resolution.
 *
 * That inversion is why 1080p is affordable at all. The camera ladder above turns layers OFF
 * as things get worse, because a camera under bitrate pressure is told to maintain-framerate:
 * it blurs, and a blurry face at 15fps is worse than a small sharp one.
 *
 * A share is the opposite. contentHint: "detail" (see media.ts) tells the encoder to hold the
 * pixels and drop frames, so squeezing a share turns it into a slower slideshow of legible
 * text. Dropping it to 360p makes the text unreadable at any framerate — which is the one
 * thing a screen share must never do, because reading it IS the content.
 *
 * The rungs, per layer:
 *
 *            360p@3    720p@15   1080p@15   total
 *   full     200        800      2500      3500 kbps
 *   reduced  200        800      off       1000 kbps
 *   minimal  200        500      off        700 kbps
 *
 * WHAT CHANGED AND WHY. There were two layers and the top one stayed 1080p at every rung. That
 * held the presenter's total down, and it left subscribers with a 12.5x gap to fall through —
 * see screenShareSimulcastLayers in media.ts for the complaint that produced. With a 720p layer
 * in the middle, a degraded tier is better spent turning the 1080p layer off and giving the
 * budget to 720p: 1200 kbps across 0.92 megapixels is visibly sharper than the same 1200 across
 * 2.07, and the totals at `reduced` and `minimal` are unchanged from before, so a struggling
 * uplink is asked for no more than it was.
 *
 * Only `full` costs more than it used to, by the 1500 kbps of the new layer, and only while the
 * uplink can carry it — which needKbps now tells judge() about, so the step down happens sooner
 * instead of the link quietly saturating.
 *
 * The low 360p layer is left active throughout. It is not the presenter's fallback; it is what
 * adaptiveStream hands a subscriber on a phone tethered to a bad signal, and turning it off to
 * save the presenter bandwidth would break exactly the people it exists for.
 */
/* The share's published layers, and the top encoding, live HERE rather than in media.ts.
 *
 * They used to sit beside the other publish options, one file away from the ladder that
 * budgets them — and the two have to agree exactly. applyLadder walks the sender's encodings
 * and indexes SHARE_LADDER by position, so a layer added in media.ts without a matching rung
 * here silently inherits the last rung's bitrate. That is the quiet half of the bug that
 * produced the 12.5x gap in the first place.
 *
 * Resolutions and budgets in one place means a change to either is a change you can see
 * against the other. media.ts imports these; nothing here imports media.ts, which is also
 * what keeps this module loadable by the test.
 *
 * SHARE_TOP is separate because the SDK takes it separately: screenShareEncoding is the top
 * layer and screenShareSimulcastLayers are the ones below it. Total encodings is therefore
 * SHARE_LAYERS.length + 1, which is what SHARE_LADDER's rung count has to match.
 */
/* THREE layers, not two, and the middle one is the fix for a real complaint.
 *
 * There used to be one fallback — h360fps3 — so the set on offer was:
 *
 *   640x360   @3fps    200 kbps
 *   1920x1080 @15fps  2500 kbps
 *
 * A 12.5x bitrate step with nothing in between. adaptiveStream picks per subscriber from what
 * is published, so anybody who could not sustain 2.5 Mbps did not step down — they fell all
 * the way to 360p at three frames a second. For a slide with text on it that is unreadable,
 * and "the screen share quality is poor" is exactly what it looks like from the other end.
 * Most domestic connections live in that gap.
 *
 * The middle layer is 1280x720 at 15fps and 800 kbps. Each of those three numbers is chosen
 * against a failure:
 *
 *   720p    enough pixels for text. 360p is not, at any bitrate.
 *   15fps   NOT the stock h720fps5 preset, whose maxFramerate is a hard cap — a subscriber on
 *           it would be pinned to five frames a second even with bandwidth to spare, which
 *           ruins a shared video clip. 15 matches the top layer so the two look alike.
 *   800k    reachable. 1500 kbps looked like the obvious middle and left a 7.5x step up from
 *           the 200 kbps floor, so everyone between roughly 300 kbps and 1.5 Mbps still fell
 *           to 360p@3. A test caught it; see network.test.mts. 800 makes the two steps 4x and
 *           3.1x, with nothing to fall through.
 *
 * The cost is the presenter's uplink, because simulcast pays for every ACTIVE layer — a
 * full-tier share went from ~2.7 to ~3.5 Mbps. needKbps accounts for it, so the ladder steps
 * down sooner on a thin uplink rather than overcommitting.
 *
 * EGRESS does not go up, and probably goes down: the SFU forwards one layer per subscriber,
 * and everybody who used to be handed 2500 kbps because it was the only real option can now be
 * served at 800.
 *
 * Deliberately not a fourth layer. Two 720p entries at different frame rates would be two
 * encoders producing the same pixel count, and the encode cost lands on the one machine that
 * can least afford it — the presenter's, which is already running a camera ladder beside this.
 */
export const SHARE_LAYERS = [
  ScreenSharePresets.h360fps3,
  // Constructed rather than picked from ScreenSharePresets, because none of them is 720p at a
  // watchable frame rate for under a megabit: h720fps5 caps at 5fps and h720fps15 asks 1500.
  new VideoPreset(1280, 720, 800_000, 15),
];

export const SHARE_TOP = ScreenSharePresets.h1080fps15;

export const SHARE_LADDER: Record<PublishTier, { maxBitrate: number }[]> = {
  // Derived from SHARE_LAYERS wherever the value is the layer's own, so a change to a layer
  // moves its rung too instead of leaving a stale number here.
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
  minimal: [
    { maxBitrate: SHARE_LAYERS[0].encoding.maxBitrate },
    { maxBitrate: 500_000 },
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
    bits += SHARE_LADDER[tier].reduce(
      (total, rung) => total + rung.maxBitrate,
      0,
    );
  }
  return Math.round(bits / 1000) + AUDIO_KBPS;
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

  /* One tier decision, two ladders.
   *
   * The judgement is about the uplink, which both tracks share, so there is exactly one tier.
   * What differs is what a tier MEANS for each: the camera drops layers, the share keeps 1080p
   * and cuts its budget. Passing the ladder in rather than branching inside keeps that
   * difference stated in one place — see SHARE_LADDER.
   */
  const applyLadder = useCallback(
    async (
      next: PublishTier,
      track: LocalVideoTrack,
      ladder: Record<PublishTier, { maxBitrate: number }[]>,
    ) => {
      const sender = track.sender;
      if (!sender) return;
      try {
        const params = sender.getParameters();
        if (!params.encodings?.length) return;
        const wanted = ladder[next];
        params.encodings.forEach((encoding, i) => {
          const rung = wanted[i] ?? wanted[wanted.length - 1];
          // Zero means "off". active=false stops the layer being encoded at all, which
          // is the point — a starved encoder producing broken frames is worse than no
          // layer, because the SFU may still forward it.
          encoding.active = rung.maxBitrate > 0;
          if (rung.maxBitrate > 0) encoding.maxBitrate = rung.maxBitrate;
        });
        await sender.setParameters(params);
      } catch {
        // A browser that refuses leaves the tier where it was, and the next sample
        // tries again.
      }
    },
    [],
  );

  /* applyTier moves BOTH tracks and is the only place tier.current is written.
   *
   * The camera is applied first and the share second, deliberately: if the share's
   * setParameters throws — Safari has historically refused fields it does not know — the
   * camera has already been stepped down, which is the half that protects the room's audio
   * budget. Recording the tier regardless means the next sample will retry the share rather
   * than concluding the step never happened and doing the camera twice.
   */
  const applyTier = useCallback(
    async (
      next: PublishTier,
      camera?: LocalVideoTrack,
      share?: LocalVideoTrack,
    ) => {
      if (camera) await applyLadder(next, camera, LADDER);
      if (share) await applyLadder(next, share, SHARE_LADDER);
      tier.current = next;
    },
    [applyLadder],
  );

  useEffect(() => {
    if (!room) return;

    let cancelled = false;

    const sample = async () => {
      const local = room.localParticipant;
      const camera = local?.getTrackPublication(Track.Source.Camera)
        ?.videoTrack as LocalVideoTrack | undefined;
      /* The share is sampled and stepped on the same schedule as the camera.
       *
       * It is by far the more expensive of the two — a 1080p share is 2.5 Mbps against the
       * camera's 2.3 for three layers — so a ladder that moved only the camera would be
       * adjusting the cheaper half of the problem while the expensive half held the link
       * saturated. */
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

      const at = TIERS.indexOf(tier.current);
      const { bad, good } = judge({
        tier: tier.current,
        lossPercent,
        rttMs,
        rttFloorMs,
        availableOutgoingKbps,
        sharing: Boolean(share),
      });

      if (bad) {
        goodSamples.current = 0;
        badSamples.current += 1;
      } else if (good) {
        badSamples.current = 0;
        goodSamples.current += 1;
      }

      /* Only a publisher has a ladder to move — and `camera || share` rather than `camera`,
       * because a presenter who shares their screen with the camera off is the common case in
       * a webinar and used to get no adaptation at all. */
      if (publishing && (camera || share)) {
        if (
          badSamples.current >= DEGRADE_AFTER_SAMPLES &&
          at < TIERS.length - 1
        ) {
          badSamples.current = 0;
          await applyTier(TIERS[at + 1], camera, share);
        } else if (goodSamples.current >= RECOVER_AFTER_SAMPLES && at > 0) {
          goodSamples.current = 0;
          await applyTier(TIERS[at - 1], camera, share);
        }
      }

      if (cancelled) return;
      setHealth({
        quality: local?.connectionQuality ?? ConnectionQuality.Unknown,
        lossPercent: Math.round(lossPercent * 10) / 10,
        rttMs: Math.round(rttMs),
        rttFloorMs: Math.round(rttFloorMs),
        jitterMs: Math.round(jitterMs),
        playoutMs: Math.round(playoutMs),
        availableOutgoingKbps,
        tier: tier.current,
        degraded: tier.current !== "full",
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
      if (publishing && (camera || share) && tier.current !== "full") {
        void applyTier(tier.current, camera, share);
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
     * So a presenter already stepped down to `minimal` who then starts sharing would publish
     * that share at the full 2 500 kbps — on the connection that caused the step down in the
     * first place — and stay there until two more bad samples accumulated, four seconds later.
     * Four seconds of a saturated uplink is exactly when the audience loses audio.
     *
     * Reasserting on publish rather than waiting for the next judgement closes that window.
     * Cheap and idempotent: at `full` there is nothing to change, which is the common case. */
    const onLocalPublished = () => {
      if (!publishing || tier.current === "full") return;
      const local = room.localParticipant;
      const camera = local?.getTrackPublication(Track.Source.Camera)
        ?.videoTrack as LocalVideoTrack | undefined;
      const share = local?.getTrackPublication(Track.Source.ScreenShare)
        ?.videoTrack as LocalVideoTrack | undefined;
      if (camera || share) void applyTier(tier.current, camera, share);
    };
    room.on(RoomEvent.LocalTrackPublished, onLocalPublished);

    return () => {
      cancelled = true;
      clearInterval(timer);
      room.off(RoomEvent.ConnectionQualityChanged, onQuality);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.LocalTrackPublished, onLocalPublished);
    };
  }, [room, publishing, applyTier]);

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
  if (
    health.quality === ConnectionQuality.Poor ||
    health.lossPercent >= BAD_LOSS_PERCENT * 2
  ) {
    return { label: "Poor connection", tone: "bad" };
  }
  if (health.degraded || health.quality === ConnectionQuality.Good) {
    return {
      label: health.degraded ? "Reduced quality" : "Good connection",
      tone: "warn",
    };
  }
  if (health.quality === ConnectionQuality.Excellent) {
    return { label: "Strong connection", tone: "ok" };
  }
  return { label: "Checking connection", tone: "warn" };
}
