"use client";

import {
  Track,
  VideoQuality,
  type Participant,
  type TrackPublication,
} from "livekit-client";
import { useCallback, useEffect, useMemo, useState } from "react";

/* How the stage is laid out, for one viewer.
 *
 * Everything here is CLIENT-SIDE and personal. Nothing is published, nothing goes
 * near the SFU's room metadata, and no other participant can observe it. That is a
 * requirement rather than an implementation detail: a viewer switching to a grid
 * because they want to watch the room must not reframe the session for the four
 * hundred people who were reading the slides.
 *
 * The reason this is a module rather than component state is the part that is not
 * about layout at all. Deciding which tiles are on screen also decides which video
 * tracks this browser downloads, and at 300 participants that is the difference
 * between a working tab and a dead one. So the same code owns both: what to show,
 * and what to ask the SFU for. Splitting them is how a paging control ends up
 * looking right and still pulling three hundred streams.
 */

export type LayoutMode = "grid" | "speaker" | "spotlight";

export const LAYOUT_MODES: readonly LayoutMode[] = [
  "speaker",
  "grid",
  "spotlight",
];

export const LAYOUT_LABEL: Record<LayoutMode, string> = {
  speaker: "Speaker",
  grid: "Grid",
  spotlight: "Spotlight",
};

export const LAYOUT_HINT: Record<LayoutMode, string> = {
  speaker: "One large tile, the rest in a strip",
  grid: "Everyone the same size, paged",
  spotlight: "Shared content locked large, presenters beside it",
};

/* Tiles per page.
 *
 * Fixed choices rather than a slider, and these three because they are the square
 * numbers that tile cleanly: 4×4, 5×5, 7×7. A page size that leaves a ragged last
 * row looks like a bug.
 *
 * The ceiling is 49 and not "all of them" on purpose. Fifty video elements is
 * already more than a laptop decodes comfortably; three hundred is a crashed tab,
 * which is the failure this whole module exists to avoid.
 */
export const PAGE_SIZES = [16, 25, 49] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

/* A hard ceiling on top of the chosen PageSize, for a screen too small to
 * make 16 tiles meaningful regardless of what the viewer picked. 767px
 * matches useCompact's own boundary in lib/compact.ts — the same width the
 * rest of the room goes phone-shaped at — and 1023px is Tailwind's `lg`,
 * used nowhere else in this file but the natural tablet/laptop line.
 *
 * Only ever narrows the page size, never widens it: a viewer who picked 16
 * on a desktop and then narrows the window to tablet width gets 8, not a
 * surprise jump to more tiles than they asked for.
 */
export function useResponsiveGridCap(): number | null {
  const [cap, setCap] = useState<number | null>(null);
  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 767px)");
    const tablet = window.matchMedia("(max-width: 1023px)");
    const sync = () => setCap(mobile.matches ? 4 : tablet.matches ? 8 : null);
    sync();
    mobile.addEventListener("change", sync);
    tablet.addEventListener("change", sync);
    return () => {
      mobile.removeEventListener("change", sync);
      tablet.removeEventListener("change", sync);
    };
  }, []);
  return cap;
}

export type LayoutPreferences = {
  /** Drop participants whose camera is off. In a large webinar most tiles are an
   *  avatar on a dark square, and a viewer looking for faces would rather have
   *  fewer, bigger ones. */
  hideNonVideo: boolean;
  /** Hide your own camera tile. A screen share you are sending stays — that is
   *  the content, not a self-view. */
  hideSelf: boolean;
  /** Only the host and the panelists — nobody the host promoted for one question. */
  onlySpeakers: boolean;
  pageSize: PageSize;
  currentPage: number;
};

export type StageLayoutState = {
  mode: LayoutMode;
  preferences: LayoutPreferences;
  /** The tile this viewer locked to the main stage, by tile key. Null is "follow the room" —
   *  which means the screen share if there is one, and otherwise the first tile in the stable
   *  order, i.e. the host. Deliberately NOT the active speaker: the main stage does not chase
   *  whoever is talking, because that moves every other tile with it. Pinning is how a viewer
   *  chooses somebody else. See `sortTiles`. */
  pinnedParticipantId: string | null;
};

