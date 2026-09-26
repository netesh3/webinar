/* Tests for the host's attendee-chat control. Run with `make test-web`.
 *
 * The one that matters most: turning chat off must not overwrite the destination,
 * or switching back on silently widens "Panelists only" to everyone.
 */

import {
  CHAT_PERMISSIONS,
  chatPermissionCopy,
  chatPermissionOf,
  chatPermissionPatch,
  chatPermissionStep,
} from "./chat-permission.ts";

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

console.log("chatPermissionOf");
eq(chatPermissionOf({ chatEnabled: true, chatDestination: "everyone" }), "everyone", "on, everyone");
eq(chatPermissionOf({ chatEnabled: true, chatDestination: "panelists" }), "panelists", "on, panelists");
eq(chatPermissionOf({ chatEnabled: false, chatDestination: "panelists" }), "off", "off wins over a destination");
eq(chatPermissionOf({ chatEnabled: true, chatDestination: "" }), "everyone", "an unknown destination reads as everyone, like the server");

console.log("chatPermissionPatch");
eq(chatPermissionPatch("off"), { chatEnabled: false }, "off leaves the destination alone");
eq(chatPermissionPatch("panelists"), { chatEnabled: true, chatDestination: "panelists" }, "panelists turns chat on");
eq(chatPermissionPatch("everyone"), { chatEnabled: true, chatDestination: "everyone" }, "everyone turns chat on");
for (const p of CHAT_PERMISSIONS) {
  const patch = chatPermissionPatch(p);
  eq(
    chatPermissionOf({
      chatEnabled: patch.chatEnabled,
      chatDestination: "chatDestination" in patch ? patch.chatDestination : "panelists",
    }),
    p,
    `${p} round-trips through the patch`,
  );
}

console.log("chatPermissionStep");
eq(chatPermissionStep("everyone", "ArrowRight"), "panelists", "right moves on");
eq(chatPermissionStep("off", "ArrowRight"), "everyone", "right wraps");
eq(chatPermissionStep("everyone", "ArrowLeft"), "off", "left wraps");
eq(chatPermissionStep("panelists", "ArrowUp"), "everyone", "up is left");
eq(chatPermissionStep("panelists", "ArrowDown"), "off", "down is right");
eq(chatPermissionStep("off", "Home"), "everyone", "home");
eq(chatPermissionStep("everyone", "End"), "off", "end");
eq(chatPermissionStep("everyone", "Enter"), null, "other keys are left alone");

console.log("chatPermissionCopy");
for (const p of CHAT_PERMISSIONS) {
  const c = chatPermissionCopy(p);
  eq(c.label.length <= 10, true, `${p} label fits a third of a 360px panel`);
  eq(c.effect.endsWith("."), true, `${p} effect is a sentence`);
}
eq(chatPermissionCopy("off").effect.includes("panelists can still chat"), true, "off says the stage still talks");

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
