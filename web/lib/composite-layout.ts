/* The composite page's layout: which classes each box gets, given what is on stage.
 *
 * Kept as data so the one tree in recorder-template keeps its shape whatever the layout —
 * swapping trees remounts every VideoTrack, which is seconds of black on the egress box —
 * and so the edge layout can be tested without a browser.
 *
 * Standard (recordings, CDN broadcast): a share sits next to a camera strip down the right.
 * Edge: the share fills the whole frame and the cameras are small tiles over the bottom-right
 * corner. The edge mix is the audience's only picture, and next to a 22% strip a share lost a
 * third of its pixels, which at 720p made slide text unreadable. Only cameras that are on get a
 * tile there: someone with their camera off is an initials card the audience gains nothing from. */

/** At most this many camera tiles over an edge share; more would cover the slides. */
export const EDGE_PIP_TILES = 3;

export type CompositeLayout = {
  root: string;
  main: string;
  strip: string;
  tile: string;
  /** How many camera tiles to show; undefined means all. */
  maxTiles: number | undefined;
  /** Show "No camera published" when there are none. */
  emptyNote: boolean;
  compactTiles: boolean;
  /** Only tiles with a live camera: an initials tile over a share covers slides for nothing. */
  camerasOnly: boolean;
};

export function compositeLayout(opts: { edge: boolean; sharing: boolean }): CompositeLayout {
  if (opts.sharing && opts.edge) {
    return {
      root: "relative h-full w-full bg-black",
      main: "absolute inset-0 flex items-center justify-center bg-black order-1",
      strip: "absolute bottom-3 right-3 z-10 flex flex-row items-end gap-2 order-2",
      tile: "w-[14vw] shadow-[0_2px_10px_rgba(0,0,0,0.6)]",
      maxTiles: EDGE_PIP_TILES,
      emptyNote: false,
      compactTiles: true,
      camerasOnly: true,
    };
  }
  if (opts.sharing) {
    return {
      root: "flex h-full w-full bg-black flex-row",
      main: "relative flex-1 h-full min-w-0 flex items-center justify-center bg-black p-1 order-1",
      strip:
        "w-[22%] min-w-[240px] max-w-[340px] h-full bg-zinc-950/90 border-l border-zinc-800/80 p-2 flex flex-col gap-2.5 overflow-hidden order-2",
      tile: "w-full",
      maxTiles: undefined,
      emptyNote: true,
      compactTiles: false,
      camerasOnly: false,
    };
  }
  return {
    root: "flex h-full w-full bg-black flex-col",
    main: "flex-1 min-h-0 relative flex items-center justify-center p-3 bg-black order-2",
    strip:
      "h-28 shrink-0 flex items-center justify-center gap-2 px-3 py-1.5 bg-zinc-950/80 border-b border-zinc-800/60 order-1",
    tile: "h-full aspect-video",
    maxTiles: 5,
    emptyNote: true,
    compactTiles: true,
    camerasOnly: false,
  };
}

/** Whether a template path asks for the edge layout: <template>/edge or <template>/edge/clock. */
export function isEdgeTemplatePath(path: string): boolean {
  return /\/edge(\/|$)/.test(path);
}

/** Whether a camera entry has a picture: published, not muted (camera off), and subscribed.
 *  useTracks with onlySubscribed false also returns placeholders for people with no camera. */
export function cameraIsOn(ref: {
  publication?: { isMuted: boolean; isSubscribed: boolean } | undefined;
}): boolean {
  const pub = ref.publication;
  return Boolean(pub && !pub.isMuted && pub.isSubscribed);
}
