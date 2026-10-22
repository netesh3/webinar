/* Speaker view (Zoom style) for edge viewers: the screen share large, the active speaker's
 * camera on its own.
 *
 * An edge viewer gets ONE picture, the LL-HLS mix the egress draws from app/recorder-template.
 * A second stream for the speaker would double the egress (and the CDN bill), so the mix itself
 * carries both, at a FIXED geometry everyone knows:
 *
 *   +--------------------------------------+---------+
 *   |                                      | speaker |   share:   x 0     .. 0.75, y 0.125 .. 0.875
 *   |              share (16:9)            +---------+   speaker: x 0.755 .. 0.995, y 0.125 .. 0.365
 *   |                                      |         |   (both 16:9 on a 16:9 frame)
 *   +--------------------------------------+     ▪ ▪ |   beacon:  four cells, bottom-right corner
 *
 * On a laptop the mix is shown as it is: the speaker sits in a sidebar beside the slides. On a
 * phone the edge player cuts the one decoded video in two: the share region fills the stage
 * (a CSS transform on the <video>, free on the compositor) and the speaker region is copied
 * into a small canvas, drawn as a floating, draggable PiP. One decode, one download.
 *
 * The beacon is how the phone knows the frame in front of it IS this layout. The host's choice
 * arrives by room metadata seconds before the video it changes (the HLS delay), and nobody
 * tells an edge viewer when a share starts; the beacon is in the picture, so it is never out of
 * step with it. It is four 16-pixel cells (macroblock-sized at 720p, so the encoder keeps them),
 * in the black corner below the speaker, that no other layout paints.
 *
 * Pure so node can test it: lib/speaker-view.test.mts, run by `make test-web`. */

export type NRect = { x: number; y: number; w: number; h: number };
export type Size = { w: number; h: number };

/** The share's region of the mix, as fractions of the frame. */
export const SV_SHARE: NRect = { x: 0, y: 0.125, w: 0.75, h: 0.75 };
/** The speaker tile's region of the mix, as fractions of the frame. */
export const SV_SPEAKER: NRect = { x: 0.755, y: 0.125, w: 0.24, h: 0.24 };

/** The beacon: cells of 1/80 × 1/45 of the frame (16 px at 720p), right-aligned on the bottom
 *  edge, painted lit / dark in this pattern. */
export const BEACON_PATTERN: readonly boolean[] = [true, false, true, false];
const CELL_W = 1 / 80;
const CELL_H = 1 / 45;
/** Lit cells are this grey: bright enough to survive the encoder, dull enough to ignore. */
export const BEACON_COLOR = "#a0a0a0";
const LIT_MIN = 96;
const DARK_MAX = 48;

export function beaconCells(): NRect[] {
  const n = BEACON_PATTERN.length;
  return BEACON_PATTERN.map((_, i) => ({ x: 1 - (n - i) * CELL_W, y: 1 - CELL_H, w: CELL_W, h: CELL_H }));
}

/** The strip holding every cell: what the player draws into its tiny probe canvas. */
export function beaconStrip(): NRect {
  const n = BEACON_PATTERN.length;
  return { x: 1 - n * CELL_W, y: 1 - CELL_H, w: n * CELL_W, h: CELL_H };
}

/** A fraction-of-frame rect in pixels of `frame`. */
export function toPixels(r: NRect, frame: Size): NRect {
  return { x: r.x * frame.w, y: r.y * frame.h, w: r.w * frame.w, h: r.h * frame.h };
}

/** The probe canvas the strip is scaled into: PROBE_CELL px per cell, one cell tall. */
export const PROBE_CELL = 4;
export const PROBE_W = PROBE_CELL * BEACON_PATTERN.length;
export const PROBE_H = PROBE_CELL;

/**
 * Whether RGBA pixels of the probe canvas (PROBE_W × PROBE_H) read as the beacon. Each cell is
 * judged by the mean luma of its centre (the edges bleed into their neighbours after the
 * encoder and the downscale): lit cells must be bright, dark cells dark.
 */
export function readBeacon(data: ArrayLike<number>, width = PROBE_W, height = PROBE_H): boolean {
  const cell = width / BEACON_PATTERN.length;
  if (cell < 2 || height < 2) return false;
  const y0 = Math.floor(height / 4);
  const y1 = Math.max(y0 + 1, Math.ceil((height * 3) / 4));
  return BEACON_PATTERN.every((lit, i) => {
    const x0 = Math.floor(i * cell + cell / 4);
    const x1 = Math.max(x0 + 1, Math.ceil(i * cell + (cell * 3) / 4));
    let sum = 0;
    let count = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * width + x) * 4;
        sum += 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
        count++;
      }
    }
    const luma = count ? sum / count : 0;
    return lit ? luma >= LIT_MIN : luma <= DARK_MAX;
  });
}

