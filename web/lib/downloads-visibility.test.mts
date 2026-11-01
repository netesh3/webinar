import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOWNLOADS_HIDDEN_REDIRECT,
  downloadPageAccess,
  downloadsVisible,
  showGetAppLink,
} from "./downloads-visibility.ts";

test("hidden unless the config says true", () => {
  assert.equal(downloadsVisible({ downloadsVisible: true }), true);
  assert.equal(downloadsVisible({ downloadsVisible: false }), false);
  assert.equal(downloadsVisible({}), false, "an API that predates the switch");
  assert.equal(downloadsVisible(null), false, "no config");
  assert.equal(downloadsVisible(undefined), false);
});

test("the Get the app links follow the switch, and never show inside our own app", () => {
  assert.equal(showGetAppLink({ visible: true, inOwnApp: false }), true);
  assert.equal(showGetAppLink({ visible: false, inOwnApp: false }), false);
  assert.equal(showGetAppLink({ visible: true, inOwnApp: true }), false);
  assert.equal(showGetAppLink({ visible: false, inOwnApp: true }), false);
});

test("/download: shown when visible, previewed by admins when hidden, else redirected home", () => {
  assert.equal(downloadPageAccess(true, null), "show");
  assert.equal(downloadPageAccess(true, { isAdmin: false }), "show");
  assert.equal(downloadPageAccess(true, { isAdmin: true }), "show");
  assert.equal(downloadPageAccess(false, null), "redirect");
  assert.equal(downloadPageAccess(false, { isAdmin: false }), "redirect");
  assert.equal(downloadPageAccess(false, { isAdmin: true }), "admin-preview");
  assert.equal(DOWNLOADS_HIDDEN_REDIRECT, "/");
});
