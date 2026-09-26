/* Customising the toolbar: adding from More, moving back, capacity, undo and
 * the one stable order More is shown in.
 *
 * Run with `make test-web`.
 */

import {
  barSlots,
  describeChange,
  gridItems,
  isCustomised,
  isPinnable,
  moreOrder,
  noteUse,
  pinIndexForDrop,
  placeOnBar,
  removeFromBar,
  resetToolbar,
  restoreToolbar,
  snapshotToolbar,
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
