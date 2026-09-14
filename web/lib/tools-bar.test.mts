/* Centre-cluster vs More: which tools sit on the Zoom-style bar.
 *
 * Run with `make test-web`.
 */

import {
  centerBarTools,
  morePanelTools,
  CENTER_BAR_TOOLS,
  type ToolId,
} from "./tools.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
}

const ALL: ToolId[] = [...CENTER_BAR_TOOLS, "invite", "layout", "host"];

console.log("\ncenterBarTools");

{
  const desktop = centerBarTools(ALL, false);
  ok(
    desktop.join() === CENTER_BAR_TOOLS.join(),
    "desktop shows the full standing cluster",
  );
  ok(!desktop.includes("invite"), "Invite stays out of the standing cluster");
}

{
  const phone = centerBarTools(ALL, true);
  ok(phone.join() === "chat,participants", "a phone bar keeps Chat and Participants");
  const more = morePanelTools(ALL, true) ?? [];
  ok(more.includes("qa") && more.includes("settings"), "the rest of the cluster land in More");
  ok(!more.includes("chat"), "Chat is not duplicated into More");
}

{
  ok(morePanelTools(ALL, false) === undefined, "desktop More has no extra engagement row");
}

{
  const none = centerBarTools(["invite"], false);
  ok(none.length === 0, "an attendee with no engagement tools gets an empty cluster");
}

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`,
);
process.exit(failures === 0 ? 0 : 1);
