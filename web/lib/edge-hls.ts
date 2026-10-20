/* hls.js settings and playback-mode policy for the Edge-delivery audience player
 * (components/room/edge-player.tsx).
 *
 * Two modes, one hls.js instance.
 *
 *  - standard: whole 1s segments, about three behind live. Few requests, so it plays
 *    smoothly even when every request is a long round trip.
 *  - low-latency: LL-HLS 500ms parts with blocking playlist reloads, about 1.5–2.5s behind
 *    the origin. Several requests a second, so it only works when requests are fast.
 *
 * Measured from India against the Germany origin through Cloudflare (2026-10-18): ~0.4–0.5s
 * to first byte per request, ~0.9s for a 200ms part. LL-HLS cannot keep up with that: the
 * player falls behind (6–8s), jumps back to live (1.9s), stutters and shows black. So a viewer
 * starts in standard mode unless the server says the playback URL is a CDN close to them
 * (JoinResponse.lowLatency), measures its own fragment requests, and only then moves up to
 * low-latency — once. If low-latency then stalls repeatedly it drops back for good.
 *
 * The constructor config deliberately sets NO liveSyncDurationCount / liveSyncDuration.
 * hls.js honours the playlist's PART-HOLD-BACK only when the caller left those unset (it
 * checks the user config, not the live one — see 6ffc2e2), and the mode is switched at
 * runtime with hls.lowLatencyMode so the video element is never torn down (that is black).
 * Without them standard mode lands on hls.js's 3 × target duration, which against MediaMTX
 * is often 6s, so the player aims for its own target there (STANDARD_TARGET_SECONDS). */

export type PlaybackMode = "standard" | "low-latency";

export type EdgeHlsConfig = {
  lowLatencyMode: boolean;
  liveDurationInfinity: boolean;
  maxBufferLength: number;
  backBufferLength: number;
  maxLiveSyncPlaybackRate: number;
  liveSyncOnStallIncrease: number;
  enableWorker: boolean;
  manifestLoadingMaxRetry: number;
  manifestLoadingRetryDelay: number;
  manifestLoadingMaxRetryTimeout: number;
  levelLoadingMaxRetry: number;
  levelLoadingRetryDelay: number;
  fragLoadingMaxRetry: number;
  fragLoadingRetryDelay: number;
};

/** maxBufferLength for each mode: a little more cushion when every request is slow. */
export const MODE_BUFFER: Record<PlaybackMode, number> = { standard: 6, "low-latency": 4 };

export function edgeHlsConfig(mode: PlaybackMode): EdgeHlsConfig {
  return {
    lowLatencyMode: mode === "low-latency",
    liveDurationInfinity: true,
    maxBufferLength: MODE_BUFFER[mode],
    backBufferLength: 10,
    /* 1: hls.js never changes the playback speed. It sped up to 1.15× and back whenever the
     * latency was over its target, and with 250ms parts the target (PART-HOLD-BACK, ~0.67s)
     * is below what fetching parts allows, so it chased it all the time — and the browser's
     * time-stretching made speech and shared music warble and "cut out" (2026-10-20). Drift
     * is corrected by skipping forward inside the buffer instead (CATCH_UP.jumpAbove). */
    maxLiveSyncPlaybackRate: 1,
    // hls.js adds this to its target latency for every stall, up to one target duration (2s
    // against MediaMTX), and never takes it back. At its default of 1s the two stalls of a
    // normal join left a viewer at 3.3s for the whole session where the playlist asks for
    // 1.3s (edge test, 2026-10-19). A connection that keeps stalling still reaches the cap.
    liveSyncOnStallIncrease: 0.25,
    enableWorker: true,
    // The origin 404s for the first seconds of a broadcast while the egress boots.
    manifestLoadingMaxRetry: 120,
    manifestLoadingRetryDelay: 1000,
    manifestLoadingMaxRetryTimeout: 300_000,
    levelLoadingMaxRetry: 60,
    levelLoadingRetryDelay: 1000,
    fragLoadingMaxRetry: 60,
    fragLoadingRetryDelay: 1000,
  };
}

/** A fragment request faster than this to first byte means the origin is close enough for LL. */
export const LL_TTFB_MS = 120;
/** Fragment samples to collect before deciding, and the longest we wait for them. */
export const DECIDE_SAMPLES = 6;
export const DECIDE_WINDOW_MS = 15_000;
/** More than this many stalls inside the window drops low-latency back to standard. */
export const MAX_LL_STALLS = 2;
export const STALL_WINDOW_MS = 30_000;
/* After a drop to standard, low latency is tried again once standard has played this long
 * without a stall, at most LL_RETRIES times a session. The drop used to be for good: one
 * network dip (six stalls in 30s, then none for the next fifteen minutes) kept a viewer at
 * ~5.4s behind until the webinar ended (instant-webinar-9277, 2026-10-20). */