const DEFAULTS: StageLayoutState = {
  // Speaker, not grid. A webinar has a handful of publishers and hundreds of
  // watchers, so the common case is one presenter and the grid would be one large
  // tile in a container built to hold forty-nine.
  mode: "speaker",
  preferences: {
    hideNonVideo: false,
    hideSelf: false,
    onlySpeakers: false,
    // 16 (4×4) rather than 25: the common case for a page that fills is a
    // laptop screen, and 4×4 is what reads as "everyone" there without the
    // tiles shrinking to the point a face is a dozen pixels wide. Still one
    // of PAGE_SIZES, so a viewer with a genuinely big monitor and a big
    // audience can still ask for 25 or 49.
    pageSize: 16,
    currentPage: 0,
  },
  pinnedParticipantId: null,
};

// --------------------------------------------------------------------- sorting

/** A tile, reduced to what sorting needs. Keeps this file independent of the
 *  component that renders one. */
export type Sortable = {
  key: string;
  participant: Participant;
  source: Track.Source;
  publication?: TrackPublication;
};

/** Role from the metadata our own API mints. Untrusted in principle, so a shape we
 *  do not recognise sorts as an attendee rather than throwing. */
function roleRank(participant: Participant): number {
  try {
    const meta = participant.metadata
      ? (JSON.parse(participant.metadata) as { role?: unknown })
      : null;
    if (meta?.role === "host") return 0;
    if (meta?.role === "panelist") return 1;
  } catch {
    // Fall through to attendee.
  }
  return 2;
}

function hasLiveVideo(tile: Sortable): boolean {
  return (
    !!tile.publication && !tile.publication.isMuted && !!tile.publication.track
  );
}

/**
 * Smart sort: the things worth looking at first.
 *
 * The order matters more than it looks, because with pagination the tail of this
 * list is what stops being downloaded, and because the position in this list is
 * what `wanted` in stage.tsx turns into a video quality.
 *
 *   1. whatever the viewer pinned. Their explicit choice outranks every heuristic.
 *   2. screen shares. Somebody sharing is presenting; that is the content.
 *   3. in speaker-mode only, the active speaker's camera. Grid and spotlight pass
 *      null here, so a conversation does not reshuffle a gallery or a slide deck.
 *   4. host, then panelists, then promoted attendees.
 *   5. cameras on before cameras off.
 *   6. identity, so the order is stable.
 *
 * Who is talking is NOT in the default order, and used to be ranked third for every
 * mode. That made the stage move constantly: every handover jumped a tile to the
 * front, re-requested a video layer, and could flash a <video> black. Speaker view
 * is the one place Zoom puts the talker on the large tile, so that mode opts in
 * through `speakingIdentity`. Pin still wins. A share still wins over a camera.
 * The green outline (lib/speaker.ts) still marks the talker in every mode.
 */
export function sortTiles<T extends Sortable>(
  tiles: readonly T[],
  pinnedKey: string | null,
  speakingIdentity: string | null = null,
): T[] {
  return [...tiles].sort((a, b) => {
    const pin = Number(b.key === pinnedKey) - Number(a.key === pinnedKey);
    if (pin !== 0) return pin;

    const share =
      Number(b.source === Track.Source.ScreenShare) -
      Number(a.source === Track.Source.ScreenShare);
    if (share !== 0) return share;

    if (speakingIdentity) {
      const speak =
        Number(
          b.source !== Track.Source.ScreenShare &&
            b.participant.identity === speakingIdentity,
        ) -
        Number(
          a.source !== Track.Source.ScreenShare &&
            a.participant.identity === speakingIdentity,
        );
      if (speak !== 0) return speak;
    }

    const role = roleRank(a.participant) - roleRank(b.participant);
    if (role !== 0) return role;

    /* Somebody else before yourself — but only as a tie-break WITHIN a role.
     *
     * Your own camera is the one video in the room you do not need to watch, and it was
     * landing on the main stage: a host with one panelist saw a large picture of themselves
     * with the person actually talking in a thumbnail — at the LOW simulcast layer, because
     * position is what `wanted` turns into a video quality. So the host was looking at a 180p
     * panelist while a 720p self-view took the big tile.
     *
     * Below the role comparison, not above it. Above it, being local outranked everything and
     * a host watching their own camera sorted below a promoted attendee — which the test for
     * this caught. The rule is "of two equally important tiles, show me the other one", not
     * "everyone matters more than me".
     *
     * Stable, unlike ranking by who is speaking: "is this me" does not change during a
     * session. For an attendee, who publishes nothing, it never fires at all.
     */
    const mine = Number(a.participant.isLocal) - Number(b.participant.isLocal);
    if (mine !== 0) return mine;

    const video = Number(hasLiveVideo(b)) - Number(hasLiveVideo(a));
    if (video !== 0) return video;

    return a.participant.identity.localeCompare(b.participant.identity);
  });
}

