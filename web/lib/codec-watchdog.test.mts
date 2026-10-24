/* The backup-codec watchdog (lib/codec-watchdog.ts) — run with `make test-web`.
 *
 * The case it exists for: an AV1 camera regressed to its VP8 backup, the AV1 sender's layers
 * paused by dynacast, and the VP8 sender switched on but sending nothing. Everything else here
 * is a case where it must NOT fire: frames flowing on any switched-on sender, a muted camera,
 * every layer paused because nobody watches, a brand-new encoder's first window.
 */

import assert from "node:assert/strict";
import { initialStall, stallStep, STALL_MS, type SenderSample, type StallState } from "./codec-watchdog.ts";

let checks = 0;
const check = (fn: () => void) => {
  fn();
  checks++;
};

const S = 2000; // ADAPT.sampleMs
type Tick = { av1: [boolean, number | null]; vp8: [boolean, number | null]; muted?: boolean };
const senders = (t: Tick): SenderSample[] => [
  { id: "av1", active: t.av1[0], framesSent: t.av1[1] },
  { id: "vp8", active: t.vp8[0], framesSent: t.vp8[1] },
];

/** Runs ticks one sample apart; returns the index of the first tick that fired, or -1. */
function run(ticks: Tick[], start: StallState = initialStall()): { fired: number[]; state: StallState } {
  let state = start;
  const fired: number[] = [];
  ticks.forEach((t, i) => {
    const step = stallStep(state, { now: i * S, muted: Boolean(t.muted), senders: senders(t) });
    state = step.state;
    if (step.stalled) fired.push(i);
  });
  return { fired, state };
}

// ---- the incident: AV1 paused (frames frozen), VP8 backup on and stuck at 0
{
  const ticks: Tick[] = [
    { av1: [true, 100], vp8: [false, null] }, // AV1 flowing, no backup yet
    { av1: [false, 130], vp8: [true, 0] }, // regressed: new VP8 sender, first sight = benefit of the doubt
    { av1: [false, 130], vp8: [true, 0] }, // 2 s without a frame
    { av1: [false, 130], vp8: [true, 0] }, // 4 s: past STALL_MS
    { av1: [false, 130], vp8: [true, 0] },
    { av1: [false, 130], vp8: [true, 0] },
  ];
  const { fired } = run(ticks);
  check(() => assert.deepEqual(fired, [3], "fires once, at the first sample past STALL_MS"));
  check(() => assert.ok((3 - 1) * S >= STALL_MS));
}

// ---- healthy regression: VP8 frames flowing — never
{
  const ticks: Tick[] = Array.from({ length: 10 }, (_, i) => ({ av1: [false, 130], vp8: [true, i * 60] }) as Tick);
  check(() => assert.deepEqual(run(ticks).fired, []));
}

// ---- one sender flowing is enough (the AV1 primary still on, the backup slow to start)
{
  const ticks: Tick[] = Array.from({ length: 10 }, (_, i) => ({ av1: [true, i * 60], vp8: [true, 0] }) as Tick);
  check(() => assert.deepEqual(run(ticks).fired, []));
}

// ---- muted: nothing is owed, and unmuting gives a fresh window
{
  const ticks: Tick[] = [
    { av1: [false, 130], vp8: [true, 50] },
    { av1: [false, 130], vp8: [true, 50], muted: true },
    { av1: [false, 130], vp8: [true, 50], muted: true },
    { av1: [false, 130], vp8: [true, 50], muted: true },
    { av1: [false, 130], vp8: [true, 50] }, // unmuted: window starts here
    { av1: [false, 130], vp8: [true, 80] }, // and frames come
    { av1: [false, 130], vp8: [true, 110] },
  ];
  check(() => assert.deepEqual(run(ticks).fired, []));
}

// ---- dynacast paused every layer (nobody watching): no frames is correct
{
  const ticks: Tick[] = Array.from({ length: 8 }, () => ({ av1: [false, 130], vp8: [false, 50] }) as Tick);
  check(() => assert.deepEqual(run(ticks).fired, []));
}

// ---- unreadable stats are never called stuck
{
  const ticks: Tick[] = Array.from({ length: 8 }, () => ({ av1: [false, null], vp8: [true, null] }) as Tick);
  check(() => assert.deepEqual(run(ticks).fired, []));
}

// ---- a stall that recovers before STALL_MS does not fire, and resets the window
{
  const ticks: Tick[] = [
    { av1: [false, 0], vp8: [true, 10] },
    { av1: [false, 0], vp8: [true, 10] }, // 2 s stuck
    { av1: [false, 0], vp8: [true, 20] }, // recovered
    { av1: [false, 0], vp8: [true, 20] }, // 2 s stuck again
    { av1: [false, 0], vp8: [true, 30] },
  ];
  check(() => assert.deepEqual(run(ticks).fired, []));
}

// ---- once per track: a stall that persists after firing does not fire again
{
  const stuck: Tick[] = Array.from({ length: 10 }, () => ({ av1: [false, 0], vp8: [true, 0] }) as Tick);
  const { fired, state } = run(stuck);
  check(() => assert.equal(fired.length, 1));
  check(() => assert.equal(state.fired, true));
}

// ---- exactly at the boundary
{
  let state = initialStall();
  const s = (now: number, frames: number) =>
    stallStep(state, { now, muted: false, senders: [{ id: "vp8", active: true, framesSent: frames }] });
  let r = s(0, 5);
  state = r.state;
  r = s(STALL_MS - 1, 5);
  state = r.state;
  check(() => assert.equal(r.stalled, false, "just under STALL_MS"));
  r = s(STALL_MS, 5);
  check(() => assert.equal(r.stalled, true, "at STALL_MS"));
}

console.log(`PASS codec-watchdog (${checks} checks)`);
