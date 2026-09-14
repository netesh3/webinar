/* Tests for the virtual-background catalogue.
 *
 * Run with `make test-web`.
 *
 * Preferences are persisted as JSON, so an old `{ mode: "image", id: "aurora" }`
 * still sits in some browsers. The compositor must never see an id it cannot
 * load — that is a black frame with no UI to explain it.
 */

import {
  asBackgroundChoice,
  describeBackground,
  VIRTUAL_BACKGROUNDS,
} from "./backgrounds.ts";

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

console.log("\nVIRTUAL_BACKGROUNDS");

{
  ok(VIRTUAL_BACKGROUNDS.length >= 1, "there is at least one still to pick");
  const ids = new Set(VIRTUAL_BACKGROUNDS.map((b) => b.id));
  ok(ids.size === VIRTUAL_BACKGROUNDS.length, "ids are unique");
  for (const b of VIRTUAL_BACKGROUNDS) {
    ok(b.src.startsWith("/backgrounds/"), `${b.id} is served from this origin`);
  }
}

console.log("\nasBackgroundChoice");

{
  eq(asBackgroundChoice({ mode: "none" }), { mode: "none" }, "off stays off");
  eq(asBackgroundChoice({ mode: "blur" }), { mode: "blur" }, "blur stays blur");
  eq(
    asBackgroundChoice({ mode: "image", id: "office" }),
    { mode: "image", id: "office" },
    "a known still is kept",
  );
  eq(
    asBackgroundChoice({ mode: "image", id: "aurora" }),
    { mode: "blur" },
    "an old still that no longer ships becomes blur, not off",
  );
  eq(
    asBackgroundChoice({ mode: "image" }),
    { mode: "blur" },
    "image without an id also becomes blur",
  );
  eq(
    asBackgroundChoice({ mode: "solid", color: "#000" }),
    { mode: "blur" },
    "a retired mode that hid the room still hides it",
  );
  eq(asBackgroundChoice(undefined), { mode: "none" }, "missing prefs are off");
  eq(asBackgroundChoice(null), { mode: "none" }, "null prefs are off");
}

console.log("\ndescribeBackground");

{
  eq(describeBackground({ mode: "none" }), "Off", "off");
  eq(describeBackground({ mode: "blur" }), "Blurred", "blur");
  eq(
    describeBackground({ mode: "image", id: "office" }),
    "Office",
    "a still uses its label",
  );
}

if (failures) {
  console.log(`\n${failures} of ${checks} failed`);
  process.exit(1);
}
console.log(`\n${checks} ok`);
