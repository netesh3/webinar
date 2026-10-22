/* Captions on replays: the captions file's address, which take's file each part of the
 * playlist gets, and switching only our track.
 *
 * Run: node --experimental-strip-types --no-warnings lib/caption-track.test.mts */

import assert from "node:assert/strict";
import { CAPTIONS_LABEL, captionsMode, captionsURL, showCaptions } from "./caption-track.ts";
import { recordingSources } from "./recording-parts.ts";

// captionsURL: empty values are left out, the rest encoded.
assert.equal(captionsURL("/c.vtt"), "/c.vtt");
assert.equal(captionsURL("/c.vtt", { passcode: undefined, part: "" }), "/c.vtt");
assert.equal(captionsURL("/c.vtt", { passcode: "a b&c", part: "p1" }), "/c.vtt?passcode=a%20b%26c&part=p1");
assert.equal(captionsURL("/c.vtt", { joinKey: "k" }), "/c.vtt?joinKey=k");

assert.equal(captionsMode(true), "showing");
assert.equal(captionsMode(false), "hidden");

// recordingSources: no captions unless asked; one take plays the session's file (no part);
// several each get their own; takes that cannot play are skipped like their video.
const part = (id: string, status: "ready" | "failed" = "ready") => ({
  id, status, sizeBytes: status === "ready" ? 10 : 0, durationMs: 1000, createdAt: "",
});
const one = { id: "s", status: "ready" as const, sizeBytes: 10, durationMs: 1000, parts: [part("s"), part("x", "failed")] };
assert.deepEqual(recordingSources(one, (id) => `/f/${id}`), [{ src: "/f/s", durationMs: 1000 }]);
assert.deepEqual(
  recordingSources(one, (id) => `/f/${id}`, (p) => `/cc${p ? `?part=${p}` : ""}`),
  [{ src: "/f/s", durationMs: 1000, captions: "/cc" }],
);
const two = { ...one, parts: [part("s"), part("x", "failed"), part("t")] };
assert.deepEqual(
  recordingSources(two, (id) => `/f/${id}`, (p) => `/cc?part=${p}`).map((s) => s.captions),
  ["/cc?part=s", "/cc?part=t"],
);

// showCaptions: only our captions track; another (hls.js's own, a chapters track) is left.
const ours = { kind: "captions", label: CAPTIONS_LABEL, mode: "disabled" };
const theirs = { kind: "captions", label: "English (CC1)", mode: "disabled" };
const chapters = { kind: "chapters", label: CAPTIONS_LABEL, mode: "disabled" };
const tracks = Object.assign([ours, theirs, chapters], {});
const video = { textTracks: tracks } as unknown as HTMLVideoElement;
showCaptions(video, true);
assert.equal(ours.mode, "showing");
assert.equal(theirs.mode, "disabled");
assert.equal(chapters.mode, "disabled");
showCaptions(video, false);
assert.equal(ours.mode, "hidden");
showCaptions(null, true); // no element yet: nothing to do

console.log("caption-track: ok");
