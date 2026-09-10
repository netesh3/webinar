"use client";

import { useTracks } from "@livekit/components-react";
import { Track, type LocalVideoTrack } from "livekit-client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyBudget,
  filterTiles,
  paginate,
  qualityFor,
  sortTiles,
  VideoQuality,
  type LayoutMode,
} from "@/lib/layout";
import { isHighlighted } from "@/lib/speaker";
import { ArrowLeftIcon, ChevronDownIcon } from "../icons";
import { useActiveSpeaker } from "./active-speaker";
import { useRoomUI } from "./context";
import { ReactionOverlay } from "./reactions";
import { ParticipantTile, type Tile, type TileSource } from "./tile";

/* The stage: whoever is publishing, laid out.
 *
 * The webinar shape decides the whole design. Attendees never publish, so they
 * never appear here — a placeholder tile per participant would mean 500 empty
 * boxes and a dead tab. The stage is the host, the panelists, and any attendee
 * the host has promoted.
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
  const { topic, controls, permissions, join, stage, entryVideo } = useRoomUI();

  // onlySubscribed: a track we have not subscribed to has no stream to render,
  // and with adaptiveStream the subscription follows what is actually on screen.
  const trackRefs = useTracks([Track.Source.ScreenShare, Track.Source.Camera], {
    onlySubscribed: true,
  });

  const tiles = useMemo<Tile[]>(
    () =>
      trackRefs.map((ref) => ({
        key: `${ref.participant.identity}:${ref.source}`,
        participant: ref.participant,
        source: ref.source as TileSource,
        publication: ref.publication,
      })),
    [trackRefs],
  );

  const screenShare = tiles.find((t) => t.source === Track.Source.ScreenShare);

  /* The viewer's own filters and sort, applied before anything is laid out.
   *
   * Sorted here rather than inside each layout, because the order is what decides
   * which tiles land on the current page — and therefore which video this browser
   * pays for. A layout that sorted its own tiles could unsubscribe from the person
   * who is talking. */
  const ordered = useMemo(
    () => sortTiles(filterTiles(tiles, stage.preferences), stage.pinnedParticipantId),
    [tiles, stage.preferences, stage.pinnedParticipantId],
  );

  /* The mode is exactly what the viewer chose. Nothing overrides it.
   *
   * An earlier version quietly promoted a viewer sitting in the grid to spotlight
   * when a share started, on the reasoning that slides in a small tile are slides
   * nobody can read. It had to go, because it could only be driven from the toggle
   * on the stage: choosing Grid from the footer menu during a share left the label
   * reading "Layout · Grid" over a stage rendering spotlight. Two controls for one
   * setting must not be able to disagree, and the auto-switch was the only thing
   * making that possible.
   *
   * The concern it was addressing is handled where it belongs instead — the sort in
   * lib/layout.ts puts screen shares first, so a share is the first grid tile, and
   * the budget below asks for its HIGH layer whatever else is on the page. A viewer
   * who wants it big has Spotlight one click away in either control. */
  const mode: LayoutMode = stage.mode;

  // Paged only in the grid. The other two modes are one tile plus a strip, and the
  // strip is bounded by what fits.
  const pageSize = mode === "grid" ? stage.preferences.pageSize : ordered.length || 1;
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
  const speaking = useActiveSpeaker();
  const wanted = useMemo(() => {
    const map = new Map<string, VideoQuality>();
    const focusKey = page.items[0]?.key;
    for (const [i, tile] of page.items.entries()) {
      if (tile.source === Track.Source.ScreenShare) {
        // Text at the low rung is unreadable, which is the whole point of a share.
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
        // The pre-join camera, for the gap before the published track arrives.
        preview={entryVideo}
        // A presenter is not waiting for anyone — they are the one everybody else is
        // waiting for. join.canPublish comes first, and that ordering is the fix for
        // a real slip: the live permissions are the SFU's answer and are unknown
        // until the connection is up, so keying on them alone showed a host the
        // attendee copy for the entire connecting phase.
        canPresent={
          join.canPublish || permissions.canShareCamera || permissions.canShareScreen
        }
      />
    );
  }

  const focus =
    ordered.find((t) => t.key === stage.pinnedParticipantId) ?? screenShare ?? ordered[0] ?? tiles[0];
  const rest = ordered.filter((t) => t.key !== focus.key);
  const pinned = stage.pinnedParticipantId;

  return (
    <div className="relative flex size-full min-h-0 flex-col">
      {/* A quick toggle over the stage, alongside the full Layout control in the
          footer. Both write the same one piece of state and neither reinterprets it,
          which is what keeps them honest — see the note on the mode above. One click
          to flip views is worth keeping for a viewer doing it repeatedly while a
          presenter switches between slides and faces. */}
      {ordered.length > 1 && (
        <div className="absolute top-2 right-2 z-20 flex items-center gap-1 rounded-lg bg-black/55 p-0.5 backdrop-blur">
          {(["speaker", "grid", "spotlight"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={mode === option}
              title={`${option[0].toUpperCase()}${option.slice(1)} view`}
              onClick={() => stage.setMode(option)}
              className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
                mode === option ? "bg-white/25 text-white" : "text-white/70 hover:text-white"
              }`}
            >
              {option === "speaker" ? "Speaker" : option === "grid" ? "Grid" : "Spotlight"}
            </button>
          ))}
        </div>
      )}

      {mode === "grid" ? (
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
    <div className={`relative flex min-h-0 flex-1 flex-col ${sharing ? "" : "gap-2 p-2"}`}>
      <div className="min-h-0 flex-1">
        <ParticipantTile
          tile={focus}
          size="lg"
          fullBleed={sharing}
          zoomable={sharing}
          pinned={pinned === focus.key}
          // No pin on a full-bleed share: it is already the focus, so the control
          // would do nothing, and at full bleed it lands under the layout switcher.
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
  // Two beside the content. A third makes each one a thumbnail again, which is
  // speaker view — and speaker view is one click away.
  const beside = rest.slice(0, 2);
  const hidden = rest.length - beside.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2 lg:flex-row">
      <div className="min-h-0 flex-1">
        <ParticipantTile
          tile={focus}
          size="lg"
          zoomable={focus.source === Track.Source.ScreenShare}
          pinned={pinned === focus.key}
          onTogglePin={() => onTogglePin(focus.key)}
        />
      </div>

      {beside.length > 0 && (
        <div
          className="flex shrink-0 gap-2 overflow-auto lg:flex-col [scrollbar-width:thin]"
          // A width on wide screens, a height on narrow ones. Sized in vw/vh so it
          // stays proportionate rather than jumping between fixed steps.
          style={{ ["--spot" as string]: "clamp(180px, 20vw, 300px)" }}
        >
          {beside.map((tile) => (
            <div
              key={tile.key}
              className="aspect-video shrink-0 lg:w-[var(--spot)]"
              style={{ height: "clamp(96px, 18vh, 170px)" }}
            >
              <ParticipantTile
                tile={tile}
                size="md"
                pinned={pinned === tile.key}
                onTogglePin={() => onTogglePin(tile.key)}
              />
            </div>
          ))}
          {hidden > 0 && (
            <span className="grid shrink-0 place-items-center rounded-lg bg-white/10 px-3 text-[12px] font-medium text-white/75 lg:w-[var(--spot)] lg:py-2">
              +{hidden} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* The cameras, floating over a shared screen.
 *
 * This is Zoom's video panel: while somebody is sharing, the faces are a small
 * overlay rather than a row that takes a sixth of the height away from the content
 * everybody is trying to read. Three things follow from being an overlay, and all
 * three are the reason it is a component rather than a div:
 *
 *   collapse  Sometimes you want the screen and nothing else. Zoom has "hide video
 *             panel" and this has the chevron; the count stays visible so it is
 *             obvious there are people behind it.
 *   move      An overlay covers something, and only the viewer knows what. Drag it
 *             and it snaps to whichever corner you let go nearest.
 *   small     Sized in vw so it stays a thumbnail on a 27" display instead of
 *             growing into the thing it is overlapping.
 *
 * The drag lives on its own grip rather than on the tiles, so it can never fight
 * with the pin button inside one of them.
 */

type Corner = "tl" | "tr" | "bl" | "br";

// top-12, not top-2, on the upper corners: the layout switcher sits at top-2 right-2
// and the zoom controls at top-1.5 left-1.5, and an overlay is not an excuse to
// cover a control.
const CORNER: Record<Corner, string> = {
  tl: "top-12 left-2",
  tr: "top-12 right-2",
  bl: "bottom-2 left-2",
  br: "bottom-2 right-2",
};

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
  const [corner, setCorner] = useState<Corner>("br");
  const [open, setOpen] = useState(true);
  const [drag, setDrag] = useState<{ pointer: number; dx: number; dy: number } | null>(null);
  const from = useRef<{ x: number; y: number } | null>(null);
  // The panel, so the snap can be computed against the stage. Read from the panel's
  // offsetParent rather than the grip's: the grip sits INSIDE the positioned panel,
  // so its own offsetParent is the panel and the halves would be measured against a
  // 150-pixel box instead of the stage.
  const panel = useRef<HTMLDivElement>(null);

  const grip = (
    <button
      type="button"
      aria-label="Move the camera panel"
      title="Drag to move"
      // touch-none so a drag on a tablet moves the panel instead of scrolling the
      // page underneath it.
      className={`grid h-6 w-4 shrink-0 touch-none place-items-center rounded-md bg-black/55 text-white/70 backdrop-blur transition-colors hover:bg-black/75 hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
        drag ? "cursor-grabbing" : "cursor-grab"
      }`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        from.current = { x: e.clientX, y: e.clientY };
        setDrag({ pointer: e.pointerId, dx: 0, dy: 0 });
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag?.pointer !== e.pointerId || !from.current) return;
        setDrag({
          pointer: e.pointerId,
          dx: e.clientX - from.current.x,
          dy: e.clientY - from.current.y,
        });
      }}
      onPointerUp={(e) => {
        if (drag?.pointer !== e.pointerId) return;
        // Snap to whichever corner of the STAGE the pointer ended nearest.
        const stage = panel.current?.offsetParent?.getBoundingClientRect();
        if (stage) {
          const right = e.clientX > stage.left + stage.width / 2;
          const bottom = e.clientY > stage.top + stage.height / 2;
          setCorner(`${bottom ? "b" : "t"}${right ? "r" : "l"}` as Corner);
        }
        from.current = null;
        setDrag(null);
      }}
      onPointerCancel={() => {
        from.current = null;
        setDrag(null);
      }}
    >
      <span className="h-3 w-0.5 rounded-full bg-current" />
    </button>
  );

  return (
    <div
      ref={panel}
      className={`absolute z-20 flex items-center gap-1.5 ${CORNER[corner]}`}
      style={
        drag
          ? { transform: `translate3d(${drag.dx}px, ${drag.dy}px, 0)` }
          : { transition: "transform 120ms ease-out" }
      }
    >
      {grip}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "Hide the cameras" : `Show ${tiles.length + hidden} cameras`}
        title={open ? "Hide cameras" : "Show cameras"}
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-black/55 px-1.5 text-[11px] font-medium text-white/85 backdrop-blur transition-colors hover:bg-black/75 hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <ChevronDownIcon className={`size-3 transition-transform ${open ? "" : "rotate-180"}`} />
        {!open && <span className="tabular-nums">{tiles.length + hidden}</span>}
      </button>

      {open && (
        <>
          {tiles.map((tile) => (
            <div
              key={tile.key}
              className="aspect-video shrink-0 overflow-hidden rounded-lg shadow-lg ring-1 ring-white/10"
              // vw rather than a breakpoint step, so it is a thumbnail at every
              // width instead of jumping between three fixed sizes.
              style={{ width: "clamp(80px, 11vw, 148px)" }}
            >
              <ParticipantTile
                tile={tile}
                size="sm"
                pinned={pinned === tile.key}
                onTogglePin={() => onTogglePin(tile.key)}
              />
            </div>
          ))}
          {hidden > 0 && (
            <span className="shrink-0 self-stretch rounded-md bg-black/60 px-1.5 py-1 text-[11px] font-medium text-white/85 backdrop-blur">
              +{hidden}
            </span>
          )}
        </>
      )}
    </div>
  );
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
 * The column count comes from a CSS minimum tile width rather than from measuring
 * the container in JavaScript: correct on the first paint, survives a window
 * opening beside it, and needs no resize observer.
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
  const minWidth =
    count <= 1 ? "100%" : count <= 4 ? "320px" : count <= 9 ? "240px" : count <= 25 ? "176px" : "132px";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div
          className="grid h-full content-center gap-2"
          style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${minWidth}), 1fr))` }}
        >
          {page.items.map((tile) => (
            <div key={tile.key} className="aspect-video max-h-full">
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
 * loop, and an un-mirrored self-view makes people reach the wrong way. */
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
    <div className="relative size-full">
      <video
        ref={ref}
        muted
        playsInline
        autoPlay
        className="size-full -scale-x-100 object-contain"
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-4">
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
  canPresent,
  preview,
}: {
  locked: boolean;
  topic: string;
  canPresent: boolean;
  preview: LocalVideoTrack | null;
}) {
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
      <div className="relative grid size-full place-items-center">
        {preview ? (
          <PreviewTile track={preview} />
        ) : (
          <span className="size-2.5 animate-pulse rounded-full bg-white/25" aria-hidden />
        )}
        <ReactionOverlay />
      </div>
    );
  }

  return (
    <div className="relative grid size-full place-items-center p-8 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-white/10">
          {/* A slow pulse, not a spinner: nothing is loading, we are waiting for
              a person, and a spinner would suggest something is stuck. */}
          <span className="size-2.5 animate-pulse rounded-full bg-white/70" />
        </div>
        <p className="text-[15px] font-medium text-white/90">Waiting for the host to start</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-white/55">
          {locked
            ? "This webinar is locked to new attendees."
            : `You're in the room for “${topic}”. The stage appears as soon as someone starts their camera or shares a screen.`}
        </p>
      </div>
      <ReactionOverlay />
    </div>
  );
}
