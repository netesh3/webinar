/* Whether closing the pop-out should suppress MediaSession auto-reopen.
 *
 * Kept free of React so `make test-web` can pin the cases with Node's TypeScript
 * stripper and no browser. The hook in pip.ts is the only caller in the app.
 */

export function shouldRememberPipDismiss({
  shareActive,
  tabVisible,
  explicitDismiss = false,
}: {
  shareActive: boolean;
  tabVisible: boolean;
  explicitDismiss?: boolean;
}): boolean {
  if (!shareActive) return false;
  if (explicitDismiss) return true;
  // X on the floating window: the opener tab is still hidden. Visibility-driven close runs
  // only after the tab is visible again, so it never takes this branch.
  return !tabVisible;
}