/** Applies the viewer's filters.
 *
 *  hideNonVideo never drops your own camera — a viewer hiding avatars should not
 *  lose the one tile that tells them they are on air. hideSelf is the explicit
 *  opposite, and still keeps a local screen share. */
export function filterTiles<T extends Sortable>(
  tiles: readonly T[],
  preferences: LayoutPreferences,
): T[] {
  return tiles.filter((tile) => {
    if (tile.participant.isLocal) {
      if (preferences.hideSelf && tile.source !== Track.Source.ScreenShare) {
        return false;
      }
      return true;
    }
    if (tile.source === Track.Source.ScreenShare) return true;
    if (preferences.onlySpeakers && roleRank(tile.participant) === 2)
      return false;
    if (preferences.hideNonVideo && !hasLiveVideo(tile)) return false;
    return true;
  });
}

// ------------------------------------------------------------------ pagination

export type Page<T> = {
  items: T[];
  page: number;
  pages: number;
  /** Everything not on this page. What the subscription budget switches off. */
  offscreen: T[];
};

export function paginate<T>(
  items: readonly T[],
  size: number,
  page: number,
): Page<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  // Clamped rather than trusted: the page number outlives the list it indexed, so
  // somebody on page 4 when a webinar empties out would otherwise be looking at
  // nothing with no way back.
  const at = Math.min(Math.max(page, 0), pages - 1);
  const from = at * size;
  const visible = items.slice(from, from + size);
  return {
    items: visible,
    page: at,
    pages,
    offscreen: [...items.slice(0, from), ...items.slice(from + size)],
  };
}

// -------------------------------------------------------- subscription budget

/** Only a remote publication can be switched off. A type guard rather than a cast,
 *  so a local publication cannot silently take the remote path. */
type Switchable = TrackPublication & {
  setEnabled: (enabled: boolean) => void;
  setVideoQuality: (quality: VideoQuality) => void;
};

function switchable(
  publication: TrackPublication | undefined,
): Switchable | null {
  if (!publication) return null;
  const p = publication as Switchable;
  return typeof p.setEnabled === "function" &&
    typeof p.setVideoQuality === "function"
    ? p
    : null;
}

/**
 * Tells the SFU exactly what this browser wants: which tracks, at which layer.
 *
 * Two facts from livekit-client's own source shape this, and the second one makes it
 * mandatory rather than an optimisation:
 *
 *   `isManualOperationAllowed()` only refuses when the track is not subscribed —
 *   NOT because adaptiveStream is on. So these calls are allowed and they compose
 *   with it. Worth knowing, because the reverse would have made this file useless.
 *
 *   `isEnabled` is `requestedDisabled !== undefined ? !requestedDisabled : visible`.
 *   In other words the FIRST setEnabled call takes the decision away from
 *   adaptiveStream permanently, for that track. There is no falling back to it
 *   afterwards. So this has to be told about every tile, including the ones the
 *   viewer's filters removed — otherwise a participant hidden by "hide non-video"
 *   keeps whatever state it had, is rendered nowhere, and goes on downloading with
 *   nothing left to switch it off.
 *
 * `wanted` maps a tile key to the layer it should arrive at. A key that is absent is
 * off screen and gets switched off. Idempotent — livekit-client returns early when
 * the request has not changed — so calling it on every layout change is free.
 */