/** Hysteresis over beacon reads: the split turns on or off only after BEACON_AGREE reads in a
 *  row agree, so a single smeared frame (a scene cut, a keyframe) cannot make it flicker. */
export type BeaconState = { on: boolean; streak: number };
export const BEACON_OFF: BeaconState = { on: false, streak: 0 };
export const BEACON_AGREE = 2;

export function nextBeacon(state: BeaconState, reading: boolean): BeaconState {
  if (reading === state.on) return state.streak === 0 ? state : { on: state.on, streak: 0 };
  const streak = state.streak + 1;
  return streak >= BEACON_AGREE ? { on: reading, streak: 0 } : { on: state.on, streak };
}

// ------------------------------------------------------------------ the active speaker

/** Somebody on stage the speaker tile could show. */
export type SpeakerCandidate = {
  id: string;
  cameraOn: boolean;
  /** Has the screen share up. */
  sharing: boolean;
  /** Host (or co-host). */
  host: boolean;
};

export type SpeakerPick = {
  /** Who the tile shows, or null with nobody on stage. */
  readonly current: string | null;
  /** When `current` took the tile. */
  readonly since: number;
  /** The latest loudest speaker (camera on) and since when it has been the loudest. */
  readonly candidate: string | null;
  readonly candidateSince: number;
};

export const NO_PICK: SpeakerPick = { current: null, since: 0, candidate: null, candidateSince: 0 };

/** A speaker keeps the tile at least this long, so a quick back-and-forth does not flip it. */
export const SPEAKER_STICKY_MS = 2_000;
/** And a newcomer must be the loudest this long first: a cough is not a handover. */
export const SPEAKER_HOLD_MS = 500;

/**
 * Who the speaker tile shows, folded from one reading.
 *
 * `speaking` is the SFU's active-speaker list, loudest first. The tile follows whoever is
 * talking among the stage members with a camera on, and holds them: a newcomer takes over only
 * after being loudest for SPEAKER_HOLD_MS, and never sooner than SPEAKER_STICKY_MS after the
 * last change. Silence keeps the last speaker (a pause is not a reason to switch). With nobody
 * valid to keep, it falls back to the sharer, then the host, then anyone with a camera on, and
 * last to the sharer or host with the camera off (an initials tile beats an empty box).
 */
export function pickSpeaker(
  prev: SpeakerPick,
  candidates: readonly SpeakerCandidate[],
  speaking: readonly string[],
  now: number,
): SpeakerPick {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const anyCamera = candidates.some((c) => c.cameraOn);
  const loud = speaking.find((id) => byId.get(id)?.cameraOn) ?? null;

  const candidate = loud;
  const candidateSince = loud === prev.candidate ? prev.candidateSince : now;

  const cur = prev.current ? byId.get(prev.current) : undefined;
  // The current pick still counts while it is on stage with a picture, or nobody has one.
  const keep = cur && (cur.cameraOn || !anyCamera);
  if (keep) {
    const handover =
      loud !== null &&
      loud !== cur.id &&
      now - candidateSince >= SPEAKER_HOLD_MS &&
      now - prev.since >= SPEAKER_STICKY_MS;
    if (handover) return { current: loud, since: now, candidate, candidateSince };
    return { current: cur.id, since: prev.since, candidate, candidateSince };
  }

  const fallback =
    loud ??
    candidates.find((c) => c.sharing && c.cameraOn)?.id ??
    candidates.find((c) => c.host && c.cameraOn)?.id ??
    candidates.find((c) => c.cameraOn)?.id ??
    candidates.find((c) => c.sharing)?.id ??
    candidates.find((c) => c.host)?.id ??
    candidates[0]?.id ??
    null;
  return { current: fallback, since: fallback === prev.current ? prev.since : now, candidate, candidateSince };
}

/** When to fold in another reading while a handover is pending (events only fire on change). */
export function pickRecheckDelay(pick: SpeakerPick, now: number): number | null {
  if (!pick.candidate || pick.candidate === pick.current) return null;
  const due = Math.max(pick.candidateSince + SPEAKER_HOLD_MS, pick.since + SPEAKER_STICKY_MS);
  return Math.max(50, due - now);
}

// ------------------------------------------------------------------ the phone split

/** Whether this viewport splits the mix: a phone (either way up) or anything portrait. A
 *  laptop or a landscape tablet shows the mix as drawn, the speaker in its sidebar. */
export function splitsMix(viewport: Size): boolean {
  if (viewport.w <= 0 || viewport.h <= 0) return false;
  return viewport.w < 768 || viewport.h < 500 || viewport.h > viewport.w;
}

/** The host's layout id, as the edge player reads it: the mix may be in speaker view. auto is
 *  speaker view on the edge mix while somebody shares (composite-layouts.ts). */
