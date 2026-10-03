/* Centre-cluster vs More: which tools sit on the Zoom-style bar.
 *
 * Run with `make test-web`.
 */

import {
  centerBarTools,
  fitAttendeeCompactBar,
  morePanelTools,
  shareButtonOnBar,
  CENTER_BAR_TOOLS,
  type ToolId,
} from "./tools.ts";
import {
  BAR_SLOT_CAPACITY,
  NARROW_SLOTS,
  PHONE_BAR_BREAK,
  PHONE_BAR_ICON_MAX_PX,
  PHONE_BAR_MAX_PX,
  mediaToggleSizeForWidth,
  mobileEngagementFit,
  phoneBarRowPx,
} from "./compact.ts";

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
  // Attendee phones put Reactions on the strip with Chat, Q&A and Raise hand.
  // Passing no slot budget is that full row; More keeps everything else.
  const phoneAttendee = centerBarTools(ALL, true, true);
  ok(
    phoneAttendee.join() === "chat,qa,hand,reactions",
    "an attendee phone bar keeps Chat, Q&A, Raise hand and Reactions",
  );
  const more = morePanelTools(ALL, true, true) ?? [];
  ok(!more.includes("reactions") && !more.includes("qa"), "tools on the bar are not duplicated into More");
  ok(
    more.includes("settings") && more.includes("participants"),
    "everything else still lands in More",
  );
}

{
  // A short row sheds Reactions first, then Q&A. Both stay reachable in More.
  // Chat and Raise hand stay until even those two cannot fit.
  for (const slots of [0, 1, 2, 3, 4, 6]) {
    const onBar = centerBarTools(ALL, true, true, [], slots);
    const more = morePanelTools(ALL, true, true, [], slots) ?? [];
    const reachable = onBar.includes("reactions") || more.includes("reactions");
    ok(reachable, `reactions is on the bar or in More at ${slots} slots`);
    ok(
      !(onBar.includes("reactions") && more.includes("reactions")),
      `reactions is not in both places at ${slots} slots`,
    );
    ok(onBar.length <= Math.max(0, slots), `attendee row stays within ${slots} slots`);
  }
  ok(
    centerBarTools(ALL, true, true, [], 3).join() === "chat,qa,hand",
    "one short slot moves Reactions into More and keeps Q&A",
  );
  ok(
    (morePanelTools(ALL, true, true, [], 3) ?? []).includes("reactions"),
    "the shed Reactions button is in More",
  );
  ok(
    centerBarTools(ALL, true, true, [], 2).join() === "chat,hand",
    "two short slots move Q&A and Reactions into More",
  );
  ok(
    fitAttendeeCompactBar(["chat", "qa", "hand", "reactions"], 2).join() === "chat,hand",
    "shedding keeps Chat then Raise hand, in bar order",
  );
}

{
  // Host/panelist never pass `attendee` — same bar as always.
  const phoneHost = centerBarTools(ALL, true);
  ok(phoneHost.join() === "chat,qa,hand", "host/panelist compact bar includes Q&A");
  const more = morePanelTools(ALL, true) ?? [];
  ok(more.includes("reactions"), "Reactions stays in More for host/panelist, same as before");
}

{
  ok(
    BAR_SLOT_CAPACITY.map(([query, slots]) => `${query}=${slots}`).join(",") ===
      "(min-width: 1280px)=6,(min-width: 1024px)=5,(min-width: 768px)=4,(min-width: 640px)=3",
    "desktop and tablet pin capacities are unchanged",
  );
  ok(NARROW_SLOTS === 0, "a phone still has no custom pin slots");
  ok(PHONE_BAR_BREAK === 640, "phone scaling stops at the sm breakpoint");
}

