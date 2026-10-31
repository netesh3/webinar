/* play() and Room.startAudio() settle; only real failures are reported (31 Oct 2026).
 *
 * Run: node --experimental-strip-types --no-warnings lib/media-play.test.mts */

import assert from "node:assert/strict";
import { guardStartAudio, isPlaybackRefusal, playMedia } from "./media-play.ts";

// WebKit's message, from the Faro report.
const refused = () =>
  new DOMException(
    "The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.",
    "NotAllowedError",
  );
const aborted = () => new DOMException("The operation was aborted.", "AbortError");
const unsupported = () => new DOMException("No supported source", "NotSupportedError");

// --- isPlaybackRefusal

assert.equal(isPlaybackRefusal(refused()), true);
assert.equal(isPlaybackRefusal(aborted()), true);
assert.equal(isPlaybackRefusal({ name: "NotAllowedError" }), true);
assert.equal(isPlaybackRefusal(unsupported()), false);
assert.equal(isPlaybackRefusal(new Error("boom")), false);
assert.equal(isPlaybackRefusal(undefined), false);
assert.equal(isPlaybackRefusal("NotAllowedError"), false);

// --- playMedia

{
  const reported: unknown[] = [];
  const report = (e: unknown) => reported.push(e);
  assert.equal(await playMedia({ play: async () => {} }, report), "played");
  // Older browsers return undefined from play().
  assert.equal(await playMedia({ play: () => undefined }, report), "played");
  assert.equal(await playMedia({ play: () => Promise.reject(refused()) }, report), "refused");
  assert.equal(await playMedia({ play: () => Promise.reject(aborted()) }, report), "aborted");
  assert.equal(reported.length, 0, "refusals are not reported");

  const err = unsupported();
  assert.equal(await playMedia({ play: () => Promise.reject(err) }, report), "failed");
  // A synchronous throw is settled too.
  assert.equal(
    await playMedia(
      {
        play: () => {
          throw new TypeError("sync");
        },
      },
      report,
    ),
    "failed",
  );
  assert.equal(reported.length, 2, "real failures are reported");
  assert.equal(reported[0], err);
  assert.equal(await playMedia(null, report), "failed");
}

// --- guardStartAudio

{
  // A refusal resolves, quietly. The room's own state (canPlaybackAudio) carries it.
  const reported: unknown[] = [];
  let calls = 0;
  const room = {
    canPlaybackAudio: true,
    startAudio: async function (this: { canPlaybackAudio: boolean }) {
      calls += 1;
      this.canPlaybackAudio = false;
      throw refused();
    },
  };
  const same = guardStartAudio(room, (e) => reported.push(e));
  assert.equal(same, room);
  await room.startAudio(); // does not reject
  assert.equal(calls, 1);
  assert.equal(room.canPlaybackAudio, false, "the original ran with the room as `this`");
  assert.equal(reported.length, 0);

  // livekit-client's own un-awaited call: no unhandled rejection.
  let unhandled = 0;
  const onUnhandled = () => {
    unhandled += 1;
  };
  process.on("unhandledRejection", onUnhandled);
  void room.startAudio();
  await new Promise((r) => setTimeout(r, 10));
  process.off("unhandledRejection", onUnhandled);
  assert.equal(unhandled, 0);

  // Guarding twice does not wrap twice.
  guardStartAudio(room, (e) => reported.push(e));
  await room.startAudio();
  assert.equal(calls, 3);
}
{
  // Anything else is reported, and still resolves.
  const reported: unknown[] = [];
  const err = new Error("engine closed");
  const room = {
    startAudio: async () => {
      throw err;
    },
  };
  guardStartAudio(room, (e) => reported.push(e));
  await room.startAudio();
  assert.deepEqual(reported, [err]);
}
{
  // Success passes through.
  let ran = false;
  const room = {
    startAudio: async () => {
      ran = true;
    },
  };
  guardStartAudio(room, () => assert.fail("nothing to report"));
  await room.startAudio();
  assert.equal(ran, true);
}

console.log("media-play: ok");
