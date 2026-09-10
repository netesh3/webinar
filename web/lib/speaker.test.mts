/* The green border's behaviour over time.
 *
 * This is the only check the debounce gets. Watching a live call cannot tell a 450 ms hold from
 * a 200 ms one, cannot reproduce a cough at the moment of a handover, and cannot demonstrate
 * that a reading which changes nothing changes nothing — which is half the requirement.
 *
 * Every case is written as a sequence of readings on a clock we control, because the whole
 * point of the module is what happens BETWEEN readings.
 *
 * Run: node --experimental-strip-types --no-warnings lib/speaker.test.mts
 */
import {
  CLEAR_MS,
  isHighlighted,
  NO_HIGHLIGHT,
  nextHighlight,
  pendingDelay,
  SWITCH_MS,
  type Highlight,
} from "./speaker.ts";

let passed = 0;
let failed = 0;

function is(label: string, got: unknown, want: unknown) {
  if (got === want) passed++;
  else {
    failed++;
    console.error(`  FAIL  ${label}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  }
}
function ok(label: string, cond: boolean, detail = "") {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? "\n        " + detail : ""}`);
  }
}

/** Replays a script of [atMs, loudest] readings and returns the state plus who held the
 *  border after each step — which is what the assertions are actually about. */
function replay(script: readonly [number, string | null][]): {
  state: Highlight;
  trail: (string | null)[];
} {
  let state = NO_HIGHLIGHT;
  const trail: (string | null)[] = [];
  for (const [at, loudest] of script) {
    state = nextHighlight(state, loudest, at);
    trail.push(state.current);
  }
  return { state, trail };
}

console.log("a first speaker");
{
  // Nobody, then A talks. A does not get the border on the first reading — a threshold
  // crossing is not yet evidence — but does once it has held.
  const { trail } = replay([
    [0, null],
    [100, "A"],
    [100 + SWITCH_MS - 1, "A"],
    [100 + SWITCH_MS, "A"],
  ]);
  is("silence highlights nobody", trail[0], null);
  is("a new voice is not believed immediately", trail[1], null);
  is("nor one millisecond early", trail[2], null);
  is("and is believed once it has held", trail[3], "A");
}

console.log("a handover");
{
  const { trail } = replay([
    [0, "A"],
    [SWITCH_MS, "A"], // A has the border
    [1_000, "B"],
    [1_000 + SWITCH_MS, "B"],
  ]);
  is("A holds it", trail[1], "A");
  is("B speaking does not take it instantly", trail[2], "A");
  is("B takes it after the hold", trail[3], "B");
}

console.log("the noise this exists to reject");
{
  /* A is presenting. B coughs — one reading, 200 ms, then silence, then A again. The border
   * must not move at all. This is the case that made the feature necessary. */
  const { trail, state } = replay([
    [0, "A"],
    [SWITCH_MS, "A"],
    [2_000, "B"], // the cough
    [2_200, "A"], // and it is over, well inside SWITCH_MS
    [2_400, "A"],
    [3_000, "A"],
  ]);
  is("the cough does not take the border", trail[2], "A");
  is("nor does it leave one pending", trail[3], "A");
  is("A still has it later", trail[5], "A");
  is("and nothing is pending", pendingDelay(state, 3_000), null);
  ok("the border never moved", new Set(trail.slice(1)).size === 1, `trail ${JSON.stringify(trail)}`);
}

console.log("a stutter between two people");
{
  /* Two microphones fighting: A B A B A, each for 100 ms. Nothing holds for SWITCH_MS, so
   * whoever had the border keeps it. Without the hold this is five moves. */
  const { trail } = replay([
    [0, "A"],
    [SWITCH_MS, "A"],
    [1_000, "B"],
    [1_100, "A"],
    [1_200, "B"],
    [1_300, "A"],
    [1_400, "B"],
  ]);
  const afterA = trail.slice(1);
  ok(
    "a stutter moves the border zero times",
    afterA.every((who) => who === "A"),
    `trail ${JSON.stringify(trail)}`,
  );
}

