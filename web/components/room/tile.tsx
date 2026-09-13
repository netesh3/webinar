"use client";

import { VideoTrack } from "@livekit/components-react";
import { Track, type Participant, type TrackPublication } from "livekit-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Role } from "@/lib/api-types";
import {
  ExpandIcon,
  FitIcon,
  MicOffIcon,
  MinusIcon,
  PinIcon,
  PlusIcon,
  ScreenShareIcon,
} from "../icons";
import { tileFit } from "@/lib/layout";
import { isHighlighted } from "@/lib/speaker";
import { useActiveSpeaker } from "./active-speaker";
import { useRoomUI } from "./context";
import { participantRole } from "./participants";

/* One video tile.
 *
 * The tile renders a track, not a participant: a host sharing their screen
 * occupies two tiles, and treating the screen share as a property of the person
 * is what produces a layout where the slides and the speaker fight for one box.
 */

export type TileSource = Track.Source.Camera | Track.Source.ScreenShare;

export type Tile = {
  /** `${identity}:${source}` — stable across re-renders so React keeps the
   *  <video> element and the stream attached to it. */
  key: string;
  participant: Participant;
  source: TileSource;
  publication: TrackPublication | undefined;
};

const roleLabel: Record<Role, string> = {
  host: "Host",
  panelist: "Panelist",
  attendee: "Attendee",
};

/* How a camera fills its tile, measured rather than assumed.
 *
 * `object-fit: cover` is right for a face nearly always, and wrong when the box and the frame
 * disagree badly — which the speaker layout produces on a wide, short window. See tileFit in
 * lib/layout.ts for the rule and the reported symptom.
 *
 * The element is held in STATE, not a ref, for the reason the control bar documents: reading a
 * ref during render is both a lint error and a real staleness bug, and `aspect` has to change
 * when the element resizes or the decision is made once against a box that no longer exists.
 *
 * Source dimensions come from the publication rather than from the <video> element, so no
 * second observer is needed and the answer is available before the first frame decodes. They
 * are undefined for a moment after publish, which tileFit reads as "keep cover" — the fit
 * settling a frame later is invisible, whereas starting at contain and snapping to cover is a
 * jump the viewer sees.
 */
