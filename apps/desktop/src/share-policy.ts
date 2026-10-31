/**
 * Zoom-like screen share: when the entire screen is captured, hide every
 * app window so the meeting UI is not in the output, and park a small
 * always-on-top Stop bar that capture cannot see.
 *
 * Window shares leave the meeting window up — the captured surface is some
 * other app. Entire-screen shares are the infinite-mirror case.
 */

export const SHARE_BAR_SIZE = { width: 380, height: 56 } as const;

export function shouldHideAppWindows(sourceKind: "screen" | "window"): boolean {
  return sourceKind === "screen";
}

/** Bottom-centre of the work area, above the Dock / taskbar. */
export function shareBarBounds(
  workArea: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number } = SHARE_BAR_SIZE,
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + workArea.height - size.height - 20),
    width: size.width,
    height: size.height,
  };
}

/** The extra room window (not the main host page) closes; Results load in main. */
export function closeExtraRoomDecision(opts: {
  senderIsMain: boolean;
  resultsUrlOk: boolean;
}): { closeSender: boolean; loadResultsInMain: boolean } {
  if (opts.senderIsMain) return { closeSender: false, loadResultsInMain: false };
  return { closeSender: true, loadResultsInMain: opts.resultsUrlOk };
}

/** Skip our own windows in the window-share picker so nobody shares the meeting chrome. */
export function isOwnCaptureSource(
  source: { id: string; name: string; kind: "screen" | "window" },
  ourMediaSourceIds: ReadonlySet<string>,
): boolean {
  if (source.kind === "screen") return false;
  if (ourMediaSourceIds.has(source.id)) return true;
  const name = source.name;
  return name === "Webinar Liv" || name.endsWith(" — Webinar Liv") || name === "Sharing — Webinar Liv";
}
