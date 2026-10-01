"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { EndedNudge } from "./ended-nudge";
import { useSession } from "./providers";
import { HostWebinarRows } from "./host-webinar-list";
import { MyWebinarsList } from "./my-webinars-list";
import { useRegistrations } from "./registrations";
import { Alert, Spinner, Tabs } from "./controls";
import { DateRangeField } from "./date-picker";
import {
  CalendarIcon,
  CheckIcon,
  ClipboardIcon,
  CloseIcon,
  SearchIcon,
  UsersIcon,
} from "./icons";
import { Button, ButtonLink, Card, Empty, ListPager } from "./ui";
import { ApiError, api, type HostWebinarTab } from "@/lib/api";
import {
  HOST_WEBINAR_PAGE_SIZE,
  hostListFilterKey,
  hostListPageKey,
  onHostListsDropped,
  rememberCursors,
  rememberPage,
  rememberedCursors,
  rememberedPage,
} from "@/lib/host-list-cache";
import { readCache, TTL_LIST, writeCache } from "@/lib/http";
import {
  FeatureInstantWebinar,
  type HostWebinarCounts,
  type HostWebinarPage,
  type Webinar,
} from "@/lib/api-types";
import { DEV_BYPASS_WEBINARS } from "@/lib/dev-bypass";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";

/* The host's own list: Upcoming / Completed / Drafts, searchable, date-filtered, and
 * read one page at a time.
 *
 * All four of those are the server's job, which is the whole reason this
 * component exists rather than the filtering living in host-webinar-list.tsx as
 * it once did. A host with three hundred past sessions was downloading all
 * three hundred on every visit to render ten rows. Now a tab click, a keystroke
 * and a date are one request each, and the tab badges come back with the page
 * because nothing here can count rows it was never sent.
 *
 * Attending sits on the end of that row, and is the one tab this endpoint knows
 * nothing about: it is the sessions other people host that this account signed up
 * for as an attendee, which used to be "My Webinar" in the top nav and then an
 * entry in the account menu. Hosting and attending are two things one person
 * does, not two places they go — so it lives here, where every other list of this
 * person's sessions already is, and only shows up once there is something in it.
 */

const TABS: readonly HostWebinarTab[] = ["upcoming", "past", "drafts"];

/* Not a HostWebinarTab, and named apart from them so it cannot be passed to the
 * paged endpoint by accident: MyWebinarsList resolves join keys and
 * /api/me/registrations itself. Everything that fetches below narrows this out
 * first. */
const ATTENDING = "attending";
/** The tab's old ?tab= name, from when the account menu linked to it. Still read, so a
 *  link or bookmark made then opens the same list. */
const ATTENDING_LEGACY = "registered";

/* Audience is its own page (/host/audience). An old ?tab=people link is sent
 * there. Messages is /host/messages, and an old ?tab=messages link is sent there. */
const PEOPLE = "people";
const MESSAGES = "messages";
type ViewTab = HostWebinarTab | typeof ATTENDING;

/* Shown in the tab row: the webinar lists, then Attending — webinars other people
 * host that this account signed up for — but only once there is at least one. */
const BASE_TABS: readonly ViewTab[] = [...TABS];
const LINKABLE: readonly ViewTab[] = [...TABS, ATTENDING];

/** The tabs that do not read the paged webinar endpoint, and so hide its filters. */
function ownList(t: ViewTab): t is typeof ATTENDING {
  return t === ATTENDING;
}

const TAB_LABELS: Record<ViewTab, string> = {
  upcoming: "Upcoming",
  past: "Completed",
  drafts: "Drafts",
  attending: "Attending",
};

/** Matches store.DefaultHostWebinarLimit. Sent explicitly rather than left to
 *  the server's default so "10 per page · 1–10 of 24" is the number asked for.
 *  Shared with the prefetch on the host home so both ask for the same page. */
