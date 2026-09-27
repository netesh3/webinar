/* The attendee list's query: what the table asks for, how it travels, and — for the
 * fixture source — how it is answered in memory with the server's semantics.
 *
 * Server contract (GET /engagement/attendees): sort=score|name|watch|join, dir=asc|desc,
 * tier=comma list, q=name/email substring, cursor=opaque, limit=1..200 (default 50).
 * Ties break on identity so paging never repeats or skips a row. */

import type { EngagementAttendeePage, EngagementAttendeeRow, EngagementAxis } from "../api-types.ts";
import type { Tier } from "./score.ts";

export type SortKey = "score" | "name" | "watch" | "join";
export type SortDir = "asc" | "desc";

export interface AttendeeFilters {
  sort: SortKey;
  dir: SortDir;
  tiers: Tier[];
  q: string;
}

export interface AttendeeQuery extends AttendeeFilters {
  cursor?: string;
  limit?: number;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export const DEFAULT_FILTERS: AttendeeFilters = { sort: "score", dir: "desc", tiers: [], q: "" };

/** Names and join times read naturally A→Z / earliest first; scores and watch time best first. */
export function defaultDir(sort: SortKey): SortDir {
  return sort === "name" || sort === "join" ? "asc" : "desc";
}

/** Clicking the active header flips it; clicking another starts at that column's default. */
export function nextSort(current: Pick<AttendeeFilters, "sort" | "dir">, key: SortKey) {
  if (current.sort !== key) return { sort: key, dir: defaultDir(key) };
  return { sort: key, dir: current.dir === "asc" ? ("desc" as const) : ("asc" as const) };
}

export function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

export function toSearchParams(q: AttendeeQuery): URLSearchParams {
  const p = new URLSearchParams({ sort: q.sort, dir: q.dir });
  if (q.tiers.length) p.set("tier", q.tiers.join(","));
  const needle = q.q.trim();
  if (needle) p.set("q", needle);
  if (q.cursor) p.set("cursor", q.cursor);
  if (q.limit) p.set("limit", String(clampLimit(q.limit)));
  return p;
}

const CURSOR_PREFIX = "o:";

export function encodeCursor(offset: number): string {
  return btoa(`${CURSOR_PREFIX}${offset}`);
}

/** Anything unreadable is treated as the first page, as the server does for a stale cursor. */
export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const raw = atob(cursor);
    if (!raw.startsWith(CURSOR_PREFIX)) return 0;
    const n = Number(raw.slice(CURSOR_PREFIX.length));
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

const collator = new Intl.Collator("en", { sensitivity: "base" });

function compareBy(sort: SortKey): (a: EngagementAttendeeRow, b: EngagementAttendeeRow) => number {
  switch (sort) {
    case "name":
      return (a, b) => collator.compare(a.name, b.name);
    case "watch":
      return (a, b) => a.watchMin - b.watchMin;
    case "join":
      return (a, b) => a.firstJoinMin - b.firstJoinMin;
    case "score":
      return (a, b) => a.score - b.score;
  }
}

export function matchesQuery(row: EngagementAttendeeRow, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  return row.name.toLowerCase().includes(n) || (row.email ?? "").toLowerCase().includes(n);
}

export function filterAndSort(rows: readonly EngagementAttendeeRow[], f: AttendeeFilters): EngagementAttendeeRow[] {
  const tiers = new Set<string>(f.tiers);
  const cmp = compareBy(f.sort);
  const sign = f.dir === "asc" ? 1 : -1;
  return rows
    .filter((r) => (tiers.size === 0 || tiers.has(r.tier)) && matchesQuery(r, f.q))
    .sort((a, b) => sign * cmp(a, b) || (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
}

export function pageOf(
  rows: readonly EngagementAttendeeRow[],
  q: AttendeeQuery,
  axis: EngagementAxis,
): EngagementAttendeePage {
  const all = filterAndSort(rows, q);
  const start = decodeCursor(q.cursor);
  const end = start + clampLimit(q.limit);
  return {
    rows: all.slice(start, end),
    total: all.length,
    ...(end < all.length ? { nextCursor: encodeCursor(end) } : {}),
    axis,
  };
}