function useTileFit(publication: TrackPublication | undefined): {
  setBox: (el: HTMLDivElement | null) => void;
  fit: "cover" | "contain";
} {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [aspect, setAspect] = useState(0);

  useEffect(() => {
    if (!box) return;
    const observer = new ResizeObserver(() => {
      const rect = box.getBoundingClientRect();
      setAspect(rect.height > 0 ? rect.width / rect.height : 0);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);

  const dimensions = publication?.dimensions;
  const source = dimensions?.height ? dimensions.width / dimensions.height : 0;
  return { setBox, fit: tileFit(aspect, source) };
}

export function ParticipantTile({
  tile,
  size = "md",
  pinned = false,
  onTogglePin,
  fullBleed = false,
  zoomable = false,
}: {
  tile: Tile;
  size?: "sm" | "md" | "lg";
  pinned?: boolean;
  onTogglePin?: () => void;
  /** Square corners and no inset, for a tile that owns the whole stage. Rounded
   *  corners on a shared screen crop the corners of somebody's slides. */
  fullBleed?: boolean;
  /** Pan and zoom, for a shared screen on the main stage. Not offered on a
   *  thumbnail or a camera: there is nothing in a face to read more closely. */
  zoomable?: boolean;
}) {
  const { participant, source, publication } = tile;
  const role = participantRole(participant);
  const { fileShare } = useRoomUI();

  const isScreen = source === Track.Source.ScreenShare;

  /* The green border, from the room's single debounced answer rather than from this
   * participant's raw speaking flag.
   *
   * Reading `useIsSpeaking` here meant every tile re-rendered on every audio-level update and
   * several tiles could be ringed at once. See components/room/active-speaker.tsx. */
  const highlighted = isHighlighted(
    useActiveSpeaker(),
    participant.identity,
    isScreen,
  );

  /* Your own camera, mirrored — and only your own.
   *
   * A self-view has to be a mirror or people reach the wrong way when adjusting the frame,
   * which is why the pre-join preview has always been one. The tile was not, so your own image
   * flipped left-right exactly once, at the moment you landed on the stage: the one genuine
   * flip of a participant's video anywhere in the room, and one nobody expects because the
   * cause is invisible.
   *
   * Never applied to anybody else. A remote camera arrives the way its owner is publishing it,
   * and mirroring that would reverse the text on their slide, their notes and their shirt. And
   * never to a screen share, mirrored or otherwise — a reversed slide is unreadable.
   *
   * CSS only, so nothing downstream sees it: the recorder composites from the track, not from
   * this element, so a recording still shows what the audience saw. */
  const mirrored = participant.isLocal && !isScreen;
  /* Your own screen share is never played back to you — unless it is a file.
   *
   * Sharing the whole screen means the capture includes this window, and this
   * window is showing the capture — so the presenter gets an infinite corridor of
   * themselves, and because their screen now CONTAINS that corridor, so does
   * everyone watching. Not rendering it locally breaks the loop at the only place
   * it can be broken. Zoom and Meet both do exactly this.
   *
   * A shared video FILE has no such loop: the frames come from a hidden element
   * playing a file, not from the screen, so showing it back is just showing the
   * presenter what the room is seeing. Which they need — it is the only way to
   * know the share is working. */
  const isOwnShare = isScreen && participant.isLocal && !fileShare.active;
  const hasVideo =
    !isOwnShare && !!publication && !publication.isMuted && !!publication.track;

  // Microphone state belongs to the person, so it is read from their audio
  // publication rather than from the video track this tile is showing.
  const micPublication = participant.getTrackPublication(
    Track.Source.Microphone,
  );
  const micMuted = !micPublication || micPublication.isMuted;

  const nameSize = size === "sm" ? "text-[10.5px]" : "text-[12px]";

  // Measured, because the right answer depends on the window's proportions. Screen shares skip
  // it entirely — they always contain, and cropping a slide loses the bottom line of a terminal.
  const { setBox, fit } = useTileFit(isScreen ? undefined : publication);

  return (
    <div
      ref={setBox}
      // size-full, not just relative: the <video> inside is h-full, and h-full
      // against an auto-height parent collapses to the stream's intrinsic size —
      // which is what leaves a band of empty black under the speaker.
      className={`group relative isolate size-full overflow-hidden bg-stage-tile ${
        fullBleed ? "" : "rounded-xl"
      } outline outline-2 outline-offset-[-2px] transition-[outline-color] duration-200 ${
        /* An outline rather than a border, always present, and only its COLOUR changes.
         *
         * A border would change the element's box, so switching the highlight would reflow
         * the tile and nudge every neighbour by two pixels — the layout movement this whole
         * change exists to remove, reintroduced by the thing meant to replace it. An outline
         * with a negative offset is drawn inside the existing box and costs no space.
         *
         * Kept at width 2 even when nobody is highlighted, with the colour transparent,
         * because `outline-width` going 0 → 2 cannot be transitioned: the border would snap
         * on and off. Fading the colour is what makes a handover read as one border moving
         * rather than two tiles blinking. Nothing animates except the colour. */
        highlighted ? "outline-ok" : "outline-transparent"
      }`}
    >
      {hasVideo ? (
        zoomable ? (
          <ZoomableVideo
            participant={participant}
            source={source}
            publication={publication!}
          />
        ) : (
          <VideoTrack
            trackRef={{
              participant,
              source,
              publication: publication!,
            }}
            /* contain for a shared screen: cropping a slide to fill the box is how the
               bottom line of a terminal disappears.
               For a camera it is usually cover — letterboxing a face is worse than trimming
               the edges — but not when the tile's shape makes "trimming" mean a third of the
               picture. useTileFit measures and decides; see tileFit in lib/layout.ts. */
            /* Literal class names, not `object-${fit}`. Tailwind scans the source for class
               strings and never sees an interpolated one, so the utility would simply not be
               generated and the tile would fall back to the browser default of `fill` —
               stretching the picture, which is worse than either option here. */
            className={`size-full ${
              isScreen || fit === "contain" ? "object-contain" : "object-cover"
            } ${mirrored ? "-scale-x-100" : ""}`}
          />
        )
      ) : isOwnShare ? (
        <OwnShareNotice size={size} />
      ) : (
        <AvatarFallback participant={participant} size={size} />
      )}

      {/* Mute stays glanceable without a bar. Nameplate chrome used to paint a
          permanent black gradient across every tile — reveal that on hover/focus
          instead. Name stays discoverable via sr-only when chrome is hidden. */}
      <span className="sr-only">
        {participant.name || participant.identity}
        {isScreen ? "’s screen" : ""}
        {role !== "attendee" ? `, ${roleLabel[role]}` : ""}
        {!isScreen && micMuted ? ", muted" : ""}
      </span>
      {!isScreen && micMuted && (
        <span
          className="pointer-events-none absolute bottom-1.5 left-1.5 z-10 rounded-md bg-black/40 p-1 backdrop-blur transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
          aria-hidden
        >
          <MicOffIcon className="size-3.5 text-white/85" />
        </span>
      )}
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-1.5 bg-gradient-to-t from-black/45 to-transparent px-2 pt-5 pb-1.5 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${
          // Hover-to-reveal exists so a name bar does not sit permanently over
          // somebody's face. There is no face here — just initials on a plain
          // colour — so nothing is decluttered by hiding it, and a viewer
          // scanning a strip of camera-off tiles (see SpotlightLayout) would
          // otherwise have to hover each one, which a touch screen cannot even
          // do, just to find out who they are looking at.
          hasVideo ? "opacity-0" : "opacity-100"
        }`}
        aria-hidden
      >
        {!isScreen && micMuted && (
          <MicOffIcon className="size-3.5 shrink-0 text-white/80" />
        )}
        {isScreen && (
          <ScreenShareIcon className="size-3.5 shrink-0 text-white/80" />
        )}
        <span className={`min-w-0 truncate font-medium text-white ${nameSize}`}>
          {participant.name || participant.identity}
          {isScreen && "’s screen"}
        </span>
        {role !== "attendee" && size !== "sm" && (
          <span className="shrink-0 rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-medium text-white/90">
            {roleLabel[role]}
          </span>
        )}
      </div>

      {onTogglePin && (
        <button
          type="button"
          onClick={onTogglePin}
          aria-label={pinned ? "Unpin" : "Pin to the main view"}
          title={pinned ? "Unpin" : "Pin to the main view"}
          aria-pressed={pinned}
          // Always visible once pinned, otherwise revealed on hover or keyboard
          // focus. focus-visible matters: without it the control is unreachable
          // by keyboard on a device with no hover.
          className={`absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-lg bg-black/50 text-white/90 backdrop-blur transition-opacity hover:bg-black/70 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-white/60 ${
            pinned ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <PinIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/* A shared screen you can read.
 *
 * Two problems, and they are different. "Fit" letterboxes: the whole screen is
 * visible and nothing is cropped, which is right for slides and essential for a
 * terminal, but a 16:10 laptop screen shown in a 16:9 window wastes a band down
 * each side. "Fill" crops to the window edges, so the picture is as large as the
 * window allows and a little is lost off the sides. Zoom offers both and so does
 * this: double-click switches.
 *
 * On top of that, zoom. Somebody sharing a 4K display has put text on screen that
 * is unreadable scaled into a laptop window, and the honest fix is to let the
 * viewer magnify a corner of it rather than to guess. Wheel or trackpad pinch to
 * zoom, drag to pan, double-click to come back.
 */

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

type View = { scale: number; x: number; y: number };

const FIT: View = { scale: 1, x: 0, y: 0 };

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/* Keeps the picture from being dragged off screen.
 *
 * The bound is derived from the CONTAINER rather than from the video's intrinsic
 * size, which is deliberate: the video's rendered box depends on the aspect
 * mismatch and on fit-versus-fill, and reading it would mean measuring the element
 * on every frame of a drag. Bounding the scaled container keeps at least the
 * container's own area in view, which is what the gesture needs to feel anchored.
 */
function clampView(view: View, box: { width: number; height: number }): View {
  const maxX = ((view.scale - 1) * box.width) / 2;
  const maxY = ((view.scale - 1) * box.height) / 2;
  return {
    scale: view.scale,
    x: clamp(view.x, -maxX, maxX),
    y: clamp(view.y, -maxY, maxY),
  };
}

function ZoomableVideo({
  participant,
  source,
  publication,
}: {
  participant: Participant;
  source: TileSource;
  publication: TrackPublication;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(FIT);
  // Fill crops to the window edges. Fit is the default because losing the edge of
  // a slide without being told is worse than a band of black.
  const [fill, setFill] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // The origin of the gesture lives in a ref because it changes on every pointer
  // move and nothing renders from it. Whether a drag is in PROGRESS is state,
  // because the cursor and the transform's transition both depend on it — and a ref
  // read during render is a value React never promised would be current.
  const drag = useRef<{
    pointer: number;
    fromX: number;
    fromY: number;
    view: View;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  /* The zoom toolbar is revealed on hover — see the div below — and hover does
   * not exist on a touchscreen. A phone or tablet tapping the shared screen got
   * every gesture (wheel-pinch, drag-to-pan) except the one thing that told
   * them any of this was there, which is what was reported: the buttons had
   * not moved, they were only ever visible to a mouse.
   *
   * So a tap also reveals the toolbar directly, independent of hover, for a
   * few seconds — long enough to find and press a button, short enough that
   * it gets out of the way of the slide again on its own rather than needing
   * a second tap to dismiss. Each further tap resets the timer. */
  const [touchRevealed, setTouchRevealed] = useState(false);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealForTouch = useCallback(() => {
    setTouchRevealed(true);
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(() => setTouchRevealed(false), 3000);
  }, []);
  useEffect(
    () => () => {
      if (revealTimer.current) clearTimeout(revealTimer.current);
    },
    [],
  );

  /** Rescales about a point, so the thing under the cursor stays under it.
   *  Zooming about the centre instead makes the gesture feel like the picture is
   *  sliding away from wherever you are trying to look. */
  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const el = box.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // The transform origin is the centre, so work in centre-relative coordinates.
      const px =
        clientX === undefined ? 0 : clientX - (rect.left + rect.width / 2);
      const py =
        clientY === undefined ? 0 : clientY - (rect.top + rect.height / 2);

      setView((current) => {
        const scale = clamp(current.scale * factor, MIN_ZOOM, MAX_ZOOM);
        if (scale === current.scale) return current;
        // The content point under the cursor now, in unscaled coordinates.
        const ux = (px - current.x) / current.scale;
        const uy = (py - current.y) / current.scale;
        return clampView(
          { scale, x: px - ux * scale, y: py - uy * scale },
          rect,
        );
      });
    },
    [],
  );

  // A native listener rather than onWheel, because this one calls preventDefault:
  // React registers wheel handlers as passive, where preventDefault is ignored and
  // the page scrolls behind the gesture.
  //
  // A trackpad pinch arrives here as a wheel event with ctrlKey set, so pinch to
  // zoom works on a laptop without any gesture handling of its own.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(
        Math.exp(-e.deltaY / (e.ctrlKey ? 120 : 400)),
        e.clientX,
        e.clientY,
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // Leaving fullscreen by pressing Escape does not go through our button, so the
  // state is read from the document rather than assumed.
  useEffect(() => {
    const sync = () =>
      setFullscreen(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const zoomed = view.scale > 1;

  return (
    <div
      ref={box}
      className={`relative size-full overflow-hidden ${
        zoomed ? (dragging ? "cursor-grabbing" : "cursor-grab") : ""
      }`}
      // Zoomed in, this resets. At rest it switches fit and fill — the same two
      // states double-clicking a shared screen toggles in Zoom.
      onDoubleClick={() => {
        if (zoomed) setView(FIT);
        else setFill((f) => !f);
      }}
      onPointerDown={(e) => {
        // Mouse already has hover; touch and pen do not, so a tap is what
        // stands in for it here.
        if (e.pointerType !== "mouse") revealForTouch();
        if (!zoomed || e.button !== 0) return;
        drag.current = {
          pointer: e.pointerId,
          fromX: e.clientX,
          fromY: e.clientY,
          view,
        };
        setDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.pointer !== e.pointerId) return;
        const rect = e.currentTarget.getBoundingClientRect();
        setView(
          clampView(
            {
              scale: d.view.scale,
              x: d.view.x + (e.clientX - d.fromX),
              y: d.view.y + (e.clientY - d.fromY),
            },
            rect,
          ),
        );
      }}
      onPointerUp={() => {
        drag.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
    >
      <div
        className="size-full"
        style={{
          transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
          // No transition while dragging, or the picture lags the pointer.
          transition: dragging ? "none" : "transform 90ms linear",
        }}
      >
        <VideoTrack
          trackRef={{ participant, source, publication }}
          className={`size-full ${fill ? "object-cover" : "object-contain"}`}
        />
      </div>

      {/* Top-left, clear of the pin button and the layout switcher on the right.
          Revealed on hover or keyboard focus, like the pin — a permanent toolbar
          over somebody's slides is in the way of the thing you came to read.
          Also revealed by a tap for the devices hover does not reach — see
          touchRevealed above. */}
      <div
        className={`absolute top-1.5 left-1.5 flex items-center gap-1 rounded-lg bg-black/55 p-0.5 backdrop-blur transition-opacity group-hover:opacity-100 focus-within:opacity-100 ${
          touchRevealed ? "opacity-100" : "opacity-0"
        }`}
      >
        <ZoomButton
          label="Zoom out"
          disabled={view.scale <= MIN_ZOOM}
          onClick={() => zoomAt(1 / 1.4)}
        >
          <MinusIcon className="size-3.5" />
        </ZoomButton>
        {/* Doubles as the reset: clicking the reading is the obvious way back. */}
        <button
          type="button"
          onClick={() => setView(FIT)}
          disabled={!zoomed}
          title="Reset zoom"
          aria-label="Reset zoom"
          className="min-w-10 rounded-md px-1 text-[11px] font-medium tabular-nums text-white/90 transition-colors hover:bg-white/15 disabled:text-white/45 disabled:hover:bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          {Math.round(view.scale * 100)}%
        </button>
        <ZoomButton
          label="Zoom in"
          disabled={view.scale >= MAX_ZOOM}
          onClick={() => zoomAt(1.4)}
        >
          <PlusIcon className="size-3.5" />
        </ZoomButton>

        <span className="mx-0.5 h-4 w-px bg-white/20" />

        <ZoomButton
          label={fill ? "Fit the whole screen in" : "Fill the window"}
          pressed={fill}
          onClick={() => setFill((f) => !f)}
        >
          {fill ? (
            <FitIcon className="size-3.5" />
          ) : (
            <ExpandIcon className="size-3.5" />
          )}
        </ZoomButton>
        <ZoomButton
          label={fullscreen ? "Leave fullscreen" : "Fullscreen"}
          pressed={fullscreen}
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void box.current?.requestFullscreen().catch(() => {});
          }}
        >
          <ScreenShareIcon className="size-3.5" />
        </ZoomButton>
      </div>
    </div>
  );
}

function ZoomButton({
  label,
  onClick,
  disabled = false,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={`grid size-7 place-items-center rounded-md text-white/90 transition-colors hover:bg-white/15 disabled:text-white/40 disabled:hover:bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
        pressed ? "bg-white/20" : ""
      }`}
    >
      {children}
    </button>
  );
}

/**
 * What the presenter sees in place of their own screen share.
 *
 * They need to know it is live and that it is on the stage — but not to watch a
 * recording of the window they are looking at. The audience sees the real thing.
 */
function OwnShareNotice({ size }: { size: "sm" | "md" | "lg" }) {
  return (
    <div className="grid size-full place-items-center bg-black/40 p-4 text-center">
      <div>
        <div className="mx-auto mb-2.5 grid size-10 place-items-center rounded-full bg-ok/20">
          <ScreenShareIcon className="size-5 text-ok" />
        </div>
        <p className="text-[13px] font-medium text-white/90">
          You&apos;re sharing your screen
        </p>
        {/* Not on a filmstrip thumbnail — there is no room for a sentence. */}
        {size !== "sm" && (
          <p className="mx-auto mt-1 max-w-[26ch] text-[11.5px] leading-relaxed text-white/50">
            Everyone can see it. Your own preview is hidden, because showing it
            here would put a mirror inside the share.
          </p>
        )}
      </div>
    </div>
  );
}

/** Shown when someone is on the stage with their camera off. Their initials on
 *  their own colour, so a muted-camera panelist is still recognisable. */
function AvatarFallback({
  participant,
  size,
}: {
  participant: Participant;
  size: "sm" | "md" | "lg";
}) {
  const name = participant.name || participant.identity;
  const initials = useMemo(() => {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return "?";
    const first = words[0][0] ?? "";
    const last = words.length > 1 ? (words[words.length - 1][0] ?? "") : "";
    return (first + last).toUpperCase();
  }, [name]);

  const box = {
    sm: "size-8 text-[11px]",
    md: "size-14 text-[18px]",
    lg: "size-20 text-[24px]",
  }[size];

  return (
    <div className="grid size-full place-items-center">
      <span
        className={`grid place-items-center rounded-full bg-white/10 font-semibold text-white/85 ${box}`}
        aria-hidden
      >
        {initials}
      </span>
    </div>
  );
}
