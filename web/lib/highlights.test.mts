/* Suggested highlights' pure half: clock times, an adjusted range's problems, chips and states.
 *
 * Run: node --experimental-strip-types --no-warnings lib/highlights.test.mts */

import assert from "node:assert/strict";
import { clock, highlightsStatusText, lengthText, parseClock, rangeProblem, signalChips } from "./highlights.ts";

assert.equal(clock(0), "0:00");
assert.equal(clock(725.9), "12:05");
assert.equal(clock(3723), "1:02:03");

assert.equal(parseClock("12:05"), 725);
assert.equal(parseClock(" 1:02:03 "), 3723);
assert.equal(parseClock("725"), 725);
assert.equal(parseClock("12:05.5"), 725.5);
assert.equal(parseClock("12:75"), null);
assert.equal(parseClock("abc"), null);
assert.equal(parseClock(""), null);

assert.equal(lengthText(45.4), "45 s");
assert.equal(lengthText(65), "1 min 5 s");
assert.equal(lengthText(90), "1 min 30 s");
assert.equal(lengthText(120), "2 min");

const part = { start: 0, end: 600 };
assert.equal(rangeProblem(100, 145, part), null);
assert.match(rangeProblem(null, 145, part)!, /minutes and seconds/);
assert.match(rangeProblem(145, 100, part)!, /after the start/);
assert.match(rangeProblem(100, 110, part)!, /at least 20/);
assert.match(rangeProblem(100, 200, part)!, /at most 90/);
assert.match(rangeProblem(590, 620, part)!, /between 0:00 and 10:00/);

assert.deepEqual(signalChips({ reactions: 50, chat: 1, questions: 2, polls: 0 }), [
  "50 reactions",
  "1 chat message",
  "2 questions",
]);
assert.deepEqual(signalChips({ reactions: 0, chat: 0, questions: 0, polls: 0 }), []);

assert.equal(highlightsStatusText("ready"), null);
assert.equal(highlightsStatusText("processing")!.pending, true);
assert.match(highlightsStatusText("no_transcript")!.text, /captioned/);
assert.match(highlightsStatusText("something_else")!.text, /Try again/);

console.log("highlights: ok");