const PAGE_SIZE = HOST_WEBINAR_PAGE_SIZE;

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
}: {
  reloadToken?: number;
}) {
  const bypass = isDevAuthBypassActive();

  /* Only for the tab's badge. The list itself calls this too, and the hook holds
   * its state per caller, so the count is here rather than lifted: reading it
   * costs the same request the top nav already makes on every page, and the
   * alternative — an unbadged tab — loses the one number that says whether it is
   * worth opening. */
  const { registrations, webinarFor } = useRegistrations();
  const { account } = useSession();
  /* Other people's webinars only: a host who registered for their own session to
   * see the attendee side has it under Upcoming or Completed already. Unknown
   * (still loading) counts as none: the tab appears once the answer is in,
   * rather than showing and then vanishing for a host with nothing to attend. */
  const attendingCount =
    registrations?.filter((r) => {
      const w = webinarFor(r.webinarId);
      return w !== undefined && w.host.id !== account?.id;
    }).length ?? 0;
  const viewTabs: readonly ViewTab[] =
    attendingCount > 0 ? [...BASE_TABS, ATTENDING] : BASE_TABS;

  /* ?tab= picks the tab, and is followed, not just read once, because those links
   * are usually clicked while the host is already on this page. Messages used to
   * be one of them; it is its own screen now, so that query leaves this page. */
  const router = useRouter();
  const search = useSearchParams();
  const rawTab = search.get("tab") ?? "";
  const messagesLink = rawTab === MESSAGES;
  const peopleLink = rawTab === PEOPLE;
  const askedTab = (
    rawTab === ATTENDING_LEGACY ? ATTENDING : rawTab
  ) as ViewTab;
  const linkedContact = search.get("contact") ?? "";
  const linkedWebinar = search.get("webinar") ?? "";
  const linkedFilter = search.get("filter") ?? "";
  const reachable = (t: ViewTab) =>
    viewTabs.includes(t) || t === ATTENDING || LINKABLE.includes(t);
  const [tab, setTabState] = useState<ViewTab>(() =>
    messagesLink || peopleLink || !reachable(askedTab) ? "upcoming" : askedTab,
  );
  // Adjusted while rendering rather than in an effect: a new link is a new tab now.
  const linkKey = search.toString();
  const [seenLink, setSeenLink] = useState(linkKey);
  if (linkKey !== seenLink) {
    setSeenLink(linkKey);
    if (!messagesLink && !peopleLink && reachable(askedTab)) setTabState(askedTab);
  }
  useEffect(() => {
    if (!messagesLink) return;
    const params = new URLSearchParams();
    if (linkedContact) params.set("contact", linkedContact);
    if (linkedWebinar) params.set("webinar", linkedWebinar);
    const q = params.toString();
    router.replace(q ? `/host/messages?${q}` : "/host/messages");
  }, [messagesLink, linkedContact, linkedWebinar, router]);
  useEffect(() => {
    if (!peopleLink) return;
    const params = new URLSearchParams();
    if (linkedWebinar) params.set("webinar", linkedWebinar);
    if (linkedFilter) params.set("filter", linkedFilter);
    const q = params.toString();
    router.replace(q ? `/host/audience?${q}` : "/host/audience");
  }, [peopleLink, linkedWebinar, linkedFilter, router]);
  /* Switching tabs by hand drops whatever a link had narrowed to. */
  const setTab = useCallback(
    (next: ViewTab) => {
      setTabState(next);
      if (search.toString() !== "") router.replace("/host");
    },
    [router, search],
  );
  // Two search values: what is in the box, and what has been asked for. The
  // gap between them is the debounce.
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [items, setItems] = useState<Webinar[] | null>(null);
  const [counts, setCounts] = useState<HostWebinarCounts>(NO_COUNTS);
  const [total, setTotal] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  /* Every reply is checked against this before it is allowed to write state.
   *
   * A debounced search and a page change in flight at the same time are two
   * requests whose replies can arrive in either order; without a sequence
   * number, a slow first page can land after the page it was superseded by. */
  const seq = useRef(0);

  const listing = !ownList(tab);
  const listKey = listing ? hostListFilterKey(tab, q, from, to) : "";
  const [seenList, setSeenList] = useState(listKey);
  const pageNow = listKey !== "" && listKey !== seenList ? rememberedPage(listKey) : page;
  if (listKey !== seenList) {
    setSeenList(listKey);
    if (listKey !== "") setPage(rememberedPage(listKey));
  }
  const cacheKey = listKey ? hostListPageKey(listKey, pageNow) : "";
  const [seenCache, setSeenCache] = useState("");
  if (listing && cacheKey !== seenCache) {
    setSeenCache(cacheKey);
    const hit = readCache<HostWebinarPage>(cacheKey, TTL_LIST);
    if (hit) {
      setItems(hit.value.items ?? []);
      setCounts(hit.value.counts);
      setTotal(hit.value.total);
      setError(null);
      setPending(false);
      const stack = rememberedCursors(listKey).slice();
      if (hit.value.nextCursor) stack[pageNow + 1] = hit.value.nextCursor;
      rememberCursors(listKey, stack);
    } else {
      setItems(null);
      setPending(true);
    }
  }

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
    /* Nothing to ask this endpoint for. Returning before the sequence number is
     * bumped deliberately leaves any reply still in the air free to land: it is
     * the answer for the tab behind this one, which is where a host goes back to. */
    if (!listKey || ownList(tab)) return;
    const hit = readCache<HostWebinarPage>(cacheKey, TTL_LIST);
    if (hit?.fresh) return;

    const mine = ++seq.current;
    const cursor = rememberedCursors(listKey)[pageNow];
    fetchPage({ tab, q, from, to }, cursor)
      .then((result) => {
        if (seq.current !== mine) return;
        setItems(result.items ?? []);
        setCounts(result.counts);
        setTotal(result.total);
        setError(null);
        const stack = rememberedCursors(listKey).slice();
        if (result.nextCursor) stack[pageNow + 1] = result.nextCursor;
        else stack.length = pageNow + 1;
        rememberCursors(listKey, stack);
        writeCache(hostListPageKey(listKey, pageNow), result);
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
  }, [fetchPage, tab, q, from, to, listKey, cacheKey, pageNow]);

  const [listGen, setListGen] = useState(0);
  useEffect(load, [load, reloadToken, listGen]);

  useEffect(
    () =>
      onHostListsDropped(() => {
        setPage(0);
        setItems(null);
        setPending(true);
        setListGen((n) => n + 1);
      }),
    [],
  );

  function goTo(index: number) {
    if (!listKey || index < 0 || index === pageNow) return;
    if (index > pageNow && rememberedCursors(listKey)[index] === undefined) return;
    rememberPage(listKey, index);
    setPage(index);
  }

  /** A search or a date starts again at page 1. A tab click restores that tab's page. */
  function refilter(apply: () => void) {
    apply();
    setPending(true);
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
              tabs={viewTabs.includes(tab) ? viewTabs : [...viewTabs, tab]}
              value={tab}
              /* Attending has nothing to re-filter and fetches itself, so it
                 skips refilter: that would raise the pending flag for a request
                 this tab never makes, and leave the rows behind it dimmed. */
              onChange={(next) =>
                ownList(next) ? setTab(next) : refilter(() => setTab(next))
              }
              labels={TAB_LABELS}
              counts={{
                ...counts,
                [ATTENDING]: attendingCount,
              }}
            />
          </div>

          {/* Hidden on Attending rather than disabled. Both controls are
              arguments to the host's paged endpoint; leaving them up over a list
              they cannot narrow is a control that lies about what it does. */}
          {!ownList(tab) && (
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

              <DateRangeField
                from={from}
                to={to}
                size="sm"
                ariaLabel="Filter webinars by date"
                onChange={(nextFrom, nextTo) =>
                  refilter(() => {
                    setFrom(nextFrom);
                    setTo(nextTo);
                  })
                }
              />

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
          )}
        </div>
      </div>

      <div className="grid items-start gap-4 min-[900px]:grid-cols-[minmax(0,1fr)_17.5rem]">
        <div className="min-w-0">
      {error && !ownList(tab) && (
        <div className="mb-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {messagesLink || peopleLink ? (
        <div className="grid place-items-center py-16">
          <Spinner />
        </div>
      ) : tab === ATTENDING ? (
        /* Its own loading, empty and error states, unchanged from the page this
           used to be: the rows carry a join key and a calendar link, which is
           what an attendee came for and is nothing like a host row. */
        <MyWebinarsList othersOnly />
      ) : items === null ? (
        <div className="grid gap-3">
          <div className="h-24 animate-pulse rounded-xl bg-surface-2" />
          <div className="h-24 animate-pulse rounded-xl bg-surface-2" />
        </div>
      ) : error && items.length === 0 && pageNow === 0 ? null : (
        <>
          {/* Dimmed rather than replaced with a spinner while a new filter is
              in flight: the rows underneath are still the answer to the last
              question, and blanking them makes the page jump on every
              keystroke. A cached page is shown as it is, then refreshed. */}
          {items.length === 0 && pageNow === 0 ? (
            <EmptyList
              tab={tab}
              filtersActive={filtersActive}
              nothingAtAll={nothingAtAll}
              onClear={clearFilters}
            />
          ) : items.length === 0 ? (
            <Empty
              title={tab === "drafts" ? "No drafts on this page" : "Nobody on this page"}
              hint={
                tab === "drafts"
                  ? "The last draft was published while this page was open. Page 1 still has the rest."
                  : "The last webinars on this page were removed, or the page is past the end of the list."
              }
              action={
                <Button variant="secondary" onClick={() => goTo(0)}>
                  Back to page 1
                </Button>
              }
            />
          ) : (
            <div
              className={pending ? "opacity-50 transition-opacity" : undefined}
            >
              <HostWebinarRows webinars={items} />
            </div>
          )}

          {/* Always under the list, including one page and an empty list.
              Page 1 of 1 leaves Previous and Next disabled. */}
          <ListPager
            page={pageNow + 1}
            pages={
              listKey && rememberedCursors(listKey)[pageNow + 1]
                ? Math.max(pageNow + 1, Math.ceil(total / PAGE_SIZE) || 1)
                : pageNow + 1
            }
            pageSize={PAGE_SIZE}
            start={items.length === 0 ? 0 : pageNow * PAGE_SIZE + 1}
            end={items.length === 0 ? 0 : pageNow * PAGE_SIZE + items.length}
            total={total}
            busy={pending}
            onPrevious={() => goTo(pageNow - 1)}
            onNext={() => goTo(pageNow + 1)}
          />
        </>
      )}
        </div>
        <aside className="grid content-start gap-3">
          <AtAGlance counts={counts} attending={attendingCount} />
          {tab === "upcoming" && <EndedNudge rail />}
        </aside>
      </div>
    </>
  );
}