export function applyBudget(
  all: readonly Sortable[],
  wanted: ReadonlyMap<string, VideoQuality>,
): void {
  for (const tile of all) {
    const publication = switchable(tile.publication);
    // A local publication has neither method: our own camera is not something to
    // subscribe to, and the guard is what keeps that out of this loop.
    if (!publication) continue;

    const quality = wanted.get(tile.key);
    if (quality === undefined) {
      // Screen shares stay subscribed even off screen: they are the content, the
      // viewer is one click from looking at them, and there is only ever one or two.
      if (tile.source === Track.Source.ScreenShare) continue;
      publication.setEnabled(false);
      continue;
    }
    publication.setEnabled(true);
    publication.setVideoQuality(quality);
  }
}

/** Which simulcast rung a grid of N equal tiles should ask for.
 *
 *  Thresholds on the tile count rather than on pixels, because the count is what
 *  the layout knows and it is what decides how small each one ends up. Forty-nine
 *  tiles at 132px do not benefit from a 1080p layer; they benefit from the tab not
 *  falling over.
 *
 *  With a 1080p HIGH layer, only 1–2 large tiles should request it. Three-to-nine
 *  equal tiles get MEDIUM (720p) — still sharp, without burning 1080 encode/egress
 *  on faces that are a few hundred CSS pixels wide. Filmstrips stay LOW (360p).
 *  Speaker/spotlight focus forces HIGH independently of this helper. */
export function qualityFor(tileCount: number): VideoQuality {
  if (tileCount <= 2) return VideoQuality.HIGH;
  if (tileCount <= 9) return VideoQuality.MEDIUM;
  return VideoQuality.LOW;
}

/** Re-exported so the stage can name a layer without importing livekit-client for
 *  one enum. */
export { VideoQuality };

// --------------------------------------------------------------- persistence

const STORAGE_KEY = "webcast.stage-layout.v1";

/** Persisted: the mode and the filters, because they are preferences. Not the page
 *  or the pin, which are about a session that has already ended. */
type Persisted = {
  mode: LayoutMode;
  hideNonVideo: boolean;
  hideSelf: boolean;
  onlySpeakers: boolean;
  pageSize: PageSize;
};

function load(): StageLayoutState {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      ...DEFAULTS,
      mode: LAYOUT_MODES.includes(parsed.mode as LayoutMode)
        ? (parsed.mode as LayoutMode)
        : DEFAULTS.mode,
      preferences: {
        ...DEFAULTS.preferences,
        hideNonVideo: parsed.hideNonVideo === true,
        hideSelf: parsed.hideSelf === true,
        onlySpeakers: parsed.onlySpeakers === true,
        pageSize: (PAGE_SIZES as readonly number[]).includes(
          parsed.pageSize as number,
        )
          ? (parsed.pageSize as PageSize)
          : DEFAULTS.preferences.pageSize,
      },
    };
  } catch {
    return DEFAULTS;
  }
}

// ---------------------------------------------------------------------- hook

export type StageLayoutApi = StageLayoutState & {
  setMode: (mode: LayoutMode) => void;
  setPreferences: (patch: Partial<LayoutPreferences>) => void;
  setPage: (page: number) => void;
  togglePin: (key: string) => void;
  clearPin: () => void;
  reset: () => void;
};

