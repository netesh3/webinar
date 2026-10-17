/* The rejoin decision and the per-webinar media record.
 *
 * Run: node --experimental-strip-types --no-warnings lib/rejoin.test.mts
 */

import assert from "node:assert/strict";
import {
  REJOIN_WINDOW_MS,
  decideArrival,
  hasRejoinIntent,
  setRejoinIntent,
  loadMedia,
  markLeft,
  readPresence,
  recordPresence,
  rejoinEntry,
  saveMedia,
  shouldAutoRejoin,
  type KV,
} from "./rejoin.ts";

function memory(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
  };
}

const T = Date.UTC(2026, 9, 17, 10, 0, 0);
const MIN = 60_000;

// ---- the decision ----

{
  const ls = memory();
  recordPresence("talk", "attendee", T, ls);
  const p = readPresence("talk", ls);

  // A refresh a few seconds later goes straight back in.
  assert.equal(shouldAutoRejoin(p, "talk", T + 5_000), true, "fresh refresh");
  // Right at the edge of the window, still yes; past it, no.
  assert.equal(shouldAutoRejoin(p, "talk", T + REJOIN_WINDOW_MS), true, "edge of window");
  assert.equal(shouldAutoRejoin(p, "talk", T + 31 * MIN), false, "over 30 minutes");
  // Another webinar's record says nothing about this one.
  assert.equal(shouldAutoRejoin(p, "other-talk", T + 5_000), false, "different webinar");
  assert.equal(readPresence("other-talk", ls), null, "presence is per webinar");
  // Nothing recorded.
  assert.equal(shouldAutoRejoin(null, "talk", T), false, "no presence");
  // A small backwards clock step is tolerated; a record far in the future is not.
  assert.equal(shouldAutoRejoin(p, "talk", T - 30_000), true, "small clock skew");
  assert.equal(shouldAutoRejoin(p, "talk", T - 10 * MIN), false, "record from the future");
}

{
  // Leave on purpose: opening the page again, a second later, shows it as normal.
  const ls = memory();
  const ss = memory();
  recordPresence("talk", "stage", T, ls);
  saveMedia("talk", { mic: true, camera: true, sharing: false }, T, ls, ss);
  markLeft("talk", T + 1_000, ls, ss);
  const p = readPresence("talk", ls);
  assert.equal(p?.left, true);
  assert.equal(p?.role, "stage", "the role survives, for the record");
  assert.equal(shouldAutoRejoin(p, "talk", T + 2_000), false, "deliberate leave");
  assert.equal(loadMedia("talk", T + 2_000, ls, ss), null, "leaving forgets the media state");
  // Coming back in later starts a fresh record that rejoins again.
  recordPresence("talk", "stage", T + 5 * MIN, ls);
  assert.equal(shouldAutoRejoin(readPresence("talk", ls), "talk", T + 6 * MIN), true);
}

{
  // Ended is written the same way as a leave, by the room, when the session ends.
  const ls = memory();
  recordPresence("talk", "attendee", T, ls);
  markLeft("talk", T + 1_000, ls, memory());
  assert.equal(shouldAutoRejoin(readPresence("talk", ls), "talk", T + 2_000), false, "ended");
}

{
  // Corrupt storage is nothing stored, never a throw.
  const ls = memory();
  ls.setItem("webcast.rejoin.v1.talk", "{not json");
  assert.equal(readPresence("talk", ls), null);
  ls.setItem("webcast.rejoin.v1.talk", JSON.stringify({ slug: "talk" }));
  assert.equal(readPresence("talk", ls), null, "a record without a time is not presence");
  // No storage at all (blocked, private mode).
  assert.equal(readPresence("talk", null), null);
  recordPresence("talk", "attendee", T, null);
}

// ---- media state ----

{
  // A refresh: this tab's own record.
  const ls = memory();
  const ss = memory();
  saveMedia("talk", { mic: false, camera: true, sharing: true }, T, ls, ss);
  assert.deepEqual(loadMedia("talk", T + 1_000, ls, ss), {
    mic: false,
    camera: true,
    sharing: true,
    at: T,
  });
  // Even a long time later — the tab's own record is the tab's own session.
  assert.equal(loadMedia("talk", T + 3 * 60 * MIN, ls, ss)?.camera, true);
  // Per webinar.
  assert.equal(loadMedia("other-talk", T + 1_000, ls, ss), null);
}

{
  // A reopened link: a new tab, so no sessionStorage, and the browser's record is used
  // only inside the window.
  const ls = memory();
  saveMedia("talk", { mic: true, camera: false, sharing: false }, T, ls, memory());
  const fresh = memory();
  assert.equal(loadMedia("talk", T + 10 * MIN, ls, fresh)?.mic, true, "reopened within window");
  assert.equal(loadMedia("talk", T + 31 * MIN, ls, fresh), null, "reopened too late");
}

{
  // The latest change wins, in both stores.
  const ls = memory();
  const ss = memory();
  saveMedia("talk", { mic: true, camera: true, sharing: false }, T, ls, ss);
  saveMedia("talk", { mic: false, camera: true, sharing: false }, T + 1_000, ls, ss);
  assert.equal(loadMedia("talk", T + 2_000, ls, ss)?.mic, false);
  assert.equal(loadMedia("talk", T + 2_000, ls, memory())?.mic, false);
}

// ---- what a publisher re-enters with ----

{
  const saved = { mic: true, camera: false, sharing: false, at: T };
  assert.deepEqual(rejoinEntry(saved, false), { micEnabled: true, cameraEnabled: false });
  // "Prevent self-unmute": stays muted however they left it.
  assert.deepEqual(rejoinEntry(saved, true), { micEnabled: false, cameraEnabled: false });
  assert.deepEqual(rejoinEntry({ ...saved, mic: false, camera: true }, false), {
    micEnabled: false,
    cameraEnabled: true,
  });
  // Nothing saved: off, the safe default for an unattended rejoin.
  assert.deepEqual(rejoinEntry(null, false), { micEnabled: false, cameraEnabled: false });
}

// ---- how the room page was reached ----

{
  const p = { slug: "talk", at: T, role: "attendee" as const };
  // A refresh inside the window goes straight back in.
  assert.equal(decideArrival(p, "talk", true, T + 5_000), "rejoin");
  // Not a refresh and not the landing page's redirect: the room behaves as it always did.
  assert.equal(decideArrival(p, "talk", false, T + 5_000), "normal");
  // A refresh too late, or for another webinar: normal.
  assert.equal(decideArrival(p, "talk", true, T + 31 * MIN), "normal");
  assert.equal(decideArrival(p, "other-talk", true, T + 5_000), "normal");
  assert.equal(decideArrival(null, "talk", true, T), "normal");
  // A refresh after Leave (or removal, or the end): offer, never auto-join.
  assert.equal(decideArrival({ ...p, left: true }, "talk", true, T + 5_000), "left");
  // Long after leaving, the room page is just the room page again.
  assert.equal(decideArrival({ ...p, left: true }, "talk", true, T + 31 * MIN), "normal");
}

{
  // The landing page's redirect is good for a few seconds, and for that webinar only.
  const ss = memory();
  setRejoinIntent("talk", T, ss);
  assert.equal(hasRejoinIntent("talk", T + 1_000, ss), true);
  assert.equal(hasRejoinIntent("talk", T + 1_000, ss), true, "reading it twice is fine");
  assert.equal(hasRejoinIntent("talk", T + 60_000, ss), false, "stale");
  assert.equal(hasRejoinIntent("other-talk", T + 1_000, ss), false);
}

console.log("rejoin: ok");
