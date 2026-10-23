/* Centre-cluster vs More: which tools sit on the Zoom-style bar.
 *
 * Run with `make test-web`.
 */

import {
  barPlacement,
  centerBarTools,
  fitCompactBar,
  moreGroups,
  morePanelTools,
  shareButtonOnBar,
  withHomeToolsTucked,
  CENTER_BAR_TOOLS,
  HOME_BAR_TOOLS,
  type ToolId,
  type ToolLayout,
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
  // Every role gets the same phone strip: Chat and Reactions, nothing else.
  const phone = centerBarTools(ALL, true);
  ok(phone.join() === "chat,reactions", "a phone bar keeps only Chat and Reactions");
  const more = morePanelTools(ALL, true) ?? [];
  for (const id of ["qa", "polls", "participants", "hand", "settings"] as ToolId[]) {
    ok(more.includes(id), `${id} lands in More on a phone`);
  }
  ok(!more.includes("chat") && !more.includes("reactions"), "standing tools are not duplicated into More");
}

{
  ok(morePanelTools(ALL, false) === undefined, "desktop More has no extra engagement row");
}

{
  const none = centerBarTools(["invite"], false);
  ok(none.length === 0, "an attendee with no engagement tools gets an empty cluster");
}

{
  // A short row sheds Reactions; Chat stays until even it cannot fit.
  for (const slots of [0, 1, 2, 4]) {
    const onBar = centerBarTools(ALL, true, [], slots);
    const more = morePanelTools(ALL, true, [], slots) ?? [];
    ok(
      onBar.includes("reactions") !== more.includes("reactions"),
      `reactions is in exactly one place at ${slots} slots`,
    );
    ok(onBar.length <= Math.max(0, slots), `phone row stays within ${slots} slots`);
  }
  ok(centerBarTools(ALL, true, [], 1).join() === "chat", "one slot keeps Chat");
  ok(fitCompactBar(["chat", "reactions"], 1).join() === "chat", "Reactions is shed first");
}

console.log("\nbarPlacement (desktop vs phone, per role)");

const HOST_TOOLS: ToolId[] = [...ALL, "youtube", "captions", "polls"];
const ATTENDEE_TOOLS: ToolId[] = ["chat", "qa", "participants", "invite", "settings", "hand", "reactions"];
const PANELIST_TOOLS: ToolId[] = ["chat", "qa", "polls", "participants", "invite", "settings", "reactions"];

{
  // Desktop host, default layout (home tools tucked).
  const d = barPlacement({ available: HOST_TOOLS, compact: false, tucked: [...HOME_BAR_TOOLS] });
  ok(!d.youtubeInline, "desktop: YouTube is in More by default");
  ok(!d.strip.includes("settings"), "desktop: Settings is in More by default");
  ok(
    d.strip.join() === "chat,qa,polls,participants,hand,reactions",
    "desktop keeps the standing strip inline, minus Settings",
  );
  ok(d.shareInline && d.recordInline && d.pinSlots, "desktop keeps Share, Record and pin slots");
  ok(d.panel === undefined, "desktop has no leftover standing row in More");

  // Desktop, somebody dragged both home tools back onto the bar.
  const back = barPlacement({ available: HOST_TOOLS, compact: false, tucked: [] });
  ok(back.youtubeInline && back.strip.includes("settings"), "desktop: a home tool put back stays inline");
}

{
  const a = barPlacement({ available: ATTENDEE_TOOLS, compact: false, tucked: [...HOME_BAR_TOOLS] });
  ok(a.strip.join() === "chat,qa,participants,hand,reactions", "desktop attendee strip, Settings in More");
  ok(!a.youtubeInline, "an attendee never gets YouTube");
}

for (const [role, tools] of [
  ["host", HOST_TOOLS],
  ["panelist", PANELIST_TOOLS],
  ["attendee", ATTENDEE_TOOLS],
] as const) {
  // Even a layout with home tools on the bar puts them in More on a phone.
  const p = barPlacement({ available: tools, compact: true, tucked: [] });
  ok(p.strip.join() === "chat,reactions", `phone ${role}: only Chat and Reactions inline`);
  ok(!p.youtubeInline && !p.shareInline && !p.recordInline, `phone ${role}: YouTube, Share, Record in More`);
  ok(!p.pinSlots, `phone ${role}: no pin slots`);
  ok(p.tucked.join() === "youtube,settings", `phone ${role}: home tools count as tucked`);
  const panel = p.panel ?? [];
  ok(!panel.includes("settings"), `phone ${role}: Settings comes from the grid, not twice`);
  for (const id of tools) {
    if (id === "chat" || id === "reactions") continue;
    if (!(CENTER_BAR_TOOLS as readonly ToolId[]).includes(id)) continue;
    if (id === "settings") continue;
    ok(panel.includes(id), `phone ${role}: ${id} is in More`);
  }
}

{
  const p = barPlacement({ available: HOST_TOOLS, compact: true, tucked: [], slots: 1 });
  ok(p.strip.join() === "chat" && (p.panel ?? []).includes("reactions"), "a tight phone row moves Reactions into More");
  const d = barPlacement({ available: HOST_TOOLS, compact: false, tucked: [], slots: 1 });
  ok(d.strip.length > 1, "slots never trim a desktop strip");
}

{
  const l: ToolLayout = { pinned: [], overflow: ["invite"], recent: [], windows: {}, nextZ: 1 };
  const t = withHomeToolsTucked(l);
  ok(t.overflow.join() === "invite,youtube,settings", "a phone reads every home tool as in More");
  ok(withHomeToolsTucked(t) === t, "and leaves an already-tucked layout alone");
}

console.log("\nmoreGroups");

{
  const g = moreGroups(["share", "raised-hands", "qa", "participants", "youtube", "host", "settings", "invite"]);
  ok(
    g.map((x) => x.id).join() === "engage,people,present,stream,manage",
    "sections come in a fixed order",
  );
  ok(g[0].keys.join() === "raised-hands,qa", "Engage holds Q&A and raised hands");
  ok(g[1].keys.join() === "participants,invite", "People holds Participants and Invite");
  ok(g[4].keys.join() === "host,settings", "Manage holds Host tools and Settings");
  ok(moreGroups(["chat"]).length === 1, "empty sections are dropped");
  ok(moreGroups(["mystery"]).at(-1)?.keys.join() === "mystery", "unknown entries are not lost");
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
  ok(shareButtonOnBar({ compact: false }), "desktop keeps Share on the bar");
  ok(!shareButtonOnBar({ compact: true }), "every compact bar parks Share in More");

  for (const width of [320, 360, 390, 430]) {
    const toggle = mediaToggleSizeForWidth(width);
    const fit = mobileEngagementFit(width, 2, toggle, 2);
    const onBar = centerBarTools(ALL, true, [], fit.slots);
    ok(onBar.length <= fit.slots, `${width}px row with mic and camera stays within its slot budget`);
    ok(
      phoneBarRowPx(onBar.length, fit.buttonPx) <= fit.available,
      `${width}px row does not overflow the strip`,
    );
    ok(onBar.join() === "chat,reactions", `${width}px keeps Chat and Reactions with mic and camera`);
  }
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