export function useStageLayout(): StageLayoutApi {
  // Read in the initialiser: the room is never server-rendered (the join response
  // is fetched in the browser), so there is nothing for a stored value to disagree
  // with, and doing it in an effect showed the default layout for one frame.
  const [state, setState] = useState<StageLayoutState>(load);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const persisted: Persisted = {
        mode: state.mode,
        hideNonVideo: state.preferences.hideNonVideo,
        hideSelf: state.preferences.hideSelf,
        onlySpeakers: state.preferences.onlySpeakers,
        pageSize: state.preferences.pageSize,
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      // Private browsing. The choice lasts the session.
    }
  }, [
    state.mode,
    state.preferences.hideNonVideo,
    state.preferences.hideSelf,
    state.preferences.onlySpeakers,
    state.preferences.pageSize,
  ]);

  const setMode = useCallback((mode: LayoutMode) => {
    setState((c) => ({
      ...c,
      mode,
      // Back to the first page on a mode change. Landing on page 3 of a grid you
      // have just switched into is disorienting, and page 3 may not exist in the
      // new mode's filtered set.
      preferences: { ...c.preferences, currentPage: 0 },
    }));
  }, []);

  const setPreferences = useCallback((patch: Partial<LayoutPreferences>) => {
    setState((c) => {
      const next = { ...c.preferences, ...patch };
      // Any filter or size change invalidates the page index, for the same reason.
      const resets =
        "hideNonVideo" in patch ||
        "hideSelf" in patch ||
        "onlySpeakers" in patch ||
        "pageSize" in patch;
      return { ...c, preferences: resets ? { ...next, currentPage: 0 } : next };
    });
  }, []);

  const setPage = useCallback((page: number) => {
    setState((c) => ({
      ...c,
      preferences: { ...c.preferences, currentPage: Math.max(0, page) },
    }));
  }, []);

  const togglePin = useCallback((key: string) => {
    setState((c) => ({
      ...c,
      pinnedParticipantId: c.pinnedParticipantId === key ? null : key,
    }));
  }, []);

  const clearPin = useCallback(() => {
    setState((c) =>
      c.pinnedParticipantId === null ? c : { ...c, pinnedParticipantId: null },
    );
  }, []);

  const reset = useCallback(() => setState(DEFAULTS), []);

  return useMemo<StageLayoutApi>(
    () => ({
      ...state,
      setMode,
      setPreferences,
      setPage,
      togglePin,
      clearPin,
      reset,
    }),
    [state, setMode, setPreferences, setPage, togglePin, clearPin, reset],
  );
}

/* Whether a camera tile should crop to fill its box, or letterbox inside it.
 *
 * `object-fit: cover` is right for a face almost always — trimming the edges of a portrait
 * beats black bars down the sides. It stops being right when the box and the frame disagree
 * badly enough, and a webinar produces exactly that: the speaker tile takes the full width and
 * whatever height is left after the filmstrip, so on a wide, short browser window it ends up
 * around 2.6:1 against a camera's 16:9.
 *
 * At that point cover scales the frame to match the WIDTH and throws away a third of its
 * height, then magnifies what is left across the full width of the tile — on a 720p capture
 * and a Retina screen that is better than a 3x upscale of two-thirds of the picture. It reads
 * as a soft, over-zoomed close-up, which is precisely what was reported.
 *
 * So: crop up to `allowCrop` of the frame, and letterbox past it. The threshold is a judgement
 * about which artefact is worse, and it is deliberately generous — a 4:3 tile showing a 16:9
 * camera crops 25% and still looks better cropped, so only genuinely extreme boxes letterbox.
 *
 * Screen shares are not passed through here at all. They always contain: cropping a slide is
 * how the bottom line of a terminal disappears.
 */
export const MAX_TILE_CROP = 0.3;

export type TileFit = "cover" | "contain";

export function tileFit(
  boxAspect: number,
  sourceAspect: number,
  allowCrop: number = MAX_TILE_CROP,
): TileFit {
  // Unknown or degenerate inputs keep the old behaviour. A tile mid-layout can report a zero
  // height for a frame, and flipping to contain on that would make the video visibly jump.
  if (!(boxAspect > 0) || !(sourceAspect > 0)) return "cover";

  /* How much of the frame survives cover, as a fraction.
   *
   * cover scales until BOTH axes are filled, so it crops along whichever axis the box is
   * proportionally longer in. The ratio of the smaller aspect to the larger is the fraction of
   * the frame still visible, whichever direction the mismatch runs — which is why this is not
   * two branches.
   */
  const kept =
    Math.min(boxAspect, sourceAspect) / Math.max(boxAspect, sourceAspect);
  return 1 - kept > allowCrop ? "contain" : "cover";
}
