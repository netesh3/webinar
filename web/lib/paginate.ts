/* Split out of lib/layout.ts so the admin lists can page a table without
 * importing livekit-client. */

export type Page<T> = {
  items: T[];
  page: number;
  pages: number;
  /** Everything not on this page. What the subscription budget switches off. */
  offscreen: T[];
};

export function paginate<T>(
  items: readonly T[],
  size: number,
  page: number,
): Page<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  // Clamped rather than trusted: the page number outlives the list it indexed, so
  // somebody on page 4 when a webinar empties out would otherwise be looking at
  // nothing with no way back.
  const at = Math.min(Math.max(page, 0), pages - 1);
  const from = at * size;
  const visible = items.slice(from, from + size);
  return {
    items: visible,
    page: at,
    pages,
    offscreen: [...items.slice(0, from), ...items.slice(from + size)],
  };
}
