/** Open a live / preview room in a new tab. Keeps manage / browse / my-webinars
 *  in place so ending or admitting people does not lose the host's place.
 *
 *  No feature string — see openPendingRoomTab's comment on why passing one
 *  at all (even just "noopener,noreferrer", nothing size/chrome-related)
 *  is what turns this into a stripped-down popup window in some browsers
 *  instead of a normal tab. .opener is nulled by hand instead. */
export function openRoomTab(url: string): void {
  const tab = window.open(url, "_blank");
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
  /* No feature string at all here, deliberately — on two counts.
   *
   * "noreferrer" implies the same opener-severing as "noopener" per spec
   * (window.open() then returns null — there is nothing to hand back), so
   * dropping only "noopener" and keeping "noreferrer" — what this used to
   * do — didn't fix anything: this function's whole point is navigating the
   * tab once the real URL is known, and a null handle breaks that outright,
   * silently, in Safari specifically.
   *
   * A non-empty features string is also the browser's own cue to render a
   * stripped-down popup window instead of a normal tab — present ANY
   * value, even just one flag, and that is what "no toolbar, no tab bar"
   * comes from. Passing nothing is what a plain target="_blank" link does,
   * and that is what should render here.
   *
   * Same-origin destination (our own /host/.../room), so there is no
   * referrer to leak to a third party regardless — the isolation that
   * actually matters (no window.opener back-reference) still happens two
   * lines down, by hand, which needs no feature string at all. */
  const tab = window.open("", "_blank");
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