{
  const desktopShare = shareButtonOnBar({
    compact: false,
    phone: false,
    attendee: true,
    mediaToggles: 2,
    cameraToggleShown: true,
  });
  ok(desktopShare, "desktop still keeps Share on the bar");
  const hostPhoneShare = shareButtonOnBar({
    compact: true,
    phone: false,
    attendee: false,
    mediaToggles: 2,
    cameraToggleShown: true,
  });
  ok(!hostPhoneShare, "a host phone with the camera toggle still parks Share in More");
  const tabletMicOnly = shareButtonOnBar({
    compact: true,
    phone: false,
    attendee: true,
    mediaToggles: 1,
    cameraToggleShown: false,
  });
  ok(tabletMicOnly, "tablet still uses the camera-toggle rule for Share");
}

{
  // Promoted attendee on a phone: mic + camera are the two toggles, Share is
  // in More even when every engagement tool fits, and the row's pixels stay
  // inside the strip.
  const promotedShare = shareButtonOnBar({
    compact: true,
    phone: true,
    attendee: true,
    mediaToggles: 2,
    cameraToggleShown: true,
  });
  ok(!promotedShare, "a promoted phone attendee keeps Share in More");
  const micOnlyShare = shareButtonOnBar({
    compact: true,
    phone: true,
    attendee: true,
    mediaToggles: 1,
    cameraToggleShown: false,
  });
  ok(!micOnlyShare, "Share stays in More when only the mic toggle is showing");

  for (const width of [320, 360, 390, 430]) {
    const toggle = mediaToggleSizeForWidth(width);
    const fit = mobileEngagementFit(width, 2, toggle, 4);
    const onBar = centerBarTools(ALL, true, true, [], fit.slots);
    const more = morePanelTools(ALL, true, true, [], fit.slots) ?? [];
    ok(onBar.length <= fit.slots, `${width}px promoted row stays within its slot budget`);
    ok(
      phoneBarRowPx(onBar.length, fit.buttonPx) <= fit.available,
      `${width}px promoted row does not overflow the strip`,
    );
    ok(
      onBar.includes("reactions") || more.includes("reactions"),
      `${width}px promoted attendee can still reach Reactions`,
    );
    ok(onBar.includes("chat") && onBar.includes("hand"), `${width}px keeps Chat and Raise hand`);
    ok(!onBar.includes("invite"), `${width}px does not pull Invite onto the strip`);
  }

  const narrow = mobileEngagementFit(320, 2, mediaToggleSizeForWidth(320), 4);
  ok(narrow.slots === 3, "a 320px promoted phone sheds one engagement tool");
  ok(
    centerBarTools(ALL, true, true, [], narrow.slots).join() === "chat,qa,hand",
    "that shed tool is Reactions, not Chat or Raise hand",
  );
  const roomy = mobileEngagementFit(390, 2, mediaToggleSizeForWidth(390), 4);
  ok(roomy.slots === 4, "a 390px promoted phone fits Reactions on the bar");
  ok(!promotedShare, "Share is still in More on that 390px phone");
}

{
  // Plain attendee: no toggles, so Chat, Q&A, Raise hand, Reactions and More
  // fit, and the buttons do not grow past the size the phone bar already used.
  const plain = mobileEngagementFit(320, 0, mediaToggleSizeForWidth(320), 4);
  ok(plain.slots === 4, "a 320px attendee fits Reactions without being on stage");
  ok(plain.buttonPx === PHONE_BAR_MAX_PX, "a plain phone does not grow the tap target");
  ok(plain.iconPx === PHONE_BAR_ICON_MAX_PX, "a plain phone keeps the 20px glyph");
  const squeezed = mobileEngagementFit(320, 2, mediaToggleSizeForWidth(320), 4);
  ok(squeezed.buttonPx < PHONE_BAR_MAX_PX, "mic and camera scale the centre buttons down");
  ok(squeezed.iconPx < PHONE_BAR_ICON_MAX_PX, "and the glyphs scale with them");
  ok(
    phoneBarRowPx(plain.slots, plain.buttonPx) <= plain.available,
    "a plain 320px row does not overflow",
  );
}

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`,
);
process.exit(failures === 0 ? 0 : 1);
