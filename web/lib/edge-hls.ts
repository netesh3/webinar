/* hls.js settings and playback-mode policy for the Edge-delivery audience player
 * (components/room/edge-player.tsx).
 *
 * Two modes, one hls.js instance.
 *
 *  - standard: whole 1s segments, about three behind live. Few requests, so it plays
 *    smoothly even when every request is a long round trip.
 *  - low-latency: LL-HLS parts with blocking playlist reloads, about 0.5–1s behind the
 *    origin. Five or more requests a second, so it only works when requests are fast.
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
 * Without them standard mode lands on hls.js's default of 3 × target duration = 3s. */

export type PlaybackMode = "standard" | "low-latency";

export type EdgeHlsConfig = {
  lowLatencyMode: boolean;
  liveDurationInfinity: boolean;
  maxBufferLength: number;
  backBufferLength: number;
  maxLiveSyncPlaybackRate: number;
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
    maxLiveSyncPlaybackRate: 1.15,
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

  /** The video stalled waiting for data. Returns "standard" when low-latency should give up. */
  stalled(now: number): PlaybackMode | null {
    this.stalls.push(now);
    this.stalls = this.stalls.filter((t) => now - t <= STALL_WINDOW_MS);
    if (this.mode === "low-latency" && this.stalls.length > MAX_LL_STALLS) {
      this.mode = "standard";
      this.locked = true;
      this.decided = true;
      return this.mode;
    }
    return null;
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
  /** Barely audible; browsers keep the pitch. */
  rate: 1.1,
  /** Seconds buffered ahead of the playhead needed to keep playing faster. */
  minBuffer: 1.5,
  /** Seconds past the target where catching up at CATCH_UP.rate would take too long: jump. */
  jumpAbove: 6,
} as const;

export type CatchUp = { rate: number } | "jump";

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
export const BEHIND_LIVE_SECONDS: Record<PlaybackMode, number> = { standard: 6, "low-latency": 4 };

/** The latency readout: one decimal under ten seconds, whole seconds above. */
export function latencyLabel(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/** What the readout says the mode is. */
export function modeLabel(mode: PlaybackMode): string {
  return mode === "low-latency" ? "Low latency" : "Smooth";
}
