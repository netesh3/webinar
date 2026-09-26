/* Initials and a stable colour for someone who has no photo.
 *
 * Both are ports of the server's own — InitialsOf and HueFor in
 * api/internal/store/users.go — so a person's initials and colour here are the
 * same ones the rest of the product would draw for the same seed. Chat seeds the
 * colour with the sender's IDENTITY rather than an email: identity is on every
 * message (hidden attendees included) and email never is.
 *
 * Pure, and free of React, so the unit test can import it directly.
 */

/** First letter of the first and last words. One word gives one letter; nothing
 *  gives "?". Splits on spaces, hyphens and dots, as the server does, so
 *  "Ana-Lucía Moreno" is AM and "jean-luc picard" is JP. */
export function initialsOf(name: string): string {
  const words = name.split(/[\s\-.]+/u).filter(Boolean);
  if (words.length === 0) return "?";
  const first = firstLetter(words[0]);
  if (words.length === 1) return first;
  return first + firstLetter(words[words.length - 1]);
}

function firstLetter(word: string): string {
  // By code point, not UTF-16 unit, so a name starting with an astral character
  // is not cut in half.
  return (Array.from(word)[0] ?? "").toLocaleUpperCase();
}

/** FNV-1a, 32-bit, over the UTF-8 bytes — what Go's hash/fnv New32a computes. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** A stable avatar colour for a seed, as a hex string.
 *
 *  Saturation and lightness are the server's fixed 62% / 38%, which keep white
 *  initials above 4.5:1 against every hue. */
export function hueFor(seed: string): string {
  return hslToHex(fnv1a32(seed.toLowerCase()) % 360, 0.62, 0.38);
}

function hslToHex(hDeg: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = hDeg / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
      : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
