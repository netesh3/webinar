/* Customising the toolbar: adding from More, moving back, capacity, undo and
 * the one stable order More is shown in.
 *
 * Run with `make test-web`.
 */

import {
  barSlots,
  centerBarTools,
  describeChange,
  gridItems,
  isCustomised,
  isPinnable,
  moreOrder,
  morePanelTools,
  noteUse,
  parseStoredToolbar,
  pinIndexForDrop,
  placeOnBar,
  reconcile,
  removeFromBar,
  resetToolbar,
  restoreToolbar,
  snapshotToolbar,
  tuckedTools,
  usableTools,
  wouldBump,
  type ToolId,
  type ToolLayout,
} from "./tools.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
}

const HOST: ToolId[] = [
  "chat",
  "qa",
  "polls",
  "participants",
  "invite",
  "reactions",
  "settings",
  "host",
  "captions",
  "sharefile",
];

function layout(pinned: ToolId[] = [], recent: ToolId[] = []): ToolLayout {
  return {
    pinned,
    overflow: ["invite", "host", "captions", "sharefile"].filter(
      (id) => !pinned.includes(id as ToolId),
    ) as ToolId[],
    recent,
    windows: {},
    nextZ: 1,
  };
}

const label = (id: ToolId) =>
  ({ invite: "Invite", host: "Host tools", captions: "Captions", sharefile: "Video file" })[
    id as string
  ] ?? id;

console.log("\nmoreOrder / gridItems");

{
  ok(
    moreOrder(["host", "invite", "captions", "share", "settings"]).join() ===
      "share,captions,invite,host,settings",
    "More is one list in a fixed order: presenting, people, host, settings",
  );
  ok(
    moreOrder(["zzz", "invite", "yyy"]).join() === "invite,zzz,yyy",
    "unknown ids keep their relative order at the end",
  );
  const l = layout();
  const grid = gridItems(l, barSlots(l, 6, HOST), HOST);
  ok(
    grid.join() === "sharefile,captions,invite,host",
    "a host's desktop More lists video file, captions, invite, host tools",
  );
  const back = removeFromBar(placeOnBar(l, "sharefile", 6, HOST).layout, "sharefile").layout;
  ok(
    gridItems(back, barSlots(back, 6, HOST), HOST)[0] === "sharefile",
    "a tool dragged back returns to its own place, not the end",
  );
}

console.log("\nisPinnable / usableTools");

{
  ok(isPinnable("captions") && isPinnable("sharefile"), "Captions and video file can move");
  ok(!isPinnable("chat") && !isPinnable("hand"), "standing-strip tools cannot");
  const u = usableTools(HOST, { sharefile: false });
  ok(!u.includes("sharefile") && u.includes("captions"), "a false gate hides only that tool");
}

console.log("\nplaceOnBar");

{
  const r = placeOnBar(layout(), "captions", 4, HOST);
  ok(r.layout.pinned.join() === "captions", "adds to an empty bar");
  ok(r.change?.kind === "added", "reports an add");
  ok(!r.layout.overflow.includes("captions"), "and takes it out of More");
}

{
  const l = layout(["invite", "host"]);
  const r = placeOnBar(l, "captions", 4, HOST, 0);
  ok(r.layout.pinned.join() === "captions,invite,host", "inserts at the drop position");
}

{
  const l = layout(["invite", "host", "captions"]);
  const r = placeOnBar(l, "invite", 4, HOST, 2);
  ok(
    r.layout.pinned.join() === "host,invite,captions",
    "dragging a pin right lands where the marker was, not one past it",
  );
  ok(r.change?.kind === "moved", "a reorder is a move, not an add");
  const same = placeOnBar(l, "invite", 4, HOST, 0);
  ok(same.change === null && same.layout === l, "dropping a pin where it already is changes nothing");
}

