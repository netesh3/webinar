/* The composite's layouts: a registry of pure functions from "what is on stage" to boxes.
 *
 * The composite is the picture edge (LL-HLS) viewers, CDN viewers and recordings get, drawn by
 * the egress from app/recorder-template. The host picks a layout (SessionControls.audienceLayout,
 * PATCH /controls); it reaches the egress page through room metadata, so a switch re-lays the
 * picture live without restarting the egress.
 *
 * Every layout returns absolute rects in the frame's pixels, and the page draws one tree of
 * absolutely positioned boxes keyed by identity. A layout switch, a share starting or someone
 * becoming the active speaker therefore only moves boxes: no VideoTrack is unmounted, which on
 * the egress box is seconds of black frames (see the page's own comment).
 *
 * To add a layout (branding, backgrounds, lower thirds later): one entry in LAYOUTS with an
 * id, a label, a sample for its thumbnail and a place() function; the server's list
 * (types.AudienceLayouts in api/types/types.go) has to learn the id too.
 *
 * Pure so node can test it — see composite-layouts.test.mts, run by `make test-web`. */

import { beaconCells, SV_SHARE, SV_SPEAKER, toPixels } from "./speaker-view.ts";

export type Rect = { x: number; y: number; w: number; h: number };
export type Frame = { w: number; h: number };

/** A camera tile on stage, in stage order: the page sorts the active speaker first. */
export type StageTile = { id: string; cameraOn: boolean };

export type LayoutInput = {
  frame: Frame;
  /** A screen share is subscribed. At most one: the room allows one share at a time. */
  share: boolean;
  cameras: readonly StageTile[];
  /** The edge mix (<template>/edge). Only auto draws differently for it. */
  edge: boolean;
};

/** The id the share's placement carries. Not a valid LiveKit identity, so it cannot clash. */
export const SHARE_ID = "\u0000share";

export type Role = "main" | "strip" | "grid" | "pip";

export type Placement = {
  id: string;
  rect: Rect;
  role: Role;
  /** Stacking: 0 for the base layer, 1 for anything drawn over it (a PiP bubble). */
  z: 0 | 1;
  /** Drawn edge to edge: no border, ring or rounding, the camera covering the box. Speaker
   *  view's tile, which a phone crops out of the mix exactly at this rect. */
  bare?: true;
};

export type LayoutResult = {
  placements: Placement[];
  /** Where to say "No camera published": auto's empty share strip, as it always did. */
  note?: Rect;
  /** Cells to paint BEACON_COLOR (lib/speaker-view.ts): this frame is speaker view's fixed
   *  geometry, which a phone splits into the share and a floating speaker. */
  beacon?: Rect[];
};

export type AudienceLayoutId =
  | "auto"
  | "speaker"
  | "grid"
  | "share_only"
  | "share_speaker"
  | "side_by_side"
  | "video_only"
  | "speaker_view";

export type CompositeLayoutDef = {
  id: AudienceLayoutId;
  label: string;
  description: string;
  /** What the picker's thumbnail draws: this layout's own place() on a small sample stage. */
  sample: { share: boolean; cameras: number };
  place: (input: LayoutInput) => LayoutResult;
};

// ------------------------------------------------------------------ limits

/** One page of grid tiles. The egress decodes every tile it draws, on a box with no CPU to
 *  spare, so the grid never pages: it shows the first page and stops. */
export const GRID_MAX = 16;
/** Speaker view's filmstrip, before width runs out. */
export const STRIP_MAX = 6;
/** auto's top strip without a share (the layout's old maxTiles). */
const AUTO_TOP_STRIP_MAX = 5;

const GAP = 8;
const PAD = 12;
const ASPECT = 16 / 9;

// ------------------------------------------------------------------ geometry

