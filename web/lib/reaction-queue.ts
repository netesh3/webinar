/* When each emoji of one reaction burst appears.
 *
 * One tap draws a burst of several copies of the same emoji (see realtime.ts).
 * They used to start a few tens of milliseconds apart, which reads as one pile
 * landing at once. Now they come out one at a time: the first on the same frame
 * as the tap, each next one a random 500–1000 ms after the previous, so the burst
 * trickles up the lane like a few separate clicks.
 *
 * Each burst is its own chain. Two people tapping together run two chains side by
 * side rather than one queue behind the other; a single shared queue at ~750 ms per
 * emoji would turn a room applauding into a minute-long backlog of clapping long
 * after the moment has passed.
 *
 * The backlog is bounded instead by `maxPending`, the number of emoji waiting to
 * appear across ALL chains. A burst arriving when that budget is spent is trimmed
 * (its tail is dropped, never deferred), but its first emoji always shows at once
 * — every tap, including your own, gets visible feedback even in a flood, and the
 * longest anything can still be arriving after a tap is one chain's length.
 * Pure, so the timing can be pinned without a browser: see reaction-queue.test.mts.
 */

export const REACTION_GAP_MIN_MS = 500;
export const REACTION_GAP_MAX_MS = 1000;
/** Copies drawn per tap, inclusive. */
export const REACTION_COPIES_MIN = 5;
export const REACTION_COPIES_MAX = 10;
/** Emoji waiting to appear across every burst in flight. */
export const REACTION_MAX_PENDING = 60;

type Random = () => number;

/** How many copies one tap draws. */
export function reactionBurstCount(random: Random = Math.random): number {
  const span = REACTION_COPIES_MAX - REACTION_COPIES_MIN + 1;
  return REACTION_COPIES_MIN + Math.min(span - 1, Math.floor(random() * span));
}

/** One gap between consecutive emoji of a burst, in [500, 1000] ms. */
export function reactionGap(random: Random = Math.random): number {
  return REACTION_GAP_MIN_MS + random() * (REACTION_GAP_MAX_MS - REACTION_GAP_MIN_MS);
}

/**
 * Delays from now, in ms, for each emoji of one burst: `[0, g1, g1+g2, …]`.
 *
 * Cumulative, so each emoji waits for the one before it rather than every copy
 * being scheduled against t=0. The first (delay 0) is shown immediately and does
 * not count against `maxPending`; the rest do, and are trimmed to what is left of
 * that budget given `pending` emoji already waiting.
 */
export function planReactionBurst(opts: {
  count: number;
  pending: number;
  maxPending?: number;
  random?: Random;
}): number[] {
  const { count, pending, maxPending = REACTION_MAX_PENDING, random = Math.random } = opts;
  if (count < 1) return [];
  const room = Math.max(0, maxPending - Math.max(0, pending));
  const queued = Math.min(count - 1, room);
  const delays = [0];
  let at = 0;
  for (let i = 0; i < queued; i++) {
    at += reactionGap(random);
    delays.push(at);
  }
  return delays;
}
