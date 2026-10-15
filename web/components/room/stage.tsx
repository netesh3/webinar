"use client";

import { useParticipants, useTracks } from "@livekit/components-react";
import { Track, type LocalVideoTrack } from "livekit-client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  applyBudget,
  filterTiles,
  paginate,
  qualityFor,
  sortTiles,
  useResponsiveGridCap,
  VideoQuality,
  type LayoutMode,
} from "@/lib/layout";
import { isHighlighted } from "@/lib/speaker";
import { API_BASE } from "@/lib/api";
import { useCompact } from "@/lib/compact";
import {
  stagePresence,
  WAITING_FOR_HOST_LABEL,
  type StageSeat,
} from "@/lib/stage-presence";
import { startWaitingTune, stopWaitingTune, useWaitingTune } from "@/lib/waiting-tune";
import { ArrowLeftIcon, ChevronDownIcon, VolumeIcon, VolumeMuteIcon } from "../icons";
import { useActiveSpeaker } from "./active-speaker";
import { useRoomUI } from "./context";
import { participantRole } from "./participants";
import { ReactionOverlay } from "./reactions";
import { ParticipantTile, type Tile, type TileSource } from "./tile";

/* The stage: whoever is on it, laid out.
 *
 * The webinar shape decides the whole design. Attendees never publish, so they
 * never appear here — a placeholder tile per participant would mean 500 empty
 * boxes and a dead tab. The stage is the host, the panelists, and any attendee
 * the host has promoted.
 *
 * A host or panelist who is already in the room is on this stage even with the
 * microphone muted and the camera off. "No camera and no screen share" is not
 * "the host hasn't started" — that card is only for when nobody who can host
 * is connected. See stagePresence.
 *
 * Three modes, chosen by the viewer and nobody else (see lib/layout.ts):
 *
 *   speaker    one large tile, the rest in a strip. The default, because a webinar
 *              usually has one presenter.
 *   grid       everyone the same size, paged. The mode that scales — and the one
 *              that decides what this browser downloads, because only the current
 *              page is subscribed.
 *   spotlight  shared content locked large with the presenters in a column beside
 *              it. For a slide deck you are meant to read while somebody talks.
 */

export type ViewMode = LayoutMode;