export const LL_RETRY_AFTER_MS = 90_000;
export const LL_RETRIES = 2;
/** Stalls this soon after the first frame plays never drop low-latency. Joining stalls while
 * the buffer first fills and hls.js settles on its target; counted, those alone sent a viewer
 * to standard for the whole session within seconds of joining (edge test, 2026-10-19).
 *
 * From the first frame, not from the player opening: a viewer who arrives before the mix has
 * started (the worker is still booting) waits a minute on "waiting for the broadcast", and a
 * grace timed from then had run out before the first frame — so the startup stalls counted
 * and the viewer sat in standard at ~4.5s for good (edge test, 2026-10-20). */
export const STARTUP_GRACE_MS = 15_000;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* ModeDecider is the whole policy, free of hls.js and timers so it can be tested.
 *
 * Feed it fragment load times and stalls; it says when to change mode. It changes mode at
 * most twice in a session — up to low-latency once, down once — so a viewer on the edge of
 * the threshold does not flap between the two. */
export class ModeDecider {
  mode: PlaybackMode;
  private readonly startedAt: number;
  private samples: number[] = [];
  private stalls: number[] = [];
  private decided: boolean;
  private locked = false;
  /** When the first frame played; stalls before it, and for STARTUP_GRACE_MS after, are startup. */
  private firstFrameAt: number | null = null;
  /** Set while in standard after a drop from low latency: when standard last stalled. */
  private quietSince: number | null = null;
  private retries = 0;

  constructor(opts: { cdn: boolean; now: number }) {
    this.mode = opts.cdn ? "low-latency" : "standard";
    this.startedAt = opts.now;
    // A CDN start is already the decision; the stall rule still applies.
    this.decided = opts.cdn;
  }

  /** The TTFB samples so far, for telemetry. */
  medianTtfb(): number | null {
    return median(this.samples);
  }

  stallCount(now: number): number {
    return this.stalls.filter((t) => now - t <= STALL_WINDOW_MS).length;
  }

  /** A fragment (or part) finished loading; ttfbMs is request start to first byte. */
  fragmentLoaded(ttfbMs: number, now: number): PlaybackMode | null {
    if (!Number.isFinite(ttfbMs) || ttfbMs < 0) return null;
    if (this.samples.length < 50) this.samples.push(ttfbMs);
    if (this.decided || this.locked) return null;
    const enough = this.samples.length >= DECIDE_SAMPLES;
    const late = now - this.startedAt >= DECIDE_WINDOW_MS;
    if (!enough && !late) return null;
    this.decided = true;
    const m = median(this.samples);
    if (m != null && m < LL_TTFB_MS && this.samples.length >= DECIDE_SAMPLES) {
      this.mode = "low-latency";
      return this.mode;
    }
    return null;
  }

  /** The first frame played. Only the first call counts. */
  played(now: number): void {
    if (this.firstFrameAt === null) this.firstFrameAt = now;
  }

  /** The video stalled waiting for data. Returns "standard" when low-latency should give up. */
  stalled(now: number): PlaybackMode | null {
    if (this.firstFrameAt === null || now - this.firstFrameAt < STARTUP_GRACE_MS) return null;
    this.stalls.push(now);
    this.stalls = this.stalls.filter((t) => now - t <= STALL_WINDOW_MS);
    if (this.mode === "standard" && this.quietSince !== null) this.quietSince = now;
    if (this.mode === "low-latency" && this.stalls.length > MAX_LL_STALLS) {
      this.mode = "standard";
      this.locked = true;
      this.decided = true;
      this.quietSince = this.retries < LL_RETRIES ? now : null;
      return this.mode;
    }
    return null;
  }

  /** Called as playback goes on. Returns "low-latency" when it is time to try it again. */
  tick(now: number): PlaybackMode | null {
    if (this.mode !== "standard" || this.quietSince === null) return null;
    if (now - this.quietSince < LL_RETRY_AFTER_MS) return null;
    this.retries += 1;
    this.quietSince = null;
    this.stalls = [];
    this.mode = "low-latency";
    return this.mode;
  }
}

/* Catching up in standard mode.
 *
 * hls.js only speeds playback toward its target latency in low-latency mode (its latency
 * controller returns early otherwise), and nothing seeks back to live either. So in standard
 * mode every stall adds a second that is never won back: a viewer far from the origin starts
 * 3s behind and drifts to 6–8s within minutes (edge test, 2026-10-18). This plays a little
 * faster while there is buffer to spare, and jumps to live once it is far behind.
 *
 * Hysteresis on both ends, so the rate does not flicker: speed up past START_ABOVE, return to
 * normal within STOP_WITHIN of the target or once the buffer ahead runs thin, so catching up
 * never causes the stall it is recovering from. */
