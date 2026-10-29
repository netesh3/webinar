/* Source artwork for @capacitor/assets, drawn as SVG and rasterised with sharp.
 *
 * Run from apps/mobile/: npm run assets   (this script, then `capacitor-assets generate`)
 *
 * There is no high-resolution logo file in the repo: web/public/brand/mark.png is 128 px.
 * The shapes below are the same ones web/scripts/pwa-icons.mjs uses for the PWA icons (the
 * blue-to-violet tile, a white camera with a play triangle and a signal), redrawn at 1024
 * so nothing is upscaled. Replace assets/*.png with designer artwork when there is some and
 * run `npx capacitor-assets generate` again.
 *
 * Writes assets/:
 *   icon-only.png        1024  full tile (iOS icon, Android legacy icon)
 *   icon-foreground.png  1024  glyph in the adaptive-icon safe zone, transparent
 *   icon-background.png  1024  gradient only
 *   splash.png           2732  glyph centred on the brand blue
 *   splash-dark.png      2732  glyph centred on the dark surface
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "assets");

const gradient = `
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1e8bff"/>
      <stop offset="0.55" stop-color="#0b5cff"/>
      <stop offset="1" stop-color="#7a3cf0"/>
    </linearGradient>
  </defs>`;

// The glyph on a 512 box (web/scripts/pwa-icons.mjs).
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

const scaled = (s, inner) =>
  `<g transform="translate(256 256) scale(${s}) translate(-256 -256)">${inner}</g>`;

// iOS draws its own rounded corners, so the icon is full bleed.
const iconOnly = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${gradient}
  <rect width="512" height="512" fill="url(#g)"/>${scaled(0.86, glyph("#ffffff", "#0b5cff"))}</svg>`;

// Android adaptive icons crop to the inner 66%: keep the glyph inside it.
const foreground = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  ${scaled(0.6, glyph("#ffffff", "#0b5cff"))}</svg>`;

const background = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${gradient}
  <rect width="512" height="512" fill="url(#g)"/></svg>`;

const splash = (bg, play) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${bg}"/>${scaled(0.22, glyph("#ffffff", play))}</svg>`;

await mkdir(out, { recursive: true });
const jobs = [
  [iconOnly, 1024, "icon-only.png"],
  [foreground, 1024, "icon-foreground.png"],
  [background, 1024, "icon-background.png"],
  [splash("#0b5cff", "#0b5cff"), 2732, "splash.png"],
  [splash("#0d0d11", "#0d0d11"), 2732, "splash-dark.png"],
];
for (const [svg, size, name] of jobs) {
  await sharp(Buffer.from(svg), { density: 600 })
    .resize(size, size)
    .flatten(name === "icon-foreground.png" ? false : { background: "#0b5cff" })
    .png({ compressionLevel: 9 })
    .toFile(path.join(out, name));
  console.log(`wrote assets/${name}`);
}
