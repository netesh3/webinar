"use client";

import { useEffect, useRef, useState } from "react";
import { formatClock } from "@/lib/format";
import {
  FullscreenExitIcon,
  FullscreenIcon,
  PauseIcon,
  PipIcon,
  PlayIcon,
  RotateCcwIcon,
  RotateCwIcon,
  SpinnerIcon,
  VolumeIcon,
  VolumeMuteIcon,
} from "./icons";

interface VideoPlayerProps {
  src: string;
  durationMs?: number;
  className?: string;
  onError?: () => void;
  poster?: string;
}

export function VideoPlayer({
  src,
  durationMs = 0,
  className = "",
  onError,
  poster,
}: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationMs > 0 ? durationMs / 1000 : 0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [buffered, setBuffered] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [seeking, setSeeking] = useState(false);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState(0);
  const [buffering, setBuffering] = useState(false);

  const hideControlsTimer = useRef<NodeJS.Timeout | null>(null);

  const effectiveDuration =
    duration > 0 ? duration : durationMs > 0 ? durationMs / 1000 : 0;

  // Handle Chrome WebM Infinity duration workaround
  function handleLoadedMetadata() {
    const video = videoRef.current;
    if (!video) return;

    if (Number.isFinite(video.duration) && video.duration > 0) {
      setDuration(video.duration);
    } else if (durationMs > 0) {
      setDuration(durationMs / 1000);
    } else {
      // Chrome Infinity workaround: seek to end then back to 0
      const onSeeked = () => {
        if (Number.isFinite(video.duration) && video.duration > 0) {
          setDuration(video.duration);
        }
        video.currentTime = 0;
        video.removeEventListener("seeked", onSeeked);
      };
      video.addEventListener("seeked", onSeeked);
      video.currentTime = 1e101;
    }
  }

  function handleTimeUpdate() {
    const video = videoRef.current;
    if (!video || seeking || isDraggingRef.current) return;
    setCurrentTime(video.currentTime);

    if (video.buffered.length > 0) {
      try {
        const end = video.buffered.end(video.buffered.length - 1);
        setBuffered(end);
      } catch {
        // ignore
      }
    }
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => {});
      setPlaying(true);
    } else {
      video.pause();
      setPlaying(false);
    }
  }

  function skip(seconds: number) {
    const video = videoRef.current;
    if (!video) return;
    const target = Math.max(0, Math.min(effectiveDuration || 999999, video.currentTime + seconds));
    video.currentTime = target;
    setCurrentTime(target);
  }

  function handleVolumeChange(val: number) {
    const video = videoRef.current;
    if (!video) return;
    const v = Math.max(0, Math.min(1, val));
    video.volume = v;
    setVolume(v);
    if (v === 0) {
      video.muted = true;
      setMuted(true);
    } else if (muted) {
      video.muted = false;
      setMuted(false);
    }
  }

  function toggleMute() {
    const video = videoRef.current;
    if (!video) return;
    if (muted || volume === 0) {
      video.muted = false;
      video.volume = volume > 0 ? volume : 1;
      setMuted(false);
      if (volume === 0) setVolume(1);
    } else {
      video.muted = true;
      setMuted(true);
    }
  }

  function changeSpeed(rate: number) {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = rate;
    setPlaybackRate(rate);
    setShowSpeedMenu(false);
  }

  async function toggleFullscreen() {
    const container = containerRef.current;
    const video = videoRef.current;
    if (!container || !video) return;

    const isCurrentlyFullscreen = !!(
      document.fullscreenElement ||
      (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement ||
      (document as unknown as { mozFullScreenElement?: Element }).mozFullScreenElement ||
      (video as unknown as { webkitDisplayingFullscreen?: boolean }).webkitDisplayingFullscreen
    );

    if (!isCurrentlyFullscreen) {
      if (container.requestFullscreen) {
        try {
          await container.requestFullscreen();
          setIsFullscreen(true);
          return;
        } catch {
          // fallback
        }
      }
      const webkitContainer = container as unknown as {
        webkitRequestFullscreen?: () => Promise<void> | void;
      };
      if (webkitContainer.webkitRequestFullscreen) {
        try {
          await webkitContainer.webkitRequestFullscreen();
          setIsFullscreen(true);
          return;
        } catch {
          // fallback
        }
      }
      // iOS Safari fallback on video element
      const webkitVideo = video as unknown as {
        webkitEnterFullscreen?: () => void;
      };
      if (webkitVideo.webkitEnterFullscreen) {
        try {
          webkitVideo.webkitEnterFullscreen();
          setIsFullscreen(true);
          return;
        } catch {
          // ignore
        }
      }
    } else {
      if (document.exitFullscreen) {
        await document.exitFullscreen().catch(() => {});
      } else {
        const webkitDoc = document as unknown as {
          webkitExitFullscreen?: () => Promise<void> | void;
        };
        if (webkitDoc.webkitExitFullscreen) {
          await webkitDoc.webkitExitFullscreen();
        }
      }
      const webkitVideo = video as unknown as {
        webkitExitFullscreen?: () => void;
      };
      if (webkitVideo.webkitExitFullscreen) {
        webkitVideo.webkitExitFullscreen();
      }
      setIsFullscreen(false);
    }
  }

  async function togglePip() {
    const video = videoRef.current;
    if (!video || !document.pictureInPictureEnabled) return;
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture().catch(() => {});
    } else {
      await video.requestPictureInPicture().catch(() => {});
    }
  }

  const isDraggingRef = useRef(false);
  const wasPlayingBeforeSeekRef = useRef(false);

  // Seek bar interaction with full drag support
  function seekToClientX(clientX: number) {
    const bar = progressBarRef.current;
    const video = videoRef.current;
    if (!bar || !video || !effectiveDuration) return;

    const rect = bar.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const target = pos * effectiveDuration;

    video.currentTime = target;
    setCurrentTime(target);
    setHoverPos(clientX - rect.left);
    setHoverTime(target);
  }

  function handleSeekStart(e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) {
    e.stopPropagation();
    const video = videoRef.current;
    if (!video) return;

    isDraggingRef.current = true;
    setSeeking(true);
    wasPlayingBeforeSeekRef.current = !video.paused;

    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    seekToClientX(clientX);

    const onPointerMove = (moveEvent: MouseEvent | TouchEvent) => {
      if (!isDraggingRef.current) return;
      const moveX =
        "touches" in moveEvent ? moveEvent.touches[0].clientX : (moveEvent as MouseEvent).clientX;
      seekToClientX(moveX);
    };

    const onPointerUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      setSeeking(false);

      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("mouseup", onPointerUp);
      window.removeEventListener("touchmove", onPointerMove);
      window.removeEventListener("touchend", onPointerUp);

      if (wasPlayingBeforeSeekRef.current && videoRef.current) {
        void videoRef.current.play().catch(() => {});
      }
    };

    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);
    window.addEventListener("touchmove", onPointerMove, { passive: true });
    window.addEventListener("touchend", onPointerUp);
  }

  function handleProgressBarHover(e: React.MouseEvent<HTMLDivElement>) {
    if (isDraggingRef.current) return;
    const bar = progressBarRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverPos(e.clientX - rect.left);
    setHoverTime(pos * (effectiveDuration || 0));
  }

  // Auto-hide controls when playing
  function handleMouseMove() {
    setControlsVisible(true);
    if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current);
    if (playing && !isDraggingRef.current) {
      hideControlsTimer.current = setTimeout(() => {
        setControlsVisible(false);
        setShowSpeedMenu(false);
      }, 3000);
    }
  }

  useEffect(() => {
    const video = videoRef.current;
    const onFullscreenChange = () => {
      const isFs = !!(
        document.fullscreenElement ||
        (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement ||
        (video as unknown as { webkitDisplayingFullscreen?: boolean })?.webkitDisplayingFullscreen
      );
      setIsFullscreen(isFs);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    if (video) {
      video.addEventListener("webkitbeginfullscreen", onFullscreenChange);
      video.addEventListener("webkitendfullscreen", onFullscreenChange);
    }
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
      if (video) {
        video.removeEventListener("webkitbeginfullscreen", onFullscreenChange);
        video.removeEventListener("webkitendfullscreen", onFullscreenChange);
      }
    };
  }, []);

  const progressPercent = effectiveDuration > 0 ? (currentTime / effectiveDuration) * 100 : 0;
  const bufferedPercent = effectiveDuration > 0 ? (buffered / effectiveDuration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => playing && !isDraggingRef.current && setControlsVisible(false)}
      className={`group relative select-none overflow-hidden bg-black font-sans ${className}`}
    >
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        playsInline
        preload="metadata"
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onError={onError}
        onClick={togglePlay}
        className="aspect-video size-full cursor-pointer bg-black object-contain"
      />

      {/* Buffering Spinner */}
      {buffering && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/20">
          <SpinnerIcon className="size-12 animate-spin text-white" />
        </div>
      )}

      {/* Big Center Play Button on Pause */}
      {!playing && !buffering && (
        <button
          type="button"
          onClick={togglePlay}
          className="absolute inset-0 m-auto grid size-16 place-items-center rounded-full bg-black/60 text-white backdrop-blur-sm transition-transform hover:scale-110"
          aria-label="Play"
        >
          <PlayIcon className="size-7 translate-x-0.5" />
        </button>
      )}

      {/* Controls Overlay */}
      <div
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-4 transition-opacity duration-200 ${
          controlsVisible || !playing ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        {/* Progress / Seek Bar */}
        <div
          ref={progressBarRef}
          onMouseDown={handleSeekStart}
          onTouchStart={handleSeekStart}
          onMouseMove={handleProgressBarHover}
          onMouseLeave={() => setHoverTime(null)}
          className="group/seek relative mb-3.5 flex h-4 cursor-pointer touch-none select-none items-center"
        >
          {/* Track Background */}
          <div className="relative h-1.5 w-full rounded-full bg-white/20 transition-all group-hover/seek:h-2.5">
            {/* Buffered Bar */}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-white/40 transition-all"
              style={{ width: `${bufferedPercent}%` }}
            />
            {/* Progress Bar */}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-brand transition-all"
              style={{ width: `${progressPercent}%` }}
            />
          </div>

          {/* Scrubber Knob */}
          <div
            className="absolute size-3.5 -translate-x-1/2 rounded-full bg-white shadow transition-transform group-hover/seek:scale-125"
            style={{ left: `${progressPercent}%` }}
          />

          {/* Hover Time Tooltip */}
          {hoverTime !== null && (
            <div
              className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded bg-black/80 px-2 py-0.5 font-mono text-[11px] text-white"
              style={{ left: `${hoverPos}px` }}
            >
              {formatClock(hoverTime * 1000)}
            </div>
          )}
        </div>

        {/* Buttons Row */}
        <div className="flex items-center justify-between gap-2 text-white">
          <div className="flex items-center gap-3 sm:gap-4">
            {/* Play / Pause */}
            <button
              type="button"
              onClick={togglePlay}
              className="text-white/90 transition-colors hover:text-white"
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? <PauseIcon className="size-5" /> : <PlayIcon className="size-5" />}
            </button>

            {/* Skip 10s Back */}
            <button
              type="button"
              onClick={() => skip(-10)}
              className="text-white/80 transition-colors hover:text-white"
              title="Skip back 10 seconds"
            >
              <RotateCcwIcon className="size-4" />
            </button>

            {/* Skip 10s Forward */}
            <button
              type="button"
              onClick={() => skip(10)}
              className="text-white/80 transition-colors hover:text-white"
              title="Skip forward 10 seconds"
            >
              <RotateCwIcon className="size-4" />
            </button>

            {/* Volume Control */}
            <div className="group/vol flex items-center gap-1.5">
              <button
                type="button"
                onClick={toggleMute}
                className="text-white/80 transition-colors hover:text-white"
                aria-label={muted ? "Unmute" : "Mute"}
              >
                {muted || volume === 0 ? (
                  <VolumeMuteIcon className="size-4.5" />
                ) : (
                  <VolumeIcon className="size-4.5" />
                )}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={muted ? 0 : volume}
                onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                className="h-1 w-14 cursor-pointer accent-brand transition-all sm:w-18"
              />
            </div>

            {/* Time Readout */}
            <div className="font-mono text-[12px] text-white/80">
              <span>{formatClock(currentTime * 1000)}</span>
              <span className="mx-1 text-white/40">/</span>
              <span>{formatClock((effectiveDuration || 0) * 1000)}</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Speed Selector */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowSpeedMenu(!showSpeedMenu)}
                className="rounded px-1.5 py-0.5 text-[12px] font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white"
              >
                {playbackRate}x
              </button>
              {showSpeedMenu && (
                <div className="absolute right-0 bottom-full mb-2 flex flex-col rounded-lg border border-line/20 bg-black/90 p-1 text-[12px] backdrop-blur-md">
                  {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                    <button
                      key={rate}
                      type="button"
                      onClick={() => changeSpeed(rate)}
                      className={`rounded px-3 py-1 text-left transition-colors hover:bg-white/20 ${
                        playbackRate === rate ? "font-bold text-brand" : "text-white"
                      }`}
                    >
                      {rate}x
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Picture-in-Picture */}
            {typeof document !== "undefined" && "pictureInPictureEnabled" in document && (
              <button
                type="button"
                onClick={() => void togglePip()}
                className="text-white/80 transition-colors hover:text-white"
                title="Picture-in-Picture"
              >
                <PipIcon className="size-4" />
              </button>
            )}

            {/* Fullscreen */}
            <button
              type="button"
              onClick={() => void toggleFullscreen()}
              className="text-white/80 transition-colors hover:text-white"
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? (
                <FullscreenExitIcon className="size-4.5" />
              ) : (
                <FullscreenIcon className="size-4.5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
