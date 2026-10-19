/* Tests for the "live but silent" microphone check.
 *
 * Run with `make test-web`. Both directions matter. Missing a stall is the bug this was
 * written to see: a speaker everyone can see and nobody can hear, with nothing in the
 * logs. Reporting one that is not there is how a diagnostic gets ignored — a quiet
 * speaker, a muted one, or the first moments after joining must never look like a stall.
 */

import {
  INITIAL_FLOW,
  LEVEL_MIN_TALKING,
  QUIET_DB,
  SILENT_MS,
  STALL_MS,
  TALKING_FLOOR_DB,
  VOICE_DB,
  intervalLevelDb,
  summarizeLevels,
  watchFlow,
  type FlowEvent,
  type FlowSample,
  type FlowState,
} from "./audio-watch.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
}

function eq<T>(actual: T, expected: T, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, what, a === e ? "" : `got ${a}\n        want ${e}`);
}

/** Runs samples through the watcher, collecting every event with when it fired. */
function run(samples: FlowSample[], start: FlowState = INITIAL_FLOW) {
  let state = start;
  const events: Array<{ at: number; event: FlowEvent }> = [];
  for (const s of samples) {
    const { next, events: fired } = watchFlow(state, s);
    state = next;
    for (const event of fired) events.push({ at: s.at, event });
  }
  return { state, events };
}

const STEP = 3_000;
/** Samples every STEP ms from 0 to `until`, with bytes and energy from the functions given. */
function series(
  until: number,
  bytes: (at: number) => number | undefined,
  energy?: (at: number) => number | undefined,
  muted: (at: number) => boolean = () => false,
): FlowSample[] {
  const out: FlowSample[] = [];
  for (let at = 0; at <= until; at += STEP) {
    out.push({ at, muted: muted(at), bytes: bytes(at), energy: energy?.(at) });
  }
  return out;
}

{
  const { events } = run(series(60_000, (at) => at * 4, (at) => at * 1e-6));
  eq(events, [], "a speaker whose bytes and energy keep moving is never reported");
}

{
  const { events } = run(series(60_000, () => 5_000, () => 0.5));
  ok(events.length >= 1 && events[0].event === "stalled", "bytes that stop moving are a stall");
  ok(events[0]?.at >= STALL_MS, "but only once they have been stopped for STALL_MS", `at ${events[0]?.at}`);
  ok(events[0]?.at < STALL_MS + STEP * 2, "and not much later than that", `at ${events[0]?.at}`);
  eq(events.filter((e) => e.event === "stalled").length, 1, "a stall is reported once, not every sample");
}

{
  // Stalled from the start, then muted for a long time, then unmuted and still stalled.
  const { events } = run(series(90_000, () => 100, undefined, (at) => at < 60_000));
  const stall = events.find((e) => e.event === "stalled");
  ok(stall !== undefined && stall.at >= 60_000 + STALL_MS, "time spent muted never counts towards a stall", `at ${stall?.at}`);
}

{
  const { events } = run(series(60_000, () => undefined));
  eq(events, [], "no stats at all is not evidence of anything");
}

{
  // Stalls, then recovers.
  const { events } = run(series(60_000, (at) => (at < 30_000 ? 1_000 : at)));
  eq(events.map((e) => e.event), ["stalled", "flowing"], "a stall that clears says so once");
}

{
  // Bytes moving, energy flat at exactly the same value: a dead source.
  const { events } = run(series(60_000, (at) => at, () => 0.25));
  const silent = events.find((e) => e.event === "silent");
  ok(silent !== undefined, "sending, but no energy at all, is a silent source");
  ok(silent !== undefined && silent.at >= SILENT_MS, "only after SILENT_MS of it", `at ${silent?.at}`);
  ok(!events.some((e) => e.event === "stalled"), "and is not called a stall: bytes are moving");
}

{
  // Energy increasing by a tiny amount — a quiet room through RNNoise — is not silence.
  const { events } = run(series(90_000, (at) => at, (at) => at * 1e-12));
  eq(events, [], "a very quiet microphone is still a microphone");
}

{
  // A browser that reports no energy: silence is never judged, stalls still are.
  const { events } = run(series(60_000, () => 7));
  ok(!events.some((e) => e.event === "silent"), "no energy reported means no silence verdict");
  ok(events.some((e) => e.event === "stalled"), "but a stall is still seen");
}

{
  // Silent, then the source comes back.
  const { events } = run(series(90_000, (at) => at, (at) => (at < 45_000 ? 1 : at)));
  eq(events.map((e) => e.event), ["silent", "flowing"], "a silence that ends says so once");
}

{
  // Nothing ever sent: the stats have no RTP stream, which telemetry.ts passes as 0 bytes.
  const { events } = run(series(30_000, () => 0));
  ok(events.some((e) => e.event === "stalled"), "a microphone that never sends a packet is a stall");
}

