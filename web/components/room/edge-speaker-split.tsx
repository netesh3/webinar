"use client";

/* Speaker view on a phone, from the one edge video (lib/speaker-view.ts).
 *
 * The edge mix in speaker view carries the share and the active speaker at a fixed geometry,
 * with a beacon in the corner. On a laptop the player shows it as drawn (the speaker in a
 * sidebar). On a phone, or anything portrait, this cuts that ONE decoded video in two, the way
 * Zoom's webinar app looks:
 *
 *   - the share region fills the stage: a CSS transform on the <video> itself, so the
 *     compositor does it and nothing is decoded or copied twice;
 *   - the speaker region is copied into a small canvas on every new video frame
 *     (requestVideoFrameCallback, or animation frames where that is missing), a floating PiP
 *     the viewer can drag (it snaps to a corner, which is remembered), tap to swap with the
 *     share, or minimise to a pill.
 *
 * It only splits while the beacon is in the picture: the host's layout reaches us by room
 * metadata seconds ahead of the video it changes, and nobody tells an edge viewer when a share
 * starts, but the beacon is in the frame itself. Reading it needs the pixels: a stream the
 * browser plays natively from another origin (older iPhones) taints them, and there the mix is
 * simply shown as it is.
 *
 * The PiP sits under the player's own chrome and under captions (z-order), so a caption is
 * never covered, wherever the PiP is dragged. */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import {
  BEACON_OFF,
  beaconStrip,
  cornerPosition,
  DEFAULT_PIP,
  isTap,
  nearestCorner,
  nextBeacon,
  parsePipPrefs,
  PIP_PREFS_KEY,
  pipSize,
  PROBE_H,
  PROBE_W,
  readBeacon,
  sourceRect,
  splitsMix,
  SV_SHARE,
  SV_SPEAKER,
  cropTransform,
  type PipPrefs,
  type Size,
} from "@/lib/speaker-view";

/** How often the beacon is read. A 4×1-cell probe: next to nothing. */
const BEACON_POLL_MS = 500;

function subscribeResize(onChange: () => void) {
  window.addEventListener("resize", onChange);
  window.addEventListener("orientationchange", onChange);
  return () => {
    window.removeEventListener("resize", onChange);
    window.removeEventListener("orientationchange", onChange);
  };
}
const readViewport = () => `${window.innerWidth}x${window.innerHeight}`;
const readViewportOnServer = () => "0x0";

function useViewport(): Size {
  const raw = useSyncExternalStore(subscribeResize, readViewport, readViewportOnServer);
  const [w, h] = raw.split("x").map(Number);
  return { w: w || 0, h: h || 0 };
}

/** Whether the frame on screen carries speaker view's beacon. Off whenever `enabled` is. */
function useBeacon(videoRef: RefObject<HTMLVideoElement | null>, enabled: boolean): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const probe = document.createElement("canvas");
    probe.width = PROBE_W;
    probe.height = PROBE_H;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    let state = BEACON_OFF;
    const timer = setInterval(() => {
      const video = videoRef.current;
      if (!video || video.videoWidth === 0 || video.readyState < 2) return;
      const src = sourceRect({ w: video.videoWidth, h: video.videoHeight }, beaconStrip());
      if (src.w <= 0 || src.h <= 0) return;
      try {
        ctx.drawImage(video, src.x, src.y, src.w, src.h, 0, 0, PROBE_W, PROBE_H);
        state = nextBeacon(state, readBeacon(ctx.getImageData(0, 0, PROBE_W, PROBE_H).data));
        setOn(state.on);
      } catch {
        // Tainted (a cross-origin stream played natively): no pixels, no split, stop asking.
        clearInterval(timer);
        setOn(false);
      }
    }, BEACON_POLL_MS);
    return () => {
      clearInterval(timer);
      setOn(false);
    };
  }, [enabled, videoRef]);
  return enabled && on;
}

function loadPrefs(): PipPrefs {
  if (typeof window === "undefined") return DEFAULT_PIP;
  try {
    return parsePipPrefs(window.localStorage.getItem(PIP_PREFS_KEY));
  } catch {
    return DEFAULT_PIP;
  }
}

