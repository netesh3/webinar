"use client";

/* The Edge-delivery audience player: the stage mix as HLS, from the live origin or a CDN pull
 * zone in front of it (docs/edge-delivery.md).
 *
 * Adaptive: it starts in standard (smooth) HLS unless the server says the playback URL is a
 * CDN close to the viewer, measures its own fragment requests, and moves up to LL-HLS only
 * when they are fast — dropping back for good if LL-HLS then stalls. The policy is
 * lib/edge-hls.ts (ModeDecider); this file only wires it to hls.js. The mode is switched with
 * hls.lowLatencyMode on the one instance, never by rebuilding the player, because rebuilding
 * detaches the video and that is a black frame.
 *
 * A stall or a recovery never leaves the picture black either: the last frame is held on a
 * canvas over the video with a small "Reconnecting" badge until playback resumes. Fatal
 * network errors retry with backoff; media errors go through hls.js's own recovery.
 *
 * Safari plays the playlist natively (no mode switch there). On top of the shared player
 * chrome this adds the latency readout with the mode, Jump to live, an edge_latency telemetry
 * sample, and, with the debug clock on, the server-synced clock the composite draws too. */

import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import {
  BEHIND_LIVE_SECONDS,
  MODE_BUFFER,
  ModeDecider,
  bufferedAhead,
  catchUp,
  edgeHlsConfig,
  latencyLabel,
  liveTarget,
  modeLabel,
  retryDelayMs,
  seekToTarget,
  type PlaybackMode,
} from "@/lib/edge-hls";
import { trackEvent } from "@/lib/telemetry";
import { useAppConfig } from "../providers";
import { StagePlayerChrome } from "./cdn-attendee-room";
import { EdgeClock } from "./edge-clock";

const TELEMETRY_EVERY_MS = 30_000;
// A wait shorter than this is a hiccup, not worth a badge.
const RECONNECTING_AFTER_MS = 800;