/** Counts already on this page: the tab badges, plus Attending. */
function AtAGlance({
  counts,
  attending,
}: {
  counts: HostWebinarCounts;
  attending: number;
}) {
  const rows: { label: string; value: number; icon: ReactNode; tint: string }[] = [
    {
      label: "Upcoming",
      value: counts.upcoming,
      icon: <CalendarIcon className="size-4" />,
      tint: "bg-brand-soft text-brand",
    },
    {
      label: "Completed",
      value: counts.past,
      icon: <CheckIcon className="size-4" />,
      tint: "bg-ok-soft text-ok",
    },
    {
      label: "Drafts",
      value: counts.drafts,
      icon: <ClipboardIcon className="size-4" />,
      tint: "bg-surface-2 text-ink-2",
    },
    {
      label: "Attending",
      value: attending,
      icon: <UsersIcon className="size-4" />,
      tint: "bg-brand-soft text-brand",
    },
  ];
  return (
    <Card className="p-4">
      <h2 className="text-[14px] font-semibold text-ink">At a glance</h2>
      <ul className="mt-3 grid gap-2.5">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center gap-2.5">
            <span className={`grid size-8 shrink-0 place-items-center rounded-lg ${row.tint}`}>
              {row.icon}
            </span>
            <span className="min-w-0 flex-1 text-[13px] text-ink-2">{row.label}</span>
            <span className="text-[14px] font-semibold tabular-nums text-ink">{row.value}</span>
          </li>
        ))}
      </ul>
    </Card>
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
  const { account } = useSession();
  const instantAllowed = (account?.features ?? []).includes(
    FeatureInstantWebinar,
  );
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
        hint={
          instantAllowed
            ? "Start one instantly, or schedule one above — then share the link."
            : "Schedule one above, then share the link."
        }
      />
    );
  }

  if (tab === "drafts") return <Empty title="No drafts" />;
  if (tab === "past") {
    return (
      <Empty
        title="No completed webinars yet"
        hint="Once a session ends, it moves here with who came and how it went."
      />
    );
  }
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
  // shape closely enough that Next exercises the same code path.
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
