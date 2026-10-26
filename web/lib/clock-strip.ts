/* The latency clock's time strip: the server time, as black and white cells along the bottom
 * left of the mix, so a program can read off a viewer's picture how old it is.
 *
 * The clock text (EdgeClock) is for a person comparing two screens. The load-test kit's
 * browser viewers need it to the frame, from every window, without OCR: they draw the video
 * into a canvas, read these cells (e2e/load/lib/clock-strip.mjs), and subtract. Drawn only
 * where the clock is (EDGE_DEBUG_CLOCK, or a webinar marked as a load test; the mix's
 * <template>/clock page), never in a recording.
 *
 * Layout, left to right, each cell 1/80 of the frame wide and 1/45 high (16 px at 720p, the
 * size the speaker-view beacon proved survives the mix's encoding), on the bottom row:
 *   [white][black]  references, so the reader's threshold follows the encoder's levels
 *   32 cells        floor(serverMs / 10) mod 2^32, most significant bit first (white = 1)
 *   8 cells         checksum: the four bytes of that value added, mod 256
 * 10 ms steps and 32 bits wrap after ~497 days; the reader takes the wrap nearest its own
 * clock. The speaker-view beacon is bottom right, so the two never meet. */

export const CLOCK_CELL_W = 1 / 80;
export const CLOCK_CELL_H = 1 / 45;
export const CLOCK_VALUE_BITS = 32;
export const CLOCK_CHECK_BITS = 8;
export const CLOCK_CELLS = 2 + CLOCK_VALUE_BITS + CLOCK_CHECK_BITS;

/** The cells for a server time (true = white), references first. */
export function encodeClock(serverMs: number): boolean[] {
  const v = Math.floor(serverMs / 10) % 2 ** 32;
  const bits: boolean[] = [true, false];
  for (let i = CLOCK_VALUE_BITS - 1; i >= 0; i--) bits.push(Math.floor(v / 2 ** i) % 2 === 1);
  const sum = ((v >>> 24) + ((v >>> 16) & 0xff) + ((v >>> 8) & 0xff) + (v & 0xff)) & 0xff;
  for (let i = CLOCK_CHECK_BITS - 1; i >= 0; i--) bits.push(((sum >> i) & 1) === 1);
  return bits;
}