export function EdgePlayer({
  playbackUrl,
  coverUrl,
  identity,
  slug,
  debugClock,
  clockOffsetMs,
  lowLatency = false,
}: {
  playbackUrl: string;
  coverUrl?: string;
  identity: string;
  slug: string;
  debugClock?: boolean;
  clockOffsetMs: number;
  /** The playback URL is a CDN close to viewers: start in LL-HLS (JoinResponse.lowLatency). */
  lowLatency?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const deciderRef = useRef<ModeDecider | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(true);
  const [latency, setLatency] = useState<number | null>(null);
  const [native, setNative] = useState(false);
  const [mode, setMode] = useState<PlaybackMode>(lowLatency ? "low-latency" : "standard");
  const [reconnecting, setReconnecting] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const { telemetryEnabled } = useAppConfig();

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playbackUrl) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    let hls: Hls | null = null;
    let played = false;
    let netAttempts = 0;
    let mediaRecoveries = 0;

    const decider = new ModeDecider({ cdn: lowLatency, now: Date.now() });
    deciderRef.current = decider;
    setMode(decider.mode);

    const tryPlay = () => {
      video.playsInline = true;
      // Muted until the viewer turns sound on: autoplay with sound is blocked.
      if (!played) {
        video.muted = true;
        setIsMuted(true);
      }
      video.play().catch(() => {});
    };
    const ready = () => {
      setLoading(false);
      setError(null);
    };
    const resumed = () => {
      clearTimeout(waitTimer);
      setReconnecting(false);
      setFrozen(false);
      netAttempts = 0;
    };
    /* Hold the current picture on the canvas before anything that resets the media element.
     * Drawing a cross-origin frame taints the canvas, which only stops reading pixels back —
     * it still shows them, and showing them is all this is for. */
    const freezeFrame = () => {
      const canvas = canvasRef.current;
      if (!canvas || !played || video.videoWidth === 0) return;
      try {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
        setFrozen(true);
      } catch {
        // Nothing to hold; the badge still shows.
      }
    };
    const applyMode = (next: PlaybackMode) => {
      if (!hls) return;
      hls.lowLatencyMode = next === "low-latency";
      hls.config.maxBufferLength = MODE_BUFFER[next];
      setMode(next);
    };

    const onPlaying = () => {
      played = true;
      resumed();
    };
    const onWaiting = () => {
      if (!played) return;
      clearTimeout(waitTimer);
      waitTimer = setTimeout(() => setReconnecting(true), RECONNECTING_AFTER_MS);
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    const detachVideo = () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
    };

    if (Hls.isSupported()) {
      hls = new Hls(edgeHlsConfig(decider.mode));
      hlsRef.current = hls;
      hls.loadSource(playbackUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        ready();
        tryPlay();
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        ready();
        if (video.paused) tryPlay();
        if (!video.paused) resumed();
      });
      hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
        const t = (data.part ?? data.frag).stats.loading;
        if (!t || !t.first || !t.start) return;
        const next = decider.fragmentLoaded(t.first - t.start, Date.now());
        if (next) applyMode(next);
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) {
          if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
            const next = decider.stalled(Date.now());
            if (next) applyMode(next);
          }
          return;
        }
        if (played) {
          freezeFrame();
          setReconnecting(true);
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          mediaRecoveries += 1;
          if (mediaRecoveries > 1) hls?.swapAudioCodec();
          hls?.recoverMediaError();
          return;
        }
        // The origin 404s until the egress has booted and pushed, and a restarting mix is a
        // gap of seconds: wait and retry, with backoff, rather than fail.
        if (!played) setError("Waiting for the broadcast to start...");
        clearTimeout(retry);
        /* Before the playlist has parsed, startLoad has nothing to load: hls.js only requests
         * the manifest from loadSource, and it does not retry a 404 on its own. So the first
         * viewer, arriving while MediaMTX starts the muxer, sat on black until a refresh. */
        const reload = !hls?.levels?.length;
        retry = setTimeout(() => {
          if (reload) hls?.loadSource(playbackUrl);
          else hls?.startLoad();
        }, retryDelayMs(netAttempts));
        netAttempts += 1;
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      setNative(true);
      video.src = playbackUrl;
      const onMeta = () => {
        ready();
        tryPlay();
      };
      const onErr = () => {
        if (played) {
          freezeFrame();
          setReconnecting(true);
        } else {
          setError("Waiting for the broadcast to start...");
        }
        clearTimeout(retry);
        retry = setTimeout(() => {
          video.src = playbackUrl;
          video.load();
          tryPlay();
        }, retryDelayMs(netAttempts));
        netAttempts += 1;
      };
      video.addEventListener("loadedmetadata", onMeta);
      video.addEventListener("error", onErr);
      return () => {
        clearTimeout(retry);
        clearTimeout(waitTimer);
        detachVideo();
        video.removeEventListener("loadedmetadata", onMeta);
        video.removeEventListener("error", onErr);
        video.removeAttribute("src");
        video.load();
      };
    } else {
      setError("This browser can't play the live stream.");
    }

    return () => {
      clearTimeout(retry);
      clearTimeout(waitTimer);
      detachVideo();
      hls?.destroy();
      hlsRef.current = null;
    };
  }, [playbackUrl, lowLatency]);

  const latencyRef = useRef(latency);
  const modeRef = useRef(mode);
  useEffect(() => {
    latencyRef.current = latency;
    modeRef.current = mode;
  }, [latency, mode]);

  /* Latency: hls.js knows it; natively it is the distance to the end of the seekable range.
   * The same tick keeps hls.js near live (lib/edge-hls.ts liveTarget): it only does that itself in low-latency mode, so
   * standard mode plays slightly faster while behind, and either mode jumps when far behind
   * (lib/edge-hls.ts catchUp). Safari's native player keeps its own distance. */
  useEffect(() => {
    const timer = setInterval(() => {
      const hls = hlsRef.current;
      const video = videoRef.current;
      if (hls && Number.isFinite(hls.latency) && hls.latency > 0) {
        setLatency(hls.latency);
        const target = liveTarget(modeRef.current, hls.targetLatency);
        if (video && !video.paused && target != null) {
          const next = catchUp({
            latency: hls.latency,
            target,
            bufferAhead: bufferedAhead(video.buffered, video.currentTime),
            rate: video.playbackRate,
          });
          if (next === "jump") {
            video.currentTime = seekToTarget({ currentTime: video.currentTime, latency: hls.latency, target });
            video.playbackRate = 1;
          } else if (modeRef.current === "standard" && video.playbackRate !== next.rate) {
            video.playbackRate = next.rate;
          }
        }
      } else if (video && video.seekable.length > 0) {
        setLatency(Math.max(0, video.seekable.end(video.seekable.length - 1) - video.currentTime));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!telemetryEnabled) return;
    const timer = setInterval(() => {
      const value = latencyRef.current;
      if (value == null) return;
      const hls = hlsRef.current;
      const decider = deciderRef.current;
      const ttfb = decider?.medianTtfb();
      trackEvent("edge_latency", { userId: identity, roomName: slug }, {
        latencySec: Math.round(value * 100) / 100,
        targetSec: hls?.targetLatency ?? null,
        native,
        mode: modeRef.current,
        stalls: decider?.stallCount(Date.now()) ?? 0,
        medianTtfbMs: ttfb == null ? null : Math.round(ttfb),
        bandwidthKbps: hls ? Math.round(hls.bandwidthEstimate / 1000) : null,
      });
    }, TELEMETRY_EVERY_MS);
    return () => clearInterval(timer);
  }, [telemetryEnabled, identity, slug, native]);

  const jumpToLive = () => {
    const video = videoRef.current;
    if (!video) return;
    const hls = hlsRef.current;
    const target = hls ? liveTarget(modeRef.current, hls.targetLatency) : null;
    const edge = hls && target != null && Number.isFinite(hls.latency) && hls.latency > 0
      ? seekToTarget({ currentTime: video.currentTime, latency: hls.latency, target })
      : video.seekable.length > 0 ? video.seekable.end(video.seekable.length - 1) - 1 : null;
    if (edge != null && Number.isFinite(edge)) video.currentTime = edge;
    void video.play().catch(() => {});
  };

  const behind = latency != null && latency > BEHIND_LIVE_SECONDS[mode];

  return (
    <div className="relative h-full w-full">
      <StagePlayerChrome
        videoRef={videoRef}
        loading={loading}
        error={error}
        isMuted={isMuted}
        coverUrl={coverUrl}
        onMutedChange={setIsMuted}
        onReady={() => {
          setLoading(false);
          setError(null);
        }}
        unmute={() => {
          const v = videoRef.current;
          if (!v) return;
          v.muted = false;
          setIsMuted(false);
          void v.play();
        }}
        toggleMute={() => {
          const v = videoRef.current;
          if (!v) return;
          v.muted = !v.muted;
          setIsMuted(v.muted);
          if (!v.muted) void v.play();
        }}
      />
      {/* The last good frame, held while the stream reconnects, so a gap is a still picture
          and not a black screen. */}
      <canvas
        ref={canvasRef}
        aria-hidden
        className={`pointer-events-none absolute inset-0 z-10 h-full w-full object-contain ${
          frozen ? "" : "hidden"
        }`}
      />
      {reconnecting && !loading && (
        <div className="pointer-events-none absolute inset-x-0 bottom-16 z-20 flex justify-center">
          <span className="rounded-full bg-black/70 px-3 py-1 text-[12px] font-medium text-white/90 backdrop-blur">
            Reconnecting…
          </span>
        </div>
      )}
      {!loading && (
        <div className="pointer-events-none absolute right-4 top-4 z-20 flex items-center gap-2">
          {debugClock && <EdgeClock offsetMs={clockOffsetMs} />}
          <span
            className="rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium tabular-nums text-white/85 backdrop-blur"
            title={
              native
                ? "How far behind live this picture is"
                : mode === "low-latency"
                  ? "How far behind live this picture is. Low latency: your connection to the stream is fast."
                  : "How far behind live this picture is. Smooth mode: plays a little further behind so it doesn't stutter."
            }
          >
            {latencyLabel(latency)} behind{native ? "" : ` · ${modeLabel(mode)}`}
          </span>
          {behind && (
            <button
              type="button"
              onClick={jumpToLive}
              className="pointer-events-auto rounded-full bg-brand px-3 py-1 text-[11.5px] font-semibold text-white shadow-lg hover:bg-brand-hover"
            >
              Jump to live
            </button>
          )}
        </div>
      )}
    </div>
  );
}
