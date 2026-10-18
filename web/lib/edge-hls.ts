/* hls.js settings for the Edge-delivery audience player (components/room/edge-audience-room.tsx).
 *
 * Low-latency mode deliberately sets NO liveSyncDurationCount / liveMaxLatencyDurationCount /
 * liveSyncDuration. hls.js honours the playlist's PART-HOLD-BACK (about 0.6s with MediaMTX's
 * 200ms parts) only when those are unset; setting any of them makes it fall back to
 * count × target duration, which throws away the point of LL-HLS (see 6ffc2e2 for the same
 * finding on the CDN player). The counts apply only to the plain-HLS fallback, for a CDN or
 * origin that serves no parts. */

export type EdgeHlsConfig = {
  lowLatencyMode: boolean;
  liveDurationInfinity?: boolean;
  liveSyncDurationCount?: number;
  liveMaxLatencyDurationCount?: number;
  maxBufferLength: number;
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

export function edgeHlsConfig(lowLatency: boolean): EdgeHlsConfig {
  const retries = {
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
  if (lowLatency) {
    return {
      lowLatencyMode: true,
      liveDurationInfinity: true,
      maxBufferLength: 4,
      maxLiveSyncPlaybackRate: 1.15,
      ...retries,
    };
  }
  return {
    lowLatencyMode: false,
    liveSyncDurationCount: 2,
    liveMaxLatencyDurationCount: 3,
    maxBufferLength: 4,
    maxLiveSyncPlaybackRate: 1.15,
    ...retries,
  };
}

/** How far behind live counts as "behind" enough to offer Jump to live, in seconds. */
export const BEHIND_LIVE_SECONDS = 4;

/** The latency readout: one decimal under ten seconds, whole seconds above. */
export function latencyLabel(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}