export const CATCH_UP = {
  /** Seconds past the target latency before speeding up. */
  startAbove: 1,
  /** Back to normal speed this close to the target. */
  stopWithin: 0.3,
  /** 1: never faster than real time, for the same reason as maxLiveSyncPlaybackRate — a
   * changing rate is time-stretched audio, which listeners hear as jitter. The jump does the
   * catching up. */
  rate: 1,
  /** Seconds buffered ahead of the playhead needed to keep playing faster. */
  minBuffer: 1.5,
  /** Seconds past the target where catching up at CATCH_UP.rate would take too long: jump.
   * 2, not the 6 it was: a viewer drifting to 5–6s behind (a stall or two, a slow phase) sat
   * there for a minute at 1.1× (edge test, 2026-10-20). The jump lands inside what is already
   * buffered (seekToTarget), so it is a skip, never a black wait, and the player spaces jumps
   * at least JUMP_COOLDOWN_MS apart so it cannot thrash. */
  jumpAbove: 2,
} as const;

export type CatchUp = { rate: number } | "jump";

/* The latency standard mode aims for, in seconds.
 *
 * Not hls.targetLatency. MediaMTX's LL-HLS playlist carries PART-HOLD-BACK but no HOLD-BACK,
 * so outside low-latency mode hls.js falls back to 3 × TARGETDURATION, and TARGETDURATION is
 * the longest segment rounded up: 1s segments that run a little over make it 2, the target
 * 6s, and up to 8s once stalls add to it. Measured against that, a viewer sitting 6s behind
 * was "on target", so standard mode never caught up (edge test, 2026-10-19).
 *
 * Four, not three: the playlist's edge includes the parts of the segment still being written,
 * but standard mode only loads whole segments, so at 3s the next one was often not ready and
 * the buffer ahead sat at 0–1s — stutter, and a black wait after every jump (same test). */
export const STANDARD_TARGET_SECONDS = 4;

/* The least latency low-latency mode aims for, in seconds.
 *
 * hls.js aims for the playlist's PART-HOLD-BACK, which with 250ms parts is ~0.67s: closer
 * than fetching parts from the CDN allows. It started there, stalled (a cut in the audio
 * each time), added 0.25s per stall, and only after ~2 minutes and four stalls settled at
 * ~1.67s, 2.5s behind — where it then played cleanly (edge test, 2026-10-20). Starting at
 * 1.5s skips those two minutes. Set at runtime (hls.targetLatency), once the live playlist
 * has loaded, so the mode switch still works as described at the top of this file. */
export const LL_MIN_TARGET_SECONDS = 1.5;

/** The target latency the catch-up and Jump to live aim for in each mode. */
export function liveTarget(mode: PlaybackMode, hlsTarget: number | null | undefined): number | null {
  if (mode === "standard") return STANDARD_TARGET_SECONDS;
  return hlsTarget != null && Number.isFinite(hlsTarget) ? hlsTarget : null;
}

/** Where to seek to sit `target` seconds behind live, given the current distance from live.
 * With `bufferedEnd`, never past what is buffered (less a margin): a seek past the buffer
 * waits on a fragment that may not exist yet, and the wait is a black frame. */
export function seekToTarget(o: { currentTime: number; latency: number; target: number; bufferedEnd?: number }): number {
  const want = o.currentTime + Math.max(0, o.latency - o.target);
  if (o.bufferedEnd == null) return want;
  return Math.max(o.currentTime, Math.min(want, o.bufferedEnd - SEEK_MARGIN_SECONDS));
}

/** The least time between two automatic jumps, so one that leaves a thin buffer cannot
 * stall into another. */
export const JUMP_COOLDOWN_MS = 15_000;

/** How far short of the buffered end an automatic jump lands. */
export const SEEK_MARGIN_SECONDS = 1;

/** What to do about the distance from live, given the current playback rate. */
export function catchUp(o: {
  latency: number;
  target: number;
  bufferAhead: number;
  rate: number;
}): CatchUp {
  if (!Number.isFinite(o.latency) || !Number.isFinite(o.target) || o.target <= 0) return { rate: 1 };
  const over = o.latency - o.target;
  if (over > CATCH_UP.jumpAbove) return "jump";
  if (o.bufferAhead < CATCH_UP.minBuffer || over <= CATCH_UP.stopWithin) return { rate: 1 };
  if (o.rate > 1 || over > CATCH_UP.startAbove) return { rate: CATCH_UP.rate };
  return { rate: 1 };
}

/** Seconds of media buffered ahead of `time`, from a video element's buffered ranges. */
export function bufferedAhead(ranges: { length: number; start(i: number): number; end(i: number): number }, time: number): number {
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= time + 0.1 && time < ranges.end(i)) return ranges.end(i) - time;
  }
  return 0;
}

/** Delay before retrying after a fatal network error: 1s, 2s, 4s, capped at 10s. */
export function retryDelayMs(attempt: number): number {
  return Math.min(10_000, 1000 * 2 ** Math.max(0, attempt));
}

/** How far behind live counts as "behind" enough to offer Jump to live, in seconds. */
export const BEHIND_LIVE_SECONDS: Record<PlaybackMode, number> = { standard: 5, "low-latency": 4 };

/** The latency readout: one decimal under ten seconds, whole seconds above. */
export function latencyLabel(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/** What the readout says the mode is. */
export function modeLabel(mode: PlaybackMode): string {
  return mode === "low-latency" ? "Low latency" : "Smooth";
}
