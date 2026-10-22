/* One page of the host's webinar list, and the cursor stack that lets Previous
 * return to it. The page key is the tab, the search, the dates and the page
 * number — not the opaque cursor — so coming back to a tab paints that page. */

import { dropCachePrefix } from "./http";

export const HOST_LIST_PREFIX = "host-webinars:";

/** Rows per page on the host home. The list request and its cache key both use this,
 *  so a prefetch and the screen share one read instead of asking twice. */
export const HOST_WEBINAR_PAGE_SIZE = 10;

const cursors = new Map<string, (string | undefined)[]>();
const pages = new Map<string, number>();
const resets = new Set<() => void>();

/** Which of the portal's lists a page belongs to: Webinars (everything but meetings) or
 *  Meetings. The API's `kind` parameter, spelled the same. */
export type HostListKind = "webinar" | "meeting";

export function hostListFilterKey(
  tab: string,
  q: string,
  from: string,
  to: string,
  kind: HostListKind | "" = "",
): string {
  return `${kind}\0${tab}\0${q}\0${from}\0${to}`;
}

export function hostListPageKey(filter: string, page: number): string {
  return `${HOST_LIST_PREFIX}page:${filter}:${page}`;
}

export const HOST_LIST_PICKER_KEY = `${HOST_LIST_PREFIX}picker`;

export function rememberedPage(filter: string): number {
  return pages.get(filter) ?? 0;
}

export function rememberPage(filter: string, page: number): void {
  pages.set(filter, page);
}

export function rememberedCursors(filter: string): (string | undefined)[] {
  return cursors.get(filter) ?? [undefined];
}

export function rememberCursors(filter: string, next: (string | undefined)[]): void {
  cursors.set(filter, next);
}

export function onHostListsDropped(cb: () => void): () => void {
  resets.add(cb);
  return () => {
    resets.delete(cb);
  };
}

/** Create, delete, start and end. The list and the webinar picker both go. */
export function dropHostWebinarLists(): void {
  dropCachePrefix(HOST_LIST_PREFIX);
  cursors.clear();
  pages.clear();
  resets.forEach((cb) => cb());
}
