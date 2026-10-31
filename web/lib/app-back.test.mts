/* Where the in-app Back button goes.
 *
 * Run: node --experimental-strip-types --no-warnings lib/app-back.test.mts
 */

import assert from "node:assert/strict";
import { appParentPath, isAppRoot, nativeBackAction } from "./app-back.ts";

assert.equal(isAppRoot("/host"), true);
assert.equal(isAppRoot("/host/meetings"), true);
assert.equal(isAppRoot("/my-webinars"), true);
assert.equal(isAppRoot("/host/abc"), false);
assert.equal(isAppRoot("/host/abc/room"), false);

assert.equal(appParentPath("/host"), null);
assert.equal(appParentPath("/host/meetings"), null);
assert.equal(appParentPath("/my-webinars"), null);
assert.equal(appParentPath("/settings"), null);

assert.equal(appParentPath("/host/abc/room"), "/host/abc");
assert.equal(appParentPath("/webinars/abc/room?k=1"), "/webinars/abc");
assert.equal(appParentPath("/host/abc"), "/host");
assert.equal(appParentPath("/host/abc/edit"), "/host/abc");
assert.equal(appParentPath("/host/new"), "/host");
assert.equal(appParentPath("/host/new/meeting"), "/host/meetings");
assert.equal(appParentPath("/host/new/simulive"), "/host");
assert.equal(appParentPath("/webinars/abc"), "/my-webinars");

assert.equal(nativeBackAction({ canGoBack: true, pathname: "/host/abc/room" }), "history");
assert.equal(nativeBackAction({ canGoBack: false, pathname: "/host/abc/room" }), "parent");
assert.equal(nativeBackAction({ canGoBack: false, pathname: "/host" }), "exit");

console.log("app-back: ok");