{
  const l = layout(["invite", "host"]);
  ok(wouldBump(l, 2, HOST) === "host", "a full bar would bump its last pin");
  ok(wouldBump(l, 3, HOST) === null, "a bar with room bumps nothing");
  const end = placeOnBar(l, "captions", 2, HOST);
  ok(end.layout.pinned.join() === "invite,captions", "adding to a full bar keeps it visible");
  ok(
    end.change?.kind === "added" && end.change.bumped.join() === "host",
    "and says which tool went back to More",
  );
  ok(end.layout.overflow.includes("host"), "the bumped tool is really in More");
  const front = placeOnBar(l, "captions", 2, HOST, 0);
  ok(
    front.layout.pinned.join() === "captions,invite",
    "dropping at the front of a full bar pushes the last one out",
  );
  ok(
    front.change?.kind === "added" && front.change.bumped.join() === "host",
    "and that one is not left pinned out of sight",
  );
}

{
  const l = layout();
  const r = placeOnBar(l, "captions", 0, HOST);
  ok(r.change === null && r.layout === l, "a screen with no slots refuses rather than pinning invisibly");
  ok(placeOnBar(l, "chat", 4, HOST).change === null, "a standing-strip tool is refused");
  ok(placeOnBar(l, "host", 4, ["chat", "invite"]).change === null, "a tool this person lacks is refused");
}

{
  const l = noteUse(layout(), "invite");
  ok(barSlots(l, 4, HOST).some((s) => s.tool === "invite" && !s.pinned), "recent use surfaces a slot");
  const r = placeOnBar(l, "invite", 4, HOST);
  ok(r.change?.kind === "kept", "adding a surfaced tool keeps it, and says so");
}

{
  ok(pinIndexForDrop(["invite", "host", "captions"], "invite", 2) === 1, "moving right shifts by one");
  ok(pinIndexForDrop(["invite", "host", "captions"], "captions", 0) === 0, "moving left does not");
  ok(pinIndexForDrop(["invite"], "host", 1) === 1, "a new tool is not shifted");
}

console.log("\nremoveFromBar");

{
  const r = removeFromBar(layout(["invite"]), "invite");
  ok(r.layout.pinned.length === 0 && r.change?.kind === "removed", "a pin goes back to More");
  ok(r.layout.overflow.includes("invite"), "and is listed there");
}

{
  const l = noteUse(layout(), "invite");
  const r = removeFromBar(l, "invite");
  ok(r.change?.kind === "removed", "a recently used slot can be moved back too");
  ok(
    !barSlots(r.layout, 4, HOST).some((s) => s.tool === "invite"),
    "and it does not fill its own slot again straight away",
  );
}

{
  const l = layout();
  ok(removeFromBar(l, "invite").change === null, "removing what is not on the bar is a no-op");
}

console.log("\nundo / reset");

{
  const l = layout(["invite"]);
  const snap = snapshotToolbar(l);
  const changed = placeOnBar(l, "host", 4, HOST).layout;
  const undone = restoreToolbar(changed, snap);
  ok(undone.pinned.join() === "invite", "undo restores the pins");
  ok(undone.overflow.includes("host"), "and More");
  snap.pinned.push("captions");
  ok(l.pinned.join() === "invite", "a snapshot is a copy, not a view");
}

{
  const l = { ...layout(["invite"], ["host"]), windows: { chat: {} } } as unknown as ToolLayout;
  const r = resetToolbar(l);
  ok(r.pinned.length === 0 && r.recent.length === 0, "reset clears pins and recents");
  ok("chat" in r.windows, "but keeps open windows");
  ok(isCustomised(l) && !isCustomised(r), "only a customised toolbar has anything to reset");
}

console.log("\nhome tools: YouTube and Settings");

const HOST_YT = [...HOST, "youtube"] as ToolId[];

