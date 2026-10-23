/* How the notification bell's list and badge move on a host's action.
 *
 * The server is the record (GET /api/host/alerts skips dismissed and 90-day-old rows). These
 * are the optimistic steps, so a row leaves the panel and the number drops the moment the host
 * clicks, before the request comes back. Pure, so `make test-web` can check them.
 */

export type AlertRow = { id: string; unread: boolean };

export type BellState<A extends AlertRow = AlertRow> = {
  alerts: A[];
  unread: number;
};

/** One notification marked read. A row already read does not move the number. */
export function readAlert<A extends AlertRow>(
  s: BellState<A>,
  id: string,
): BellState<A> {
  const hit = s.alerts.find((a) => a.id === id);
  if (!hit || !hit.unread) return s;
  return {
    alerts: s.alerts.map((a) => (a.id === id ? { ...a, unread: false } : a)),
    unread: Math.max(0, s.unread - 1),
  };
}

/** "Mark all as read": every row stays, the badge goes to zero. */
export function readAllAlerts<A extends AlertRow>(
  s: BellState<A>,
): BellState<A> {
  return {
    alerts: s.alerts.map((a) => (a.unread ? { ...a, unread: false } : a)),
    unread: 0,
  };
}

/** The ✕ on one row: it leaves the list, and the badge if it was unread. */
export function dismissAlert<A extends AlertRow>(
  s: BellState<A>,
  id: string,
): BellState<A> {
  const hit = s.alerts.find((a) => a.id === id);
  if (!hit) return s;
  return {
    alerts: s.alerts.filter((a) => a.id !== id),
    unread: hit.unread ? Math.max(0, s.unread - 1) : s.unread,
  };
}

/** "Clear all". */
export function dismissAllAlerts<A extends AlertRow>(): BellState<A> {
  return { alerts: [], unread: 0 };
}

/** How far (px) a row has to be swiped sideways before letting go dismisses it. */
export const SWIPE_DISMISS_PX = 80;

/** Whether a horizontal drag of `dx` pixels, released, dismisses the row. Either direction. */
export function swipeDismisses(dx: number): boolean {
  return Math.abs(dx) >= SWIPE_DISMISS_PX;
}

/** The keys that dismiss the focused notification row. */
export function isDismissKey(key: string): boolean {
  return key === "Delete" || key === "Backspace";
}
