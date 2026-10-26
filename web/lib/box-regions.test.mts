import assert from "node:assert/strict";
import { test } from "node:test";
import { offersRegions, regionLabel, shownRegion } from "./box-regions.ts";

test("the region choice only appears with two or more regions", () => {
  assert.equal(offersRegions(undefined), false);
  assert.equal(offersRegions([]), false);
  assert.equal(offersRegions(["in"]), false);
  assert.equal(offersRegions(["in", "us"]), true);
});

test("a region is named, an unknown one shown as its code", () => {
  assert.equal(regionLabel("in"), "India (Bangalore)");
  assert.equal(regionLabel("us"), "United States");
  assert.equal(regionLabel("au"), "AU");
});

test("the shown region is the session's own, else the default", () => {
  assert.equal(shownRegion("us", ["in", "us"]), "us");
  assert.equal(shownRegion("", ["in", "us"]), "in");
  assert.equal(shownRegion("eu", ["in", "us"]), "in");
});