/** The largest 16:9 rect inside `box`, centred. */
export function fit16x9(box: Rect): Rect {
  let w = box.w;
  let h = w / ASPECT;
  if (h > box.h) {
    h = box.h;
    w = h * ASPECT;
  }
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

function inset(r: Rect, d: number): Rect {
  return { x: r.x + d, y: r.y + d, w: Math.max(0, r.w - 2 * d), h: Math.max(0, r.h - 2 * d) };
}

function full(frame: Frame): Rect {
  return { x: 0, y: 0, w: frame.w, h: frame.h };
}

/** Equal 16:9 cells for n items in `box`: as large as they can be, rows centred. */
export function gridRects(n: number, box: Rect, gap = GAP): Rect[] {
  if (n <= 0) return [];
  let best: { cols: number; rows: number; w: number; h: number } | null = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = (box.w - gap * (cols - 1)) / cols;
    const ch = (box.h - gap * (rows - 1)) / rows;
    if (cw <= 0 || ch <= 0) continue;
    const cell = fit16x9({ x: 0, y: 0, w: cw, h: ch });
    if (!best || cell.w > best.w) best = { cols, rows, w: cell.w, h: cell.h };
  }
  if (!best) return [];
  const { cols, rows, w, h } = best;
  const totalH = rows * h + (rows - 1) * gap;
  const top = box.y + (box.h - totalH) / 2;
  const out: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(cols, n - r * cols);
    const rowW = inRow * w + (inRow - 1) * gap;
    const left = box.x + (box.w - rowW) / 2;
    for (let c = 0; c < inRow; c++) {
      out.push({ x: left + c * (w + gap), y: top + r * (h + gap), w, h });
    }
  }
  return out;
}

/** A centred row of 16:9 tiles of height h in `box`, as many as fit (at most max). */
function rowRects(n: number, box: Rect, max: number, gap = GAP): Rect[] {
  const h = box.h;
  const w = h * ASPECT;
  const fits = Math.max(0, Math.floor((box.w + gap) / (w + gap)));
  const count = Math.min(n, max, fits);
  const rowW = count * w + Math.max(0, count - 1) * gap;
  const left = box.x + (box.w - rowW) / 2;
  return Array.from({ length: count }, (_, i) => ({ x: left + i * (w + gap), y: box.y, w, h }));
}

// ------------------------------------------------------------------ layouts

const NOTHING: LayoutResult = { placements: [] };

/** auto without a share: the active speaker in the main area, the others along the top. */
function autoNoShare(input: LayoutInput): LayoutResult {
  const { frame, cameras } = input;
  if (cameras.length === 0) return NOTHING;
  const others = cameras.slice(1);
  const stripH = others.length > 0 ? Math.min(112, Math.round(frame.h * 0.2)) : 0;
  const placements: Placement[] = [];
  if (stripH > 0) {
    const tiles = rowRects(others.length, { x: PAD, y: 6, w: frame.w - 2 * PAD, h: stripH - 12 }, AUTO_TOP_STRIP_MAX);
    tiles.forEach((rect, i) => placements.push({ id: others[i].id, rect, role: "strip", z: 0 }));
  }
  const main = inset({ x: 0, y: stripH, w: frame.w, h: frame.h - stripH }, PAD);
  placements.unshift({ id: cameras[0].id, rect: fit16x9(main), role: "main", z: 0 });
  return { placements };
}

/** auto: the composite as it always was. */
function placeAuto(input: LayoutInput): LayoutResult {
  const { frame, cameras, share, edge } = input;
  if (!share) return autoNoShare(input);
  /* The edge mix, when the host has not chosen a layout: speaker view (Zoom style), so phones
   * get the share full width with the speaker floating over it. It used to be the share over
   * the whole frame with up to three corner tiles, which a phone could not take apart. */
  if (edge) return placeSpeakerView(input);
  // Recordings and the CDN broadcast: the share next to a camera strip down the right.
  const stripW = Math.min(340, Math.max(240, Math.round(frame.w * 0.22)));
  const shareBox = inset({ x: 0, y: 0, w: frame.w - stripW, h: frame.h }, 4);
  const placements: Placement[] = [{ id: SHARE_ID, rect: shareBox, role: "main", z: 0 }];
  const tileW = stripW - 16;
  const tileH = tileW / ASPECT;
  const fits = Math.max(0, Math.floor((frame.h - 16 + 10) / (tileH + 10)));
  cameras.slice(0, fits).forEach((c, i) => {
    placements.push({
      id: c.id,
      rect: { x: frame.w - stripW + 8, y: 8 + i * (tileH + 10), w: tileW, h: tileH },
      role: "strip",
      z: 0,
    });
  });
  const note = cameras.length === 0 ? { x: frame.w - stripW, y: 0, w: stripW, h: frame.h } : undefined;
  return { placements, note };
}

