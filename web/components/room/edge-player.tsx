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
  JUMP_COOLDOWN_MS,
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
  const lastJumpRef = useRef(0);
  const deciderRef = useRef<ModeDecider | null>(null);
  // Playback has started. Until then currentTime is 0, hls.latency reads as the whole
  // window, and the catch-up jumped past the buffer: a black start (edge test, 2026-10-19).
  const playingRef = useRef(false);
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
    playingRef.current = false;
    let netAttempts = 0;
    let mediaRecoveries = 0;

    const decider = new ModeDecider({ cdn: lowLatency, now: Date.now() });
    deciderRef.current = decider;
    setMode(decider.mode);

    /* Sound if the browser allows it, muted if not. Browsers block autoplay WITH sound until
     * the person has interacted with the page — but an attendee has usually just clicked Join
     * or Register here, and that click allows sound for the rest of the page. So try with
     * sound once; if the browser refuses (a room link opened cold), fall back to muted and the
     * "Tap to unmute" button, and do not ask again. */
    let soundAllowed: boolean | null = null;
    const tryPlay = () => {
      video.playsInline = true;
      if (played || soundAllowed === true) {
        video.play().catch(() => {});
        return;
      }
      if (soundAllowed === false) {
        video.muted = true;
        setIsMuted(true);
        video.play().catch(() => {});
        return;
      }
      soundAllowed = true;
      video.muted = false;
      video
        .play()
        .then(() => setIsMuted(false))
        .catch((err: unknown) => {
          // Only NotAllowedError is the autoplay policy; anything else (no data yet, a
          // reload) says nothing about sound, so ask again on the next try.
          if (!(err instanceof DOMException && err.name === "NotAllowedError")) {
            soundAllowed = null;
            return;
          }
          soundAllowed = false;
          video.muted = true;
          setIsMuted(true);
          video.play().catch(() => {});
        });
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
      mediaRecoveries = 0;
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
      decider.played(Date.now());
      played = true;
      playingRef.current = true;
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
          /* swapAudioCodec only for a codec error, the case it exists for (HE-AAC detected as
           * AAC or back). Our mix is plain AAC, and swapping on any second media error of the
           * session made the audio undecodable: picture on, sound gone (2026-10-20). */
          if (mediaRecoveries > 1 && data.details === Hls.ErrorDetails.BUFFER_ADD_CODEC_ERROR) {
            hls?.swapAudioCodec();
          }
          hls?.recoverMediaError();
          return;
        }
        // The origin 404s until the egress has booted and pushed, and a restarting mix is a
        // gap of seconds: wait and retry, with backoff, rather than fail.
        if (!played) setError("The stream is starting, usually in under a minute…");
        clearTimeout(retry);
        /* Before the playlist has parsed, startLoad has nothing to load: hls.js only requests
         * the manifest from loadSource, and it does not retry a 404 on its own. So the first
         * viewer, arriving while MediaMTX starts the muxer, sat on black until a refresh. */
        /* startLoad resumes a stream that paused; after two that did not bring it back (a mix
         * restarted under a new muxer, the low-latency playlist lost), reload it from the top,
         * which is what a refresh did whenever a viewer sat on "Reconnecting" for good. */
        const reload = !hls?.levels?.length || netAttempts >= 2;
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
          setError("The stream is starting, usually in under a minute…");
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
    let lastTime = -1;
    const timer = setInterval(() => {
      const hls = hlsRef.current;
      const video = videoRef.current;
      /* The badge is cleared by playback events, and a recovery can resume playing without
       * the one that clears it. Video that is moving is not reconnecting. */
      if (video && !video.paused) {
        if (lastTime >= 0 && video.currentTime > lastTime + 0.5) {
          setReconnecting(false);
          setFrozen(false);
        }
        lastTime = video.currentTime;
      }
      if (hls && Number.isFinite(hls.latency) && hls.latency > 0) {
        setLatency(hls.latency);
        const target = liveTarget(modeRef.current, hls.targetLatency);
        if (video && !video.paused && playingRef.current && target != null) {
          const next = catchUp({
            latency: hls.latency,
            target,
            bufferAhead: bufferedAhead(video.buffered, video.currentTime),
            rate: video.playbackRate,
          });
          if (next === "jump" && Date.now() - lastJumpRef.current >= JUMP_COOLDOWN_MS) {
            lastJumpRef.current = Date.now();
            video.currentTime = seekToTarget({
              currentTime: video.currentTime,
              latency: hls.latency,
              target,
              bufferedEnd: video.currentTime + bufferedAhead(video.buffered, video.currentTime),
            });
            video.playbackRate = 1;
          } else if (next !== "jump" && modeRef.current === "standard" && video.playbackRate !== next.rate) {
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
