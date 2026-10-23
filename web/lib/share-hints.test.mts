/* Tests for lib/share-hints.ts — the share picker's hints and the tips around it.
 *
 * Run with `make test-web` (node --experimental-strip-types, no runner).
 */

import {
  chromiumMajor,
  displayMediaHints,
  shareStartOffer,
  shouldShowShareTip,
} from "./share-hints.ts";

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

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const FIREFOX_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0";
const IOS_CHROME_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1";

console.log("\nchromiumMajor");
eq(chromiumMajor({ userAgent: CHROME_UA }), 141, "Chrome from the UA string");
eq(
  chromiumMajor({
    userAgent: CHROME_UA,
    brands: [
      { brand: "Microsoft Edge", version: "140" },
      { brand: "Chromium", version: "140" },
    ],
  }),
  140,
  "client hints win over the UA string",
);
eq(chromiumMajor({ userAgent: SAFARI_UA }), null, "Safari is not Chromium");
eq(chromiumMajor({ userAgent: FIREFOX_UA }), null, "Firefox is not Chromium");
eq(chromiumMajor({ userAgent: IOS_CHROME_UA }), null, "Chrome on iOS is WebKit");
eq(chromiumMajor({}), null, "nothing to go on");

console.log("\ndisplayMediaHints");
eq(
  displayMediaHints(141),
  {
    preferCurrentTab: false,
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    systemAudio: "include",
    monitorTypeSurfaces: "include",
  },
  "a current Chrome gets every hint",
);
eq(
  displayMediaHints(110),
  {
    preferCurrentTab: false,
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    systemAudio: "include",
  },
  "Chrome 110 has no monitorTypeSurfaces yet",
);
eq(displayMediaHints(100), { preferCurrentTab: false }, "Chrome 100: only preferCurrentTab");
eq(displayMediaHints(90), {}, "an old Chrome gets none");
eq(displayMediaHints(null), {}, "Safari and Firefox get none");
eq(
  (displayMediaHints(141) as { preferCurrentTab?: boolean }).preferCurrentTab !== true,
  true,
  "never preferCurrentTab: true beside selfBrowserSurface exclude",
);

console.log("\nshouldShowShareTip");
eq(shouldShowShareTip(null), true, "never seen");
eq(shouldShowShareTip("1"), false, "seen before");
eq(shouldShowShareTip("0"), true, "anything else is not seen");

console.log("\nshareStartOffer");
const yes = { miniSupported: true, miniOpen: false };
eq(shareStartOffer("monitor", yes), { kind: "suggest-mini" }, "entire screen: suggest the mini controls");
eq(
  shareStartOffer("monitor", { miniSupported: true, miniOpen: true }),
  { kind: "none" },
  "entire screen with the mini controls already open: nothing",
);
eq(
  shareStartOffer("monitor", { miniSupported: false, miniOpen: false }),
  { kind: "suggest-window" },
  "entire screen without Document PiP: suggest a window or tab",
);
eq(shareStartOffer("browser", yes), { kind: "open-mini" }, "a tab: open the mini controls");
eq(
  shareStartOffer("browser", { miniSupported: true, miniOpen: true }),
  { kind: "none" },
  "a tab with them already open",
);
eq(
  shareStartOffer("browser", { miniSupported: false, miniOpen: false }),
  { kind: "none" },
  "a tab without Document PiP",
);
eq(shareStartOffer("window", yes), { kind: "none" }, "a window has the presenter window");
eq(shareStartOffer(null, yes), { kind: "none" }, "a browser that does not say");

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`,
);
process.exit(failures === 0 ? 0 : 1);
