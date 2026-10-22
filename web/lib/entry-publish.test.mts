/* Tests for getting the pre-join camera and microphone onto the stage (lib/entry-publish.ts).
 *
 * Run with `make test-web`. The bug these guard: a host's stage showed their pre-join self-view
 * under "Your camera — joining the webinar" for the whole session while the camera button said
 * off, because the one publish attempt was lost to a connection that dropped and recovered, and
 * nothing ever tried again or said so.
 */

import assert from "node:assert/strict";
import {
  afterFailure,
  cameraButton,
  entryPlan,
  initialCameraStart,
  publishFailureMessage,
  showEntryPreview,
} from "./entry-publish.ts";

/* ---- entryPlan ---------------------------------------------------------- */

// The ordinary join: the pre-join camera is live and nothing is published yet.
assert.equal(entryPlan({ wanted: true, published: false, entryLive: true }), "publish-entry");

// The reconnect that used to publish nothing: still wanted, still unpublished. The capture was
// released (LiveKit stops a track whose publish timed out), so the device is opened again.
assert.equal(entryPlan({ wanted: true, published: false, entryLive: false }), "open-device");

// Already up — restored by the ladder, or switched on from the control bar. Never twice.
assert.equal(entryPlan({ wanted: true, published: true, entryLive: true }), "skip");

// Not asked for, or given up on after a real failure: nothing is opened behind their back.
assert.equal(entryPlan({ wanted: false, published: false, entryLive: true }), "skip");
assert.equal(entryPlan({ wanted: false, published: false, entryLive: false }), "skip");

/* ---- afterFailure ------------------------------------------------------- */

// The production case: the publish failed because the connection went away under it.
assert.equal(afterFailure({ connected: false, connectionChanged: false }), "retry-on-reconnect");
// The ladder rebuilt the connection while the publish was in flight.
assert.equal(afterFailure({ connected: true, connectionChanged: true }), "retry-on-reconnect");
// A working connection refused it: a real failure, shown with a retry.
assert.equal(afterFailure({ connected: true, connectionChanged: false }), "give-up");

/* ---- showEntryPreview --------------------------------------------------- */

assert.equal(showEntryPreview({ phase: "connecting", entryLive: true }), true);
assert.equal(showEntryPreview({ phase: "publishing", entryLive: true }), true);
// The bug: a camera that never made it must not be dressed up as one that is joining.
assert.equal(showEntryPreview({ phase: "failed", entryLive: true }), false);
// Published: the stage shows the publication, not the preview.
assert.equal(showEntryPreview({ phase: "published", entryLive: true }), false);
assert.equal(showEntryPreview({ phase: "off", entryLive: true }), false);
// A capture that ended is not a preview of anything.
assert.equal(showEntryPreview({ phase: "connecting", entryLive: false }), false);

/* ---- initialCameraStart -------------------------------------------------- */

assert.deepEqual(initialCameraStart(true), { phase: "connecting", error: null });
assert.deepEqual(initialCameraStart(false), { phase: "off", error: null });

/* ---- cameraButton ------------------------------------------------------- */

// The button reads the publication and nothing else.
assert.deepEqual(cameraButton({ published: false, phase: "failed" }), { on: false, busy: false });
assert.deepEqual(cameraButton({ published: false, phase: "connecting" }), {
  on: false,
  busy: false,
});
assert.deepEqual(cameraButton({ published: true, phase: "published" }), { on: true, busy: false });
// Busy only while the pre-join camera is on its way, so a press cannot open a second camera.
assert.deepEqual(cameraButton({ published: false, phase: "publishing" }), {
  on: false,
  busy: true,
});
// Published (e.g. from the control bar) wins over a stale phase.
assert.deepEqual(cameraButton({ published: true, phase: "publishing" }), { on: true, busy: false });
// Rooms without a publishing flow pass no phase.
assert.deepEqual(cameraButton({ published: true, phase: undefined }), { on: true, busy: false });

/* ---- publishFailureMessage ---------------------------------------------- */

const msg = publishFailureMessage(
  "camera",
  "publication of local track timed out, no response from server.",
);
assert.match(msg, /camera is working but couldn't be sent/);
assert.match(msg, /\(publication of local track timed out, no response from server\)\./);
// Not the site-settings advice describeMediaError gives a word like "permissions".
assert.doesNotMatch(publishFailureMessage("camera", "insufficient permissions"), /site settings/);
assert.equal(
  publishFailureMessage("microphone", ""),
  "Your microphone is working but couldn't be sent to the webinar. Check your connection and try again.",
);

console.log("entry-publish: ok");
