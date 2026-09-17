/** Open a live / preview room in a new tab. Keeps manage / browse / my-webinars
 *  in place so ending or admitting people does not lose the host's place. */
export function openRoomTab(url: string): void {
  const tab = window.open(url, "_blank", "noopener,noreferrer");
  if (tab) tab.opener = null;
}

/**
 * For a click handler that has to `await` something (create a webinar, start
 * it) before it knows which room to open. Call this FIRST, synchronously,
 * before any `await` — it opens a blank tab right there, while the click is
 * still "live" as far as the browser's popup blocker is concerned. Call
 * `.open(url)` once the real URL is known; navigating an already-open tab is
 * never treated as a popup, only the original open() is. If the awaited work
 * fails instead, call `.cancel()` so the blank tab does not sit there empty.
 *
 * Doing the obvious thing instead — `await` the work, then `openRoomTab()` —
 * is what broke this: by the time that runs, the click has receded far
 * enough into the past that Safari in particular no longer credits it as a
 * direct response to a user gesture, and silently blocks the tab. Nothing in
 * the app's own code failed; the tab just never existed.
 */
export function openPendingRoomTab(): {
  open: (url: string) => void;
  cancel: () => void;
} {
  const tab = window.open("", "_blank", "noopener,noreferrer");
  if (tab) tab.opener = null;
  return {
    open: (url: string) => {
      if (tab && !tab.closed) {
        tab.location.href = new URL(url, window.location.origin).toString();
      } else {
        // The blank tab didn't survive (closed, or never opened at all) —
        // fall back to a normal open. This one might still be blocked, but
        // it is no worse than the pre-existing behaviour, and most of the
        // time the blank tab above is exactly what avoids needing this.
        openRoomTab(url);
      }
    },
    cancel: () => {
      if (tab && !tab.closed) tab.close();
    },
  };
}
