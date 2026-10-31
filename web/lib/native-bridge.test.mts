/* The mobile app's link routing and keep-awake pages.
 *
 * Run: node --experimental-strip-types --no-warnings lib/native-bridge.test.mts
 */

import assert from "node:assert/strict";
import { handOffReturn, inAppClickUrl, inAppDestination, isNativeApp, keepsScreenAwake, pushNeedsSync, routeForOpenedUrl } from "./native-bridge.ts";

// App Links / Universal Links on the site itself become a path on the same origin.
assert.equal(routeForOpenedUrl("https://webinarliv.com/webinars/abc?k=1#q"), "/webinars/abc?k=1#q");
assert.equal(routeForOpenedUrl("https://www.webinarliv.com/w/abc/recording"), "/w/abc/recording");
assert.equal(routeForOpenedUrl("https://WEBINARLIV.com/host/x/room"), "/host/x/room");

// Allowed subdomains load as they are.
assert.equal(
  routeForOpenedUrl("https://recordings.webinarliv.com/a/b.mp4"),
  "https://recordings.webinarliv.com/a/b.mp4",
);

// The custom scheme, with and without a host part.
assert.equal(routeForOpenedUrl("webinarliv://webinars/abc?k=1"), "/webinars/abc?k=1");
assert.equal(routeForOpenedUrl("webinarliv:///webinars/abc"), "/webinars/abc");
assert.equal(routeForOpenedUrl("webinarliv://"), "/");

// Everything else is ignored: other sites, look-alike hosts, plain http, junk.
assert.equal(routeForOpenedUrl("https://evil.example/webinars/abc"), null);
assert.equal(routeForOpenedUrl("https://webinarliv.com.evil.example/x"), null);
assert.equal(routeForOpenedUrl("https://notwebinarliv.com/x"), null);
assert.equal(routeForOpenedUrl("http://webinarliv.com/webinars/abc"), null);
assert.equal(routeForOpenedUrl("javascript:alert(1)"), null);
assert.equal(routeForOpenedUrl("not a url"), null);

// The Google sign-in hand-off comes back on the custom scheme (lib/app-auth.ts).
assert.equal(routeForOpenedUrl("webinarliv://auth/complete?code=abc"), "/auth/complete?code=abc");
assert.equal(routeForOpenedUrl("webinarliv://auth/complete/?code=abc"), "/auth/complete?code=abc");
// The connect hand-offs come back the same way (lib/app-connect.ts).
assert.equal(
  routeForOpenedUrl("webinarliv://connect/complete?code=abc&provider=zoom"),
  "/connect/complete?code=abc&provider=zoom",
);
assert.equal(routeForOpenedUrl("webinarliv://connect/picked"), "/connect/picked");
// Sign-in and connect completions load their page; a Drive pick leaves the live room alone.
assert.equal(handOffReturn("/auth/complete?code=abc"), "navigate");
assert.equal(handOffReturn("/auth/complete/?code=abc"), "navigate");
assert.equal(handOffReturn("/connect/complete?error=denied&provider=youtube"), "navigate");
assert.equal(handOffReturn("/connect/picked"), "stay");
assert.equal(handOffReturn("/connect/pickedx"), "none");
assert.equal(handOffReturn("/webinars/abc/room"), "none");
// A push may carry a bare site path; a protocol-relative or backslashed one is not a path.
assert.equal(routeForOpenedUrl("/webinars/abc/room?k=K"), "/webinars/abc/room?k=K");
assert.equal(routeForOpenedUrl("//evil.example/x"), null);
assert.equal(routeForOpenedUrl("/\\evil.example"), null);

// Phone app: our rooms stay in the WebView; Zoom / WhatsApp do not.
assert.equal(inAppDestination("/host/abc/room"), "https://webinarliv.com/host/abc/room");
assert.equal(inAppDestination("/webinars/abc/room?k=1"), "https://webinarliv.com/webinars/abc/room?k=1");
assert.equal(inAppDestination("https://webinarliv.com/host/abc/room"), "https://webinarliv.com/host/abc/room");
assert.equal(inAppDestination("https://zoom.us/s/123"), null);
assert.equal(inAppDestination("https://wa.me/?text=hi"), null);
assert.equal(inAppClickUrl("/host/abc/room", "_blank"), "https://webinarliv.com/host/abc/room");
assert.equal(inAppClickUrl("/host/abc/room", "_new"), "https://webinarliv.com/host/abc/room");
assert.equal(inAppClickUrl("/host/abc/room", null), null);
assert.equal(inAppClickUrl("https://calendar.google.com/x", "_blank"), null);

// The screen stays on in a session and on a replay, nowhere else.
assert.equal(keepsScreenAwake("/webinars/abc/room"), true);
assert.equal(keepsScreenAwake("/host/abc/room"), true);
assert.equal(keepsScreenAwake("/webinars/abc/recording"), true);
assert.equal(keepsScreenAwake("/w/abc/recording"), true);
assert.equal(keepsScreenAwake("/webinars/abc"), false);
assert.equal(keepsScreenAwake("/host"), false);
assert.equal(keepsScreenAwake("/"), false);

// The push token is sent when it or the account changes, and once a day besides.
const day = 24 * 60 * 60_000;
assert.equal(pushNeedsSync(null, "t1", "u1", 0), true);
assert.equal(pushNeedsSync({ token: "t1", user: "u1", at: 1000 }, "t1", "u1", 2000), false);
assert.equal(pushNeedsSync({ token: "t1", user: "u1", at: 1000 }, "t2", "u1", 2000), true);
assert.equal(pushNeedsSync({ token: "t1", user: "u1", at: 1000 }, "t1", "u2", 2000), true);
assert.equal(pushNeedsSync({ token: "t1", user: "u1", at: 1000 }, "t1", "u1", 1000 + day + 1), true);
assert.equal(pushNeedsSync(null, "", "u1", 0), false);
assert.equal(pushNeedsSync(null, "t1", "", 0), false);

// Outside the app (no window here at all) it is never native.
assert.equal(isNativeApp(), false);

console.log("native-bridge: ok");
