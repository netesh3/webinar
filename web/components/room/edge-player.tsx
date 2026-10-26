"use client";

/* The Edge-delivery audience player: the stage mix as plain HLS, from the box or a CDN pull
 * zone in front of it, whichever the join chose for this viewer (docs/edge-delivery.md).
 *
 * One mode, about three seconds behind live (lib/edge-hls.ts says why it is no longer LL-HLS).
 * A stall or a recovery never leaves the picture black: the last frame is held on a canvas
 * over the video, with a small "Reconnecting" badge if it stays stuck. Fatal network errors
 * retry with backoff, and after several in a row on the same URL the player moves, once, to
 * the other one the join offered (fallbackPlaybackUrl). Media errors go through hls.js's own
 * recovery.
 *
 * Safari plays the playlist natively. On top of the shared player chrome this adds Back to
 * live when far behind, an edge_latency telemetry sample, and, with the debug clock on, the
 * server-synced clock the composite draws too. */

import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BEHIND_LIVE_SECONDS,
  PlaybackStats,
  TARGET_SECONDS,
  bufferedAhead,
  catchUp,
  decayedTarget,
  JUMP_COOLDOWN_MS,
  edgeHlsConfig,
  retryDelayMs,
  seekToTarget,
  shouldUseFallback,
} from "@/lib/edge-hls";
import { setEdgeVideoDelay } from "@/lib/caption-sync";
import { jumpToLiveOnReturn } from "@/lib/background-return";
import { useReturnQuiet } from "@/lib/use-return-quiet";
import { deviceSummary } from "@/lib/device";
import { trackEvent } from "@/lib/telemetry";
import { loadProbe, reportLoadProbe, startingPath } from "@/lib/load-probe";
import { useAppConfig } from "../providers";
import { StagePlayerChrome } from "./cdn-attendee-room";
import { EdgeClock } from "./edge-clock";
import { EdgeSpeakerSplit } from "./edge-speaker-split";

const TELEMETRY_EVERY_MS = 30_000;
/* A wait shorter than this is a hiccup, not worth a badge: a blip on the viewer's network or
 * at the CDN edge stalls the picture and plays on by itself, and at 800ms every such blip read
 * as "Reconnecting" (instant-webinar-2050, 2026-10-24). */
const RECONNECTING_AFTER_MS = 4000;