/** Speaker: the active speaker large, a filmstrip of the rest along the bottom. A share, when
 *  there is one, leads the filmstrip so it is not lost. */
function placeSpeaker(input: LayoutInput): LayoutResult {
  const { frame, cameras, share } = input;
  const [lead, ...rest] = cameras;
  const stripIds = [...(share ? [SHARE_ID] : []), ...rest.map((c) => c.id)];
  if (!lead) {
    // Nobody on camera: whatever is left fills the frame.
    return share ? { placements: [{ id: SHARE_ID, rect: full(frame), role: "main", z: 0 }] } : NOTHING;
  }
  const stripH = stripIds.length > 0 ? Math.round(frame.h * 0.18) : 0;
  const placements: Placement[] = [];
  const main = inset({ x: 0, y: 0, w: frame.w, h: frame.h - stripH }, PAD);
  placements.push({ id: lead.id, rect: fit16x9(main), role: "main", z: 0 });
  if (stripH > 0) {
    const tiles = rowRects(stripIds.length, { x: PAD, y: frame.h - stripH, w: frame.w - 2 * PAD, h: stripH - PAD }, STRIP_MAX);
    tiles.forEach((rect, i) => placements.push({ id: stripIds[i], rect, role: "strip", z: 0 }));
  }
  return { placements };
}

/** Grid: equal tiles, the share first, one page at most. */
function placeGrid(input: LayoutInput): LayoutResult {
  const ids = [...(input.share ? [SHARE_ID] : []), ...input.cameras.map((c) => c.id)].slice(0, GRID_MAX);
  const rects = gridRects(ids.length, inset(full(input.frame), PAD));
  return { placements: rects.map((rect, i) => ({ id: ids[i], rect, role: "grid", z: 0 })) };
}

/** Share only: the share and nothing else; speaker view when nobody shares. */
function placeShareOnly(input: LayoutInput): LayoutResult {
  if (!input.share) return placeSpeaker(input);
  return { placements: [{ id: SHARE_ID, rect: full(input.frame), role: "main", z: 0 }] };
}

/** Share + speaker: the share fills the frame, the active speaker in a bubble bottom-right. */
function placeShareSpeaker(input: LayoutInput): LayoutResult {
  const { frame, share, cameras } = input;
  if (!share) return placeSpeaker(input);
  const placements: Placement[] = [{ id: SHARE_ID, rect: full(frame), role: "main", z: 0 }];
  const lead = cameras[0];
  if (lead) {
    const w = Math.round(frame.w * 0.22);
    const h = w / ASPECT;
    placements.push({ id: lead.id, rect: { x: frame.w - 16 - w, y: frame.h - 16 - h, w, h }, role: "pip", z: 1 });
  }
  return { placements };
}

/** Side by side: the share on the left two thirds, the active speaker on the right third. */
function placeSideBySide(input: LayoutInput): LayoutResult {
  const { frame, share, cameras } = input;
  if (!share) return placeSpeaker(input);
  const lead = cameras[0];
  if (!lead) return { placements: [{ id: SHARE_ID, rect: full(frame), role: "main", z: 0 }] };
  const split = Math.round((frame.w * 2) / 3);
  return {
    placements: [
      { id: SHARE_ID, rect: inset({ x: 0, y: 0, w: split, h: frame.h }, 4), role: "main", z: 0 },
      { id: lead.id, rect: fit16x9(inset({ x: split, y: 0, w: frame.w - split, h: frame.h }, PAD)), role: "main", z: 0 },
    ],
  };
}

