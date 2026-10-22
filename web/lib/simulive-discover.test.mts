/* Tests for making simulive findable: the cross-session recording picker, which ended session
 * gets the "run this again" card, its per-session dismissal, and the explainer's premium tag.
 * Run with `make test-web`. */

import assert from "node:assert/strict";
import type { Recording } from "./api-types.ts";
import {
  autopilotDismissKey,
  autopilotRecording,
  dismissAutopilot,
  firstPlayablePart,
  isAutopilotDismissed,
  simuliveExplainer,
  simuliveLibrary,
  type KeyStore,
} from "./simulive-discover.ts";

function rec(over: Partial<Recording>): Recording {
  return {
    id: "rec-1",
    webinar: "original-session",
    topic: "Original session",
    status: "ready",
    mime: "video/mp4",
    sizeBytes: 1000,
    durationMs: 45 * 60_000,
    startedBy: "Coach Asha",
    createdAt: "2026-10-01T10:00:00Z",
    ext: "mp4",
    isPublic: false,
    passcodeRequired: false,
    uploadedToS3: true,
    uploadPercent: 100,
    retentionDays: 0,
    ...over,
  };
}

// Library: ready recordings from any session, newest first, each once.
const lib = simuliveLibrary([
  rec({ id: "old", webinar: "a", createdAt: "2026-09-01T10:00:00Z" }),
  rec({ id: "new", webinar: "b", createdAt: "2026-10-20T10:00:00Z" }),
  rec({ id: "busy", webinar: "c", status: "processing", createdAt: "2026-10-21T10:00:00Z" }),
  rec({ id: "empty", webinar: "c", sizeBytes: 0, createdAt: "2026-10-21T11:00:00Z" }),
  rec({ id: "failed", webinar: "d", status: "failed" }),
  rec({ id: "mid", webinar: "a", createdAt: "2026-10-05T10:00:00Z" }),
  rec({ id: "new", webinar: "b", createdAt: "2026-10-20T10:00:00Z" }),
  rec({ id: "nodate", createdAt: "" }),
]);
assert.deepEqual(
  lib.map((r) => r.id),
  ["new", "mid", "old", "nodate"],
);
assert.deepEqual(simuliveLibrary(null), []);
assert.deepEqual(simuliveLibrary(undefined), []);
// Same instant keeps the server's order.
assert.deepEqual(
  simuliveLibrary([rec({ id: "x" }), rec({ id: "y" })]).map((r) => r.id),
  ["x", "y"],
);

// Thumbnail take: the first stored part, else the recording.
assert.equal(firstPlayablePart({ id: "r" }), "r");
assert.equal(
  firstPlayablePart({
    id: "r",
    parts: [rec({ id: "p0", status: "failed" }), rec({ id: "p1" })] as Recording["parts"],
  }),
  "p1",
);

// The Results card: ended, the viewer's own, not a simulive, with a ready recording.
const host = { id: "h1", canHost: true, features: ["simulive", "cloud_recording"] };
const ended = { status: "ended" as const, kind: "live" as const, host: { id: "h1" } };
const recs = [
  rec({ id: "first", createdAt: "2026-10-22T09:00:00Z" }),
  rec({ id: "second", createdAt: "2026-10-22T10:00:00Z" }),
];
assert.equal(autopilotRecording(ended, recs, host)?.id, "second");
assert.equal(autopilotRecording({ ...ended, status: "live" }, recs, host), null);
assert.equal(autopilotRecording({ ...ended, status: "scheduled" }, recs, host), null);
assert.equal(autopilotRecording({ ...ended, kind: "simulive" }, recs, host), null);
assert.equal(autopilotRecording(ended, recs, { id: "cohost", canHost: true }), null);
assert.equal(autopilotRecording(ended, recs, { id: "h1", canHost: false }), null);
assert.equal(autopilotRecording(ended, recs, null), null);
// No card for an account without the simulive switch, cloud recording or not.
assert.equal(autopilotRecording(ended, recs, { ...host, features: ["cloud_recording"] }), null);
assert.equal(autopilotRecording(ended, recs, { id: "h1", canHost: true }), null);
assert.equal(autopilotRecording(ended, [], host), null);
assert.equal(autopilotRecording(ended, [rec({ status: "processing" })], host), null);
// A meeting's recording qualifies (the simulive made from it is a webinar).
assert.equal(autopilotRecording({ ...ended, kind: "meeting" }, recs, host)?.id, "second");

// Dismissal: per session, and a throwing store neither hides the card nor throws.
const data = new Map<string, string>();
const store: KeyStore = {
  getItem: (k) => data.get(k) ?? null,
  setItem: (k, v) => void data.set(k, v),
};
assert.equal(isAutopilotDismissed(store, "s1"), false);
dismissAutopilot(store, "s1");
assert.equal(isAutopilotDismissed(store, "s1"), true);
assert.equal(isAutopilotDismissed(store, "s2"), false);
assert.equal(data.get(autopilotDismissKey("s1")), "1");
assert.notEqual(autopilotDismissKey("s1"), autopilotDismissKey("s2"));
assert.equal(isAutopilotDismissed(null, "s1"), false);
assert.equal(isAutopilotDismissed(store, ""), false);
const broken: KeyStore = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};
assert.equal(isAutopilotDismissed(broken, "s1"), false);
assert.doesNotThrow(() => dismissAutopilot(broken, "s1"));
assert.doesNotThrow(() => dismissAutopilot(undefined, "s1"));

// Explainer: four points; only engagement replay is premium, and only without the feature.
const without = simuliveExplainer(false);
assert.equal(without.length, 4);
assert.deepEqual(
  without.map((p) => p.premium),
  [false, false, true, false],
);
assert.ok(without[2]!.text.includes("chat, Q&A and polls"));
assert.ok(simuliveExplainer(true).every((p) => !p.premium));
assert.ok(without.some((p) => p.text.includes("never re-recorded")));

console.log("simulive-discover: ok");
