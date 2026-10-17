/* Tests for the presenter's own-share facts: lib/own-share.ts.
 *
 * Run with `make test-web` (node --experimental-strip-types, no runner). Only the pure
 * parts — which surface a capture is, who gets the presenter view, the timer's format.
 * The one that matters most is wantsPresenterView: answering "monitor" wrongly would play
 * the entire screen back to itself, which the audience then receives too.
 */

import { formatElapsed, shareSurface, wantsPresenterView } from "./own-share-surface.ts";

let failures = 0;
let checks = 0;

function eq<T>(actual: T, expected: T, what: string): void {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failures++;
  console.log(`  FAIL  ${what}\n        got ${a}\n        want ${e}`);
}

const track = (displaySurface?: string) =>
  ({ getSettings: () => (displaySurface ? { displaySurface } : {}) }) as unknown as MediaStreamTrack;

console.log("\nshareSurface");
eq(shareSurface(track("window")), "window", "a window");
eq(shareSurface(track("monitor")), "monitor", "the entire screen");
eq(shareSurface(track("browser")), "browser", "a tab");
eq(shareSurface(track()), null, "a browser that does not say");
eq(shareSurface(track("application")), null, "an old value we do not know");
eq(shareSurface(null), null, "no track");

console.log("\nwantsPresenterView");
eq(wantsPresenterView("window"), true, "a window gets the presenter view");
eq(wantsPresenterView("monitor"), true, "the entire screen gets it");
eq(wantsPresenterView("browser"), false, "a tab is left to Chrome");
eq(wantsPresenterView(null), false, "unknown is left alone rather than guessed");

console.log("\nformatElapsed");
eq(formatElapsed(0), "0:00", "zero");
eq(formatElapsed(7_400), "0:07", "seconds");
eq(formatElapsed(134_000), "2:14", "minutes");
eq(formatElapsed(3_789_000), "1:03:09", "hours");
eq(formatElapsed(-5_000), "0:00", "a clock that went backwards");

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`,
);
process.exit(failures === 0 ? 0 : 1);
