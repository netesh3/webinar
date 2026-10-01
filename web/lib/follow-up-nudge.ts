/* Which ended webinars the host home still asks the coach to follow up.
 *
 * The column shows the three that ended most recently, and nothing else.
 * A follow-up is worth showing for a week after the end, and not after —
 * the same bound the single card used. Upcoming and live sessions are not
 * in this read: it asks the past tab for just those three rows. */

/** Shown for a week after the end. The same bound the single card used. */
export const FOLLOW_UP_WINDOW_MS = 7 * 24 * 3_600_000;

/** Cards in the column. There is no fourth, and no scroll of the rest. */
export const FOLLOW_UP_LIMIT = 3;

/** One short past page. The column never shows more than FOLLOW_UP_LIMIT. */
export const FOLLOW_UP_FETCH_LIMIT = FOLLOW_UP_LIMIT;

/** Cache key for that one read. The prefetch and the column share it, so the
 *  cards are already in memory when the column mounts. `prefix` is
 *  HOST_LIST_PREFIX. The rest matches hostWebinarsKey for
 *  `{ tab: "past", limit: FOLLOW_UP_FETCH_LIMIT }`. */
export function followUpListCacheKey(prefix: string): string {
  return `${prefix}tab=past&limit=${FOLLOW_UP_FETCH_LIMIT}`;
}

/** True when this end time is still inside the follow-up week.
 *
 *  A missing or unreadable end is not a follow-up: the card's sentence is
 *  "ended … ago", and there is nothing to say. An end in the future still
 *  counts, which is what `now - ended < window` already did for the one card. */
export function withinFollowUpWindow(endedAt: string | undefined, now: number): boolean {
  if (!endedAt) return false;
  const ended = Date.parse(endedAt);
  return Number.isFinite(ended) && now - ended < FOLLOW_UP_WINDOW_MS;
}

/** The past page, narrowed to the week. Order is the page's order. */
export function eligibleFollowUps<T extends { endedAt?: string }>(
  items: readonly T[],
  now: number,
): T[] {
  return items.filter((w) => withinFollowUpWindow(w.endedAt, now));
}

/** The three most recently ended webinars still inside the week.
 *
 *  Anything older than the week is already gone. A longer eligible list is
 *  cut here, so the column cannot grow a fourth card or a scrollbar. */
export function recentFollowUps<T extends { endedAt?: string }>(
  items: readonly T[],
  now: number,
): T[] {
  return eligibleFollowUps(items, now)
    .slice()
    .sort((a, b) => Date.parse(b.endedAt ?? "") - Date.parse(a.endedAt ?? ""))
    .slice(0, FOLLOW_UP_LIMIT);
}
