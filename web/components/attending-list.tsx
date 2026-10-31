"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RegisteredCard } from "./my-webinars-list";
import { Alert } from "./controls";
import { Button, Empty, ListPager } from "./ui";
import { api } from "@/lib/api";
import type { AttendingPage, RegisteredWebinar } from "@/lib/api-types";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { onHostListsDropped } from "@/lib/host-list-cache";
import { orderedRange } from "@/lib/host-list-url";
import { useVisibleRefresh } from "@/lib/visible-refresh";

/* The host home's Attending tab: other people's sessions this account registered
 * for, read a page at a time from GET /api/me/attending.
 *
 * It used to be every registration at once, oldest first, split into Upcoming
 * and Past. That list only grows, and the session somebody is looking for is
 * almost always the latest one, so the server now orders it: live first (the
 * one you can join right now), then newest start first. Search and dates are
 * the same toolbar the host's own tabs use, applied on the server. */

/** Rows per page. Matches store.DefaultAttendingLimit. */
export const ATTENDING_PAGE_SIZE = 20;

export function AttendingList({
  q,
  from,
  to,
  onClear,
  onTotal,
}: {
  q: string;
  from: string;
  to: string;
  onClear: () => void;
  /** The total for this filter, for the tab's badge. */
  onTotal?: (filterKey: string, total: number) => void;
}) {
  const bypass = isDevAuthBypassActive();
  const range = orderedRange(from, to);
  const filterKey = `${q.trim()}\0${range.from}\0${range.to}`;

  const [seenKey, setSeenKey] = useState(filterKey);
  const [page, setPage] = useState(0);
  // cursors[i] is what page i is read with; page 0 has none.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [items, setItems] = useState<RegisteredWebinar[] | null>(null);
  const [total, setTotal] = useState(0);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gen, setGen] = useState(0);

  // A new search or date range starts again at page 1. Adjusted while rendering
  // rather than in an effect, so the old filter's page 3 is never requested.
  if (filterKey !== seenKey) {
    setSeenKey(filterKey);
    setPage(0);
    setCursors([undefined]);
    setPending(true);
  }

  const seq = useRef(0);
  const cursor = cursors[page];
  useEffect(() => {
    const mine = ++seq.current;
    const [sq, sfrom, sto] = filterKey.split("\0");
    const read: Promise<AttendingPage> = bypass
      ? Promise.resolve({ items: [], total: 0 })
      : api.attending({
          q: sq || undefined,
          from: sfrom || undefined,
          to: sto || undefined,
          limit: ATTENDING_PAGE_SIZE,
          cursor,
        });
    read
      .then((res) => {
        if (seq.current !== mine) return;
        setItems(res.items ?? []);
        setTotal(res.total);
        setError(null);
        setCursors((prev) => {
          const next = prev.slice(0, page + 1);
          if (res.nextCursor) next[page + 1] = res.nextCursor;
          return next;
        });
        onTotal?.(filterKey, res.total);
      })
      .catch((e: unknown) => {
        if (seq.current !== mine) return;
        setItems((prev) => prev ?? []);
        setError(e instanceof Error ? e.message : "Could not load the sessions you're attending.");
      })
      .finally(() => {
        if (seq.current === mine) setPending(false);
      });
    // onTotal is a report, not an input: a new callback identity is not a new page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bypass, filterKey, page, cursor, gen]);

  const refresh = useCallback(() => setGen((n) => n + 1), []);
  useVisibleRefresh(refresh);
  useEffect(() => onHostListsDropped(refresh), [refresh]);

  function goTo(index: number) {
    if (index < 0 || index === page) return;
    if (index > page && cursors[index] === undefined) return;
    setPending(true);
    setPage(index);
  }

  const narrowed = q.trim() !== "" || from !== "" || to !== "";

  if (items === null) {
    if (error) {
      return (
        <Empty
          title="Couldn't load the sessions you're attending"
          hint={`${error} Your registrations are safe — this is a problem reaching the server.`}
          action={
            <Button
              onClick={() => {
                setPending(true);
                setError(null);
                setGen((n) => n + 1);
              }}
            >
              Try again
            </Button>
          }
        />
      );
    }
    return (
      <div className="grid gap-3">
        <div className="h-32 animate-pulse rounded-xl bg-surface-2" />
        <div className="h-32 animate-pulse rounded-xl bg-surface-2" />
      </div>
    );
  }

  return (
    <>
      {error && (
        <div className="mb-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      {items.length === 0 && page === 0 ? (
        narrowed ? (
          <Empty
            title="No sessions match"
            hint="Try a different title or host name, or a wider date range."
            action={
              <Button variant="secondary" onClick={onClear}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <Empty
            title="You haven't registered for anything yet"
            hint="Open an invitation link to register for a session. Your personal join link will show up here."
          />
        )
      ) : items.length === 0 ? (
        <Empty
          title="Nothing on this page"
          hint="The list changed while it was open. Page 1 still has the rest."
          action={
            <Button variant="secondary" onClick={() => goTo(0)}>
              Back to page 1
            </Button>
          }
        />
      ) : (
        <div className={`grid gap-3${pending ? " opacity-50 transition-opacity" : ""}`}>
          {items.map(({ webinar, registration }) => (
            <RegisteredCard
              key={webinar.id}
              webinar={webinar}
              registration={registration}
              past={webinar.status === "ended"}
            />
          ))}
        </div>
      )}
      <ListPager
        page={page + 1}
        pages={
          cursors[page + 1]
            ? Math.max(page + 2, Math.ceil(total / ATTENDING_PAGE_SIZE) || 1)
            : page + 1
        }
        pageSize={ATTENDING_PAGE_SIZE}
        start={items.length === 0 ? 0 : page * ATTENDING_PAGE_SIZE + 1}
        end={items.length === 0 ? 0 : page * ATTENDING_PAGE_SIZE + items.length}
        total={total}
        busy={pending}
        onPrevious={() => goTo(page - 1)}
        onNext={() => goTo(page + 1)}
      />
    </>
  );
}
