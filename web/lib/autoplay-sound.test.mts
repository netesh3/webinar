/* Whether the broadcast player tries for sound first.
 *
 * Run: node --experimental-strip-types --no-warnings lib/autoplay-sound.test.mts */

import assert from "node:assert/strict";
import { isAutoplayRefusal, tryWithSound } from "./autoplay-sound.ts";

// Clicked Join (Chrome, Edge, Firefox): sticky activation, so with sound.
assert.equal(tryWithSound({ activated: true, primed: false }), true);
// Safari: an element unlocked by the Join tap plays with sound, whatever the activation says.
assert.equal(tryWithSound({ activated: false, primed: true }), true);
// No userActivation API: try, and let play() say no.
assert.equal(tryWithSound({ activated: undefined, primed: false }), true);
// A cold room link, a refresh, a new tab: muted from the start, sound on the first tap.
assert.equal(tryWithSound({ activated: false, primed: false }), false);

assert.equal(isAutoplayRefusal(new DOMException("no", "NotAllowedError")), true);
assert.equal(isAutoplayRefusal(new DOMException("aborted", "AbortError")), false);
assert.equal(isAutoplayRefusal({ name: "NotAllowedError" }), true);
assert.equal(isAutoplayRefusal(undefined), false);
assert.equal(isAutoplayRefusal("NotAllowedError"), false);

console.log("autoplay-sound: ok");
