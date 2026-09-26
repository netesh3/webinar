/* When each emoji of a reaction burst appears.
 *
 * Run with `make test-web`.
 *
 * One click used to put its whole burst on screen within a fraction of a second,
 * which read as several clicks. These pin the replacement: one at a time, first
 * immediately, then 500–1000 ms apart, with the backlog bounded.
 */

import {
  planReactionBurst,
  reactionBurstCount,
  reactionGap,
  REACTION_COPIES_MAX,
  REACTION_COPIES_MIN,
  REACTION_GAP_MAX_MS,
  REACTION_GAP_MIN_MS,
  REACTION_MAX_PENDING,
} from "./reaction-queue.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
}

/** Replays a fixed sequence, so a test can put the gap exactly where it wants. */
function seq(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

function gaps(delays: number[]): number[] {
  return delays.slice(1).map((d, i) => d - delays[i]);
}

console.log("\nplanReactionBurst");

{
  const d = planReactionBurst({ count: 7, pending: 0, random: Math.random });
  ok(d.length === 7, "the count is honoured: 7 copies, 7 delays");
  ok(d[0] === 0, "the first appears immediately");
  ok(
    gaps(d).every((g) => g >= REACTION_GAP_MIN_MS && g <= REACTION_GAP_MAX_MS),
    "every gap is within [500, 1000] ms",
  );
  ok(
    d.every((v, i) => i === 0 || v > d[i - 1]),
    "cumulative — each waits for the one before, not all from t=0",
  );
}

{
  const d = planReactionBurst({ count: 3, pending: 0, random: seq(0) });
  ok(d.join() === "0,500,1000", "random() = 0 gives the 500 ms floor");
  const e = planReactionBurst({ count: 3, pending: 0, random: seq(1) });
  ok(e.join() === "0,1000,2000", "random() = 1 gives the 1000 ms ceiling");
  const f = planReactionBurst({ count: 4, pending: 0, random: seq(0, 1, 0.5) });
  ok(f.join() === "0,500,1500,2250", "gaps vary per step with the injected random");
}

{
  for (let trial = 0; trial < 200; trial++) {
    const d = planReactionBurst({ count: 10, pending: 0 });
    if (d.length !== 10 || d[0] !== 0) {
      ok(false, `trial ${trial}: shape`);
      break;
    }
    const bad = gaps(d).find((g) => g < REACTION_GAP_MIN_MS || g > REACTION_GAP_MAX_MS);
    if (bad !== undefined) {
      ok(false, `trial ${trial}: gap ${bad} out of range`);
      break;
    }
  }
  ok(true, "200 random bursts all stay in range");
}

{
  ok(planReactionBurst({ count: 0, pending: 0 }).length === 0, "count 0 schedules nothing");
  ok(planReactionBurst({ count: 1, pending: 0 }).join() === "0", "count 1 is a single immediate emoji");
}

console.log("\nqueue cap");

{
  const full = planReactionBurst({ count: 8, pending: REACTION_MAX_PENDING });
  ok(full.join() === "0", "with the backlog full, only the immediate first emoji shows");
  const over = planReactionBurst({ count: 8, pending: REACTION_MAX_PENDING + 50 });
  ok(over.join() === "0", "over the cap is the same as at it — never negative room");
  const some = planReactionBurst({ count: 8, pending: REACTION_MAX_PENDING - 3 });
  ok(some.length === 4, "3 slots left: the first plus 3 queued, the tail dropped");
  const small = planReactionBurst({ count: 8, pending: 0, maxPending: 2, random: seq(0) });
  ok(small.join() === "0,500,1000", "maxPending is injectable and caps the queued tail");
}

{
  // A flood: 500 bursts arriving together never builds more backlog than the cap.
  let pending = 0;
  let longest = 0;
  for (let i = 0; i < 500; i++) {
    const d = planReactionBurst({ count: 10, pending });
    pending += d.length - 1;
    longest = Math.max(longest, d[d.length - 1]);
  }
  ok(pending === REACTION_MAX_PENDING, `a 500-tap flood waits at most ${REACTION_MAX_PENDING}`);
  ok(
    longest <= (REACTION_COPIES_MAX - 1) * REACTION_GAP_MAX_MS,
    "nothing is scheduled later than one burst's own length",
  );
}

console.log("\nreactionBurstCount / reactionGap");

{
  ok(reactionBurstCount(() => 0) === REACTION_COPIES_MIN, "random 0 → min copies");
  ok(reactionBurstCount(() => 0.999999) === REACTION_COPIES_MAX, "random ~1 → max copies");
  ok(reactionBurstCount(() => 1) === REACTION_COPIES_MAX, "random 1 is clamped to max");
  ok(reactionGap(() => 0.5) === 750, "gap is 500 + random * 500");
}

console.log(
  failures === 0 ? `\n${checks} passed\n` : `\n${failures}/${checks} FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
