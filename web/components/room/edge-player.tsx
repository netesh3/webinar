"use client";

/* The Edge-delivery audience player: the stage mix as LL-HLS, from the live origin or a CDN
 * pull zone in front of it (docs/edge-delivery.md).
 *
 * hls.js settings come from lib/edge-hls.ts — in low-latency mode it must not be given the
 * sync counts, or it ignores the playlist's PART-HOLD-BACK. Safari plays the playlist natively.
 * On top of the shared player chrome (volume, fullscreen, Live badge) this adds what testing
 * edge needs: how far behind live the picture is, a Jump to live button when it drifts, an
 * edge_latency telemetry sample, and, with the debug clock on, the server-synced clock that
 * the composite draws too, so glass-to-glass latency can be read off a screenshot. */

import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { BEHIND_LIVE_SECONDS, edgeHlsConfig, latencyLabel } from "@/lib/edge-hls";
import { trackEvent } from "@/lib/telemetry";
import { useAppConfig } from "../providers";
import { StagePlayerChrome } from "./cdn-attendee-room";
import { EdgeClock } from "./edge-clock";

const TELEMETRY_EVERY_MS = 30_000;

export function EdgePlayer({
  playbackUrl,
  coverUrl,
  identity,
  slug,
  debugClock,
  clockOffsetMs,
}: {
  playbackUrl: string;
  coverUrl?: string;
  identity: string;
  slug: string;
  debugClock?: boolean;
  clockOffsetMs: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(true);
  const [latency, setLatency] = useState<number | null>(null);
  const [native, setNative] = useState(false);
  const { telemetryEnabled } = useAppConfig();

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playbackUrl) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let hls: Hls | null = null;

    const tryPlay = () => {
      video.playsInline = true;
      video.muted = true;
      setIsMuted(true);
      video.play().catch(() => {});
    };
    const ready = () => {
      setLoading(false);
      setError(null);
    };

    if (Hls.isSupported()) {
      hls = new Hls(edgeHlsConfig(true));
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
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls?.recoverMediaError();
          return;
        }
        // The origin 404s until the egress has booted and pushed: wait, do not fail.
        setError("Waiting for the broadcast to start...");
        clearTimeout(retry);
        retry = setTimeout(() => hls?.startLoad(), 1500);
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      setNative(true);
      video.src = playbackUrl;
      const onMeta = () => {
        ready();
        tryPlay();
      };
      const onErr = () => {
        setError("Waiting for the broadcast to start...");
        clearTimeout(retry);
        retry = setTimeout(() => {
          video.src = playbackUrl;
          video.load();
        }, 1500);
      };
      video.addEventListener("loadedmetadata", onMeta);
      video.addEventListener("error", onErr);
      return () => {
        clearTimeout(retry);
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
      hls?.destroy();
      hlsRef.current = null;
    };
  }, [playbackUrl]);

  // Latency: hls.js knows it; natively it is the distance to the end of the seekable range.
  useEffect(() => {
    const timer = setInterval(() => {
      const hls = hlsRef.current;
      const video = videoRef.current;
      if (hls && Number.isFinite(hls.latency) && hls.latency > 0) {
        setLatency(hls.latency);
      } else if (video && video.seekable.length > 0) {
        setLatency(Math.max(0, video.seekable.end(video.seekable.length - 1) - video.currentTime));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const latencyRef = useRef(latency);
  useEffect(() => {
    latencyRef.current = latency;
  }, [latency]);
  useEffect(() => {
    if (!telemetryEnabled) return;
    const timer = setInterval(() => {
      const value = latencyRef.current;
      if (value == null) return;
      const hls = hlsRef.current;
      trackEvent("edge_latency", { userId: identity, roomName: slug }, {
        latencySec: Math.round(value * 100) / 100,
        targetSec: hls?.targetLatency ?? null,
        native,
        bandwidthKbps: hls ? Math.round(hls.bandwidthEstimate / 1000) : null,
      });
    }, TELEMETRY_EVERY_MS);
    return () => clearInterval(timer);
  }, [telemetryEnabled, identity, slug, native]);

  const jumpToLive = () => {
    const video = videoRef.current;
    if (!video) return;
    const hls = hlsRef.current;
    const edge = hls?.liveSyncPosition ??
      (video.seekable.length > 0 ? video.seekable.end(video.seekable.length - 1) - 1 : null);
    if (edge != null && Number.isFinite(edge)) video.currentTime = edge;
    void video.play().catch(() => {});
  };

  const behind = latency != null && latency > BEHIND_LIVE_SECONDS;

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
      {!loading && (
        <div className="pointer-events-none absolute right-4 top-4 z-20 flex items-center gap-2">
          {debugClock && <EdgeClock offsetMs={clockOffsetMs} />}
          <span
            className="rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium tabular-nums text-white/85 backdrop-blur"
            title="How far behind live this picture is"
          >
            {latencyLabel(latency)} behind
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
