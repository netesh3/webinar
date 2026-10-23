/* Tests for the host team's camera choice for a simulive's live part. Run with `make test-web`. */

import assert from "node:assert/strict";
import {
  GO_LIVE_CHOICE_TTL_MS,
  goLiveEntry,
  goLiveSummary,
  parseGoLiveChoice,
  peekGoLiveChoice,
  saveGoLiveChoice,
  takeGoLiveChoice,
} from "./simulive-golive.ts";

const now = Date.parse("2026-10-23T10:00:00Z");

// ---- parsing: only a well-formed, recent choice counts
assert.equal(parseGoLiveChoice(null, now), null);
assert.equal(parseGoLiveChoice("not json", now), null);
assert.equal(parseGoLiveChoice("[]", now), null);
assert.equal(parseGoLiveChoice(JSON.stringify({ camera: "yes", mic: false, at: now }), now), null);
assert.deepEqual(parseGoLiveChoice(JSON.stringify({ camera: true, mic: false, at: now }), now), {
  camera: true,
  mic: false,
  at: now,
});
assert.equal(
  parseGoLiveChoice(JSON.stringify({ camera: true, mic: true, at: now - GO_LIVE_CHOICE_TTL_MS - 1 }), now),
  null,
  "a stale choice from another session is not obeyed",
);
assert.equal(
  parseGoLiveChoice(JSON.stringify({ camera: true, mic: true, at: now + 5 * 60_000 }), now),
  null,
  "a choice from the future is not trusted",
);

// ---- the live room's entry: no choice is both off; a host mute beats the microphone
assert.deepEqual(goLiveEntry(null, false), { cameraEnabled: false, micEnabled: false });
assert.deepEqual(goLiveEntry({ camera: true, mic: true, at: now }, false), { cameraEnabled: true, micEnabled: true });
assert.deepEqual(goLiveEntry({ camera: true, mic: true, at: now }, true), { cameraEnabled: true, micEnabled: false });
assert.deepEqual(goLiveEntry({ camera: false, mic: true, at: now }, false), { cameraEnabled: false, micEnabled: true });

// ---- the summary says what will happen
assert.match(goLiveSummary(null), /camera and mic off/);
assert.match(goLiveSummary({ camera: false, mic: false }), /camera and mic off/);
assert.match(goLiveSummary({ camera: true, mic: false }), /camera on, mic off/);
assert.match(goLiveSummary({ camera: true, mic: true }), /camera on, mic on/);

// ---- storage: saved per session, peeked by the simulive room, taken once by the live room
const store = new Map<string, string>();
const kv = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
saveGoLiveChoice("abc", { camera: true, mic: false }, now, kv);
assert.deepEqual(peekGoLiveChoice("abc", now, kv), { camera: true, mic: false, at: now });
assert.equal(peekGoLiveChoice("other", now, kv), null, "per session");
assert.deepEqual(takeGoLiveChoice("abc", now + 1000, kv), { camera: true, mic: false, at: now });
assert.equal(takeGoLiveChoice("abc", now + 2000, kv), null, "taken once");
// No storage at all: no choice, no throw.
saveGoLiveChoice("abc", { camera: true, mic: true }, now, null);
assert.equal(takeGoLiveChoice("abc", now, null), null);

console.log("simulive-golive ok");
