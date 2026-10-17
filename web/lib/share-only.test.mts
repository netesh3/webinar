/* Tests for "Show only the shared video to the audience": lib/share-only.ts.
 *
 * Run with node --experimental-strip-types (no runner — the same harness as
 * layout.test.mts). The cases are the whole decision table: the flag, whether a
 * share is on the stage, and who is looking — and what each combination
 * downloads.
 */

import {
  bannerText,
  FULL_PLAN,
  shareOnlyView,
  subscriptionPlan,
  viewerOf,
  wantsSource,
  type ShareOnlyInput,
  type Viewer,
} from "./share-only.ts";

let failures = 0;
let checks = 0;

function eq<T>(actual: T, expected: T, what: string): void {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failures++;
  console.log(`  FAIL  ${what}\n        expected ${e}, got ${a}`);
}

function group(name: string, body: () => void): void {
  console.log(name);
  body();
}

const input = (over: Partial<ShareOnlyInput>): ShareOnlyInput => ({
  shareOnly: true,
  muteStage: true,
  shareActive: true,
  viewer: "audience",
  ...over,
});

group("viewerOf: who counts as the stage", () => {
  eq(viewerOf({ isHost: true, canPresent: false }), "stage", "host (or co-host) before permissions land");
  eq(viewerOf({ isHost: false, canPresent: true }), "stage", "panelist or promoted attendee");
  eq(viewerOf({ isHost: false, canPresent: false }), "audience", "attendee");
});

group("shareOnlyView: flag × share × viewer", () => {
  for (const shareOnly of [false, true]) {
    for (const shareActive of [false, true]) {
      for (const viewer of ["audience", "stage"] as Viewer[]) {
        const want = shareOnly && shareActive && viewer === "audience";
        eq(
          shareOnlyView(input({ shareOnly, shareActive, viewer })),
          want,
          `shareOnly=${shareOnly} shareActive=${shareActive} viewer=${viewer}`,
        );
      }
    }
  }
  eq(
    shareOnlyView(input({ shareActive: false })),
    false,
    "never a blank screen: no share means the normal stage",
  );
});

group("subscriptionPlan", () => {
  eq(subscriptionPlan(input({})), { cameras: false, microphones: false }, "on, stage muted");
  eq(
    subscriptionPlan(input({ muteStage: false })),
    { cameras: false, microphones: true },
    "on, stage audible: the coach can talk over the clip",
  );
  eq(subscriptionPlan(input({ shareOnly: false })), FULL_PLAN, "off: everything");
  eq(
    subscriptionPlan(input({ shareOnly: false, muteStage: true })),
    FULL_PLAN,
    "mute alone does nothing without share-only",
  );
  eq(subscriptionPlan(input({ shareActive: false })), FULL_PLAN, "no share: resubscribe");
  eq(subscriptionPlan(input({ viewer: "stage" })), FULL_PLAN, "the stage hears and sees itself");
});

group("wantsSource", () => {
  const muted = subscriptionPlan(input({}));
  eq(wantsSource("camera", muted), false, "camera off");
  eq(wantsSource("microphone", muted), false, "stage mic off");
  eq(wantsSource("screen_share", muted), true, "share stays");
  eq(wantsSource("screen_share_audio", muted), true, "the video's own sound stays");
  eq(wantsSource("unknown", muted), true, "unknown sources are left alone");
  const audible = subscriptionPlan(input({ muteStage: false }));
  eq(wantsSource("microphone", audible), true, "stage mic stays when not muted");
  eq(wantsSource("camera", FULL_PLAN), true, "camera back when off");
});

group("bannerText", () => {
  eq(bannerText({ muteStage: true, shareActive: true }).includes("muted"), true, "says the mics are muted");
  eq(bannerText({ muteStage: false, shareActive: true }), "Audience sees only the shared video", "plain");
  eq(bannerText({ muteStage: true, shareActive: false }).includes("see the stage"), true, "no share yet");
});

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`,
);
process.exit(failures === 0 ? 0 : 1);
