/* When a tap opens a popover, iOS / WKWebView often delivers another
 * pointerdown on the document after the menu is already in the tree.
 * Treating that leftover press as "click outside" closes the popover the
 * moment it opens — Leave looks broken, the speaker menu never stays up.
 *
 * Ready only after the opening pointer is up and a short floor has passed.
 */

export const OUTSIDE_DISMISS_FLOOR_MS = 400;

export function outsideDismissReady(
  openedAt: number,
  now: number,
  opts: { pointerDown?: boolean; floorMs?: number } = {},
): boolean {
  if (opts.pointerDown) return false;
  return now - openedAt >= (opts.floorMs ?? OUTSIDE_DISMISS_FLOOR_MS);
}

/** Listen for a press outside `contains`. No-ops until `outsideDismissReady`. */
export function bindOutsideDismiss({
  contains,
  ignoreClosest,
  onOutside,
}: {
  contains: (node: Node | null) => boolean;
  ignoreClosest?: string;
  onOutside: () => void;
}): () => void {
  const openedAt = Date.now();
  const onDown = (e: PointerEvent) => {
    if (!outsideDismissReady(openedAt, Date.now())) return;
    if (contains(e.target as Node)) return;
    if (ignoreClosest && (e.target as HTMLElement | null)?.closest?.(ignoreClosest)) return;
    onOutside();
  };
  window.addEventListener("pointerdown", onDown);
  return () => window.removeEventListener("pointerdown", onDown);
}