export function mayBeSpeakerView(layoutId: string | null | undefined): boolean {
  return layoutId === "speaker_view" || layoutId === "auto" || !layoutId;
}

/**
 * A CSS transform (origin 0 0: translate(tx, ty) scale(k)) that makes `region` of a video,
 * drawn object-contain in a box of `box`, fill the box (contained, centred). The box clips the
 * rest. `video` is the intrinsic size (videoWidth × videoHeight).
 */
export function cropTransform(box: Size, video: Size, region: NRect): { k: number; tx: number; ty: number } {
  if (box.w <= 0 || box.h <= 0 || video.w <= 0 || video.h <= 0 || region.w <= 0 || region.h <= 0) {
    return { k: 1, tx: 0, ty: 0 };
  }
  // Where object-contain put the picture inside the element.
  const s = Math.min(box.w / video.w, box.h / video.h);
  const ox = (box.w - video.w * s) / 2;
  const oy = (box.h - video.h * s) / 2;
  // The region, in element pixels.
  const rx = ox + region.x * video.w * s;
  const ry = oy + region.y * video.h * s;
  const rw = region.w * video.w * s;
  const rh = region.h * video.h * s;
  // Scale it to fit the box and centre it.
  const k = Math.min(box.w / rw, box.h / rh);
  const tx = (box.w - rw * k) / 2 - k * rx;
  const ty = (box.h - rh * k) / 2 - k * ry;
  return { k, tx, ty };
}

/** The source rect in video pixels for drawImage, rounded inward to whole pixels. */
export function sourceRect(video: Size, region: NRect): NRect {
  const x = Math.ceil(region.x * video.w);
  const y = Math.ceil(region.y * video.h);
  const x2 = Math.floor((region.x + region.w) * video.w);
  const y2 = Math.floor((region.y + region.h) * video.h);
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

// ------------------------------------------------------------------ the floating PiP

export type Corner = "tl" | "tr" | "bl" | "br";
export const CORNERS: readonly Corner[] = ["tl", "tr", "bl", "br"];
/** Clear of the player's own chrome: the LIVE badge and Back to live along the top, the mute
 *  and fullscreen pill along the bottom. Captions are drawn above the PiP (z-order), so they
 *  are never covered whichever corner it is in. */
export const PIP_INSETS = { top: 48, right: 8, bottom: 60, left: 8 };

/** The PiP's size in a stage of `box`: a third of the width, within sane bounds, 16:9. */
export function pipSize(box: Size): Size {
  const w = Math.round(Math.min(240, Math.max(96, box.w * 0.34)));
  let h = Math.round((w * 9) / 16);
  const room = box.h - PIP_INSETS.top - PIP_INSETS.bottom;
  if (room > 0 && h > room) {
    h = Math.max(36, room);
    return { w: Math.round((h * 16) / 9), h };
  }
  return { w, h };
}

/** Top-left of a PiP of `size` snapped to `corner` of `box`. */
export function cornerPosition(corner: Corner, size: Size, box: Size, insets = PIP_INSETS): { x: number; y: number } {
  const left = insets.left;
  const right = Math.max(left, box.w - insets.right - size.w);
  const top = insets.top;
  const bottom = Math.max(top, box.h - insets.bottom - size.h);
  return {
    x: corner === "tl" || corner === "bl" ? left : right,
    y: corner === "tl" || corner === "tr" ? top : bottom,
  };
}

/** The corner nearest to a PiP dropped with its top-left at `pos`: by its centre's half. */
export function nearestCorner(pos: { x: number; y: number }, size: Size, box: Size): Corner {
  const cx = pos.x + size.w / 2;
  const cy = pos.y + size.h / 2;
  const right = cx >= box.w / 2;
  const bottom = cy >= box.h / 2;
  return bottom ? (right ? "br" : "bl") : right ? "tr" : "tl";
}

/** A drag that moved less than this is a tap. */
export const TAP_SLOP_PX = 6;

export function isTap(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) < TAP_SLOP_PX;
}

/** What the viewer last did with the PiP, remembered across visits. */
export type PipPrefs = { corner: Corner; minimised: boolean };
export const DEFAULT_PIP: PipPrefs = { corner: "tr", minimised: false };
export const PIP_PREFS_KEY = "edge-speaker-pip";

export function parsePipPrefs(raw: string | null | undefined): PipPrefs {
  if (!raw) return DEFAULT_PIP;
  try {
    const v = JSON.parse(raw) as { corner?: unknown; minimised?: unknown } | null;
    const corner = CORNERS.includes(v?.corner as Corner) ? (v!.corner as Corner) : DEFAULT_PIP.corner;
    return { corner, minimised: v?.minimised === true };
  } catch {
    return DEFAULT_PIP;
  }
}
