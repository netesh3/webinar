/* The installed app's icons, drawn once as SVG and rasterised with sharp.
 *
 * Run from web/: node scripts/pwa-icons.mjs
 *
 * Writes public/icons/:
 *   icon-192.png, icon-512.png   the mark on its rounded tile ("any")
 *   maskable-512.png             the mark inside the 80% safe zone on a full-bleed tile, for
 *                                launchers that cut their own shape (Android adaptive icons)
 *   badge-96.png                 white glyph on transparent — Android's status-bar badge is a
 *                                mask, so colour would be thrown away
 *
 * The artwork follows public/brand/mark.png (blue-to-violet tile, white camera with a play
 * triangle and a signal). That file is 128 px, too small to scale up to 512, which is why the
 * shapes are redrawn here rather than resized.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "public", "icons");

const gradient = `
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1e8bff"/>
      <stop offset="0.55" stop-color="#0b5cff"/>
      <stop offset="1" stop-color="#7a3cf0"/>
    </linearGradient>
  </defs>`;

// The glyph, on a 512 box: camera body, lens wedge, play triangle, two signal arcs.
function glyph(fill, play) {
  return `
    <g>
      <rect x="92" y="178" width="232" height="176" rx="44" fill="${fill}"/>
      <path d="M318 236 L410 188 Q424 181 424 197 L424 335 Q424 351 410 344 L318 296 Z" fill="${fill}"/>
      <path d="M180 220 L262 266 L180 312 Z" fill="${play}" stroke="${play}" stroke-width="10" stroke-linejoin="round"/>
      <path d="M318 132 A70 70 0 0 1 388 202" fill="none" stroke="${fill}" stroke-width="22" stroke-linecap="round"/>
      <path d="M318 82 A120 120 0 0 1 438 202" fill="none" stroke="${fill}" stroke-width="22" stroke-linecap="round"/>
    </g>`;
}

const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${gradient}
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#g)"/>
  ${glyph("#ffffff", "#0b5cff")}
</svg>`;

// Full bleed; the glyph scaled into the central 80% circle a launcher may crop to.
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${gradient}
  <rect width="512" height="512" fill="url(#g)"/>
  <g transform="translate(256 256) scale(0.72) translate(-256 -256)">${glyph("#ffffff", "#0b5cff")}</g>
</svg>`;

// Monochrome: the play triangle is cut out so it still reads as a mask.
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><mask id="m"><rect width="512" height="512" fill="#fff"/>
    <path d="M180 220 L262 266 L180 312 Z" fill="#000" stroke="#000" stroke-width="10" stroke-linejoin="round"/></mask></defs>
  <g mask="url(#m)">${glyph("#ffffff", "#ffffff")}</g>
</svg>`;

await mkdir(out, { recursive: true });
const jobs = [
  [tile, 192, "icon-192.png"],
  [tile, 512, "icon-512.png"],
  [maskable, 512, "maskable-512.png"],
  [badge, 96, "badge-96.png"],
];
for (const [svg, size, name] of jobs) {
  await sharp(Buffer.from(svg), { density: 300 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(path.join(out, name));
  console.log(`wrote public/icons/${name}`);
}
