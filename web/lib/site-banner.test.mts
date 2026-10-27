import { test } from "node:test";
import assert from "node:assert/strict";
import { bannerId, bannerVisible } from "./site-banner.ts";

const on = { enabled: true, message: "Maintenance tonight.", updatedAt: "2026-10-27T03:00:00Z" };

test("shown to everyone but admins while on", () => {
  assert.equal(bannerVisible(on, { isAdmin: false, dismissed: null }), true);
  assert.equal(bannerVisible(on, { isAdmin: true, dismissed: null }), false);
});

test("hidden when off, empty or unknown", () => {
  assert.equal(bannerVisible({ ...on, enabled: false }, { isAdmin: false, dismissed: null }), false);
  assert.equal(bannerVisible({ ...on, message: "  " }, { isAdmin: false, dismissed: null }), false);
  assert.equal(bannerVisible(null, { isAdmin: false, dismissed: null }), false);
});

test("a dismissal hides this banner for the session, and a new message shows again", () => {
  assert.equal(bannerVisible(on, { isAdmin: false, dismissed: bannerId(on) }), false);
  const changed = { ...on, message: "Back soon.", updatedAt: "2026-10-27T04:00:00Z" };
  assert.equal(bannerVisible(changed, { isAdmin: false, dismissed: bannerId(on) }), true);
});
