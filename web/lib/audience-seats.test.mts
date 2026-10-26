import assert from "node:assert/strict";
import { test } from "node:test";
import { seatsView } from "./audience-seats.ts";

test("seatsView reads count against limit", () => {
  assert.deepEqual(seatsView(12, 50), { text: "12 / 50 seats", tone: "ok", percent: 24 });
});

test("near within five seats of a small limit, or at 90% of a big one", () => {
  assert.equal(seatsView(45, 50)?.tone, "near");
  assert.equal(seatsView(44, 50)?.tone, "ok");
  assert.equal(seatsView(270, 300)?.tone, "near");
  assert.equal(seatsView(269, 300)?.tone, "ok");
});

test("full at the limit, and an overshoot stays full at 100%", () => {
  assert.deepEqual(seatsView(50, 50), { text: "50 / 50 seats", tone: "full", percent: 100 });
  assert.equal(seatsView(52, 50)?.percent, 100);
  assert.equal(seatsView(52, 50)?.tone, "full");
});

test("no limit is no view; a bad count is zero", () => {
  assert.equal(seatsView(3, 0), null);
  assert.equal(seatsView(Number.NaN, 10)?.text, "0 / 10 seats");
});