/** Speaker view (Zoom style): the share in a fixed 16:9 region on the left, the active speaker
 *  in a fixed tile top right, and the beacon in the corner. The geometry is constant
 *  (lib/speaker-view.ts) because the edge player cuts phones' picture along it. The page puts
 *  the sticky active speaker first (pickSpeaker), so cameras[0] is the one to show. */
function placeSpeakerView(input: LayoutInput): LayoutResult {
  const { frame, share, cameras } = input;
  if (!share) return placeSpeaker(input);
  const lead = cameras[0];
  // Nobody to show beside it: the share alone, and no beacon (there is nothing to split).
  if (!lead) return { placements: [{ id: SHARE_ID, rect: full(frame), role: "main", z: 0 }] };
  return {
    placements: [
      { id: SHARE_ID, rect: toPixels(SV_SHARE, frame), role: "main", z: 0 },
      { id: lead.id, rect: toPixels(SV_SPEAKER, frame), role: "main", z: 0, bare: true },
    ],
    beacon: beaconCells().map((c) => toPixels(c, frame)),
  };
}

/** Whether the page should draw speaker view for this layout and stage, so it puts the sticky
 *  speaker first: speaker_view itself, or auto on the edge mix, while somebody shares. */
export function usesSpeakerView(id: string | null | undefined, share: boolean, edge: boolean): boolean {
  if (!share) return false;
  const def = layoutById(id).id;
  return def === "speaker_view" || (def === "auto" && edge);
}

/** Video only: cameras, never the share. One person is speaker view; more is a grid, and past
 *  one page of grid it is speaker view with a filmstrip. */
function placeVideoOnly(input: LayoutInput): LayoutResult {
  const cams = { ...input, share: false };
  if (input.cameras.length >= 2 && input.cameras.length <= GRID_MAX) return placeGrid(cams);
  return placeSpeaker(cams);
}

export const LAYOUTS: readonly CompositeLayoutDef[] = [
  {
    id: "auto",
    label: "Automatic",
    description:
      "Speaker view for live viewers while someone shares (the share beside the cameras in other recordings); the speaker when nobody shares.",
    sample: { share: true, cameras: 3 },
    place: placeAuto,
  },
  {
    id: "speaker",
    label: "Speaker",
    description: "The active speaker large, everyone else in a filmstrip.",
    sample: { share: false, cameras: 4 },
    place: placeSpeaker,
  },
  {
    id: "grid",
    label: "Grid",
    description: "Everyone in equal tiles.",
    sample: { share: false, cameras: 4 },
    place: placeGrid,
  },
  {
    id: "share_only",
    label: "Share only",
    description: "Just the screen share. The speaker when nobody is sharing.",
    sample: { share: true, cameras: 2 },
    place: placeShareOnly,
  },
  {
    id: "speaker_view",
    label: "Speaker view (Zoom style)",
    description:
      "The screen share with the active speaker beside it; on phones the speaker floats over the share. Live viewers get it while someone shares unless you pick another layout.",
    sample: { share: true, cameras: 2 },
    place: placeSpeakerView,
  },
  {
    id: "share_speaker",
    label: "Share + speaker",
    description: "The screen share with the active speaker in a corner.",
    sample: { share: true, cameras: 2 },
    place: placeShareSpeaker,
  },
  {
    id: "side_by_side",
    label: "Side by side",
    description: "The screen share on the left, the active speaker on the right.",
    sample: { share: true, cameras: 2 },
    place: placeSideBySide,
  },
  {
    id: "video_only",
    label: "Cameras only",
    description: "Only the cameras; a screen share is not shown.",
    sample: { share: true, cameras: 3 },
    place: placeVideoOnly,
  },
];

export const DEFAULT_LAYOUT: AudienceLayoutId = "auto";

/** The registry entry for an id, auto for anything unknown (a newer server, a bad value). */
export function layoutById(id: string | null | undefined): CompositeLayoutDef {
  return LAYOUTS.find((l) => l.id === id) ?? LAYOUTS[0];
}

/** Lay out the stage with the named layout. */
export function placeStage(id: string | null | undefined, input: LayoutInput): LayoutResult {
  return layoutById(id).place(input);
}