{
  const fresh = parseStoredToolbar(null);
  const H = HOST_YT;
  ok(tuckedTools(fresh).length === 0, "by default YouTube and Settings are on the bar, not tucked");
  ok(isPinnable("youtube") && isPinnable("settings"), "both can move");
  ok(!isCustomised(fresh), "and that default is not a customised toolbar");
  ok(
    centerBarTools(H, false).includes("settings"),
    "Settings keeps its place at the end of the standing strip",
  );
  ok(
    !gridItems(fresh, barSlots(fresh, 6, H), H).some((id) => id === "youtube" || id === "settings"),
    "and neither is listed in More while it is on the bar",
  );
  ok(
    barSlots(fresh, 6, H).every((s) => s.tool !== "youtube" && s.tool !== "settings"),
    "neither takes one of the customisable slots",
  );

  for (const id of ["youtube", "settings"] as ToolId[]) {
    const out = removeFromBar(fresh, id);
    ok(out.change?.kind === "removed", `dragging ${id} into More is a removal`);
    ok(tuckedTools(out.layout).includes(id), `${id} is then tucked`);
    ok(
      gridItems(out.layout, barSlots(out.layout, 6, H), H).includes(id),
      `${id} is listed in More`,
    );
    ok(isCustomised(out.layout), `a tucked ${id} is something Reset can undo`);
    ok(removeFromBar(out.layout, id).change === null, `tucking ${id} twice changes nothing`);

    const back = placeOnBar(out.layout, id, 6, H, 0);
    ok(back.change?.kind === "added", `dragging ${id} back onto the bar is an add`);
    ok(!tuckedTools(back.layout).includes(id), `${id} is back in its own place`);
    ok(!back.layout.pinned.includes(id), `${id} does not become a pin`);
    ok(
      !gridItems(back.layout, barSlots(back.layout, 6, H), H).includes(id),
      `${id} is no longer in More`,
    );
    const noSlots = placeOnBar(out.layout, id, 0, H);
    ok(noSlots.change?.kind === "added", `${id} goes back even on a screen with no pin slots`);
  }

  const tuckedSettings = removeFromBar(fresh, "settings").layout;
  ok(
    !centerBarTools(H, false, false, tuckedTools(tuckedSettings)).includes("settings"),
    "a tucked Settings leaves the standing strip",
  );
  ok(
    !(morePanelTools(H, true, false, tuckedTools(tuckedSettings)) ?? []).includes("settings"),
    "and is not also listed in a phone's leftover row — it is in More once",
  );
  ok(
    (morePanelTools(H, true) ?? []).includes("settings"),
    "an untucked Settings still sits in a phone's More, as before",
  );
}

{
  // A full bar: bringing a home tool back must not push a pin out.
  const H = HOST_YT;
  const full = removeFromBar(layout(["invite", "host"]), "youtube").layout;
  ok(wouldBump(full, 2, H) === "host", "the bar is full");
  ok(wouldBump(full, 2, H, "youtube") === null, "but YouTube would bump nothing");
  const back = placeOnBar(full, "youtube", 2, H);
  ok(
    back.change?.kind === "added" && back.change.bumped.length === 0,
    "and bringing it back reports no bump",
  );
  ok(back.layout.pinned.join() === "invite,host", "every pin stays where it was");
}

{
  const H = HOST_YT;
  const both = removeFromBar(removeFromBar(layout(["invite"]), "youtube").layout, "settings").layout;
  const r = resetToolbar(both);
  ok(tuckedTools(r).length === 0, "reset puts YouTube and Settings back on the bar");
  ok(!isCustomised(r), "and leaves nothing to reset");

  const snap = snapshotToolbar(layout());
  const undone = restoreToolbar(both, snap);
  ok(tuckedTools(undone).length === 0, "undo brings a tucked tool back too");
  const redo = restoreToolbar(undone, snapshotToolbar(both));
  ok(tuckedTools(redo).join() === "youtube,settings", "and undoing a return tucks it again");

  ok(noteUse(layout(), "settings").recent.length === 0, "opening Settings is not a 'recent use'");
  ok(noteUse(layout(), "youtube").recent.length === 0, "nor is opening YouTube");

  const asPin = placeOnBar(layout(), "settings", 6, H, 0);
  ok(asPin.change === null, "dropping Settings on the bar while it is there changes nothing");
}

