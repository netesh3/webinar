/* A simulive's shared clock: when the player is put back, when it resumes, and which
 * controls a simulive shows next to a recording replay.
 *
 * Run: node --experimental-strip-types --no-warnings lib/simulive-clock.test.mts */

import assert from "node:assert/strict";
import {
  playerControls,
  simuliveCorrection,
  SIMULIVE_BLOCKED_KEYS,
  type ClockReading,
} from "./simulive-clock.ts";

const at = (over: Partial<ClockReading>): ClockReading => ({
  positionSec: 100,
  sharedSec: 100,
  durationSec: 3600,
  paused: false,
  ended: false,
  blocked: false,
  ...over,
});

// On the clock, playing: nothing to do. Within the tolerance either way: still nothing.
assert.deepEqual(simuliveCorrection(at({})), { seekTo: null, resume: false });
assert.deepEqual(simuliveCorrection(at({ positionSec: 101.9 })), { seekTo: null, resume: false });
assert.deepEqual(simuliveCorrection(at({ positionSec: 98.1 })), { seekTo: null, resume: false });

// Seeked back (arrow keys, the OS card) or ahead: snapped to the shared position.
assert.deepEqual(simuliveCorrection(at({ positionSec: 40 })), { seekTo: 100, resume: false });
assert.deepEqual(simuliveCorrection(at({ positionSec: 400 })), { seekTo: 100, resume: false });
// A throttled tab that fell behind: caught up.
assert.equal(simuliveCorrection(at({ positionSec: 90, sharedSec: 130 })).seekTo, 130);

// Paused by the browser or the OS: resumed. Refused autoplay: waits for the tap instead.
assert.deepEqual(simuliveCorrection(at({ paused: true })), { seekTo: null, resume: true });
assert.deepEqual(simuliveCorrection(at({ paused: true, blocked: true })), { seekTo: null, resume: false });
// Paused AND seeked away: both.
assert.deepEqual(simuliveCorrection(at({ paused: true, positionSec: 5 })), { seekTo: 100, resume: true });
// Skipped to the end while the session is mid-way: back, and playing.
assert.deepEqual(simuliveCorrection(at({ positionSec: 3600, ended: true })), { seekTo: 100, resume: true });

// Before the session starts there is no clock: leave the player alone.
assert.deepEqual(simuliveCorrection(at({ sharedSec: null, paused: true })), { seekTo: null, resume: false });

// Duration not known yet (HLS loading): the shared position is still the target.
assert.equal(simuliveCorrection(at({ durationSec: NaN, positionSec: 0 })).seekTo, 100);

// Past the end of the recording: everybody is at the end, nothing resumes.
assert.deepEqual(
  simuliveCorrection(at({ sharedSec: 4000, positionSec: 3600, ended: true, paused: true })),
  { seekTo: null, resume: false },
);
assert.deepEqual(simuliveCorrection(at({ sharedSec: 4000, positionSec: 10 })), {
  seekTo: 3599.5,
  resume: false,
});

// Controls: a recording replay keeps everything; a simulive and a live stage only sound,
// captions, fullscreen and the Live badge.
const vod = playerControls("vod", true);
assert.ok(vod.playPause && vod.seekBar && vod.time && vod.playbackRate && vod.skip && vod.fullscreen);
assert.equal(vod.liveBadge, false);
for (const kind of ["simulive", "live"] as const) {
  const c = playerControls(kind, true);
  assert.deepEqual(
    [c.playPause, c.seekBar, c.time, c.playbackRate, c.skip],
    [false, false, false, false, false],
    kind,
  );
  assert.ok(c.volume && c.captions && c.fullscreen && c.liveBadge, kind);
}
// iPhone (no element fullscreen): a simulive hides the button rather than open the native
// player with its scrubber; a live stage keeps it (nowhere to seek on a live stream).
assert.equal(playerControls("simulive", false).fullscreen, false);
assert.equal(playerControls("live", false).fullscreen, true);

for (const key of ["ArrowLeft", "ArrowRight", " ", "k", "MediaTrackNext"]) {
  assert.ok(SIMULIVE_BLOCKED_KEYS.has(key), key);
}
assert.ok(!SIMULIVE_BLOCKED_KEYS.has("m"));

console.log("simulive-clock: ok");
