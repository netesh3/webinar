/* Tests for room media shortcuts: they must not fire while typing.
 *
 * Run with `make test-web`.
 */

import { isTypingTarget, mediaHotkey } from "./media-hotkeys.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
}

function eq<T>(actual: T, expected: T, what: string): void {
  ok(actual === expected, `${what} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

console.log("\nisTypingTarget");

{
  ok(!isTypingTarget(null), "nothing focused is not typing");
  ok(
    isTypingTarget({ tagName: "TEXTAREA" }),
    "a chat box is typing",
  );
  ok(
    !isTypingTarget({ tagName: "BUTTON" }),
    "a button is not typing",
  );
}

console.log("\nmediaHotkey");

{
  const base = { repeat: false, metaKey: false, ctrlKey: false, altKey: false };
  eq(mediaHotkey({ ...base, code: "KeyM" }, "down"), "mute", "M mutes");
  eq(mediaHotkey({ ...base, code: "KeyV" }, "down"), "camera", "V toggles the camera");
  eq(mediaHotkey({ ...base, code: "Space" }, "down"), "ptt-down", "Space starts talk-to-speak");
  eq(mediaHotkey({ ...base, code: "Space" }, "up"), "ptt-up", "…and releasing it ends it");
  eq(
    mediaHotkey({ ...base, code: "KeyM", metaKey: true }, "down"),
    null,
    "⌘M is the browser's, not ours",
  );
  eq(
    mediaHotkey({ ...base, code: "KeyM", repeat: true }, "down"),
    null,
    "a held M does not chatter the mute",
  );
  eq(mediaHotkey({ ...base, code: "KeyM" }, "up"), null, "releasing M does nothing");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