{
  // Heard, then a long pause with exact zeros — a denoiser quantising a quiet room.
  const { events } = run(series(120_000, (at) => at, (at) => (at < 9_000 ? at : 9_000)));
  ok(!events.some((e) => e.event === "silent"), "a speaker already heard is never a dead source for pausing");
}

{
  // Heard, muted, unmuted — and from then on exactly nothing.
  const { events } = run(series(
    150_000,
    (at) => at,
    (at) => (at < 9_000 ? at : 9_000),
    (at) => at >= 30_000 && at < 60_000,
  ));
  const silent = events.find((e) => e.event === "silent");
  ok(silent !== undefined && silent.at >= 60_000 + SILENT_MS, "a source that dies across a mute is still caught", `at ${silent?.at}`);
}

{
  // Both, then only the stall clears: still not flowing.
  const { events } = run(series(
    120_000,
    (at) => (at < 60_000 ? 50 : at),
    () => 2,
  ));
  eq(events.map((e) => e.event), ["stalled", "silent"], "a cleared stall over a dead source is not 'flowing'");
}

// ---------------------------------------------------------------- how loud a voice is

{
  // Three seconds at a steady level of 0.1: energy 0.01 × 3, so −20 dB.
  const db = intervalLevelDb({ energy: 1, duration: 10 }, 1 + 0.01 * 3, 13);
  ok(db !== undefined && Math.abs(db + 20) < 1e-6, "the level of an interval comes from the counters' deltas", `got ${db}`);
  ok(intervalLevelDb({}, 1, 10) === undefined, "no earlier reading, no interval");
  ok(intervalLevelDb({ energy: 1, duration: 10 }, 1, 10) === undefined, "no audio in between, no level");
  ok(intervalLevelDb({ energy: 2, duration: 10 }, 1, 13) === undefined, "counters that went backwards are not trusted");
  const silent = intervalLevelDb({ energy: 1, duration: 10 }, 1, 13);
  ok(silent !== undefined && silent < -100, "exact silence is very quiet, not -Infinity", `got ${silent}`);
}

/* Readings in WebRTC's units (see the file's level section): a close speaker with automatic
 * gain control reads about −4 while talking; one 12 dB quieter, about −16; a room's noise
 * floor, about −43; typing, about −30. */

{
  eq(summarizeLevels([]), { speakingDb: null, loudestDb: null, talking: 0, quiet: false }, "nothing heard, nothing said");
}

{
  // The reviewer's case: someone unmuted and silent in a noisy room used to be reported as a
  // quiet speaker every thirty seconds.
  const room = summarizeLevels([-43, -44, -42, -43, -45, -43, -44, -42, -43, -44]);
  ok(room.talking === 0 && !room.quiet, "a noisy room with nobody talking is not a quiet speaker", JSON.stringify(room));
  const typing = summarizeLevels([-30, -43, -29, -44, -31, -42, -30, -43, -28, -44]);
  ok(typing.talking === 0 && !typing.quiet, "nor is somebody typing", JSON.stringify(typing));
}

{
  // A close speaker with pauses between sentences.
  const s = summarizeLevels([-4, -43, -6, -3, -42, -5, -4, -7, -44, -5]);
  ok(s.talking === 7 && !s.quiet, "a normal speaker is not quiet", JSON.stringify(s));
  ok(s.speakingDb === -5 && s.loudestDb === -3, "and their usual level is the median of their talking, not their peak", JSON.stringify(s));
}

{
  // The reviewer's other case: a speaker 12 dB quieter than the room used to read as normal.
  const s = summarizeLevels([-16, -43, -18, -15, -19, -44, -17, -16]);
  ok(s.quiet && s.talking === 6, "a speaker some 12 dB under the others is quiet", JSON.stringify(s));
}

{
  // Quiet, and only just above the floor — still a voice, still talking.
  const s = summarizeLevels([-25, -44, -27, -24, -28, -26]);
  ok(s.quiet && s.talking >= 4, "a very quiet voice is talking, and quiet", JSON.stringify(s));
}

{
  const short = summarizeLevels(Array.from({ length: LEVEL_MIN_TALKING - 1 }, () => -20));
  ok(!short.quiet, "too little talking for a verdict");
}

{
  // Mostly normal, one quiet aside: the usual level decides, not the quietest moment.
  const s = summarizeLevels([-4, -5, -3, -6, -17]);
  ok(!s.quiet, "one quiet moment does not make a quiet speaker", JSON.stringify(s));
}

{
  ok(TALKING_FLOOR_DB < QUIET_DB && VOICE_DB < QUIET_DB, "the thresholds are in order");
}

if (failures) {
  console.log(`\n${failures} of ${checks} failed`);
  process.exit(1);
}
console.log(`\n${checks} ok`);