export function EdgePlayer({
  playbackUrl,
  fallbackUrl,
  deliveryPath,
  coverUrl,
  identity,
  slug,
  debugClock,
  clockOffsetMs,
  speakerView = false,
}: {
  playbackUrl: string;
  /** The other path, for when playbackUrl keeps failing (JoinResponse.fallbackPlaybackUrl). */
  fallbackUrl?: string;
  /** Which path playbackUrl is, "direct" (the box) or "cdn", for telemetry. */
  deliveryPath?: string;
  coverUrl?: string;
  identity: string;
  slug: string;
  debugClock?: boolean;
  clockOffsetMs: number;
  /** The host's layout may put the mix in speaker view: phones split it (EdgeSpeakerSplit). */
  speakerView?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  // The viewer muted it themselves: never unmute behind their back.
  const userMutedRef = useRef(false);
  const lastJumpRef = useRef(0);
  // The stall creep's decay (lib/edge-hls.ts decayedTarget): when the last stall, the last step
  // down and this player's start were.
  const lastStallRef = useRef<number | null>(null);
  const lastStepRef = useRef<number | null>(null);
  const startedRef = useRef(0);
  const statsRef = useRef<PlaybackStats | null>(null);
  // For the load-test kit's read-out (lib/load-probe.ts): the URL playing and the fallbacks.
  const sourceRef = useRef("");
  const fallbacksRef = useRef(0);
  // Playback has started. Until then currentTime is 0, hls.latency reads as the whole
  // window, and the catch-up jumped past the buffer: a black start (edge test, 2026-10-19).
  const playingRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(true);
  const [latency, setLatency] = useState<number | null>(null);
  const [native, setNative] = useState(false);
  // Which path is playing: the join's choice, or the other one after a fallback.
  const [path, setPath] = useState(deliveryPath ?? "");
  const [reconnecting, setReconnecting] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const { telemetryEnabled } = useAppConfig();
  // When the player mounted, and whether the first unmute was already reported.
  const shownAt = useRef(0);
  const unmuteReported = useRef(false);
  useEffect(() => {
    shownAt.current = Date.now();
  }, []);

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
    // The URL being played, and whether it is already the fallback (never switched back).
    // The load-test kit may start a viewer on the other path (lib/load-probe.ts).
    const start = startingPath(playbackUrl, fallbackUrl, deliveryPath, loadProbe()?.preferPath);
    let source = start.url;
    let switched = false;
    setPath(start.path);
    sourceRef.current = source;

    const stats = new PlaybackStats();
    statsRef.current = stats;

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
    /* Muted only because the browser said so, not by the viewer: their next click, tap or key
     * anywhere on the page is the permission the browser wanted, so take the sound back then.
     * A speaker sent back from the stage had to find the unmute button again (2026-10-20). */
    const unmuteOnGesture = () => {
      if (soundAllowed !== false || userMutedRef.current || !video.muted) return;
      soundAllowed = true;
      video.muted = false;
      setIsMuted(false);
      video.play().catch(() => {});
    };
    const gestures = ["pointerdown", "keydown", "touchend"] as const;
    for (const g of gestures) document.addEventListener(g, unmuteOnGesture, true);
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
    /* The other path, once: the box for a CDN viewer, the CDN for a box viewer. Reported, so a
     * path that keeps sending people away shows in telemetry. */
    const moveToFallback = (): boolean => {
      if (!shouldUseFallback({ fatalNetworkErrors: netAttempts, fallbackUrl: start.fallback, switched })) return false;
      switched = true;
      source = start.fallback as string;
      sourceRef.current = source;
      fallbacksRef.current += 1;
      const next = start.path === "cdn" ? "direct" : start.path === "direct" ? "cdn" : "fallback";
      setPath(next);
      netAttempts = 0;
      if (telemetryEnabled) {
        trackEvent("edge_fallback", { userId: identity, roomName: slug }, { from: start.path || null, to: next });
      }
      return true;
    };
    const onPlaying = () => {
      played = true;
      playingRef.current = true;
      resumed();
    };
    // The badge only once the picture has stayed stuck; playing again (resumed) cancels it.
    const badgeIfStuck = () => {
      clearTimeout(waitTimer);
      waitTimer = setTimeout(() => setReconnecting(true), RECONNECTING_AFTER_MS);
    };
    const onWaiting = () => {
      if (played) badgeIfStuck();
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    const detachVideo = () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
    };

    if (Hls.isSupported()) {
      hls = new Hls(edgeHlsConfig());
      hlsRef.current = hls;
      hls.loadSource(source);
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
        const t = data.frag.stats.loading;
        if (!t || !t.first || !t.start) return;
        stats.fragmentLoaded(t.first - t.start);
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) {
          if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
            stats.stalled(Date.now());
            lastStallRef.current = Date.now();
          }
          return;
        }
        if (played) {
          freezeFrame();
          badgeIfStuck();
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
         * restarted under a new muxer, the playlist lost), reload it from the top, which is
         * what a refresh did whenever a viewer sat on "Reconnecting" for good. Past
         * FALLBACK_AFTER_ERRORS in a row, the reload is of the other path. */
        netAttempts += 1;
        const moved = moveToFallback();
        const reload = moved || !hls?.levels?.length || netAttempts >= 2;
        retry = setTimeout(() => {
          if (reload) hls?.loadSource(source);
          else hls?.startLoad();
        }, moved ? 0 : retryDelayMs(netAttempts - 1));
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      setNative(true);
      video.src = source;
      const onMeta = () => {
        ready();
        tryPlay();
      };
      const onErr = () => {
        if (played) {
          freezeFrame();
          badgeIfStuck();
        } else {
          setError("The stream is starting, usually in under a minute…");
        }
        clearTimeout(retry);
        netAttempts += 1;
        const moved = moveToFallback();
        retry = setTimeout(() => {
          video.src = source;
          video.load();
          tryPlay();
        }, moved ? 0 : retryDelayMs(netAttempts - 1));
      };
      video.addEventListener("loadedmetadata", onMeta);
      video.addEventListener("error", onErr);
      return () => {
        for (const g of gestures) document.removeEventListener(g, unmuteOnGesture, true);
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
      for (const g of gestures) document.removeEventListener(g, unmuteOnGesture, true);
      clearTimeout(retry);
      clearTimeout(waitTimer);
      detachVideo();
      hls?.destroy();
      hlsRef.current = null;
    };
    // telemetryEnabled, identity and slug are read for the fallback event only; a change to
    // them must not rebuild the player.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackUrl, fallbackUrl, deliveryPath]);

  // The caption overlay holds each line by this much, so captions land with the video they
  // caption rather than seconds ahead of it (lib/caption-sync.ts).
  useEffect(() => {
    setEdgeVideoDelay(loading ? null : latency);
  }, [latency, loading]);
  useEffect(() => () => setEdgeVideoDelay(null), []);

  const latencyRef = useRef(latency);
  const pathRef = useRef(path);
  const reconnectingRef = useRef(reconnecting);
  useEffect(() => {
    latencyRef.current = latency;
    pathRef.current = path;
    reconnectingRef.current = reconnecting;
  }, [latency, path, reconnecting]);

  /* Latency: hls.js knows it; natively it is the distance to the end of the seekable range.
   * The same tick keeps hls.js near live: well past its target, it skips forward inside the
   * buffer (lib/edge-hls.ts catchUp). Safari's native player keeps its own distance. */
  useEffect(() => {
    let lastTime = -1;
    startedRef.current = Date.now();
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
        const target = TARGET_SECONDS;
        /* A quiet spell takes a quarter second of stall creep back (decayedTarget). Only while
         * playing: a paused or hidden player has no stalls to be quiet about. */
        if (video && !video.paused && playingRef.current) {
          const stepped = decayedTarget({
            current: hls.targetLatency,
            floor: TARGET_SECONDS,
            lastStallAt: lastStallRef.current,
            lastStepAt: lastStepRef.current,
            startedAt: startedRef.current,
            now: Date.now(),
          });
          if (stepped !== null) {
            hls.targetLatency = stepped;
            lastStepRef.current = Date.now();
          }
        }
        if (video && !video.paused && playingRef.current) {
          const next = catchUp({ latency: hls.latency, target });
          if (next === "jump" && Date.now() - lastJumpRef.current >= JUMP_COOLDOWN_MS) {
            lastJumpRef.current = Date.now();
            video.currentTime = seekToTarget({
              currentTime: video.currentTime,
              latency: hls.latency,
              target,
              bufferedEnd: video.currentTime + bufferedAhead(video.buffered, video.currentTime),
            });
          }
        }
      } else if (video && video.seekable.length > 0) {
        setLatency(Math.max(0, video.seekable.end(video.seekable.length - 1) - video.currentTime));
      }
      reportLoadProbe({
        latencySec: latencyRef.current,
        path: pathRef.current,
        url: sourceRef.current,
        reconnecting: reconnectingRef.current,
        fallbacks: fallbacksRef.current,
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!telemetryEnabled) return;
    const timer = setInterval(() => {
      const value = latencyRef.current;
      if (value == null) return;
      const hls = hlsRef.current;
      const stats = statsRef.current;
      const ttfb = stats?.medianTtfb();
      trackEvent("edge_latency", { userId: identity, roomName: slug }, {
        latencySec: Math.round(value * 100) / 100,
        targetSec: hls?.targetLatency ?? null,
        native,
        // "standard" since there is one mode; kept so old and new samples compare in queries.
        mode: "standard",
        // "direct" (the box) or "cdn", after any fallback; "" when the join did not say.
        delivery: pathRef.current,
        stalls: stats?.stallCount(Date.now()) ?? 0,
        medianTtfbMs: ttfb == null ? null : Math.round(ttfb),
        bandwidthKbps: hls ? Math.round(hls.bandwidthEstimate / 1000) : null,
      });
    }, TELEMETRY_EVERY_MS);
    return () => clearInterval(timer);
  }, [telemetryEnabled, identity, slug, native]);

  const jumpToLive = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const hls = hlsRef.current;
    const edge = hls && Number.isFinite(hls.latency) && hls.latency > 0
      ? seekToTarget({ currentTime: video.currentTime, latency: hls.latency, target: TARGET_SECONDS })
      : video.seekable.length > 0 ? video.seekable.end(video.seekable.length - 1) - 1 : null;
    if (edge != null && Number.isFinite(edge)) video.currentTime = edge;
    void video.play().catch(() => {});
  }, []);

  /* Back from a locked phone or another app. The phone paused the video while the page was
   * hidden, so it would carry on from where it stopped — minutes behind everyone else, behind
   * a Back to live button the person has to notice. Far enough behind to have shown that
   * button, it jumps to live by itself; otherwise it just plays again. The "Reconnecting…"
   * badge stays down meanwhile (useReturnQuiet): a stall while catching up is not news. */
  const onReturn = useCallback(() => {
    const video = videoRef.current;
    if (!video || !playingRef.current) return;
    const hls = hlsRef.current;
    const latency =
      hls && Number.isFinite(hls.latency) && hls.latency > 0
        ? hls.latency
        : video.seekable.length > 0
          ? video.seekable.end(video.seekable.length - 1) - video.currentTime
          : null;
    if (jumpToLiveOnReturn({ latencySec: latency, behindSec: BEHIND_LIVE_SECONDS })) {
      // The catch-up tick must not jump again straight after this one.
      lastJumpRef.current = Date.now();
      jumpToLive();
    } else if (video.paused) {
      void video.play().catch(() => {});
    }
  }, [jumpToLive]);
  const quiet = useReturnQuiet(onReturn);

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
          // How long people sit in silence before finding the sound (mobile diagnosis).
          if (telemetryEnabled && !unmuteReported.current) {
            unmuteReported.current = true;
            trackEvent("broadcast_unmuted", { userId: identity, roomName: slug }, {
              afterMs: shownAt.current ? Date.now() - shownAt.current : null,
              ...deviceSummary(),
            });
          }
        }}
        toggleMute={() => {
          const v = videoRef.current;
          if (!v) return;
          v.muted = !v.muted;
          userMutedRef.current = v.muted;
          setIsMuted(v.muted);
          if (!v.muted) void v.play();
        }}
      />
      {/* Speaker view on a phone: the share full width, the speaker floating over it, both
          from this one <video>. */}
      <EdgeSpeakerSplit videoRef={videoRef} enabled={speakerView && !loading && !error} />
      {/* The last good frame, held while the stream reconnects, so a gap is a still picture
          and not a black screen. */}
      <canvas
        ref={canvasRef}
        aria-hidden
        className={`pointer-events-none absolute inset-0 z-10 h-full w-full object-contain ${
          frozen ? "" : "hidden"
        }`}
      />
      {reconnecting && !loading && !quiet && (
        <div className="pointer-events-none absolute inset-x-0 bottom-16 z-20 flex justify-center">
          <span className="rounded-full bg-black/70 px-3 py-1 text-[12px] font-medium text-white/90 backdrop-blur">
            Reconnecting…
          </span>
        </div>
      )}
      {!loading && (
        <div className="pointer-events-none absolute right-4 top-4 z-20 flex items-center gap-2">
          {debugClock && <EdgeClock offsetMs={clockOffsetMs} />}
          {/* No delay readout or mode for viewers: those were for tuning, and the delay is
              still measured (edge_latency telemetry). No LIVE badge here either:
              StagePlayerChrome already draws one top left, and two read as a glitch. */}
          {behind && (
            <button
              type="button"
              onClick={jumpToLive}
              className="pointer-events-auto rounded-full bg-brand px-3 py-1 text-[11.5px] font-semibold text-white shadow-lg hover:bg-brand-hover"
            >
              Back to live
            </button>
          )}
        </div>
      )}
    </div>
  );
}