console.log("clearing");
{
  const { trail } = replay([
    [0, "A"],
    [SWITCH_MS, "A"],
    [5_000, null],
    [5_000 + SWITCH_MS, null], // long enough to switch, NOT long enough to clear
    [5_000 + CLEAR_MS - 1, null],
    [5_000 + CLEAR_MS, null],
  ]);
  is("a pause does not clear the border", trail[2], "A");
  ok("and SWITCH_MS of silence is not enough", trail[3] === "A", `got ${trail[3]}`);
  is("nor one millisecond early", trail[4], "A");
  is("sustained silence clears it", trail[5], null);
}

console.log("the gap between two sentences");
{
  /* The asymmetry earning its keep: A pauses for a second — longer than SWITCH_MS, shorter
   * than CLEAR_MS — and keeps talking. The border must not blink. */
  const { trail } = replay([
    [0, "A"],
    [SWITCH_MS, "A"],
    [3_000, null],
    [3_900, null],
    [4_000, "A"],
    [4_500, "A"],
  ]);
  ok(
    "a one-second pause never drops the border",
    trail.slice(1).every((who) => who === "A"),
    `trail ${JSON.stringify(trail)}`,
  );
}

console.log("silence, then somebody new");
{
  // Clearing must not make the next speaker wait CLEAR_MS. They wait SWITCH_MS like anyone.
  const { trail } = replay([
    [0, "A"],
    [SWITCH_MS, "A"],
    [1_000, null],
    [1_000 + CLEAR_MS, null], // cleared
    [4_000, "B"],
    [4_000 + SWITCH_MS, "B"],
  ]);
  is("the border cleared", trail[3], null);
  is("B is not believed instantly", trail[4], null);
  is("B gets it after the normal hold", trail[5], "B");
}

console.log("pendingDelay");
{
  let state = nextHighlight(NO_HIGHLIGHT, "A", 0);
  is("a pending switch asks to be woken", pendingDelay(state, 0), SWITCH_MS);
  is("and the wait shortens as time passes", pendingDelay(state, 200), SWITCH_MS - 200);
  ok("never zero, so a caller cannot spin", (pendingDelay(state, 10_000) ?? 0) > 0);

  state = nextHighlight(state, "A", SWITCH_MS); // promoted
  is("nothing pending once it has moved", pendingDelay(state, SWITCH_MS), null);

  state = nextHighlight(state, null, 1_000);
  is("a pending clear uses the longer wait", pendingDelay(state, 1_000), CLEAR_MS);
}

console.log("only one, and never a share");
{
  is("the highlighted person matches", isHighlighted("A", "A", false), true);
  is("everybody else does not", isHighlighted("A", "B", false), false);
  is("nobody highlighted means no border", isHighlighted(null, "A", false), false);
  /* The screen-share rule. Its owner is often the one talking, and ringing the slides every
   * time they speak is the flicker this module exists to remove. */
  is("a share is never highlighted", isHighlighted("A", "A", true), false);
}

console.log("readings that change nothing cost nothing");
{
  /* The re-render requirement, as a property of the function: once the border has settled,
   * repeating the same reading must return the IDENTICAL object. The hook publishes
   * `state.current`, so a new object here would be a new render there. */
  let state = nextHighlight(NO_HIGHLIGHT, "A", 0);
  state = nextHighlight(state, "A", SWITCH_MS);
  const settled = state;
  for (const at of [SWITCH_MS + 1, SWITCH_MS + 50, 10_000, 60_000]) {
    state = nextHighlight(state, "A", at);
  }
  ok("a steady speaker produces no new state", state === settled);

  // And while a change IS pending, the state is also stable between readings — the clock is
  // only restarted by a reading that differs.
  let pending = nextHighlight(settled, "B", 1_000);
  const first = pending;
  pending = nextHighlight(pending, "B", 1_100);
  ok("an unchanged pending reading is stable too", pending === first);
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
