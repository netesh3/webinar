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
  ok(phone.join() === "chat,qa,hand", "a phone bar keeps Chat, Q&A and Raise hand");
  const more = morePanelTools(ALL, true) ?? [];
  ok(
    more.includes("settings") && more.includes("participants"),
    "the rest of the cluster, including Participants, lands in More",
  );
  ok(!more.includes("chat") && !more.includes("hand") && !more.includes("qa"), "standing tools are not duplicated into More");
}

{
  ok(morePanelTools(ALL, false) === undefined, "desktop More has no extra engagement row");
}

{
  const none = centerBarTools(["invite"], false);
  ok(none.length === 0, "an attendee with no engagement tools gets an empty cluster");
}

{
  // Attendee, promoted or not — see CENTER_BAR_COMPACT_ATTENDEE's own
  // comment: MediaToggle's mobile sizing was shrunk specifically so this
  // never needs to fall back, including the one case that matters most (mic
  // AND camera both showing).
  const phoneAttendee = centerBarTools(ALL, true, true);
  ok(
    phoneAttendee.join() === "chat,qa,hand",
    "an attendee gets Chat, Q&A and Raise hand on the bar",
  );
  const more = morePanelTools(ALL, true, true) ?? [];
  ok(!more.includes("qa"), "Q&A is not duplicated into More once it's on the bar");
  ok(
    more.includes("reactions") && more.includes("settings") && more.includes("participants"),
    "everything else still lands in More",
  );
}

{
  // Host/panelist never pass `attendee` — same two-item bar as always,
  // Reactions included, regardless of mic/camera state.
  const phoneHost = centerBarTools(ALL, true);
  ok(phoneHost.join() === "chat,qa,hand", "host/panelist compact bar includes Q&A");
  const more = morePanelTools(ALL, true) ?? [];
  ok(more.includes("reactions"), "Reactions stays in More for host/panelist, same as before");
}

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`,
);
process.exit(failures === 0 ? 0 : 1);
