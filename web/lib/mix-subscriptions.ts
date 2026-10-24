/* What the recorder template (the edge mix and the cloud recordings) subscribes to for each
 * camera: which simulcast layer, and whether it is forwarded at all.
 *
 * The egress decodes every video track the SFU forwards to it, in software, in the same
 * headless Chrome that composites and encodes the mix. Cameras publish 180p / 360p / 1080p
 * (lib/network.ts CAMERA_LAYERS, CAMERA_TOP; 720p on top for machines that cannot capture
 * 1080p), so a camera on the top layer is a 1080p VP8 decode, which a 640x360 grid tile then
 * throws three quarters of away. Two to four cameras in a 720p grid used to be two to four
 * 1080p decodes; on this mapping they are 360p ones.
 *
 *   tile height (output px)   layer
 *   bare (speaker view tile)  medium (360p): what a phone crops its PiP out of
 *   < 300                     low (180p)
 *   300 .. 540                medium (360p): at most a 1.5x upscale
 *   > 540                     high (the publisher's top, 720p or 1080p)
 *
 * A camera the layout does not draw (speaker view's other cameras, the grid past its page) is
 * not forwarded at all (enabled false): with no element attached it was still decoded.
 *
 * Screen shares are not on this mapping: the page always takes their top layer (ShareVideo),
 * because slide text is the one thing in the mix that has to stay sharp.
 *
 * Pure, so the mapping can be tested without a room: `make test-web`. */

import { SHARE_ID, type Placement } from "./composite-layouts.ts";

export type CameraLayer = "low" | "medium" | "high";

/** Below this output height a tile takes the low (180p) layer. */
export const LOW_TILE_MAX_PX = 300;
/** At or below this output height a tile takes the medium (360p) layer; above it, the top. */
export const MEDIUM_TILE_MAX_PX = 540;

/** How long a camera the layout stopped drawing stays forwarded, so a quick swap back (a
 *  speaker-view handover reversing, a layout flip) does not wait on a fresh keyframe. */
export const HIDDEN_CAMERA_GRACE_MS = 3000;

/* The output pixels a tile covers are its CSS height times the page's pixel ratio. The
 * egress sizes its Chrome window to the encoding (1280x720 CSS px at ratio 1), and the page
 * passes 1 rather than whatever devicePixelRatio says, so a headless Chrome reporting a
 * high-density screen cannot push every tile up a layer. */
export function cameraLayerForTile(tile: { heightPx: number; pixelRatio?: number; bare?: boolean }): CameraLayer {
  if (tile.bare) return "medium";
  const ratio = tile.pixelRatio && tile.pixelRatio > 0 ? tile.pixelRatio : 1;
  const h = tile.heightPx * ratio;
  if (!(h >= LOW_TILE_MAX_PX)) return "low"; // also NaN / negative: the cheapest layer
  if (h <= MEDIUM_TILE_MAX_PX) return "medium";
  return "high";
}

export type CameraSubscription = { enabled: true; layer: CameraLayer } | { enabled: false };

/** For every camera on stage: its layer if the layout draws it, else not forwarded. */
export function cameraSubscriptions(
  cameraIds: readonly string[],
  placements: readonly Pick<Placement, "id" | "rect" | "bare">[],
  pixelRatio = 1,
): Map<string, CameraSubscription> {
  const drawn = new Map<string, Pick<Placement, "rect" | "bare">>();
  for (const p of placements) if (p.id !== SHARE_ID) drawn.set(p.id, p);
  const out = new Map<string, CameraSubscription>();
  for (const id of cameraIds) {
    const p = drawn.get(id);
    out.set(
      id,
      p ? { enabled: true, layer: cameraLayerForTile({ heightPx: p.rect.h, pixelRatio, bare: p.bare }) } : { enabled: false },
    );
  }
  return out;
}
