"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HostWebinarRows } from "./host-webinar-list";
import { Alert, Spinner, Tabs } from "./controls";
import { CloseIcon, SearchIcon } from "./icons";
import { Button, ButtonLink, Empty } from "./ui";
import { ApiError, api, type HostWebinarTab } from "@/lib/api";
import type { HostWebinarCounts, HostWebinarPage, Webinar } from "@/lib/api-types";
import { DEV_BYPASS_WEBINARS } from "@/lib/dev-bypass";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";

/* The host's own list: Upcoming / Past / Drafts, searchable, date-filtered, and
 * read one page at a time.
 *
 * All four of those are the server's job, which is the whole reason this
 * component exists rather than the filtering living in host-webinar-list.tsx as
 * it once did. A host with three hundred past sessions was downloading all
 * three hundred on every visit to render ten rows. Now a tab click, a keystroke
 * and a date are one request each, and the tab badges come back with the page
 * because nothing here can count rows it was never sent.
 */

const TABS: readonly HostWebinarTab[] = ["upcoming", "past", "drafts"];

const TAB_LABELS: Record<HostWebinarTab, string> = {
  upcoming: "Upcoming",
  past: "Past",
  drafts: "Drafts",
};

/** Matches store.DefaultHostWebinarLimit. Sent explicitly rather than left to
 *  the server's default so the number the UI reasons about ("of 34", when to
 *  offer Load more) is the number it actually asked for. */
const PAGE_SIZE = 10;

/** Long enough that a host typing a title is one request rather than fifteen,
 *  short enough that stopping to read the result never feels like waiting. */
const SEARCH_DEBOUNCE_MS = 300;

const NO_COUNTS: HostWebinarCounts = { upcoming: 0, past: 0, drafts: 0 };

/** What the toolbar is currently asking for, in the form the controls hold it:
 *  plain strings, empty meaning "no restriction". */
type Filters = {
  tab: HostWebinarTab;
  q: string;
  from: string;
  to: string;
};

/** The same thing in the form the API takes, with the empties dropped so an
 *  untouched filter contributes no query parameter at all. */
type PageQuery = {
  tab: HostWebinarTab;
  limit: number;
  cursor?: string;
  q?: string;
  from?: string;
  to?: string;
};

/* pageQuery also normalises the date ends, ordering them rather than validating.
 * A host who sets the later date first has expressed a range, not made a
 * mistake — native date inputs are happy to be filled in either order — and
 * returning nothing would be the widget arguing with them. */
function pageQuery(f: Filters, cursor?: string): PageQuery {
  const swap = f.from !== "" && f.to !== "" && f.from > f.to;
  return {
    tab: f.tab,
    limit: PAGE_SIZE,
    cursor,
    q: f.q.trim() || undefined,
    from: (swap ? f.to : f.from) || undefined,
    to: (swap ? f.from : f.to) || undefined,
  };
}

