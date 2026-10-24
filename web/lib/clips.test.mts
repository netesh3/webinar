/* node --experimental-strip-types --no-warnings lib/clips.test.mts */
import assert from "node:assert/strict";
import type { Clip } from "./api-types.ts";
import { clipBadge, clipsPending, formatLabel, postText, rangesLength, reelProblem, sizeText, waitingText } from "./clips.ts";

// A post as pasted: title, text, hashtags.
assert.equal(
  postText({ platform: "youtube_shorts", title: "Pay yourself first", text: "One rule.", hashtags: ["Shorts", "money"] }),
  "Pay yourself first\n\nOne rule.\n\n#Shorts #money",
);
assert.equal(postText({ platform: "tiktok", text: "Just this", hashtags: [] }), "Just this");

// Reels follow the server's rules.
assert.equal(reelProblem([{ startSec: 0, endSec: 15 }]), "A reel stitches 2 to 4 moments.");
assert.equal(
  reelProblem([
    { startSec: 0, endSec: 15 },
    { startSec: 30, endSec: 31 },
  ]),
  "Each moment of a reel has to be 2 to 30 seconds long.",
);
assert.equal(
  reelProblem([
    { startSec: 0, endSec: 3 },
    { startSec: 30, endSec: 33 },
  ]),
  "A reel has to be 10 to 90 seconds long in all (30 to 60 works best).",
);
assert.equal(
  reelProblem([
    { startSec: 0, endSec: 15 },
    { startSec: 30, endSec: 50 },
  ]),
  null,
);
assert.equal(rangesLength([{ startSec: 0, endSec: 15 }, { startSec: 30, endSec: 50 }]), 35);

const clip = (status: string, progress = 0) => ({ status, progress }) as Clip;
assert.deepEqual(clipBadge(clip("queued")), { text: "Waiting", tone: "neutral" });
assert.deepEqual(clipBadge(clip("processing", 40)), { text: "Making… 40%", tone: "brand" });
assert.deepEqual(clipBadge(clip("ready")), { text: "Ready", tone: "ok" });
assert.equal(clipsPending([clip("ready"), clip("processing")]), true);
assert.equal(clipsPending([clip("ready"), clip("failed")]), false);
const server = { state: "waiting", text: "Waiting for the video server." };
assert.equal(waitingText([clip("queued")], server), "Waiting for the video server.");
assert.equal(waitingText([clip("ready")], server), null);

assert.equal(formatLabel("9x16"), "9:16 vertical");
assert.equal(sizeText(512), "1 KB");
assert.equal(sizeText(12.34 * 1024 * 1024), "12.3 MB");

console.log("clips: ok");
