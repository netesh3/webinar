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
  ok(phone.join() === "chat,hand", "a phone bar keeps only Chat and Raise hand");
  const more = morePanelTools(ALL, true) ?? [];
  ok(
    more.includes("qa") && more.includes("settings") && more.includes("participants"),
    "the rest of the cluster, including Participants, lands in More",
  );
  ok(!more.includes("chat") && !more.includes("hand"), "Chat and Raise hand are not duplicated into More");
}

{
  ok(morePanelTools(ALL, false) === undefined, "desktop More has no extra engagement row");
}

{
  const none = centerBarTools(["invite"], false);
  ok(none.length === 0, "an attendee with no engagement tools gets an empty cluster");
}

{
  const phoneAttendee = centerBarTools(ALL, true, true);
  ok(
    phoneAttendee.join() === "chat,hand,reactions",
    "an attendee with room to spare also gets Reactions on the bar",
  );
  const more = morePanelTools(ALL, true, true) ?? [];
  ok(!more.includes("reactions"), "Reactions is not duplicated into More once it's on the bar");
  ok(
    more.includes("qa") && more.includes("settings") && more.includes("participants"),
    "everything else still lands in More",
  );
}

{
  // Promoted (mic+camera showing): falls back to the plain two-item bar —
  // see CENTER_BAR_COMPACT_ATTENDEE's own comment for the measured reason.
  const phonePromoted = centerBarTools(ALL, true, false);
  ok(
    phonePromoted.join() === "chat,hand",
    "attendee=false (e.g. mic+camera claiming the width) keeps the plain bar",
  );
  const more = morePanelTools(ALL, true, false) ?? [];
  ok(more.includes("reactions"), "Reactions falls back into More when there's no room for it on the bar");
}

{
  // Host/panelist never pass `attendee` — same two-item bar as always.
  const phoneHost = centerBarTools(ALL, true);
  ok(phoneHost.join() === "chat,hand", "host/panelist compact bar is unaffected by the attendee variant");
}

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`,
);
process.exit(failures === 0 ? 0 : 1);