/** The thumbnail's boxes: the layout's own place() on its sample stage at 720p (the pixel
 *  floors are real-frame sizes), scaled down to `frame`. */
export function thumbnailFor(def: CompositeLayoutDef, frame: Frame = { w: 160, h: 90 }): LayoutResult {
  const cameras = Array.from({ length: def.sample.cameras }, (_, i) => ({ id: `cam${i}`, cameraOn: true }));
  const real = def.place({ frame: { w: 1280, h: 720 }, share: def.sample.share, cameras, edge: false });
  const sx = frame.w / 1280;
  const sy = frame.h / 720;
  const scale = (r: Rect): Rect => ({ x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy });
  return {
    placements: real.placements.map((p) => ({ ...p, rect: scale(p.rect) })),
    note: real.note && scale(real.note),
  };
}

/** The layout named in room metadata (types.RoomMeta), or auto. */
export function audienceLayoutFromMetadata(raw: string | null | undefined): AudienceLayoutId {
  if (!raw) return DEFAULT_LAYOUT;
  try {
    const parsed = JSON.parse(raw) as { controls?: { audienceLayout?: unknown } } | null;
    const v = parsed?.controls?.audienceLayout;
    return typeof v === "string" ? layoutById(v).id : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** Whether a participant is a tile on the composite: on the stage, and not the egress itself
 *  or an agent (the caption agent). "On the stage" is somebody with a camera or a share
 *  published, or permission to publish them (a host whose camera is off is an initials tile,
 *  as it always was). An attendee watching through WebRTC is not. */
export function isStageTile(p: {
  isLocal: boolean;
  isAgentOrEgress: boolean;
  hasVideoPublication: boolean;
  canPublishVideo: boolean;
}): boolean {
  if (p.isLocal || p.isAgentOrEgress) return false;
  return p.hasVideoPublication || p.canPublishVideo;
}

/* Connections the SFU says have left, from the API's participant-left packet (the
 * participant_left webhook, repeated to the room), by identity.
 *
 * The mix kept a co-host who had left on the audience stream, an avatar tile with the mic
 * off, for twenty minutes, while the SFU listed him gone and a fresh mix did not show him
 * (instant-webinar-2050, 2026-10-24): its own copy of the room had missed the departure.
 * The packet carries the sid that left, so a rejoin, which is a new sid, is never dropped
 * with it; a join forgets the identity's entry for the same reason. */
export type LeftConnections = ReadonlyMap<string, ReadonlySet<string>>;

/** The participant-left packet, decoded; null for anything else on the topic. */
export function decodeParticipantLeft(raw: unknown): { identity: string; sid: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const msg = raw as Record<string, unknown>;
  if (msg.kind !== "participant-left") return null;
  const identity = typeof msg.identity === "string" ? msg.identity.slice(0, 200) : "";
  const sid = typeof msg.sid === "string" ? msg.sid.slice(0, 100) : "";
  return identity && sid ? { identity, sid } : null;
}

export function noteLeft(left: LeftConnections, identity: string, sid: string): LeftConnections {
  const next = new Map(left);
  next.set(identity, new Set([...(left.get(identity) ?? []), sid]));
  return next;
}

/** Somebody joined: a new connection for that identity, so its old departures no longer
 *  describe them. A join for a sid already reported gone (a late event) changes nothing. */
export function noteJoined(left: LeftConnections, identity: string, sid: string): LeftConnections {
  const gone = left.get(identity);
  if (!gone || gone.has(sid)) return left;
  const next = new Map(left);
  next.delete(identity);
  return next;
}

/** Whether a tile is somebody the SFU said has left: that very connection, or, with nothing
 *  published, the identity a departure named (the copy kept a sid the packet never saw). */
export function hasLeft(
  p: { identity: string; sid: string; hasPublications: boolean },
  left: LeftConnections,
): boolean {
  const gone = left.get(p.identity);
  if (!gone) return false;
  return gone.has(p.sid) || !p.hasPublications;
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
