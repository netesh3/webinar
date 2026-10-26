import assert from "node:assert/strict";
import { test } from "node:test";
import { poolPercent, poolStateLabel, poolTone } from "./box-pool.ts";

test("a box's fill is its points over capacity", () => {
  assert.equal(poolPercent({ used: 50, capacity: 100 }), 50);
  assert.equal(poolPercent({ used: 0, capacity: 0 }), 0);
  assert.equal(poolPercent({ used: 130, capacity: 100 }), 130);
});

test("the meter warns from 80% and flags over capacity", () => {
  assert.equal(poolTone({ used: 79, capacity: 100 }), "ok");
  assert.equal(poolTone({ used: 80, capacity: 100 }), "warn");
  assert.equal(poolTone({ used: 101, capacity: 100 }), "over");
});

test("states read as words", () => {
  assert.equal(poolStateLabel("ready"), "Up");
  assert.equal(poolStateLabel("booting"), "Starting");
  assert.equal(poolStateLabel("down"), "Off");
  assert.equal(poolStateLabel("failed"), "Failed");
});
