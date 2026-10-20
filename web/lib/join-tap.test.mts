/* Tests for who is asked to tap "Join webinar" (lib/join-tap.ts).
 *
 * Run with `make test-web`. Both directions matter. Not asking somebody who needed it is the
 * bug this exists for: a webinar they can see and not hear. Asking somebody who did not is a
 * screen in front of the webinar for nothing, and a presenter must never be told to join
 * their own room.
 */

import { isAppleTouch, needsJoinTap } from "./join-tap.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
}

const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const DESKTOP_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1";
// An iPad's default user agent since iPadOS 13 is the Mac's.
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";

const attendee = { publisher: false };

{
  ok(
    needsJoinTap({ ...attendee, activated: false, userAgent: ANDROID, maxTouchPoints: 5 }),
    "an attendee who opened the room from a link on Android is asked",
  );
  ok(
    !needsJoinTap({ ...attendee, activated: true, userAgent: ANDROID, maxTouchPoints: 5 }),
    "one who pressed Join now on the webinar's page is not: Chrome already plays the sound",
  );
  ok(
    needsJoinTap({ ...attendee, activated: false, userAgent: DESKTOP_CHROME, maxTouchPoints: 0 }),
    "nor is a laptop exempt: an untouched tab is silent there too",
  );
  ok(
    !needsJoinTap({ ...attendee, activated: true, userAgent: DESKTOP_CHROME, maxTouchPoints: 0 }),
    "and a touched one on a laptop goes straight in",
  );
}

{
  ok(
    needsJoinTap({ ...attendee, activated: true, userAgent: IPHONE, maxTouchPoints: 5 }),
    "an iPhone is asked even after Join now: Safari wants the tap when the sound starts",
  );
  ok(
    needsJoinTap({ ...attendee, activated: true, userAgent: IPHONE_CHROME, maxTouchPoints: 5 }),
    "Chrome on an iPhone is Safari underneath, and is asked too",
  );
  ok(
    needsJoinTap({ ...attendee, activated: true, userAgent: MAC_SAFARI, maxTouchPoints: 5 }),
    "an iPad sending the Mac's user agent is still an iPad",
  );
  ok(
    !needsJoinTap({ ...attendee, activated: true, userAgent: MAC_SAFARI, maxTouchPoints: 0 }),
    "a real Mac is not",
  );
}

{
  ok(
    needsJoinTap({ ...attendee, activated: undefined, userAgent: DESKTOP_CHROME, maxTouchPoints: 0 }),
    "a browser that cannot say whether the tab was touched is asked, to be safe",
  );
}

{
  for (const [userAgent, maxTouchPoints] of [
    [ANDROID, 5],
    [IPHONE, 5],
    [MAC_SAFARI, 5],
    [DESKTOP_CHROME, 0],
  ] as const) {
    for (const activated of [true, false, undefined]) {
      ok(
        !needsJoinTap({ publisher: true, activated, userAgent, maxTouchPoints }),
        `a publisher is never asked (${userAgent.slice(13, 40)}…, activated ${activated})`,
      );
    }
  }
}

{
  ok(isAppleTouch(IPHONE, 0), "an iPhone's user agent says so, touch points or not");
  ok(!isAppleTouch(ANDROID, 5), "an Android phone is not an Apple device");
  ok(!isAppleTouch(MAC_SAFARI, 1), "an iPad is more than one touch point, as in lib/media.ts");
}

if (failures) {
  console.log(`\n${failures} of ${checks} failed`);
  process.exit(1);
}
console.log(`\n${checks} ok`);
