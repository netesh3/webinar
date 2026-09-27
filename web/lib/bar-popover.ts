/* When the More panel gets out of the way of the rest of the control bar.
 *
 * Only one bar popover should be open at a time: pressing Chat, React,
 * Settings, Share… while More is open closes More AND does that button's own
 * thing, in the same click. The hard part is the exceptions, which are what
 * made the old handler skip the toolbar's tool buttons entirely:
 *
 *   - A press on a toolbar tool may be the start of a drag aimed at the open
 *     panel, so a PRESS on one must not close it. Its activation (the click
 *     the drag layer lets through only when the press did not become a drag)
 *     is what closes it instead — see `closesMoreOnToolActivate`.
 *   - In "Customize toolbar" every toolbar tool carries a − badge, and the
 *     whole point of the mode is that More stays open while you use them.
 *   - The undo notice belongs to the edit that just happened in More.
 *
 * Pure so the rules can be tested without a DOM; more-grid.tsx classifies the
 * event target and asks here.
 */

/** Where a press or click landed, relative to the More panel. */
export type MoreTarget =
  | "panel"
  | "more-button"
  | "tool-slot"
  | "notice"
  | "elsewhere";

/** Anything with Element's `closest` — lets tests pass a stand-in. */
type Closest = { closest?: (selector: string) => unknown };

/** Classifies an event target. `insidePanel` comes from the panel's own
 *  `contains`, which is cheaper and exact. */
export function moreTargetOf(target: Closest | null, insidePanel: boolean): MoreTarget {
  if (insidePanel) return "panel";
  if (!target?.closest) return "elsewhere";
  if (target.closest("[data-more-button]")) return "more-button";
  if (target.closest("[data-tool-slot]")) return "tool-slot";
  if (target.closest("[data-toolbar-notice]")) return "notice";
  return "elsewhere";
}

/** Should a pointer press, or a keyboard-activated click, close More?
 *
 *  Keyboard activation matters because it fires no pointerdown at all: Tab to
 *  Record and press Enter used to leave More open over the bar. A click from a
 *  pointer is ignored here (`fromKeyboard: false`) — its pointerdown already
 *  decided, and the click at the end of a drag from the panel onto the bar
 *  lands "elsewhere" and must not close the panel the tool just left. */
export function closesMoreOn(
  event: "pointerdown" | "click",
  target: MoreTarget,
  fromKeyboard = false,
): boolean {
  if (event === "click" && !fromKeyboard) return false;
  return target === "elsewhere";
}

/** Should activating a toolbar tool (a real click, not the end of a drag)
 *  close More? Yes, unless the host is customising the toolbar, or a drag is
 *  somehow still in flight. */
export function closesMoreOnToolActivate({
  moreOpen,
  editing,
  dragging,
}: {
  moreOpen: boolean;
  editing: boolean;
  dragging: boolean;
}): boolean {
  return moreOpen && !editing && !dragging;
}
