/* Coming back to the page after being away from it — a locked phone, another app, a
 * minimised window — and what the players and rooms do about it.
 *
 * While the page is hidden a phone pauses the video, throttles or freezes the page and often
 * takes its network away. So on return a live player is behind live by however long the
 * person was gone, and every connection on the page is mid-way through finding its feet
 * again. Neither is news to them: they were away. These are the shared rules for that moment,
 * kept free of imports so lib/background-return.test.mts can load them.
 */

/** Hidden at least this long counts as having been away. A glance at a notification does not. */
export const AWAY_MIN_MS = 2_000;

/** After returning, how long "Reconnecting…" badges and messages are held back while the page
 *  catches up by itself. A player jumping back to live and an event stream reopening usually
 *  take a second or two; the rest is room for a slow phone network. */
export const RETURN_QUIET_MS = 6_000;

/** Follows the page's visibility and says how long it was away each time it comes back. */
export class AwayClock {
  private hiddenAt: number | null;

  constructor(hidden: boolean, now: number) {
    this.hiddenAt = hidden ? now : null;
  }

  /** The page's visibility changed. Returns how long it was hidden, in ms, when it has just
   *  become visible after at least AWAY_MIN_MS; null otherwise. */
  change(hidden: boolean, now: number): number | null {
    if (hidden) {
      this.hiddenAt ??= now;
      return null;
    }
    const since = this.hiddenAt;
    this.hiddenAt = null;
    if (since === null) return null;
    const away = now - since;
    return away >= AWAY_MIN_MS ? away : null;
  }
}

/** Whether a live player that has just come back should jump to live by itself, rather than
 *  leave the person watching what happened while they were away. `latencySec` is how far
 *  behind live it is now; `behindSec` is the distance the player already calls "behind" (and
 *  offers Back to live for). */
export function jumpToLiveOnReturn(o: { latencySec: number | null; behindSec: number }): boolean {
  return o.latencySec != null && Number.isFinite(o.latencySec) && o.latencySec > o.behindSec;
}
