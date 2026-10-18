import assert from "node:assert/strict";
import { cameraIsOn, compositeLayout, EDGE_PIP_TILES, isEdgeTemplatePath } from "./composite-layout.ts";

// Edge + share: the share fills the frame, cameras are a few small corner tiles.
const edge = compositeLayout({ edge: true, sharing: true });
assert.match(edge.main, /absolute inset-0/);
assert.match(edge.strip, /absolute bottom-3 right-3/);
assert.equal(edge.maxTiles, EDGE_PIP_TILES);
assert.equal(edge.emptyNote, false);
// ...and only for cameras that are on: no initials cards over the slides.
assert.equal(edge.camerasOnly, true);

// Standard + share is exactly the old layout.
const std = compositeLayout({ edge: false, sharing: true });
assert.match(std.strip, /w-\[22%\]/);
assert.equal(std.maxTiles, undefined);
assert.equal(std.camerasOnly, false);

// No share: same in both modes.
assert.deepEqual(compositeLayout({ edge: true, sharing: false }), compositeLayout({ edge: false, sharing: false }));

// A camera tile needs a published, unmuted, subscribed camera.
assert.equal(cameraIsOn({ publication: { isMuted: false, isSubscribed: true } }), true);
assert.equal(cameraIsOn({ publication: { isMuted: true, isSubscribed: true } }), false);
assert.equal(cameraIsOn({ publication: { isMuted: false, isSubscribed: false } }), false);
assert.equal(cameraIsOn({ publication: undefined }), false);
assert.equal(cameraIsOn({}), false);

assert.equal(isEdgeTemplatePath("/recorder-template/edge"), true);
assert.equal(isEdgeTemplatePath("/recorder-template/edge/clock"), true);
assert.equal(isEdgeTemplatePath("/recorder-template/clock"), false);
assert.equal(isEdgeTemplatePath("/recorder-template"), false);
assert.equal(isEdgeTemplatePath("/recorder-template/edgewise"), false);

console.log("composite-layout ok");