{
  // Availability: YouTube is the host's.
  const attendee: ToolId[] = ["chat", "qa", "participants", "invite", "settings"];
  const tucked = removeFromBar(layout(), "youtube").layout;
  ok(
    !gridItems(tucked, barSlots(tucked, 6, attendee), attendee).includes("youtube"),
    "someone who may not stream never sees YouTube, tucked or not",
  );
  ok(placeOnBar(tucked, "youtube", 6, attendee).change === null, "and cannot put it on the bar");
  ok(
    tuckedTools(reconcile(tucked, attendee)).includes("youtube"),
    "but the host's choice survives a session where they were not hosting",
  );
  ok(
    !reconcile(layout(), HOST_YT).overflow.includes("youtube"),
    "a newly available YouTube lands on the bar, not in More",
  );
}

console.log("\nmigrating a saved toolbar");

{
  // A v7 record from before this change: no home tool anywhere.
  const saved = parseStoredToolbar(
    JSON.stringify({ pinned: ["invite"], overflow: ["host", "captions", "sharefile"], recent: [] }),
  );
  ok(saved.pinned.join() === "invite", "pins are kept");
  ok(tuckedTools(saved).length === 0, "YouTube and Settings are on the bar");

  // A v6 record: older v6 builds put Settings in `overflow` by default, and
  // opening Settings was recorded as recent use. Neither means "tucked".
  const legacy = parseStoredToolbar(
    JSON.stringify({
      pinned: ["invite", "settings", "invite", "youtube"],
      overflow: ["host", "settings", "captions", "settings"],
      recent: ["settings", "host", "chat"],
    }),
    true,
  );
  ok(legacy.pinned.join() === "invite", "a legacy record keeps its pins, deduplicated, with no home tool pinned");
  ok(tuckedTools(legacy).length === 0, "and loads with YouTube and Settings on the bar");
  ok(legacy.overflow.join() === "host,captions", "the rest of More is kept, without duplicates");
  ok(legacy.recent.join() === "host", "a recorded Settings open is dropped from recents");
  const shown = gridItems(legacy, barSlots(legacy, 6, HOST_YT), HOST_YT);
  ok(
    new Set(shown).size === shown.length && !shown.includes("settings"),
    "More lists nothing twice, and not Settings",
  );
  const reconciled = reconcile(legacy, HOST_YT);
  ok(
    tuckedTools(reconciled).length === 0 &&
      reconciled.overflow.filter((id) => id === "host").length === 1,
    "and reconciling it adds neither home tool to More, nor duplicates anything",
  );

  // A v7 record where the person did tuck Settings keeps it tucked.
  const tuckedNow = parseStoredToolbar(
    JSON.stringify({ pinned: [], overflow: ["settings", "invite"], recent: [] }),
  );
  ok(
    tuckedTools(tuckedNow).join() === "settings",
    "a Settings tucked after this change stays in More across a reload",
  );

  ok(tuckedTools(parseStoredToolbar("{not json")).length === 0, "corrupt storage falls back to the default");
  ok(parseStoredToolbar('"a string"').pinned.length === 0, "so does a record of the wrong shape");
}

console.log("\ndescribeChange");

{
  ok(
    describeChange({ kind: "added", tool: "captions", bumped: [] }, label) ===
      "Captions is on your toolbar now.",
    "plain words for an add",
  );
  ok(
    describeChange({ kind: "added", tool: "captions", bumped: ["host"] }, label)?.includes(
      "Host tools moved to More",
    ) === true,
    "an add that bumped something says what moved",
  );
  ok(describeChange({ kind: "removed", tool: "invite" }, label) === "Invite moved to More.", "a removal");
  ok(describeChange({ kind: "moved", tool: "invite" }, label) === null, "a reorder needs no sentence");
}

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`,
);
process.exit(failures === 0 ? 0 : 1);
