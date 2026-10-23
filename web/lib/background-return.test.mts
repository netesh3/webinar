/* Tests for lib/background-return.ts. Run with `make test-web`. */

import { AWAY_MIN_MS, AwayClock, jumpToLiveOnReturn, pageLeaveNotice } from "./background-return.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
}

{
  const c = new AwayClock(false, 0);
  ok(c.change(true, 1_000) === null, "going hidden reports nothing");
  ok(c.change(false, 1_000 + 60_000) === 60_000, "back after a minute reports a minute away");
  ok(c.change(false, 70_000) === null, "a second 'visible' with no hidden between reports nothing");
}
{
  const c = new AwayClock(false, 0);
  c.change(true, 1_000);
  ok(c.change(false, 1_000 + AWAY_MIN_MS - 1) === null, "a glance shorter than AWAY_MIN_MS is not being away");
  c.change(true, 5_000);
  ok(c.change(false, 5_000 + AWAY_MIN_MS) === AWAY_MIN_MS, "exactly AWAY_MIN_MS counts");
}
{
  const c = new AwayClock(true, 0);
  ok(c.change(false, 10_000) === 10_000, "a page that mounted hidden counts from mount");
}
{
  const c = new AwayClock(false, 0);
  c.change(true, 1_000);
  c.change(true, 9_000);
  ok(c.change(false, 11_000) === 10_000, "repeated hidden events keep the first time");
}

ok(jumpToLiveOnReturn({ latencySec: 180, behindSec: 10 }), "three minutes behind jumps to live");
ok(!jumpToLiveOnReturn({ latencySec: 4, behindSec: 10 }), "a normal live delay is left alone");
ok(!jumpToLiveOnReturn({ latencySec: 10, behindSec: 10 }), "exactly at the threshold is left alone");
ok(!jumpToLiveOnReturn({ latencySec: null, behindSec: 10 }), "unknown latency is left alone");
ok(!jumpToLiveOnReturn({ latencySec: Number.NaN, behindSec: 10 }), "NaN latency is left alone");

{
  const none = { mic: false, camera: false, share: false };
  ok(pageLeaveNotice(none) === null, "nothing was on: no notice");
  ok(
    pageLeaveNotice({ ...none, mic: true }) ===
      "Your microphone was turned off while this page was in the background. Turn it back on when you're ready.",
    "one thing: singular",
    String(pageLeaveNotice({ ...none, mic: true })),
  );
  ok(
    pageLeaveNotice({ ...none, mic: true, camera: true }) ===
      "Your camera and microphone were turned off while this page was in the background. Turn them back on when you're ready.",
    "two things: plural, joined with and",
    String(pageLeaveNotice({ ...none, mic: true, camera: true })),
  );
  ok(
    pageLeaveNotice({ mic: true, camera: true, share: true })?.startsWith("Your camera, microphone and screen share were turned off") === true,
    "three things: a list",
    String(pageLeaveNotice({ mic: true, camera: true, share: true })),
  );
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
