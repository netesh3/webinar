/* Tests for the host's attendee-chat control. Run with `make test-web`.
 *
 * The one that matters most: turning chat off must not overwrite the destination,
 * or switching back on silently widens "Panelists only" to everyone.
 */

import {
  CHAT_PERMISSIONS,
  chatPermissionCopy,
  chatPermissionOf,
  chatPermissionOpenStored,
  chatPermissionPatch,
  chatPermissionStartsOpen,
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

console.log("chatPermissionStartsOpen");
eq(chatPermissionStartsOpen(null), true, "no preference starts expanded");
eq(chatPermissionStartsOpen(""), true, "an empty value is not a preference");
eq(chatPermissionStartsOpen("1"), true, "a saved open stays open");
eq(chatPermissionStartsOpen("0"), false, "a saved collapse stays collapsed");
eq(chatPermissionStartsOpen("yes"), true, "anything else is not a saved collapse");

console.log("chatPermissionOpenStored");
eq(chatPermissionOpenStored(false, null), null, "collapsing with no preference is not saved");
eq(chatPermissionOpenStored(true, null), null, "opening with no preference is not saved");
eq(chatPermissionOpenStored(false, ""), null, "an empty value is not updated into a collapse");
eq(chatPermissionOpenStored(false, "1"), "0", "an existing preference can be collapsed");
eq(chatPermissionOpenStored(true, "0"), "1", "an existing collapse can be opened");
eq(chatPermissionOpenStored(false, "0"), "0", "collapsing again keeps the saved choice");
eq(chatPermissionOpenStored(true, "1"), "1", "opening again keeps the saved choice");

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
