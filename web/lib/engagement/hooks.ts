"use client";

/* Data hooks for the Engagement page. Each keys its state on what it asked for, so a slow
 * response to an old question can never overwrite the answer to a newer one, and nothing is
 * reset by a synchronous setState inside an effect. Sources must be referentially stable. */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { EngagementAttendeeDetail, EngagementAttendeeRow, EngagementAxis, EngagementSummary } from "@/lib/api-types";
import type { AttendeeFilters, AttendeeQuery } from "./query";
import type { Tier } from "./score";
import type { EngagementSource } from "./source";

export const LIVE_REFRESH_MS = 30_000;
export const SEARCH_DEBOUNCE_MS = 250;
export const PAGE_SIZE = 50;

interface SummaryState {
  sourceId: string;
  key: string;
  data: EngagementSummary | null;
  error: unknown;
}

export function useEngagementSummary(source: EngagementSource) {
  const [tick, setTick] = useState(0);
  const key = `${source.id}#${tick}`;
  const [state, setState] = useState<SummaryState | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    source.summary(ctrl.signal).then(
      (data) => setState({ sourceId: source.id, key, data, error: null }),
      (error: unknown) => {
        if (ctrl.signal.aborted) return;
        // A failed background refresh keeps the numbers already on screen.
        setState((s) => ({ sourceId: source.id, key, data: s?.sourceId === source.id ? s.data : null, error }));
      },
    );
    return () => ctrl.abort();
  }, [source, key]);

  const mine = state?.sourceId === source.id ? state : null;
  const data = mine?.data ?? null;
  const live = data?.webinar.status === "live";

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    }, LIVE_REFRESH_MS);
    return () => clearInterval(id);
  }, [live]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const replace = useCallback(
    (next: EngagementSummary) => setState({ sourceId: source.id, key, data: next, error: null }),
    [source.id, key],
  );

  return {
    data,
    error: mine?.error ?? null,
    loading: mine?.key !== key,
    live,
    refresh,
    replace,
  };
}

export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

interface ListState {
  key: string;
  rows: EngagementAttendeeRow[];
  total: number;
  nextCursor?: string;
  axis?: EngagementAxis;
  error: unknown;
  loadingMore: boolean;
}

function appendUnique(a: EngagementAttendeeRow[], b: EngagementAttendeeRow[]) {
  const seen = new Set(a.map((r) => r.identity));
  return [...a, ...b.filter((r) => !seen.has(r.identity))];
}

/** Server-paged attendee rows. Search is debounced; sort and tier changes apply at once.
 *  While a new first page loads, the previous rows stay visible (`stale`). */
export function useEngagementAttendees(
  source: EngagementSource,
  filters: AttendeeFilters,
  refreshKey = "",
  limit = PAGE_SIZE,
) {
  const q = useDebounced(filters.q.trim(), SEARCH_DEBOUNCE_MS);
  const tiersKey = [...filters.tiers].sort().join(",");
  const query = useMemo<AttendeeQuery>(
    () => ({
      sort: filters.sort,
      dir: filters.dir,
      tiers: tiersKey ? (tiersKey.split(",") as Tier[]) : [],
      q,
      limit,
    }),
    [filters.sort, filters.dir, tiersKey, q, limit],
  );
  const key = `${source.id}|${JSON.stringify(query)}|${refreshKey}`;
  const [state, setState] = useState<ListState | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    source.attendees(query, ctrl.signal).then(
      (page) =>
        setState({
          key,
          rows: page.rows,
          total: page.total,
          nextCursor: page.nextCursor,
          axis: page.axis,
          error: null,
          loadingMore: false,
        }),
      (error: unknown) => {
        if (!ctrl.signal.aborted) setState({ key, rows: [], total: 0, error, loadingMore: false });
      },
    );
    return () => ctrl.abort();
  }, [source, query, key]);

  const current = state?.key === key ? state : null;

  const loadMore = useCallback(() => {
    if (!current?.nextCursor || current.loadingMore) return;
    const cursor = current.nextCursor;
    const at = key;
    setState({ ...current, loadingMore: true });
    const settle = (update: (s: ListState) => ListState) =>
      setState((s) => (s && s.key === at && s.nextCursor === cursor ? update(s) : s));
    source.attendees({ ...query, cursor }).then(
      (page) =>
        settle((s) => ({
          ...s,
          rows: appendUnique(s.rows, page.rows),
          total: page.total,
          nextCursor: page.nextCursor,
          error: null,
          loadingMore: false,
        })),
      (error: unknown) => settle((s) => ({ ...s, error, loadingMore: false })),
    );
  }, [current, key, source, query]);

  return {
    rows: state?.rows ?? [],
    total: state?.total ?? 0,
    axis: state?.axis,
    hasMore: !!current?.nextCursor,
    loading: !state,
    stale: !!state && !current,
    loadingMore: current?.loadingMore ?? false,
    error: current?.error ?? null,
    loadMore,
  };
}

interface DetailState {
  key: string;
  data: EngagementAttendeeDetail | null;
  error: unknown;
}

export function useAttendeeDetail(source: EngagementSource, identity: string | null) {
  const [tick, setTick] = useState(0);
  const key = identity ? `${source.id}|${identity}#${tick}` : null;
  const [state, setState] = useState<DetailState | null>(null);

  useEffect(() => {
    if (!identity || !key) return;
    const ctrl = new AbortController();
    source.attendee(identity, ctrl.signal).then(
      (data) => setState({ key, data, error: null }),
      (error: unknown) => {
        if (!ctrl.signal.aborted) setState({ key, data: null, error });
      },
    );
    return () => ctrl.abort();
  }, [source, identity, key]);

  const mine = key && state?.key === key ? state : null;
  const retry = useCallback(() => setTick((n) => n + 1), []);
  return { data: mine?.data ?? null, error: mine?.error ?? null, loading: !!key && !mine, retry };
}
