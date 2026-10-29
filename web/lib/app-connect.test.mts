/* The apps' connect hand-off: which links it takes over, the fragment, and the link back.
 *
 * Run: node --experimental-strip-types --no-warnings lib/app-connect.test.mts
 */

import assert from "node:assert/strict";
import {
  connectAppKind,
  connectCompleteLink,
  connectErrorMessage,
  connectFromHref,
  DRIVE_PICKED_LINK,
  parseConnectFragment,
  providerLabel,
  safeReturn,
} from "./app-connect.ts";

// The integration cards' and the YouTube buttons' connect links, relative or absolute.
assert.deepEqual(connectFromHref("/api/host/zoom/connect?return=%2Fsettings%23integrations"), {
  provider: "zoom",
  ret: "/settings#integrations",
});
assert.deepEqual(connectFromHref("https://webinarliv.com/api/host/youtube/connect?return=%2Fhost%2Fx%2Froom"), {
  provider: "youtube",
  ret: "/host/x/room",
});
// No return, or a return that leaves the site: back to Settings.
assert.deepEqual(connectFromHref("/api/host/youtube/connect"), { provider: "youtube", ret: "/settings" });
assert.equal(connectFromHref("/api/host/zoom/connect?return=https%3A%2F%2Fevil.example")?.ret, "/settings");
assert.equal(connectFromHref("/api/host/zoom/connect?return=%2F%2Fevil.example")?.ret, "/settings");
// Anything else is not taken over.
assert.equal(connectFromHref("/api/host/slack/connect"), null);
assert.equal(connectFromHref("/api/host/zoom/connect/extra"), null);
assert.equal(connectFromHref("/settings"), null);
assert.equal(connectFromHref("/api/host/integrations/zoom"), null);

assert.equal(safeReturn("/w/x"), "/w/x");
assert.equal(safeReturn("/\\evil"), "/settings");
assert.equal(safeReturn(null), "/settings");

// What the callback put in /connect/app-return's fragment.
assert.deepEqual(parseConnectFragment("#code=abc&app=ios&provider=zoom"), {
  code: "abc",
  error: "",
  app: "ios",
  provider: "zoom",
});
assert.deepEqual(parseConnectFragment("error=denied&provider=youtube&app=desktop"), {
  code: "",
  error: "denied",
  app: "desktop",
  provider: "youtube",
});

// The link back into the app: the code or one error word, and the provider. Nothing else.
const ok = new URL(connectCompleteLink({ code: "abc", provider: "zoom" }));
assert.equal(ok.protocol, "webinarliv:");
assert.equal(ok.host, "connect");
assert.equal(ok.pathname, "/complete");
assert.equal(ok.searchParams.get("code"), "abc");
assert.equal(ok.searchParams.get("provider"), "zoom");
assert.equal(ok.searchParams.get("error"), null);
const bad = new URL(connectCompleteLink({ error: "denied", provider: "youtube" }));
assert.equal(bad.searchParams.get("error"), "denied");
assert.equal(bad.searchParams.get("code"), null);
// An odd error word or provider does not ride along.
const odd = new URL(connectCompleteLink({ error: "<script>", provider: "evil" }));
assert.equal(odd.searchParams.get("error"), "provider");
assert.equal(odd.searchParams.get("provider"), null);

assert.equal(DRIVE_PICKED_LINK, "webinarliv://connect/picked");
assert.equal(providerLabel("zoom"), "Zoom");
assert.equal(providerLabel("drive"), "Google Drive");
assert.match(connectErrorMessage("zoom", "denied"), /Zoom wasn't connected/);
assert.match(connectErrorMessage("youtube", "expired"), /too long/);
assert.match(connectErrorMessage("youtube", "whatever"), /YouTube didn't finish/);

// Outside an app (no window here at all) nothing is taken over.
assert.equal(connectAppKind(), null);

console.log("app-connect: ok");