export function Stage() {
  const { topic, controls, permissions, join, stage, entryVideo, coverImageUrl } = useRoomUI();

  // onlySubscribed: a track we have not subscribed to has no stream to render,
  // and with adaptiveStream the subscription follows what is actually on screen.
  const trackRefs = useTracks([Track.Source.ScreenShare, Track.Source.Camera], {
    onlySubscribed: true,
  });

  const published = useMemo<Tile[]>(
    () =>
      trackRefs.map((ref) => ({
        key: `${ref.participant.identity}:${ref.source}`,
        participant: ref.participant,
        source: ref.source as TileSource,
        publication: ref.publication,
      })),
    [trackRefs],
  );

  const people = useParticipants();
  /* A presenter is not waiting for anyone. join.canPublish comes first: the live
   * permissions are unknown until the connection is up, and keying on them alone
   * showed a host the attendee copy for the entire connecting phase. */
  const canPresent =
    join.canPublish || permissions.canShareCamera || permissions.canShareScreen;

  const presence = useMemo(() => {
    const seats: StageSeat[] = people.map((person) => ({
      identity: person.identity,
      role: participantRole(person, join),
      hasCamera: published.some(
        (tile) =>
          tile.participant.identity === person.identity &&
          tile.source === Track.Source.Camera,
      ),
      hasScreenShare: published.some(
        (tile) =>
          tile.participant.identity === person.identity &&
          tile.source === Track.Source.ScreenShare,
      ),
    }));
    return stagePresence({
      seats,
      viewerIdentity: join.identity,
      viewerCanPresent: canPresent,
    });
  }, [people, published, join, canPresent]);

  /* Camera-off placeholders only when the stage would otherwise be the waiting
   * card. A real camera or screen share keeps the published list untouched, so
   * starting with them on, or turning them on later, lays out as before. */
  const tiles = useMemo<Tile[]>(() => {
    if (presence.kind !== "camera-off") return published;
    const byIdentity = new Map(people.map((person) => [person.identity, person]));
    const placeholders: Tile[] = [];
    for (const identity of presence.identities) {
      const participant = byIdentity.get(identity);
      if (!participant) continue;
      placeholders.push({
        key: `${identity}:${Track.Source.Camera}`,
        participant,
        source: Track.Source.Camera,
        publication: undefined,
      });
    }
    return placeholders.length > 0 ? placeholders : published;
  }, [presence, people, published]);

  const screenShare = tiles.find((t) => t.source === Track.Source.ScreenShare);
  const mode: LayoutMode = stage.mode;
  const speaking = useActiveSpeaker();

  /* The viewer's own filters and sort, applied before anything is laid out.
   *
   * Sorted here rather than inside each layout, because the order is what decides
   * which tiles land on the current page — and therefore which video this browser
   * pays for. A layout that sorted its own tiles could unsubscribe from the person
   * who is talking.
   *
   * Speaker-mode is the one place the large tile follows the talker. Grid and
   * spotlight pass null, so a conversation cannot reshuffle a gallery or a deck.
   * Pin and a screen share still outrank the talker — see sortTiles. */
  const ordered = useMemo(() => {
    const filtered = filterTiles(tiles, stage.preferences);
    /* Hiding non-video would drop the only proof the host is here and leave a
     * blank stage. The preference still applies once somebody is actually
     * publishing — those tiles all have a publication. */
    const kept =
      filtered.length === 0 && tiles.some((tile) => tile.publication === undefined)
        ? tiles
        : filtered;
    return sortTiles(
      kept,
      stage.pinnedParticipantId,
      mode === "speaker" ? speaking : null,
    );
  }, [tiles, stage.preferences, stage.pinnedParticipantId, mode, speaking]);

  /* The mode is exactly what the viewer chose — with one deliberate exception below.
   *
   * An earlier version quietly RENDERED a viewer sitting in the grid as spotlight
   * when a share started, without telling `stage.mode` about it. That had to go,
   * because the header switch reads `stage.mode` directly: choosing Grid from
   * the footer menu during a share left the label reading "Layout · Grid" over a
   * stage rendering spotlight. Two controls for one setting must not be able to
   * disagree.
   *
   * This version does not repeat that mistake, because it does not create a second
   * source of truth — the effect below calls stage.setMode, the same setter the
   * toggle calls, so the toggle and the stage can never disagree about what is
   * selected. It also only fires once per share STARTING while the viewer happens
   * to be in Grid, not a standing override: switching back to Grid mid-share is
   * respected, and the switch does not repeat itself while the same share continues. */
  const { setMode } = stage;
  const isSharing = !!screenShare;

  const wasSharing = useRef(false);
  useEffect(() => {
    if (isSharing && !wasSharing.current && mode === "grid") {
      setMode("speaker");
    }
    wasSharing.current = isSharing;
  }, [isSharing, mode, setMode]);

  // Paged only in the grid. The other two modes are one tile plus a strip, and the
  // strip is bounded by what fits.
  //
  // gridCap narrows the viewer's own pageSize preference on a small screen — 4 on a
  // phone, 8 on a tablet — never widens it. See useResponsiveGridCap.
  const gridCap = useResponsiveGridCap();
  const pageSize =
    mode === "grid"
      ? Math.min(stage.preferences.pageSize, gridCap ?? stage.preferences.pageSize)
      : ordered.length || 1;
  const page = paginate(ordered, pageSize, stage.preferences.currentPage);

  /* What this browser asks the SFU for: which tracks, at which layer.
   *
   * The one part of this file that is not about pixels, and the reason the layout
   * owns it. A tile's size is what decides its layer, and only the layout knows the
   * size — so a big speaker tile stays HIGH while the strip beside it drops to LOW,
   * rather than everything on the page sharing one rung chosen from a count.
   *
   * `applyBudget` is handed EVERY tile, not just the ones on this page. That is not
   * tidiness: the first setEnabled call takes the decision away from adaptiveStream
   * permanently, so a tile the viewer's filters removed has to be switched off here
   * or it downloads forever with nothing rendering it. See applyBudget. */
  const wanted = useMemo(() => {
    const map = new Map<string, VideoQuality>();
    const focusKey = page.items[0]?.key;
    for (const [i, tile] of page.items.entries()) {
      if (tile.source === Track.Source.ScreenShare) {
        // Always HIGH: MEDIUM/LOW land on the 720p/360p rungs, and even a sharp 720p
        // publisher looks soft if the subscriber asked for the wrong layer. Text is why
        // the share exists — never let adaptive tile-count logic demote it.
        map.set(tile.key, VideoQuality.HIGH);
      } else if (mode === "grid") {
        map.set(tile.key, qualityFor(page.items.length));
      } else if (tile.key === focusKey) {
        map.set(tile.key, VideoQuality.HIGH);
      } else {
        // Spotlight keeps two prominent tiles beside the content; a speaker-view
        // strip is thumbnails and nothing more.
        map.set(tile.key, mode === "spotlight" && i <= 2 ? VideoQuality.MEDIUM : VideoQuality.LOW);
      }

      /* And whoever is talking is worth more than a thumbnail's worth of pixels.
       *
       * This is the half of "follow the speaker" that is worth keeping. The tile does not
       * move — that was the thing making the stage unusable — but asking the SFU for a better
       * layer for the person currently speaking costs nothing visually and is exactly what an
       * SFU is for. A panelist answering a question in a strip tile is the one face anybody is
       * looking at, and LOW is 320x180.
       *
       * Only ever a floor, so it cannot demote the focus or a share, and only ever MEDIUM: a
       * thumbnail does not need 720p, and requesting it would spend the audience's bandwidth
       * on pixels their tile cannot show. Driven by the debounced highlight, so a handover
       * changes this at most once every 450 ms rather than on every audio-level update.
       */
      if (isHighlighted(speaking, tile.participant.identity, tile.source === Track.Source.ScreenShare)) {
        const current = map.get(tile.key) ?? VideoQuality.LOW;
        if (current === VideoQuality.LOW) map.set(tile.key, VideoQuality.MEDIUM);
      }
    }
    return map;
  }, [page.items, mode, speaking]);

  // A signature rather than the map, so the effect fires on a real change and not
  // on every audio-level update that rebuilt the arrays.
  const signature = [...wanted].map(([k, q]) => `${k}:${q}`).join(",");
  useEffect(() => {
    applyBudget(tiles, wanted);
    // `signature` is the dependency; `tiles` and `wanted` are read through the
    // closure. Depending on them directly would re-issue every subscription change
    // several times a second, because both are rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  if (tiles.length === 0) {
    return (
      <WaitingForStage
        locked={controls.locked}
        topic={topic}
        imageUrl={coverImageUrl}
        // The pre-join camera, for the gap before the published track arrives.
        preview={entryVideo}
        // A presenter is not waiting for anyone — they are the one everybody else is
        // waiting for. join.canPublish comes first, and that ordering is the fix for
        // a real slip: the live permissions are the SFU's answer and are unknown
        // until the connection is up, so keying on them alone showed a host the
        // attendee copy for the entire connecting phase.
        canPresent={canPresent}
      />
    );
  }

  const focus =
    ordered.find((t) => t.key === stage.pinnedParticipantId) ?? screenShare ?? ordered[0] ?? tiles[0];
  const rest = ordered.filter((t) => t.key !== focus.key);
  const pinned = stage.pinnedParticipantId;
  // One publisher has nothing to grid. A 16:9 cell centered in a wider stage leaves
  // stage-coloured bars on both sides — the picture looks cropped in from the left and
  // right the moment you connect, while pre-join (a 16:9 card) still looked full.
  const solo = ordered.length === 1 ? ordered[0] : null;

  return (
    <div className="relative flex size-full min-h-0 min-w-0 flex-col">
      {solo ? (
        <SoloStage tile={solo} pinned={pinned} onTogglePin={stage.togglePin} />
      ) : mode === "grid" ? (
        <GridLayout page={page} pinned={pinned} onTogglePin={stage.togglePin} onPage={stage.setPage} />
      ) : mode === "spotlight" ? (
        <SpotlightLayout focus={focus} rest={rest} pinned={pinned} onTogglePin={stage.togglePin} />
      ) : (
        <SpeakerLayout focus={focus} rest={rest} pinned={pinned} onTogglePin={stage.togglePin} />
      )}

      <ReactionOverlay />
    </div>
  );
}

/* One camera (or one share) owns the stage.
 *
 * The grid packs every tile at 16:9 and centers the result. With a single camera that
 * is the largest 16:9 rectangle that fits, so a laptop window — wider than 16:9 once
 * the control bar takes its strip — shows the feed floating between two dark margins.
 * Covering the whole column removes those margins. The camera still uses tileFit, so
 * a wildly tall window letterboxes instead of slicing the face off; a normal window
 * covers and meets both edges. A lone screen share stays contain inside this same
 * full-bleed box, so slides are not cropped to make the margins disappear.
 */
function SoloStage({
  tile,
  pinned,
  onTogglePin,
}: {
  tile: Tile;
  pinned: string | null;
  onTogglePin: (key: string) => void;
}) {
  const sharing = tile.source === Track.Source.ScreenShare;
  // Absolute, not a flex child: Safari sizes a canvas/captureStream tile from the
  // track's own aspect and would otherwise center a 16:9 box between the margins again.
  return (
    <div className="absolute inset-0">
      <ParticipantTile
        tile={tile}
        size="lg"
        fullBleed
        zoomable={sharing}
        pinned={pinned === tile.key}
        onTogglePin={sharing ? undefined : () => onTogglePin(tile.key)}
      />
    </div>
  );
}

/* Speaker view.
 *
 * A shared screen gets the whole stage, and that is the difference between this
 * and a filmstrip layout. The strip below costs `clamp(72px, 15vh, 132px)` plus
 * the padding and the gap, which took something like a sixth of the height away
 * from the one thing everybody is trying to read — a shared terminal rendered at
 * 80% of the available area and then letterboxed on top of that. So when the focus
 * is a screen share the cameras float over it instead, the way Meet and Teams do
 * it, and the inset comes off.
 *
 * A camera in focus keeps the strip. Faces do not need the last 15% and a row of
 * them along the bottom is easier to scan than thumbnails overlapping a face.
 */
function SpeakerLayout({
  focus,
  rest,
  pinned,
  onTogglePin,
}: {
  focus: Tile;
  rest: Tile[];
  pinned: string | null;
  onTogglePin: (key: string) => void;
}) {
  const sharing = focus.source === Track.Source.ScreenShare;
  // Three is what fits beside a shared screen without eating into it. The rest are
  // counted rather than dropped silently, and the grid shows everyone.
  const thumbnails = sharing ? rest.slice(0, 3) : rest;
  const hidden = rest.length - thumbnails.length;

  return (
    <div className={`relative flex min-h-0 min-w-0 flex-1 flex-col ${sharing ? "" : "gap-2 p-2"}`}>
      <div className="min-h-0 min-w-0 flex-1">
        <ParticipantTile
          tile={focus}
          size="lg"
          fullBleed={sharing}
          zoomable={sharing}
          pinned={pinned === focus.key}
          // No pin on a full-bleed share: it is already the focus, so the control
          // would do nothing.
          onTogglePin={sharing ? undefined : () => onTogglePin(focus.key)}
        />
      </div>

      {thumbnails.length > 0 &&
        (sharing ? (
          <FloatingCameras
            tiles={thumbnails}
            hidden={hidden}
            pinned={pinned}
            onTogglePin={onTogglePin}
          />
        ) : (
          // A horizontally scrolling filmstrip, sized in vh so it stays a strip on
          // a short laptop screen and does not eat the main tile on a tall phone.
          <div
            className="flex shrink-0 gap-2 overflow-x-auto pb-0.5 [scrollbar-width:thin]"
            style={{ height: "clamp(72px, 15vh, 132px)" }}
          >
            {thumbnails.map((tile) => (
              <div key={tile.key} className="aspect-video h-full shrink-0">
                <ParticipantTile
                  tile={tile}
                  size="sm"
                  pinned={pinned === tile.key}
                  onTogglePin={() => onTogglePin(tile.key)}
                />
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

/* Spotlight.
 *
 * The content is locked to the stage and the presenters sit in a column beside it,
 * at a size worth looking at. The difference from speaker view is not cosmetic:
 * speaker view floats small thumbnails OVER the share, which is right when the
 * share is the only thing that matters, and wrong when somebody is presenting a
 * deck and their face is half the point. Zoom's side-by-side mode is this.
 *
 * The column becomes a row below `lg`, because a 320px column on a 900px laptop
 * leaves the slides narrower than the faces.
 */
function SpotlightLayout({
  focus,
  rest,
  pinned,
  onTogglePin,
}: {
  focus: Tile;
  rest: Tile[];
  pinned: string | null;
  onTogglePin: (key: string) => void;
}) {
  // Every presenter beside the content, scrollable rather than capped at two
  // with a static "+N more" label. The cap used to exist so nobody was
  // reduced to a thumbnail-behind-a-count they could not do anything with —
  // but a count that cannot be clicked, scrolled past, or expanded is worse
  // than a thumbnail: it hides people entirely. Scrolling is the same
  // affordance the strip already offered for the two it did show, just no
  // longer cut off before a third person.
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-2 lg:flex-row">
      <div className="min-h-0 min-w-0 flex-1">
        <ParticipantTile
          tile={focus}
          size="lg"
          zoomable={focus.source === Track.Source.ScreenShare}
          pinned={pinned === focus.key}
          onTogglePin={() => onTogglePin(focus.key)}
        />
      </div>

      {rest.length > 0 && (
        <div
          // No top padding: the stage itself starts below the room header
          // (top-12 on the data-stage element), so this column no longer has a
          // header to clear at any breakpoint.
          className="flex shrink-0 gap-2 overflow-auto lg:flex-col [scrollbar-width:thin]"
          // A width on wide screens, a height on narrow ones. Sized in vw/vh so it
          // stays proportionate rather than jumping between fixed steps.
          style={{ ["--spot" as string]: "clamp(180px, 20vw, 300px)" }}
        >
          {rest.map((tile) => (
            <div
              key={tile.key}
              // A width on wide screens, a height on narrow ones — never both, or
              // `aspect-video` has no effect (CSS only sizes from aspect-ratio when
              // one axis is otherwise unconstrained) and the box stops actually
              // being 16:9. That mismatch is what fed a camera's frame into
              // `object-cover` at the wrong ratio and read as a bad crop.
              className="aspect-video h-[clamp(96px,18vh,170px)] shrink-0 lg:h-auto lg:w-[var(--spot)]"
            >
              <ParticipantTile
                tile={tile}
                size="md"
                pinned={pinned === tile.key}
                onTogglePin={() => onTogglePin(tile.key)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* The cameras, floating over a shared screen.
 *
 * Compact Zoom-style overlay: faces only, thin border, no tall “Drag to move”
 * bar and no dashed snap placeholders on the stage. Four controls:
 *
 *   collapse  Small chevron on hover (top-right); count stays when collapsed.
 *   move      Drag the frame — free place anywhere on the stage (clamped).
 *   resize    Three corners (not top-right — that is hide); L-brackets on hover.
 *   remember  Tile size + position persist in this browser.
 *
 * Move and resize live on their own handles, never on a tile, so they cannot
 * fight the pin button.
 */

type ResizeCorner = "tl" | "tr" | "bl" | "br";

const RESIZE_CORNERS: Record<
  ResizeCorner,
  { cursor: string; sx: 1 | -1; sy: 1 | -1; fixRight: boolean; fixBottom: boolean }
> = {
  // Growing from a corner keeps the opposite corner planted.
  br: { cursor: "nwse-resize", sx: 1, sy: 1, fixRight: false, fixBottom: false },
  bl: { cursor: "nesw-resize", sx: -1, sy: 1, fixRight: true, fixBottom: false },
  tr: { cursor: "nesw-resize", sx: 1, sy: -1, fixRight: false, fixBottom: true },
  tl: { cursor: "nwse-resize", sx: -1, sy: -1, fixRight: true, fixBottom: true },
};

const FLOAT_CAM_W_KEY = "wl-floating-cam-w";
const FLOAT_CAM_POS_KEY = "wl-floating-cam-pos";
const FLOAT_CAM_MIN = 96;
const FLOAT_CAM_MAX = 280;
const FLOAT_CAM_DEFAULT = 132;
const FLOAT_MARGIN = 8;
/** Gap between tiles + panel padding (p-0.5 = 2px each side → 4, gap-1.5 = 6). */
const FLOAT_GAP = 6;
const FLOAT_PAD = 4;

function readFloatCamW(): number {
  if (typeof window === "undefined") return FLOAT_CAM_DEFAULT;
  try {
    const n = Number(window.localStorage.getItem(FLOAT_CAM_W_KEY));
    if (Number.isFinite(n)) {
      return Math.min(FLOAT_CAM_MAX, Math.max(FLOAT_CAM_MIN, Math.round(n)));
    }
  } catch {
    /* private mode */
  }
  return FLOAT_CAM_DEFAULT;
}

/** Position as fractions of the free space so a window resize keeps the feel. */
type FloatPos = { fx: number; fy: number };

function readFloatCamPos(): FloatPos | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(FLOAT_CAM_POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as FloatPos;
    if (
      typeof p?.fx === "number" &&
      typeof p?.fy === "number" &&
      Number.isFinite(p.fx) &&
      Number.isFinite(p.fy)
    ) {
      return {
        fx: Math.min(1, Math.max(0, p.fx)),
        fy: Math.min(1, Math.max(0, p.fy)),
      };
    }
  } catch {
    /* private mode / bad JSON */
  }
  return null;
}

function panelSize(tileW: number, tileCount: number, showExtra: boolean) {
  const extraW = showExtra ? 36 : 0;
  const width =
    FLOAT_PAD * 2 +
    tileCount * tileW +
    Math.max(0, tileCount - 1) * FLOAT_GAP +
    (showExtra ? FLOAT_GAP + extraW : 0);
  const height = FLOAT_PAD * 2 + (tileW * 9) / 16;
  return { width, height };
}

function clampPos(
  left: number,
  top: number,
  stageW: number,
  stageH: number,
  panelW: number,
  panelH: number,
) {
  const maxL = Math.max(FLOAT_MARGIN, stageW - panelW - FLOAT_MARGIN);
  const maxT = Math.max(FLOAT_MARGIN, stageH - panelH - FLOAT_MARGIN);
  return {
    left: Math.min(maxL, Math.max(FLOAT_MARGIN, left)),
    top: Math.min(maxT, Math.max(FLOAT_MARGIN, top)),
  };
}

function toFractions(
  left: number,
  top: number,
  stageW: number,
  stageH: number,
  panelW: number,
  panelH: number,
): FloatPos {
  const freeW = Math.max(1, stageW - panelW - FLOAT_MARGIN * 2);
  const freeH = Math.max(1, stageH - panelH - FLOAT_MARGIN * 2);
  return {
    fx: (left - FLOAT_MARGIN) / freeW,
    fy: (top - FLOAT_MARGIN) / freeH,
  };
}

function fromFractions(
  pos: FloatPos,
  stageW: number,
  stageH: number,
  panelW: number,
  panelH: number,
) {
  const freeW = Math.max(0, stageW - panelW - FLOAT_MARGIN * 2);
  const freeH = Math.max(0, stageH - panelH - FLOAT_MARGIN * 2);
  return clampPos(
    FLOAT_MARGIN + pos.fx * freeW,
    FLOAT_MARGIN + pos.fy * freeH,
    stageW,
    stageH,
    panelW,
    panelH,
  );
}

function FloatingCameras({
  tiles,
  hidden,
  pinned,
  onTogglePin,
}: {
  tiles: Tile[];
  hidden: number;
  pinned: string | null;
  onTogglePin: (key: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [tileW, setTileW] = useState(readFloatCamW);
  const [pos, setPos] = useState<FloatPos | null>(readFloatCamPos);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [resizing, setResizing] = useState<ResizeCorner | null>(null);
  const [hover, setHover] = useState(false);
  const movePtr = useRef<number | null>(null);
  const moveFrom = useRef<{ x: number; y: number; left: number; top: number } | null>(
    null,
  );
  const resizePtr = useRef<number | null>(null);
  const resizeFrom = useRef<{
    corner: ResizeCorner;
    startW: number;
    x: number;
    y: number;
    left: number;
    top: number;
    panelW: number;
    panelH: number;
  } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ left: FLOAT_MARGIN, top: FLOAT_MARGIN });

  const showExtra = hidden > 0;
  const size = panelSize(tileW, tiles.length, showExtra);

  // Resolve fractions → pixels against the live stage; default bottom-right.
  useLayoutEffect(() => {
    const stage = panel.current?.offsetParent as HTMLElement | null;
    if (!stage) return;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const next = pos
      ? fromFractions(pos, sw, sh, size.width, size.height)
      : clampPos(
          sw - size.width - FLOAT_MARGIN,
          sh - size.height - FLOAT_MARGIN,
          sw,
          sh,
          size.width,
          size.height,
        );
    setLayout(next);
  }, [pos, size.width, size.height, open, tiles.length, showExtra]);

  const persistTileW = (w: number) => {
    try {
      window.localStorage.setItem(FLOAT_CAM_W_KEY, String(w));
    } catch {
      /* private mode */
    }
  };

  const persistPos = (p: FloatPos) => {
    try {
      window.localStorage.setItem(FLOAT_CAM_POS_KEY, JSON.stringify(p));
    } catch {
      /* private mode */
    }
  };

  const placeAt = (left: number, top: number) => {
    const stage = panel.current?.offsetParent as HTMLElement | null;
    if (!stage) return;
    const clamped = clampPos(
      left,
      top,
      stage.clientWidth,
      stage.clientHeight,
      size.width,
      size.height,
    );
    const frac = toFractions(
      clamped.left,
      clamped.top,
      stage.clientWidth,
      stage.clientHeight,
      size.width,
      size.height,
    );
    setPos(frac);
    persistPos(frac);
    setLayout(clamped);
  };

  const applyResize = (clientX: number, clientY: number, persist: boolean) => {
    const start = resizeFrom.current;
    if (!start) return;
    const aff = RESIZE_CORNERS[start.corner];
    const dx = (clientX - start.x) * aff.sx;
    const dy = (clientY - start.y) * aff.sy;
    const nextW = Math.min(
      FLOAT_CAM_MAX,
      Math.max(FLOAT_CAM_MIN, Math.round(start.startW + (dx + dy) / 2)),
    );
    const nextSize = panelSize(nextW, tiles.length, showExtra);
    let left = start.left;
    let top = start.top;
    if (aff.fixRight) left = start.left + start.panelW - nextSize.width;
    if (aff.fixBottom) top = start.top + start.panelH - nextSize.height;
    setTileW(nextW);
    const stage = panel.current?.offsetParent as HTMLElement | null;
    if (stage) {
      const clamped = clampPos(
        left,
        top,
        stage.clientWidth,
        stage.clientHeight,
        nextSize.width,
        nextSize.height,
      );
      const frac = toFractions(
        clamped.left,
        clamped.top,
        stage.clientWidth,
        stage.clientHeight,
        nextSize.width,
        nextSize.height,
      );
      setPos(frac);
      setLayout(clamped);
      if (persist) {
        persistTileW(nextW);
        persistPos(frac);
      }
    } else if (persist) {
      persistTileW(nextW);
    }
  };

  const showChrome = hover || drag !== null || resizing !== null;

  const startResize = useCallback(
    (
      corner: ResizeCorner,
      pointerId: number,
      clientX: number,
      clientY: number,
      target: HTMLElement,
    ) => {
      resizePtr.current = pointerId;
      resizeFrom.current = {
        corner,
        startW: tileW,
        x: clientX,
        y: clientY,
        left: layout.left,
        top: layout.top,
        panelW: size.width,
        panelH: size.height,
      };
      setResizing(corner);
      target.setPointerCapture(pointerId);
    },
    [tileW, layout.left, layout.top, size.width, size.height],
  );

  return (
    <div
      ref={panel}
      className={`group absolute z-20 rounded-[11px] border border-white/20 bg-black/40 p-0.5 shadow-2xl backdrop-blur-md ${
        drag ? "cursor-grabbing" : "cursor-grab"
      } ${showChrome ? "border-white/35" : ""}`}
      style={{
        left: layout.left + (drag?.dx ?? 0),
        top: layout.top + (drag?.dy ?? 0),
        transition: drag || resizing ? undefined : "left 120ms ease-out, top 120ms ease-out",
      }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onPointerDown={(e) => {
        // Drag the frame; corner hits and tile buttons stopPropagation.
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest("[data-float-resize],[data-float-hide]")) {
          return;
        }
        const stage = panel.current?.offsetParent as HTMLElement | null;
        if (!stage) return;
        movePtr.current = e.pointerId;
        moveFrom.current = {
          x: e.clientX,
          y: e.clientY,
          left: layout.left,
          top: layout.top,
        };
        setDrag({ dx: 0, dy: 0 });
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (movePtr.current === e.pointerId && moveFrom.current) {
          setDrag({
            dx: e.clientX - moveFrom.current.x,
            dy: e.clientY - moveFrom.current.y,
          });
          return;
        }
        if (resizePtr.current === e.pointerId) {
          applyResize(e.clientX, e.clientY, false);
        }
      }}
      onPointerUp={(e) => {
        if (movePtr.current === e.pointerId && moveFrom.current) {
          const left = moveFrom.current.left + (e.clientX - moveFrom.current.x);
          const top = moveFrom.current.top + (e.clientY - moveFrom.current.y);
          movePtr.current = null;
          moveFrom.current = null;
          setDrag(null);
          placeAt(left, top);
          return;
        }
        if (resizePtr.current === e.pointerId) {
          applyResize(e.clientX, e.clientY, true);
          resizePtr.current = null;
          resizeFrom.current = null;
          setResizing(null);
        }
      }}
      onPointerCancel={(e) => {
        if (movePtr.current === e.pointerId) {
          movePtr.current = null;
          moveFrom.current = null;
          setDrag(null);
        }
        if (resizePtr.current === e.pointerId) {
          resizePtr.current = null;
          resizeFrom.current = null;
          setResizing(null);
        }
      }}
    >
      {/* Hide only — top-right. No grip dots; the whole frame is already draggable. */}
      <div
        className={`pointer-events-none absolute top-0 right-0 z-30 p-1.5 transition-opacity ${
          showChrome || !open ? "opacity-100" : "opacity-0"
        }`}
      >
        <button
          type="button"
          data-float-hide
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Hide the cameras" : `Show ${tiles.length + hidden} cameras`}
          title={open ? "Hide cameras" : "Show cameras"}
          className="pointer-events-auto inline-flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-md bg-black/55 px-1 text-[10px] font-semibold text-white/90 outline-none backdrop-blur transition-colors hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-white/50"
        >
          <ChevronDownIcon
            className={`size-3 transition-transform ${open ? "" : "rotate-180"}`}
          />
          {!open && <span className="tabular-nums">{tiles.length + hidden}</span>}
        </button>
      </div>

      {open ? (
        <div className="relative flex items-stretch gap-1.5">
          {tiles.map((tile) => (
            <div
              key={tile.key}
              className="aspect-video shrink-0 overflow-hidden rounded-lg shadow-lg ring-1 ring-white/10"
              style={{ width: tileW }}
            >
              <ParticipantTile
                tile={tile}
                size={tileW >= 168 ? "md" : "sm"}
                pinned={pinned === tile.key}
                onTogglePin={() => onTogglePin(tile.key)}
              />
            </div>
          ))}
          {hidden > 0 && (
            <span className="grid w-9 shrink-0 place-items-center self-stretch rounded-md bg-black/50 text-[12px] font-semibold text-white/85">
              +{hidden}
            </span>
          )}
        </div>
      ) : (
        // Keep a small hit target when collapsed so the panel is still draggable.
        <div className="h-7 w-16" aria-hidden />
      )}

      {/* Resize on three corners — top-right is reserved for hide. */}
      {open &&
        (["tl", "bl", "br"] as const).map((c) => (
          <FloatCornerHit
            key={c}
            corner={c}
            visible={showChrome || resizing === c}
            active={resizing === c}
            onStart={startResize}
          />
        ))}
    </div>
  );
}

function FloatCornerHit({
  corner,
  visible,
  active,
  onStart,
}: {
  corner: ResizeCorner;
  visible: boolean;
  active: boolean;
  onStart: (
    corner: ResizeCorner,
    pointerId: number,
    clientX: number,
    clientY: number,
    target: HTMLElement,
  ) => void;
}) {
  const aff = RESIZE_CORNERS[corner];
  const place =
    corner === "tl"
      ? "left-0 top-0"
      : corner === "tr"
        ? "right-0 top-0"
        : corner === "bl"
          ? "left-0 bottom-0"
          : "right-0 bottom-0";
  const mark =
    corner === "tl"
      ? "top-0.5 left-0.5 before:top-0 before:left-0 after:top-0 after:left-0"
      : corner === "tr"
        ? "top-0.5 right-0.5 before:top-0 before:right-0 after:top-0 after:right-0"
        : corner === "bl"
          ? "bottom-0.5 left-0.5 before:bottom-0 before:left-0 after:bottom-0 after:left-0"
          : "bottom-0.5 right-0.5 before:bottom-0 before:right-0 after:bottom-0 after:right-0";

  return (
    <button
      type="button"
      data-float-resize
      aria-label={`Resize from ${corner} corner`}
      title="Drag to resize"
      className={`absolute z-40 size-6 touch-none outline-none transition-opacity ${place} ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      style={{ cursor: aff.cursor }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        onStart(corner, e.pointerId, e.clientX, e.clientY, e.currentTarget);
      }}
    >
      <span
        aria-hidden
        className={`pointer-events-none absolute size-4 before:absolute before:h-[2.5px] before:w-[13px] before:rounded-[1px] before:bg-white before:shadow-[0_0_0_1px_rgba(0,0,0,0.45)] after:absolute after:h-[13px] after:w-[2.5px] after:rounded-[1px] after:bg-white after:shadow-[0_0_0_1px_rgba(0,0,0,0.45)] ${mark} ${
          active ? "opacity-100" : "opacity-90"
        }`}
      />
    </button>
  );
}

// Matches the grid's own `gap-2` (0.5rem). Kept as a constant rather than
// read from the DOM because it never changes and reading it would mean a
// second measurement pass before the first useful layout.
const GRID_GAP_PX = 8;
const TILE_ASPECT = 16 / 9;

/** How many columns, and how wide each tile is, to make `count` fixed-aspect
 *  tiles as large as possible inside a W×H box — the Zoom/Meet "gallery"
 *  packing. Tries every column count from 1 to `count` and keeps whichever
 *  produces the largest tile; there is no closed-form shortcut once both a
 *  width and a height constraint are in play; count rarely exceeds 49 (see
 *  PAGE_SIZES), so the brute force is a few dozen iterations, not a
 *  performance concern next to the video decoders sitting beside it. */
function bestGridPacking(
  count: number,
  width: number,
  height: number,
  minCols = 1,
): { cols: number; tileWidth: number } {
  if (count <= 0 || width <= 0 || height <= 0) return { cols: 1, tileWidth: 0 };

  /* Pure "which column count makes tiles biggest" picks a single scrolling
   * column for a narrow, tall box — a phone in portrait — because one wide
   * 16:9 tile genuinely IS the biggest any single tile gets there, even
   * though it leaves visible margins on both sides unused. That is correct
   * by the metric and wrong by the eye: nobody expects a phone's video grid
   * to be a vertical scroll of one-per-row. minCols is the floor that keeps
   * the search from reaching that answer — see useResponsiveGridCap's
   * caller, which sets it to 2 on a phone, 1 (no floor) everywhere else. */
  const start = Math.max(1, Math.min(minCols, count));

  let bestCols = start;
  let bestWidth = 0;
  for (let cols = start; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const widthLimited = (width - GRID_GAP_PX * (cols - 1)) / cols;
    const heightLimited =
      ((height - GRID_GAP_PX * (rows - 1)) / rows) * TILE_ASPECT;
    const tileWidth = Math.max(0, Math.min(widthLimited, heightLimited));
    if (tileWidth > bestWidth) {
      bestWidth = tileWidth;
      bestCols = cols;
    }
  }
  return { cols: bestCols, tileWidth: Math.floor(bestWidth) };
}

/** Measures the grid's own container and returns the packing that fills it.
 *  A resize observer, deliberately — see the comment on GridLayout for why
 *  the CSS-only approach this replaces got the wrong picture. */
function useGridPacking(
  count: number,
  minCols: number,
): {
  setBox: (el: HTMLDivElement | null) => void;
  cols: number;
  tileWidth: number;
} {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!box) return;
    const observer = new ResizeObserver(() => {
      const rect = box.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);

  const { cols, tileWidth } = useMemo(
    () => bestGridPacking(count, size.width, size.height, minCols),
    [count, size.width, size.height, minCols],
  );
  // Before the first measurement, or in a box with no area yet (a brand new
  // tab mid-layout): one column at zero width rather than a NaN/Infinity
  // that would otherwise reach a CSS custom property. The observer fires
  // within a frame either way.
  return { setBox, cols: cols || 1, tileWidth: tileWidth || 0 };
}

/**
 * The grid, paged.
 *
 * Paged rather than virtualised, and that is a decision worth defending because a
 * virtualised list is the reflex answer. `react-window` recycles DOM rows, which is
 * the right tool when the rows are cheap and the list is long. These rows each hold
 * a decoding `<video>` — the expensive part is not the element, it is the stream
 * behind it — so recycling elements while scrolling would keep three hundred
 * subscriptions alive and hand the browser three hundred decoders. Paging bounds
 * both: 49 elements, 49 subscriptions, and everything else switched off (see
 * applyBudget).
 *
 * The column count used to come from a CSS minimum tile width (auto-fit/minmax)
 * rather than from measuring the container, specifically to avoid a resize
 * observer. That traded away the wrong thing: minmax picks the NARROWEST width
 * that satisfies the constraint, so five tiles in a wide container sat in one row
 * at their minimum size with most of the container's height sitting empty below
 * them — correct CSS, wrong picture, and the gap only grows with a shorter,
 * wider window. Zoom's own grid fills both axes: it is really "pick the column
 * count that makes tiles as large as possible without any one of them taller
 * than the box," which needs the box's actual pixel size. Hence the observer.
 */
function GridLayout({
  page,
  pinned,
  onTogglePin,
  onPage,
}: {
  page: { items: Tile[]; page: number; pages: number };
  pinned: string | null;
  onTogglePin: (key: string) => void;
  onPage: (page: number) => void;
}) {
  const count = page.items.length;
  // Same 767px boundary useCompact uses everywhere else in the room — see
  // its own comment in lib/compact.ts. Two columns minimum on a phone, so
  // four tiles reads as the familiar 2×2 rather than a scroll of four rows;
  // no floor otherwise, where the packing already fills the space well.
  const compact = useCompact();
  const { setBox, cols, tileWidth } = useGridPacking(count, compact ? 2 : 1);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={setBox} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2">
        <div
          className="grid gap-2"
          style={{
            gridTemplateColumns: `repeat(${cols}, ${tileWidth}px)`,
            // auto-rows sized from the same tile width keeps every row the same
            // height as the columns are wide, at the fixed 16:9 tiles use — a grid
            // with an EXPLICIT column count (unlike auto-fit) does not do this on
            // its own, and a ragged row height is exactly the "ordinary CSS grid"
            // look this is meant to replace.
            gridAutoRows: `${Math.round((tileWidth * 9) / 16)}px`,
          }}
        >
          {page.items.map((tile) => (
            <div key={tile.key} style={{ width: tileWidth }} className="aspect-video">
              <ParticipantTile
                tile={tile}
                size={count > 9 ? "sm" : "md"}
                pinned={pinned === tile.key}
                onTogglePin={() => onTogglePin(tile.key)}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Paging, only when there is more than one page. A control that is always
          there but usually says "1 of 1" is furniture. */}
      {page.pages > 1 && (
        <div className="flex shrink-0 items-center justify-center gap-2 pb-2">
          <PageButton
            label="Previous page"
            disabled={page.page === 0}
            onClick={() => onPage(page.page - 1)}
          >
            <ArrowLeftIcon className="size-3.5" />
          </PageButton>
          <span className="text-[11.5px] font-medium tabular-nums text-white/70">
            {page.page + 1} / {page.pages}
          </span>
          <PageButton
            label="Next page"
            disabled={page.page >= page.pages - 1}
            onClick={() => onPage(page.page + 1)}
          >
            <ArrowLeftIcon className="size-3.5 rotate-180" />
          </PageButton>
        </div>
      )}
    </div>
  );
}

function PageButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-lg bg-white/10 text-white/80 transition-colors hover:bg-white/20 hover:text-white disabled:opacity-35 disabled:hover:bg-white/10 outline-none focus-visible:ring-2 focus-visible:ring-white/50"
    >
      {children}
    </button>
  );
}

/* Nothing on stage yet.
 *
 * For an ATTENDEE only. A presenter used to get a headline, a paragraph and two
 * buttons here — "start your camera or share your screen" — and it was the wrong
 * shape of thing twice over: it is a nag screen in the first seconds of a session
 * the presenter has just deliberately started, and the fix it suggested is
 * something the app can simply do. So it does: the camera comes on by itself (see
 * RoomSession) and a presenter sees the connection state instead, which is the one
 * thing actually worth knowing while it happens.
 */
/* The pre-connection self-view.
 *
 * Attached by hand rather than through LiveKit's VideoTrack component, because this track
 * is not in the room yet — there is no participant to key it off and no publication to
 * subscribe to. `track.attach(el)` is the same call that component makes.
 *
 * Muted and mirrored: it is the presenter's own camera, so it must not create an audio
 * loop, and an un-mirrored self-view makes people reach the wrong way.
 *
 * object-cover + absolute fill, same as the pre-join preview: object-contain left
 * stage-coloured bars down each side the moment this track sat in a flex/grid stage
 * instead of an aspect-video box, and a SoftSegmenter canvas track made Safari eager to
 * size the element from the stream's intrinsic aspect. */
function PreviewTile({ track }: { track: LocalVideoTrack }) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  return (
    <div className="relative size-full min-h-0 min-w-0 overflow-hidden">
      <video
        ref={ref}
        muted
        playsInline
        autoPlay
        className="absolute inset-0 size-full -scale-x-100 object-cover"
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] flex justify-center p-4">
        <span className="rounded-full bg-black/55 px-3 py-1.5 text-[12px] font-medium text-white/85 backdrop-blur">
          Your camera — joining the webinar
        </span>
      </div>
    </div>
  );
}

function WaitingForStage({
  locked,
  topic,
  imageUrl,
  canPresent,
  preview,
}: {
  locked: boolean;
  topic: string;
  /** The webinar's own cover image, or null when the host never set one.
   *  Only ever shown on the attendee side of this screen — a presenter sees
   *  their own camera preview instead, see `canPresent` below. */
  imageUrl: string | null;
  canPresent: boolean;
  preview: LocalVideoTrack | null;
}) {
  const { enabled: tuneEnabled, setEnabled: setTuneEnabled } = useWaitingTune();

  // The only place that starts or stops it: a presenter is never shown this card (see
  // the branch below), so gating on canPresent here is what keeps a host checking
  // their camera from hearing hold music meant for people waiting on them.
  useEffect(() => {
    if (canPresent || !tuneEnabled) return;
    startWaitingTune();
    return () => stopWaitingTune();
  }, [canPresent, tuneEnabled]);

  if (canPresent) {
    /* Their own camera, while the connection is still being made.
     *
     * This used to be a pulsing dot on a black stage, on the reasoning that anything more
     * would read as an instruction. That was right about instructions and wrong about the
     * dot: a presenter who has just enabled their camera and pressed Join is asking one
     * question — is my camera working — and a black rectangle answers it badly. The track
     * exists already; it was captured on the pre-join screen. So it is shown, and the
     * published track replaces it the moment there is one, because a published track means
     * `tiles` is no longer empty and this component unmounts.
     *
     * The dot remains for the case with no camera: a presenter joining to share their
     * screen has nothing to preview, and a spinner would suggest something is stuck. */
    return (
      <div className="relative size-full min-h-0 min-w-0">
        {preview ? (
          <PreviewTile track={preview} />
        ) : (
          <span
            className="absolute left-1/2 top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 animate-pulse rounded-full bg-white/25"
            aria-hidden
          />
        )}
        <ReactionOverlay />
      </div>
    );
  }

  return (
    <div className="relative grid size-full place-items-center overflow-hidden p-8 text-center">
      {/* The host's own cover image, full-bleed behind the waiting card —
          exactly what they picked when scheduling this webinar, so an
          attendee arriving early sees something deliberate rather than a
          blank stage. A gradient over it, not a flat dim, because the card
          sits in the middle where the stage is otherwise brightest; the top
          and bottom edges are left more of the image to look at. Absent
          entirely — not even the div — when there is no image, so a webinar
          with none renders pixel-identical to before this existed. */}
      {imageUrl && (
        <>
          {/* Two copies of the same image, same trick Spotify/YouTube use for
           * art that does not match the frame it lands in.
           *
           * A host uploads one cover image and it has to fill everything from a
           * square phone-in-hand crop to an ultrawide monitor — no single aspect
           * ratio is right for all of them. object-cover alone (the previous
           * version) picked "always fill the frame" and paid for it by cropping
           * the image itself: a banner designed as a wide landscape strip, full
           * of edge-to-edge text, lost most of that text off the top or sides on
           * a tall phone screen. That is what was reported as broken.
           *
           * So the backdrop copy still covers and crops — full-bleed color with
           * nothing legible on it, blurred so the crop is invisible — and the
           * foreground copy uses object-contain, which never crops: the whole
           * image is always visible, letterboxed on whichever axis does not
           * match. That holds at every aspect ratio, not just the one this was
           * tested at, which is the point of fixing it here instead of shipping
           * a breakpoint tuned to today's screenshot. */}
          {/* eslint-disable @next/next/no-img-element -- a cross-origin API
              URL, not something next/image's loader can optimize. */}
          <img
            src={`${API_BASE}${imageUrl}`}
            alt=""
            aria-hidden
            className="absolute inset-0 size-full scale-110 object-cover opacity-60 blur-2xl"
          />
          <img
            src={`${API_BASE}${imageUrl}`}
            alt=""
            className="absolute inset-0 size-full object-contain"
          />
          {/* eslint-enable @next/next/no-img-element */}
          <div
            aria-hidden
            className="absolute inset-0 bg-gradient-to-b from-black/70 via-black/55 to-black/70"
          />
        </>
      )}
      <div className="relative max-w-sm">
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-white/10">
          {/* A slow pulse, not a spinner: nothing is loading, we are waiting for
              a person, and a spinner would suggest something is stuck. */}
          <span className="size-2.5 animate-pulse rounded-full bg-white/70" />
        </div>
        <p className="text-[15px] font-medium text-white/90">{WAITING_FOR_HOST_LABEL}</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-white/55">
          {locked
            ? "This webinar is locked to new attendees."
            : `You're in the room for “${topic}”. The stage appears as soon as someone starts their camera or shares a screen.`}
        </p>
      </div>
      <ReactionOverlay />
      <button
        type="button"
        onClick={() => setTuneEnabled(!tuneEnabled)}
        aria-label={tuneEnabled ? "Mute the waiting tune" : "Unmute the waiting tune"}
        title={tuneEnabled ? "Mute the waiting tune" : "Unmute the waiting tune"}
        className="absolute right-4 top-4 grid size-9 place-items-center rounded-full bg-white/10 text-white/70 backdrop-blur transition-colors outline-none hover:bg-white/20 hover:text-white/90 focus-visible:ring-2 focus-visible:ring-white/60"
      >
        {tuneEnabled ? (
          <VolumeIcon className="size-4.5" aria-hidden />
        ) : (
          <VolumeMuteIcon className="size-4.5" aria-hidden />
        )}
      </button>
    </div>
  );
}
