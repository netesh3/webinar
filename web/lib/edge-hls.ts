/* hls.js settings and playback policy for the Edge-delivery audience player
 * (components/room/edge-player.tsx).
 *
 * Plain HLS only: whole ~2s fMP4 segments, no parts, no blocking playlist reloads, about six
 * seconds behind live. Few requests (about one a second per viewer), every one of them
 * cacheable, so it plays the same from the box and through a CDN.
 *
 * Until 2026-10-25 this was LL-HLS (250–500ms parts, blocking reloads, ~2s behind) with a
 * standard-HLS fallback. Through Bunny the blocking reloads failed under a real audience:
 * Bunny's request coalescing ties every viewer asking for the next part to one origin
 * request, and those shared requests got stuck. In Bunny's log for
 * video1_stream.m3u8?_HLS_msn=1585&_HLS_part=0, 89 viewers at the Singapore edge waited until
 * they gave up (499) while the origin was healthy, and the same at the Mumbai edges after a
 * tier change; the whole audience froze in waves and the customer left
 * (create-your-first-ai-agent-with-ai-automation-6148). A few seconds more delay costs a
 * webinar nothing: the stage talks over WebRTC, and chat, polls and Q&A have their own channel.
 *
 * The delay is set here (liveSyncDuration), not left to hls.js's 3 × TARGETDURATION: MediaMTX's
 * 2s segments run a little over, TARGETDURATION rounds that up to 3, and 9s is more than it
 * needs to be. */

export type EdgeHlsConfig = {
  lowLatencyMode: boolean;
  liveDurationInfinity: boolean;
  liveSyncDuration: number;
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

/** How far behind live the player sits, in seconds: three segments of ~2s. */
export const TARGET_SECONDS = 6;

export function edgeHlsConfig(): EdgeHlsConfig {
  return {
    lowLatencyMode: false,
    liveDurationInfinity: true,
    liveSyncDuration: TARGET_SECONDS,
    // Room for the whole target and a segment or two more, so a slow request is absorbed.
    maxBufferLength: 12,
    backBufferLength: 10,
    /* 1: hls.js never changes the playback speed. A changing rate is time-stretched audio,
     * which listeners hear as speech warbling and music "cutting out" (2026-10-20). Drift is
     * corrected by skipping forward inside the buffer instead (CATCH_UP.jumpAbove). */
    maxLiveSyncPlaybackRate: 1,
    // hls.js adds this to its target for every stall and never takes it back; half a second a
    // stall lets a connection that keeps stalling settle a little further back, slowly.
    liveSyncOnStallIncrease: 0.5,
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

/** Stalls inside this window are what edge_latency reports. */
export const STALL_WINDOW_MS = 30_000;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* PlaybackStats is what edge_latency reports about the connection: recent stalls and the
 * median time to first byte of fragment requests. Free of hls.js and timers so it can be
 * tested. Nothing decides on these any more (there is one mode); they are for telemetry. */
export class PlaybackStats {
  private samples: number[] = [];
  private stalls: number[] = [];

  /** A fragment finished loading; ttfbMs is request start to first byte. */
  fragmentLoaded(ttfbMs: number): void {
    if (!Number.isFinite(ttfbMs) || ttfbMs < 0) return;
    this.samples.push(ttfbMs);
    // The most recent 50: a viewer whose network got worse should show it.
    if (this.samples.length > 50) this.samples.shift();
  }

  stalled(now: number): void {
    this.stalls.push(now);
    this.stalls = this.stalls.filter((t) => now - t <= STALL_WINDOW_MS);
  }

  stallCount(now: number): number {
    return this.stalls.filter((t) => now - t <= STALL_WINDOW_MS).length;
  }

  medianTtfb(): number | null {
    return median(this.samples);
  }
}

/* The other playback URL (JoinResponse.fallbackPlaybackUrl): the CDN for a viewer sent to the
 * box, the box for one sent to the CDN. Moved to once, after this many fatal network errors in
 * a row with no playback in between: one is a blip, a mix restart is two or three a few
 * seconds apart and still recovers on the same URL with backoff, and by the fourth the path
 * itself is the problem. Never back: a viewer flapping between paths is worse than either. */
export const FALLBACK_AFTER_ERRORS = 4;

export function shouldUseFallback(o: { fatalNetworkErrors: number; fallbackUrl: string | undefined; switched: boolean }): boolean {
  return !o.switched && Boolean(o.fallbackUrl) && o.fatalNetworkErrors >= FALLBACK_AFTER_ERRORS;
}

/* Keeping near live.
 *
 * hls.js holds its distance from live when it starts and after a seek, but each stall adds to
 * it and nothing wins that back: a viewer whose wifi dropped for ten seconds would watch ten
 * seconds late for the rest of the session. So once the player is well past its target it
 * skips forward, inside what is already buffered (seekToTarget), no more often than
 * JUMP_COOLDOWN_MS. Never by playing faster (see maxLiveSyncPlaybackRate). */
export const CATCH_UP = {
  /** Seconds past the target latency before skipping forward. Generous: a stall or two of
   * ordinary jitter is not worth a jump in the picture. */
  jumpAbove: 6,
} as const;

export type CatchUp = "stay" | "jump";

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

/** Whether the distance from live calls for a jump. */
export function catchUp(o: { latency: number; target: number }): CatchUp {
  if (!Number.isFinite(o.latency) || !Number.isFinite(o.target) || o.target <= 0) return "stay";
  return o.latency - o.target > CATCH_UP.jumpAbove ? "jump" : "stay";
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

/* How far behind live counts as "behind" enough to offer Back to live, in seconds.
 *
 * Well clear of the target (TARGET_SECONDS, 6) and of where the catch-up jumps (12): somebody
 * who paused, or came back to a tab the browser had throttled, is the case a button is for. */
export const BEHIND_LIVE_SECONDS = 20;

/** The latency readout: one decimal under ten seconds, whole seconds above. */
export function latencyLabel(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}
