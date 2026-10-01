/* Which ended webinars the host home still asks the coach to follow up.
 *
 * The column used to ask for a single past row. A coach with several sessions
 * in the same week only saw the latest, so the read now takes as many as the
 * host-list endpoint will return and the week rule below drops the rest.
 * That rule is unchanged: a follow-up is worth showing for a week after the
 * end, and not after. store.MaxHostWebinarLimit is the cap on the read. */

/** Shown for a week after the end. The same bound the single card used. */
export const FOLLOW_UP_WINDOW_MS = 7 * 24 * 3_600_000;

/** Cards in view before the column scrolls. */
export const FOLLOW_UP_VISIBLE = 5;

/** store.MaxHostWebinarLimit. One page is the eligible set. */
export const FOLLOW_UP_FETCH_LIMIT = 100;

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

/** The past page, newest first, narrowed to the week. Order is the page's
 *  order, so the first card is the session the single card used to show. */
export function eligibleFollowUps<T extends { endedAt?: string }>(
  items: readonly T[],
  now: number,
): T[] {
  return items.filter((w) => withinFollowUpWindow(w.endedAt, now));
}
