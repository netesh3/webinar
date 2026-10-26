/* Reading the mix's time strip off a viewer's picture (web/lib/clock-strip.ts draws it).
 *
 * The strip is on a load test's mix (and with EDGE_DEBUG_CLOCK): 42 cells along the bottom
 * left, each 1/80 of the frame wide and 1/45 high, white = 1:
 *   [white][black] references, 32 bits of floor(serverMs / 10) mod 2^32, an 8-bit checksum.
 * A browser viewer draws its <video> into a canvas, reads each cell's middle (READ_STRIP, in
 * the page), and decodes here: glass-to-glass delay = its own clock - the time in the picture.
 * That counts everything after the mix draws the frame (encode, MediaMTX, CDN, the player's
 * buffer, decode); the presenter -> SFU -> mix part before it is ~0.1-0.3 s more. */

export const CELLS = 42;
const VALUE_BITS = 32;
const CHECK_BITS = 8;

/* decodeClock(lumas, nowMs) -> the server ms in the picture, or null when it isn't a clean
 * read (no strip, too little contrast, a checksum that fails: a frame mid-transition). */
export function decodeClock(lumas, nowMs) {
  if (!Array.isArray(lumas) || lumas.length < CELLS) return null;
  const white = lumas[0];
  const black = lumas[1];
  if (!(white - black >= 80)) return null;
  const mid = (white + black) / 2;
  const bits = lumas.slice(2, CELLS).map((l) => l > mid);
  let v = 0;
  for (let i = 0; i < VALUE_BITS; i++) v = v * 2 + (bits[i] ? 1 : 0);
  let check = 0;
  for (let i = 0; i < CHECK_BITS; i++) check = check * 2 + (bits[VALUE_BITS + i] ? 1 : 0);
  const sum = ((v >>> 24) + ((v >>> 16) & 0xff) + ((v >>> 8) & 0xff) + (v & 0xff)) & 0xff;
  if (sum !== check) return null;
  // The 32-bit wrap (every ~497 days) nearest our own clock.
  const period = 2 ** 32 * 10;
  const base = v * 10;
  const k = Math.round((nowMs - base) / period);
  return base + k * period;
}

/** Cells (true = white) -> lumas as a perfect read would give them (tests). */
export function lumasOf(cells, { white = 235, black = 16 } = {}) {
  return cells.map((c) => (c ? white : black));
}

/* The page side: draw the biggest playing <video> into a canvas and read each cell's middle
 * (a 3x3 average of luma). Returns { lumas, at } or null (no video yet, or a tainted canvas:
 * Safari's native player; Chrome plays through hls.js and MSE, which can be read). */
export const READ_STRIP = `(() => {
  const vids = [...document.querySelectorAll('video')].filter(v => v.videoWidth > 0);
  const v = vids.sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0];
  if (!v) return null;
  const W = v.videoWidth, H = v.videoHeight;
  const cw = W / 80, ch = H / 45;
  const rowY = Math.max(0, Math.floor(H - ch));
  const c = (window.__LOAD_STRIP_CANVAS__ ||= document.createElement('canvas'));
  const width = Math.ceil(cw * ${CELLS}), height = Math.ceil(ch);
  if (c.width !== width || c.height !== height) { c.width = width; c.height = height; }
  const g = c.getContext('2d', { willReadFrequently: true });
  const at = Date.now();
  try { g.drawImage(v, 0, rowY, width, height, 0, 0, width, height); } catch { return null; }
  let data; try { data = g.getImageData(0, 0, width, height).data; } catch { return null; }
  const lumas = [];
  for (let i = 0; i < ${CELLS}; i++) {
    const cx = Math.floor((i + 0.5) * cw), cy = Math.floor(height / 2);
    let sum = 0, n = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const x = Math.min(width - 1, Math.max(0, cx + dx)), y = Math.min(height - 1, Math.max(0, cy + dy));
      const o = (y * width + x) * 4;
      sum += 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]; n++;
    }
    lumas.push(Math.round(sum / n));
  }
  return { lumas, at };
})()`;
