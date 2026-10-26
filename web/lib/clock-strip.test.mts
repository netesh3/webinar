/* Tests for the latency clock's time strip (lib/clock-strip.ts). Run with `make test-web`.
 *
 * The load-test kit decodes these cells (e2e/load/lib/clock-strip.mjs); the fixture below is
 * the contract between the two, repeated in e2e/load/test/browser.test.mjs. */

import assert from "node:assert/strict";
import { CLOCK_CELLS, encodeClock } from "./clock-strip.ts";

const at = Date.UTC(2026, 9, 26, 10, 0, 0, 123); // 2026-10-26T10:00:00.123Z
const cells = encodeClock(at);
assert.equal(cells.length, CLOCK_CELLS);
assert.equal(CLOCK_CELLS, 42);
assert.deepEqual(cells.slice(0, 2), [true, false]); // white, black references
// The contract fixture: references, floor(at / 10) mod 2^32, its checksum, as 1s and 0s.
export const FIXTURE = "101011111100101010010011101000110011000011";
const fixture = cells.map((c) => (c ? "1" : "0")).join("");
assert.equal(fixture, FIXTURE);
const v = Math.floor(at / 10) % 2 ** 32;
assert.equal(parseInt(fixture.slice(2, 34), 2), v);
const sum = ((v >>> 24) + ((v >>> 16) & 0xff) + ((v >>> 8) & 0xff) + (v & 0xff)) & 0xff;
assert.equal(parseInt(fixture.slice(34), 2), sum);
// 10 ms steps: times inside one step draw the same cells; the next step differs.
assert.deepEqual(encodeClock(at + 6), encodeClock(at + 1));
assert.notDeepEqual(encodeClock(at + 10), cells);

console.log("clock-strip: ok");
