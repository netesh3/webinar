/* Tests for the publish ledger.
 *
 * Run with `make test-web`. What is being tested is a decision about somebody's camera and
 * microphone, made at the one moment nobody is watching the screen it affects: a presenter
 * whose connection just dropped. Both directions are worth guarding.
 *
 * Restoring too little is the bug this ledger was written for — a host reconnected into a
 * room publishing nothing, with a working local preview and no way to tell the audience had
 * lost them.
 *
 * Restoring too much is worse, and is the reason the tests below outnumber the code. Putting
 * back a screen share the presenter had stopped means republishing their desktop without
 * them asking, and "the network hiccuped" is not an acceptable reason for that to happen.
 */

import {
  publishLedger,
  CAMERA,
  MICROPHONE,
  SCREEN_SHARE,
  SCREEN_SHARE_AUDIO,
} from "./republish.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
}

function eq<T>(actual: T, expected: T, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, what, a === e ? "" : `got ${a}\n        want ${e}`);
}

/** A stand-in for a LocalTrack. `live` is what isCapturing reads. */
type FakeTrack = { id: string; live: boolean };
const track = (id: string, live = true): FakeTrack => ({ id, live });
const isCapturing = (t: FakeTrack) => t.live;

/** The sources that would go back up, in order. */
function plan(ledger: ReturnType<typeof publishLedger<FakeTrack>>): string[] {
  return ledger.restorable(isCapturing).map((r) => r.source);
}

console.log("\nwhat a recovery puts back");

{
  const ledger = publishLedger<FakeTrack>();
  eq(plan(ledger), [], "a session that published nothing restores nothing");

  ledger.published(MICROPHONE, track("mic"));
  ledger.published(CAMERA, track("cam"));
  eq(plan(ledger), [MICROPHONE, CAMERA], "what was published comes back");

  // The voice first: it is what an audience misses most, and the share is the heaviest
  // thing to negotiate so it must not delay it.
  const shares = publishLedger<FakeTrack>();
  shares.published(SCREEN_SHARE_AUDIO, track("share-audio"));
  shares.published(SCREEN_SHARE, track("share"));
  shares.published(CAMERA, track("cam"));
  shares.published(MICROPHONE, track("mic"));
  eq(
    plan(shares),
    [MICROPHONE, CAMERA, SCREEN_SHARE, SCREEN_SHARE_AUDIO],
    "restoration is ordered by what matters, not by when it was published",
  );
}

{
  const ledger = publishLedger<FakeTrack>();
  ledger.published("unknown", track("mystery"));
  eq(plan(ledger), [], "a source the ledger has no opinion about is never restored");
}

{
  // A device switch republishes on the same source. Keying by source rather than by track
  // is what stops recovery putting back the camera somebody switched away from.
  const ledger = publishLedger<FakeTrack>();
  ledger.published(CAMERA, track("built-in"));
  ledger.published(CAMERA, track("external"));
  const back = ledger.restorable(isCapturing);
  eq(back.length, 1, "switching camera leaves one entry, not two");
  eq(back[0]?.track.id, "external", "and it is the camera in use, not the one replaced");
}

console.log("\nthe capture behind the track");

{
  const ledger = publishLedger<FakeTrack>();
  ledger.published(MICROPHONE, track("mic"));
  // Muting a camera stops its capture to put the indicator light out, so an "off" camera
  // arrives here as an ended track. Skipping it is what makes "off" survive a reconnect.
  ledger.published(CAMERA, track("cam", false));
  eq(plan(ledger), [MICROPHONE], "a camera that was turned off does not come back on");

  const gone = publishLedger<FakeTrack>();
  gone.published(SCREEN_SHARE, track("share", false));
  eq(plan(gone), [], "a share stopped from the browser's own bar is not republished");
}

console.log("\ntelling a drop apart from the presenter");

{
  /* The case this whole flag exists for. LiveKit's teardown unpublishes every local track
   * on the way out, while room.state is still Connected — so a drop is indistinguishable
   * from somebody switching everything off, unless the ledger is told a drop has begun. */
  const ledger = publishLedger<FakeTrack>();
  const mic = track("mic");
  const cam = track("cam");
  ledger.published(MICROPHONE, mic);
  ledger.published(CAMERA, cam);

  ledger.dropping();
  ledger.unpublished(MICROPHONE);
  ledger.unpublished(CAMERA);

  eq(
    plan(ledger),
    [MICROPHONE, CAMERA],
    "the teardown's own unpublications do not empty the ledger",
  );
}

{
  // The other direction, and the one that must never break: something the presenter
  // deliberately stopped stays stopped.
  const ledger = publishLedger<FakeTrack>();
  ledger.published(MICROPHONE, track("mic"));
  ledger.published(SCREEN_SHARE, track("share"));
  ledger.unpublished(SCREEN_SHARE);
  eq(plan(ledger), [MICROPHONE], "a share the presenter stopped is not restored");
}

{
  const ledger = publishLedger<FakeTrack>();
  ledger.published(SCREEN_SHARE, track("share"));

  ok(!ledger.isDropping(), "a healthy session is not dropping");
  ledger.dropping();
  ok(ledger.isDropping(), "a drop is noted");
  ledger.settled();
  ok(!ledger.isDropping(), "and cleared once the room is back");

  // After settling, an unpublication is the presenter again. Without this a single drop
  // would make the ledger permanently deaf and every later stop would be undone by the
  // next one.
  ledger.unpublished(SCREEN_SHARE);
  eq(plan(ledger), [], "stopping a share after recovery still stops it");
}

{
  // Restoring publishes, which fires LocalTrackPublished, which writes to the ledger
  // again. That has to be a no-op rather than a duplicate.
  const ledger = publishLedger<FakeTrack>();
  const mic = track("mic");
  ledger.published(MICROPHONE, mic);
  ledger.dropping();
  for (const entry of ledger.restorable(isCapturing)) {
    ledger.published(entry.source, entry.track);
  }
  ledger.settled();
  eq(plan(ledger), [MICROPHONE], "restoring is idempotent");
}

if (failures) {
  console.log(`\n${failures} of ${checks} failed`);
  process.exit(1);
}
console.log(`\n${checks} ok`);