export function HostWebinarBrowser({
  /** Bumped by the parent after it creates or starts a webinar, to pull the
   *  list back in step with what just happened. */
  reloadToken = 0,
  /** Reports the tab tallies up so the page heading can say "3 upcoming"
   *  without a second request for a list this component already holds. */
  onCounts,
}: {
  reloadToken?: number;
  onCounts?: (counts: HostWebinarCounts) => void;
}) {
  const bypass = isDevAuthBypassActive();

  const [tab, setTab] = useState<HostWebinarTab>("upcoming");
  // Two search values: what is in the box, and what has been asked for. The
  // gap between them is the debounce.
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [items, setItems] = useState<Webinar[] | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [counts, setCounts] = useState<HostWebinarCounts>(NO_COUNTS);
  const [total, setTotal] = useState(0);
  const [pending, setPending] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Every reply is checked against this before it is allowed to write state.
   *
   * A debounced search and a Load more in flight at the same time are two
   * requests whose replies can arrive in either order; without a sequence
   * number, a slow first page can land after the page it was superseded by, or
   * an append can staple yesterday's rows onto today's filter. */
  const seq = useRef(0);

  const filtersActive = q !== "" || from !== "" || to !== "";
  const nothingAtAll =
    !filtersActive &&
    counts.upcoming === 0 &&
    counts.past === 0 &&
    counts.drafts === 0;

  // Debounce only the text box. A tab click or a date pick is deliberate and
  // final, so those go straight through.
  useEffect(() => {
    if (typed === q) return;
    const t = setTimeout(() => setQ(typed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [typed, q]);

  const fetchPage = useCallback(
    (f: Filters, next?: string): Promise<HostWebinarPage> => {
      const query = pageQuery(f, next);
      return bypass
        ? Promise.resolve(bypassPage(query))
        : api.hostWebinars(query);
    },
    [bypass],
  );

  /* Not async, and the state writes are inside .then() —
   * react-hooks/set-state-in-effect rejects an async function called from an
   * effect body, the same shape admin-screen.tsx's load has. */
  const load = useCallback(() => {
    const mine = ++seq.current;
    fetchPage({ tab, q, from, to })
      .then((page) => {
        if (seq.current !== mine) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setCounts(page.counts);
        setTotal(page.total);
        setError(null);
      })
      .catch((e: unknown) => {
        if (seq.current !== mine) return;
        setItems([]);
        setCounts(NO_COUNTS);
        setTotal(0);
        // Hosting revoked mid-session: the parent already renders the screen
        // that explains that, so there is nothing useful to say twice here.
        if (e instanceof ApiError && e.code === "not_a_host") return;
        setError(
          e instanceof Error ? e.message : "Could not load your webinars.",
        );
      })
      .finally(() => {
        if (seq.current === mine) setPending(false);
      });
  }, [fetchPage, tab, q, from, to]);

  useEffect(load, [load, reloadToken]);

  /* Only ever reported from an unfiltered page.
   *
   * Counts are narrowed by the search and the dates, which is what the tab
   * badges want and the opposite of what the page heading above wants: "3
   * upcoming" there is a summary of the host's schedule, and it must not drop
   * to 3 because they typed "security" into a box. A filtered page has no
   * answer to the question the parent is asking, so it says nothing and the
   * heading keeps the last real one. */
  useEffect(() => {
    if (!filtersActive) onCounts?.(counts);
  }, [counts, filtersActive, onCounts]);

  function loadMore() {
    if (!cursor || loadingMore) return;
    const mine = seq.current;
    setLoadingMore(true);
    fetchPage({ tab, q, from, to }, cursor)
      .then((page) => {
        // A filter changed while this was in the air: those rows answer a
        // question nobody is asking any more.
        if (seq.current !== mine) return;
        setItems((prev) => [...(prev ?? []), ...page.items]);
        setCursor(page.nextCursor);
        setCounts(page.counts);
        setTotal(page.total);
      })
      .catch((e: unknown) => {
        if (seq.current !== mine) return;
        setError(e instanceof Error ? e.message : "Could not load more.");
      })
      .finally(() => {
        if (seq.current === mine) setLoadingMore(false);
      });
  }

  /** Any filter change restarts the list from the first page — a cursor is a
   *  position in one specific result set and means nothing in the next one. */
  function refilter(apply: () => void) {
    apply();
    setPending(true);
    setCursor(undefined);
  }

  function clearFilters() {
    refilter(() => {
      setTyped("");
      setQ("");
      setFrom("");
      setTo("");
    });
  }

  return (
    <>
      {/* Tabs and filters share one rule: the tabs pick which sessions, the
          controls to their right narrow them, and a second line between the two
          would imply they were separate things. */}
      <div className="mb-4 border-b border-line">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <Tabs
              bare
              tabs={TABS}
              value={tab}
              onChange={(next) => refilter(() => setTab(next))}
              labels={TAB_LABELS}
              counts={counts}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 pb-2.5 sm:pb-2">
            <label className="relative">
              <span className="sr-only">Search webinars by name</span>
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
              <input
                type="search"
                className="field h-9 w-full pl-8 text-[13px] sm:w-56"
                placeholder="Search by name…"
                value={typed}
                onChange={(e) => refilter(() => setTyped(e.target.value))}
              />
              {pending && typed !== "" && (
                <Spinner className="absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
              )}
            </label>

            {/* One bordered group, not two loose inputs: a range is a single
                idea, and the arrow between the ends says which way it runs. No
                icon of our own in front — each date input draws its own picker
                indicator, and a third calendar glyph on one control is clutter
                pretending to be a label. */}
            <div className="flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
              <DateEnd
                label="Show webinars from this date"
                value={from}
                onChange={(v) => refilter(() => setFrom(v))}
              />
              <span aria-hidden className="text-[11px] text-ink-3">
                →
              </span>
              <DateEnd
                label="Show webinars up to this date"
                value={to}
                onChange={(v) => refilter(() => setTo(v))}
              />
            </div>

            {filtersActive && (
              <button
                type="button"
                onClick={clearFilters}
                className="flex h-9 items-center gap-1 rounded-lg px-2 text-[12.5px] text-ink-2 hover:bg-surface-2 hover:text-ink"
              >
                <CloseIcon className="size-3.5" />
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {items === null ? (
        <div className="grid gap-3">
          <div className="h-24 animate-pulse rounded-xl bg-surface-2" />
          <div className="h-24 animate-pulse rounded-xl bg-surface-2" />
        </div>
      ) : items.length === 0 ? (
        error ? null : (
          <EmptyList
            tab={tab}
            filtersActive={filtersActive}
            nothingAtAll={nothingAtAll}
            onClear={clearFilters}
          />
        )
      ) : (
        <>
          {/* Dimmed rather than replaced with a spinner while a new filter is
              in flight: the rows underneath are still the answer to the last
              question, and blanking them makes the page jump on every
              keystroke. */}
          <div className={pending ? "opacity-50 transition-opacity" : undefined}>
            <HostWebinarRows webinars={items} />
          </div>

          {cursor ? (
            <div className="mt-4 flex flex-col items-center gap-1.5">
              <Button
                variant="secondary"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? <Spinner className="size-3.5" /> : "Load more"}
              </Button>
              <p className="text-[12px] text-ink-3 tabular-nums">
                Showing {items.length} of {total}
              </p>
            </div>
          ) : (
            items.length > PAGE_SIZE && (
              <p className="mt-4 text-center text-[12px] text-ink-3 tabular-nums">
                All {items.length} shown
              </p>
            )
          )}
        </>
      )}
    </>
  );
}

/** One end of the range. Bare inside its group's border — a field outline
 *  around each end would read as two separate filters. */
function DateEnd({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <input
      type="date"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-[6.6rem] bg-transparent text-[12.5px] text-ink outline-none [&::-webkit-calendar-picker-indicator]:opacity-45"
    />
  );
}

function EmptyList({
  tab,
  filtersActive,
  nothingAtAll,
  onClear,
}: {
  tab: HostWebinarTab;
  filtersActive: boolean;
  nothingAtAll: boolean;
  onClear: () => void;
}) {
  if (filtersActive) {
    return (
      <Empty
        title="No webinars match"
        hint="Try a different name, a wider date range, or another tab — the counts above show where your matches are."
        action={
          <Button variant="secondary" onClick={onClear}>
            Clear filters
          </Button>
        }
      />
    );
  }

  // Nothing anywhere, not just nothing in this tab. No action button: the two
  // rows above this list already are the actions, and repeating "Create
  // webinar" a third time says nothing new.
  if (nothingAtAll) {
    return (
      <Empty
        title="No webinars yet"
        hint="Start one instantly, or schedule one above — then share the link."
      />
    );
  }

  if (tab === "drafts") return <Empty title="No drafts" />;
  if (tab === "past") return <Empty title="No past webinars" />;
  return (
    <Empty
      title="Nothing upcoming"
      hint="Create a webinar, then Host it from this list when it's time."
      action={<ButtonLink href="/host/new">Create webinar</ButtonLink>}
    />
  );
}

/* ------------------------------------------------------------ local preview
 *
 * Auth bypass has no API behind it, so the fixtures are filtered, ordered and
 * sliced here under the same rules store.ByHostPage applies. Without this every
 * control on the toolbar above would look broken in the one mode that exists
 * for reviewing how controls look.
 */
function bypassPage(p: PageQuery): HostWebinarPage {
  const q = p.q?.toLowerCase() ?? "";
  const narrowed = DEV_BYPASS_WEBINARS.filter((w) => {
    if (q && !w.topic.toLowerCase().includes(q)) return false;
    const day = w.startsAt.slice(0, 10);
    if (p.from && day < p.from) return false;
    if (p.to && day > p.to) return false;
    return true;
  });

  const counts: HostWebinarCounts = {
    upcoming: narrowed.filter(
      (w) => w.status === "scheduled" || w.status === "live",
    ).length,
    past: narrowed.filter((w) => w.status === "ended").length,
    drafts: narrowed.filter((w) => w.status === "draft").length,
  };

  const inTab = narrowed
    .filter((w) =>
      p.tab === "past"
        ? w.status === "ended"
        : p.tab === "drafts"
          ? w.status === "draft"
          : w.status === "scheduled" || w.status === "live",
    )
    .sort((a, b) =>
      p.tab === "past"
        ? b.startsAt.localeCompare(a.startsAt)
        : a.startsAt.localeCompare(b.startsAt),
    );

  // The cursor is the previous page's last slug, matching the server's keyset
  // shape closely enough that Load more exercises the same code path.
  const start = p.cursor ? inTab.findIndex((w) => w.id === p.cursor) + 1 : 0;
  const items = inTab.slice(start, start + p.limit);
  const last = items.at(-1);

  return {
    items,
    counts,
    total:
      p.tab === "past"
        ? counts.past
        : p.tab === "drafts"
          ? counts.drafts
          : counts.upcoming,
    nextCursor:
      last && start + items.length < inTab.length ? last.id : undefined,
  };
}
