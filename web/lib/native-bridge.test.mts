/* The mobile app's link routing and keep-awake pages.
 *
 * Run: node --experimental-strip-types --no-warnings lib/native-bridge.test.mts
 */

import assert from "node:assert/strict";
import { isNativeApp, keepsScreenAwake, routeForOpenedUrl } from "./native-bridge.ts";

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

// The screen stays on in a session and on a replay, nowhere else.
assert.equal(keepsScreenAwake("/webinars/abc/room"), true);
assert.equal(keepsScreenAwake("/host/abc/room"), true);
assert.equal(keepsScreenAwake("/webinars/abc/recording"), true);
assert.equal(keepsScreenAwake("/w/abc/recording"), true);
assert.equal(keepsScreenAwake("/webinars/abc"), false);
assert.equal(keepsScreenAwake("/host"), false);
assert.equal(keepsScreenAwake("/"), false);

// Outside the app (no window here at all) it is never native.
assert.equal(isNativeApp(), false);

console.log("native-bridge: ok");
