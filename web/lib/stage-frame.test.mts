/* Where the stage sits, and the box a stage <video> player fills inside it.
 *
 * Run with `make test-web`.
 *
 * The bug this guards: the CDN / edge player's flex-1 box had no min-h-0, so a
 * 16:9 <video> at a 1660px-wide stage took its 933px content height, ran past
 * the stage under the control bar, and took the bottom of the picture and the
 * native caption track with it. A browser shows that only at a real size; a
 * class string losing one token is what this checks instead.
 */

import {
  COMPACT_STAGE_HEIGHT,
  DOCKED_PANEL_WIDTH,
  STAGE_PLAYER_FRAME,
  stageFrame,
} from "./compact.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
}

console.log("\nSTAGE_PLAYER_FRAME");
{
  const classes = new Set(STAGE_PLAYER_FRAME.split(/\s+/));
  ok(classes.has("flex-1"), "fills the stage column");
  ok(classes.has("min-h-0"), "min-h-0: the video's content height cannot grow it past the stage");
  ok(classes.has("min-w-0"), "min-w-0: nor its content width");
  ok(classes.has("overflow-hidden"), "nothing paints under the control bar");
  ok(classes.has("relative"), "a containing block for the player's overlays");
}

console.log("\nstageFrame");
{
  ok(JSON.stringify(stageFrame(false, false)) === JSON.stringify({ bottom: 0 }),
    "desktop, no panel: down to the control bar");
  ok(JSON.stringify(stageFrame(true, false)) === JSON.stringify({ bottom: 0 }),
    "phone, no panel: down to the control bar");
  ok(JSON.stringify(stageFrame(false, true)) ===
    JSON.stringify({ bottom: 0, right: DOCKED_PANEL_WIDTH }),
    "desktop, panel: down to the control bar, beside the panel");
  const phone = stageFrame(true, true);
  ok(phone.height === COMPACT_STAGE_HEIGHT && phone.bottom === undefined,
    "phone, panel: a fixed strip, the panel below it");
}

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`,
);
process.exit(failures === 0 ? 0 : 1);