export function EdgeSpeakerSplit({
  videoRef,
  enabled,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** The host's layout may be speaker view and the stream is playing. */
  enabled: boolean;
}) {
  const viewport = useViewport();
  // Fullscreen too: the PiP is inside the player's container (StagePlayerChrome children), so
  // a phone in fullscreen keeps the share full and the speaker floating, in either orientation.
  const active = useBeacon(videoRef, enabled && splitsMix(viewport));
  const [prefs, setPrefsState] = useState<PipPrefs>(loadPrefs);
  const [swapped, setSwapped] = useState(false);
  const setPrefs = useCallback((next: PipPrefs) => {
    setPrefsState(next);
    try {
      window.localStorage.setItem(PIP_PREFS_KEY, JSON.stringify(next));
    } catch {
      // Private mode: remembered for this visit only.
    }
  }, []);

  // The stage's size, which the PiP is placed in.
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Size>({ w: 0, h: 0 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const mainRegion = swapped ? SV_SPEAKER : SV_SHARE;
  const pipRegion = swapped ? SV_SHARE : SV_SPEAKER;

  // The main picture: the <video> itself, transformed so its region fills the stage.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !active) return;
    const apply = () => {
      const t = cropTransform(
        { w: video.clientWidth, h: video.clientHeight },
        { w: video.videoWidth, h: video.videoHeight },
        mainRegion,
      );
      video.style.transformOrigin = "0 0";
      video.style.transform = `translate(${t.tx}px, ${t.ty}px) scale(${t.k})`;
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(video);
    video.addEventListener("resize", apply);
    return () => {
      ro.disconnect();
      video.removeEventListener("resize", apply);
      video.style.transform = "";
      video.style.transformOrigin = "";
    };
  }, [active, mainRegion, videoRef]);

  const size = pipSize(box);
  const showPip = active && !prefs.minimised && box.w > 0;

  // The PiP: the other region, copied from the same decoded frame.
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!showPip || !video || !canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    let stopped = false;
    let frameHandle = 0;
    let rafHandle = 0;
    const rvfc = typeof video.requestVideoFrameCallback === "function";
    const draw = () => {
      if (stopped) return;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw > 0 && vh > 0) {
        const src = sourceRect({ w: vw, h: vh }, pipRegion);
        if (src.w > 0 && src.h > 0) {
          // No more pixels than the PiP shows, nor than the source has.
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          const cw = Math.max(1, Math.round(Math.min(src.w, size.w * dpr)));
          const ch = Math.max(1, Math.round((cw * src.h) / src.w));
          if (canvas.width !== cw) canvas.width = cw;
          if (canvas.height !== ch) canvas.height = ch;
          try {
            ctx.drawImage(video, src.x, src.y, src.w, src.h, 0, 0, cw, ch);
          } catch {
            // A frame not ready yet; the next one draws.
          }
        }
      }
      if (rvfc) frameHandle = video.requestVideoFrameCallback(draw);
      else rafHandle = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      stopped = true;
      if (rvfc && frameHandle) video.cancelVideoFrameCallback(frameHandle);
      if (rafHandle) cancelAnimationFrame(rafHandle);
    };
  }, [showPip, pipRegion, size.w, videoRef]);

  // Dragging: free while the finger is down, snapped to the nearest corner on release.
  const drag = useRef<{ id: number; sx: number; sy: number; x0: number; y0: number } | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const rest = cornerPosition(prefs.corner, size, box);
  const pos = dragPos ?? rest;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x0: pos.x, y0: pos.y };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!dragPos && isTap(dx, dy)) return;
    setDragPos({
      x: Math.min(Math.max(0, d.x0 + dx), Math.max(0, box.w - size.w)),
      y: Math.min(Math.max(0, d.y0 + dy), Math.max(0, box.h - size.h)),
    });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!dragPos) {
      setSwapped((s) => !s);
      return;
    }
    setPrefs({ ...prefs, corner: nearestCorner(dragPos, size, box) });
    setDragPos(null);
  };
  const onPointerCancel = () => {
    drag.current = null;
    setDragPos(null);
  };

  return (
    <div ref={boxRef} className="pointer-events-none absolute inset-0 z-[15]" aria-hidden={!active}>
      {showPip && (
        <div
          role="button"
          tabIndex={0}
          aria-label={swapped ? "Screen share. Tap to swap back, drag to move." : "Speaker video. Tap to swap with the screen share, drag to move."}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setSwapped((s) => !s);
            }
          }}
          className={`pointer-events-auto absolute touch-none select-none overflow-hidden rounded-xl bg-black shadow-[0_4px_16px_rgba(0,0,0,0.6)] ring-1 ring-white/15 outline-none focus-visible:ring-2 focus-visible:ring-brand ${
            dragPos ? "cursor-grabbing" : "cursor-grab transition-[left,top] duration-200 ease-out"
          }`}
          style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
        >
          <canvas ref={canvasRef} className="block size-full" />
          <button
            type="button"
            aria-label="Hide the speaker video"
            title="Hide"
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setSwapped(false);
              setPrefs({ ...prefs, minimised: true });
            }}
            className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-black/60 text-white/90 hover:bg-black/80"
          >
            <svg viewBox="0 0 16 16" className="size-3" fill="currentColor" aria-hidden>
              <rect x="3" y="7.25" width="10" height="1.5" rx="0.75" />
            </svg>
          </button>
        </div>
      )}
      {active && prefs.minimised && box.w > 0 && (
        <button
          type="button"
          onClick={() => setPrefs({ ...prefs, minimised: false })}
          className="pointer-events-auto absolute flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-[12px] font-semibold text-white shadow-lg backdrop-blur hover:bg-black/85"
          style={pillStyle(prefs, box)}
        >
          <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden>
            <circle cx="8" cy="5.5" r="2.75" />
            <path d="M2.5 13.5c0-2.5 2.5-4 5.5-4s5.5 1.5 5.5 4v.5h-11Z" />
          </svg>
          Show speaker
        </button>
      )}
    </div>
  );
}

/** The minimised pill, in the PiP's corner. */
function pillStyle(prefs: PipPrefs, box: Size): React.CSSProperties {
  const pos = cornerPosition(prefs.corner, { w: 132, h: 30 }, box);
  return { left: pos.x, top: pos.y };
}
