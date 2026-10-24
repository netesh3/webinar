"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { EndedNudge } from "./ended-nudge";
import { useSession } from "./providers";
import { HostWebinarRows } from "./host-webinar-list";
import { AttendingList } from "./attending-list";
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
import { Button, ButtonLink, Empty, ListPager } from "./ui";
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
  type HostListKind,
} from "@/lib/host-list-cache";
import { readCache, TTL_LIST, writeCache } from "@/lib/http";
import {
  FeatureInstantWebinar,
  type HostRecordingSummary,
  type HostWebinarCounts,
  type HostWebinarPage,
  type Webinar,
} from "@/lib/api-types";
import { DEV_BYPASS_WEBINARS } from "@/lib/dev-bypass";
import { presentForHostList } from "@/lib/webinar-status";
import {
  filtersActive as hasFilters,
  listUrl,
  orderedRange,
  parseListUrl,
  RECORDING_TAB,
  urlRecording,
  type ListUrlState,
  type RecordingFilter,
} from "@/lib/host-list-url";
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
 * It has its own paged endpoint (GET /api/me/attending, AttendingList) under the
 * same search and dates; tab, search and dates are all in the URL.
 */

const TABS: readonly HostWebinarTab[] = ["upcoming", "past", "drafts"];

/* Not a HostWebinarTab, and named apart from them so it cannot be passed to the
 * paged endpoint by accident: AttendingList reads
 * /api/me/attending itself. Everything that fetches below narrows this out
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

/** The tabs that do not read the paged host webinar endpoint. */
function ownList(t: ViewTab): t is typeof ATTENDING {
  return t === ATTENDING;
}

const TAB_LABELS: Record<ViewTab, string> = {
  upcoming: "Upcoming",
  past: "Completed",
  drafts: "Drafts",
  attending: "Attending",
};

/** The same glyphs the glance rail used, now on the tab that already shows the count. */
const TAB_ICONS: Record<ViewTab, ReactNode> = {
  upcoming: <CalendarIcon className="size-3.5 shrink-0" />,
  past: <CheckIcon className="size-3.5 shrink-0" />,
  drafts: <ClipboardIcon className="size-3.5 shrink-0" />,
  attending: <UsersIcon className="size-3.5 shrink-0" />,
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
  /** Completed only; ignored on the other tabs. */
  recording: RecordingFilter;
};

/** The same thing in the form the API takes, with the empties dropped so an
 *  untouched filter contributes no query parameter at all. */
type PageQuery = {
  tab: HostWebinarTab;
  kind: HostListKind;
  limit: number;
  cursor?: string;
  q?: string;
  from?: string;
  to?: string;
  recording?: "with" | "without";
};

/* pageQuery also normalises the date ends, ordering them rather than validating.
 * A host who sets the later date first has expressed a range, not made a
 * mistake — native date inputs are happy to be filled in either order — and
 * returning nothing would be the widget arguing with them. */
function pageQuery(f: Filters, kind: HostListKind, cursor?: string): PageQuery {
  const range = orderedRange(f.from, f.to);
  return {
    tab: f.tab,
    kind,
    limit: PAGE_SIZE,
    cursor,
    q: f.q.trim() || undefined,
    from: range.from || undefined,
    to: range.to || undefined,
    recording: (f.tab === RECORDING_TAB && f.recording) || undefined,
  };
}

/** The Completed tab's recording choices, in the API's words. */
const RECORDING_OPTIONS: { id: RecordingFilter; label: string }[] = [
  { id: "", label: "All" },
  { id: "with", label: "With recording" },
  { id: "without", label: "Without recording" },
];

export function HostWebinarBrowser({
  /** Bumped by the parent after it creates or starts a webinar, to pull the
   *  list back in step with what just happened. */
  reloadToken = 0,
  /** The one-time "hosting is on" note is up, so Attending is worth a mark
   *  until they dismiss it. The tab itself only exists once there is a row. */
  attendingHint = false,
  /** Which list: the Webinars page (everything but meetings, with Attending) or the
   *  Meetings page (meetings only). The server filters, so the counts and paging are
   *  the list's own. */
  kind = "webinar",
}: {
  reloadToken?: number;
  attendingHint?: boolean;
  kind?: HostListKind;
}) {
  const bypass = isDevAuthBypassActive();
  const meetings = kind === "meeting";
  const basePath = meetings ? "/host/meetings" : "/host";
  const noun = meetings ? "meetings" : "webinars";

  /* Only for the tab's badge. The list itself calls this too, and the hook holds
   * its state per caller, so the count is here rather than lifted: reading it
   * costs the same request the top nav already makes on every page, and the
   * alternative — an unbadged tab — loses the one number that says whether it is
   * worth opening. */
  const { accountRegistrations, webinarFor } = useRegistrations();
  const { account } = useSession();
  /* Other people's webinars only: a host who registered for their own session to
   * see the attendee side has it under Upcoming or Completed already. Unknown
   * (still loading) counts as none: the tab appears once the answer is in,
   * rather than showing and then vanishing for a host with nothing to attend. */
  const attendingCount =
    accountRegistrations?.filter((r) => {
      const w = webinarFor(r.webinarId);
      return w !== undefined && w.host.id !== account?.id;
    }).length ?? 0;

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
  // Attending is the Webinars page's: it lists other people's webinars this account joined.
  const reachable = (t: ViewTab) => LINKABLE.includes(t) && !(meetings && t === ATTENDING);
  const [tab, setTabState] = useState<ViewTab>(() =>
    messagesLink || peopleLink || !reachable(askedTab) ? "upcoming" : askedTab,
  );
  // Adjusted while rendering rather than in an effect: a new link is a new tab now.
  const linkKey = search.toString();
  const [seenLink, setSeenLink] = useState(linkKey);
  /* The search and dates are in the address too (see lib/host-list-url.ts), so a
   * refresh or the back button from a webinar opens the list narrowed the same way. */
  const linked = parseListUrl(search);
  // Two search values: what is in the box, and what has been asked for. The
  // gap between them is the debounce.
  const [typed, setTyped] = useState(linked.q);
  const [q, setQ] = useState(linked.q);
  const [from, setFrom] = useState(linked.from);
  const [to, setTo] = useState(linked.to);
  /* Completed's recording filter. Kept while another tab is open, but only sent,
   * written to the URL and counted as a filter on Completed itself. */
  const [recordingPick, setRecording] = useState<RecordingFilter>(linked.recording);
  const recording: RecordingFilter = tab === RECORDING_TAB ? recordingPick : "";
  if (linkKey !== seenLink) {
    setSeenLink(linkKey);
    if (!messagesLink && !peopleLink && reachable(askedTab)) setTabState(askedTab);
    /* Our own replaceState lands here too, carrying exactly what is already in
     * state, so this only changes anything for a link or a history step. The box
     * is only overwritten when the committed search moved: text still inside the
     * debounce is the host mid-word, not a stale value. */
    if (linked.q.trim() !== q.trim()) {
      setQ(linked.q);
      setTyped(linked.q);
    }
    if (linked.from !== from) setFrom(linked.from);
    if (linked.to !== to) setTo(linked.to);
    // A link to another tab carries no recording filter; leave the pick alone for it.
    if (askedTab === RECORDING_TAB && linked.recording !== recordingPick) setRecording(linked.recording);
  }

  /* Mirrored with history.replaceState, not router.replace: a router navigation
   * is a server round trip per keystroke, and Next syncs replaceState into
   * useSearchParams without one (schedule-form.tsx's ?step= does the same).
   * Replace rather than push, so Back leaves the page instead of undoing a filter. */
  const writeUrl = useCallback(
    (next: ListUrlState) => {
      const href = listUrl(basePath, next);
      if (`${window.location.pathname}${window.location.search}` === href) return;
      window.history.replaceState(window.history.state, "", href);
    },
    [basePath],
  );
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
  /* Switching tabs by hand keeps the search and dates — they narrow every tab —
   * and drops anything else an old link carried (?contact=, ?webinar=). */
  const setTab = useCallback(
    (next: ViewTab) => {
      setTabState(next);
      writeUrl({ tab: next, q, from, to, recording: recordingPick });
    },
    [writeUrl, q, from, to, recordingPick],
  );

  const [items, setItems] = useState<Webinar[] | null>(null);
  const [recordings, setRecordings] = useState<Record<string, HostRecordingSummary>>({});
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
  const listKey = listing ? hostListFilterKey(tab, q, from, to, kind, recording) : "";
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
      setRecordings(hit.value.recordings ?? {});
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

  /* A meeting is started or scheduled, never saved as a draft, so Drafts is only on the
   * Meetings page when one somehow exists. */
  const listTabs: readonly ViewTab[] = meetings
    ? BASE_TABS.filter((t) => t !== "drafts" || counts.drafts > 0)
    : BASE_TABS;
  const viewTabs: readonly ViewTab[] =
    !meetings && attendingCount > 0 ? [...listTabs, ATTENDING] : listTabs;

  const filtersActive = hasFilters({ q, from, to, recording });
  const nothingAtAll =
    !filtersActive &&
    counts.upcoming === 0 &&
    counts.past === 0 &&
    counts.drafts === 0;

  // Debounce only the text box. A tab click or a date pick is deliberate and
  // final, so those go straight through.
  useEffect(() => {
    if (typed === q) return;
    const t = setTimeout(() => {
      setQ(typed);
      writeUrl({ tab, q: typed, from, to, recording });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [typed, q, tab, from, to, recording, writeUrl]);

  const fetchPage = useCallback(
    (f: Filters, next?: string): Promise<HostWebinarPage> => {
      const query = pageQuery(f, kind, next);
      return bypass
        ? Promise.resolve(bypassPage(query))
        : api.hostWebinars(query);
    },
    [bypass, kind],
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
    fetchPage({ tab, q, from, to, recording }, cursor)
      .then((result) => {
        if (seq.current !== mine) return;
        setItems(result.items ?? []);
        setRecordings(result.recordings ?? {});
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
          e instanceof Error ? e.message : `Could not load your ${noun}.`,
        );
      })
      .finally(() => {
        if (seq.current === mine) setPending(false);
      });
  }, [fetchPage, tab, q, from, to, recording, listKey, cacheKey, pageNow, noun]);

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
    /* Attending reads its own endpoint and dims its own rows. Raising this flag
     * there would wait on a request this component never makes. */
    if (!ownList(tab)) setPending(true);
  }

  function clearFilters() {
    refilter(() => {
      setTyped("");
      setQ("");
      setFrom("");
      setTo("");
      setRecording("");
    });
    writeUrl({ tab, q: "", from: "", to: "", recording: "" });
  }

  function pickRecording(next: RecordingFilter) {
    refilter(() => setRecording(next));
    writeUrl({ tab, q, from, to, recording: next });
  }

  function setRange(nextFrom: string, nextTo: string) {
    refilter(() => {
      setFrom(nextFrom);
      setTo(nextTo);
    });
    writeUrl({ tab, q, from: nextFrom, to: nextTo, recording });
  }

  /* The Attending tab's own total under the current filters, once it has read
   * one, so its badge narrows with the search like the host tabs' do. */
  const [attendingSeen, setAttendingSeen] = useState<{ key: string; total: number } | null>(null);
  const attendingKey = `${q.trim()}\0${orderedRange(from, to).from}\0${orderedRange(from, to).to}`;
  const attendingBadge =
    attendingSeen && attendingSeen.key === attendingKey ? attendingSeen.total : attendingCount;
  const onAttendingTotal = useCallback(
    (key: string, total: number) => setAttendingSeen({ key, total }),
    [],
  );

  return (
    <>
      {/* The follow-up column sits beside this list from 900px up and under it
          below that. The tab row is a cell of the list column, not of the page,
          so Search and Filter end where the list ends and never cross into
          Recent webinars. An empty week draws no second column, and the list
          keeps the full width. */}
      <div className="grid min-w-0 grid-cols-1 items-start gap-y-4 min-[900px]:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0 border-b border-line min-[900px]:col-start-1 min-[900px]:row-start-1">
        {/* Tabs and filters share one rule: the tabs pick which sessions, the
            controls to their right narrow them, and a second line between the two
            would imply they were separate things. */}
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
          <div className="min-w-0 sm:flex-1">
            <Tabs
              bare
              tabs={viewTabs.includes(tab) ? viewTabs : [...viewTabs, tab]}
              value={tab}
              /* Attending fetches itself, so it skips refilter: that would raise
                 the pending flag for a request this tab never makes. */
              onChange={(next) => {
                setTab(next);
                if (!ownList(next)) setPending(true);
              }}
              labels={TAB_LABELS}
              icons={TAB_ICONS}
              marks={attendingHint ? { [ATTENDING]: true } : undefined}
              counts={{
                ...counts,
                [ATTENDING]: attendingBadge,
              }}
            />
          </div>

          {/* One toolbar for every tab: the same search and dates narrow the
              host's own lists and Attending alike, each on its own endpoint. */}
          <div className="flex min-w-0 items-center gap-2 pb-2.5 sm:max-w-[min(28rem,62%)] sm:shrink sm:pb-2">
            <label className="relative min-w-0 grow shrink sm:max-w-56 sm:grow-0 sm:basis-56">
              <span className="sr-only">
                {ownList(tab) ? "Search by title or host" : `Search ${noun} by name`}
              </span>
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
              <input
                type="search"
                className="field h-9 w-full min-w-0 pl-8 text-[13px]"
                placeholder={ownList(tab) ? "Search title or host…" : "Search by name…"}
                value={typed}
                onChange={(e) => refilter(() => setTyped(e.target.value))}
              />
              {pending && !ownList(tab) && typed !== "" && (
                <Spinner className="absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
              )}
            </label>

            <DateRangeField
              from={from}
              to={to}
              size="sm"
              emptyLabel="Filter"
              className="shrink-0 [&_button]:max-w-44"
              ariaLabel={`Filter ${noun} by date`}
              onChange={setRange}
            />

            {/* Completed only: nothing upcoming or drafted has a recording yet. */}
            {tab === RECORDING_TAB && (
              <label className="shrink-0">
                <span className="sr-only">Filter {noun} by recording</span>
                <select
                  className={`field h-9 w-auto py-0 pr-7 pl-2.5 text-[12.5px] ${recording ? "border-brand-line text-brand" : ""}`}
                  value={recording}
                  onChange={(e) => pickRecording(urlRecording(e.target.value))}
                >
                  {RECORDING_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.id === "" ? "Any recording" : o.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {filtersActive && (
              <button
                type="button"
                onClick={clearFilters}
                className="flex h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-[12.5px] text-ink-2 hover:bg-surface-2 hover:text-ink"
              >
                <CloseIcon className="size-3.5" />
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="min-w-0 w-full min-[900px]:col-start-1 min-[900px]:row-start-2">
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
        /* Its own loading, empty, error and paging: the rows carry a join key
           and a calendar link, which is what an attendee came for and is
           nothing like a host row. */
        <AttendingList
          q={q}
          from={from}
          to={to}
          onClear={clearFilters}
          onTotal={onAttendingTotal}
        />
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
              kind={kind}
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
                  : `The last ${noun} on this page were removed, or the page is past the end of the list.`
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
              <HostWebinarRows webinars={items} recordings={recordings} />
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
      {tab === "upcoming" && !meetings && (
        <EndedNudge className="min-[900px]:col-start-2 min-[900px]:row-start-2 min-[900px]:ml-4" />
      )}
      </div>
    </>
  );
}

function EmptyList({
  tab,
  kind,
  filtersActive,
  nothingAtAll,
  onClear,
}: {
  tab: HostWebinarTab;
  kind: HostListKind;
  filtersActive: boolean;
  nothingAtAll: boolean;
  onClear: () => void;
}) {
  const { account } = useSession();
  if (kind === "meeting") {
    if (filtersActive) {
      return (
        <Empty
          title="No meetings match"
          hint="Try a different name, a wider date range, or another tab — the counts above show where your matches are."
          action={
            <Button variant="secondary" onClick={onClear}>
              Clear filters
            </Button>
          }
        />
      );
    }
    if (nothingAtAll) {
      return (
        <Empty
          title="No meetings yet"
          hint="Start one now or schedule one above, then share the link."
        />
      );
    }
    if (tab === "past") {
      return (
        <Empty
          title="No past meetings yet"
          hint="Once a meeting ends, it moves here."
        />
      );
    }
    if (tab === "drafts") return <Empty title="No drafts" />;
    return (
      <Empty
        title="Nothing upcoming"
        hint="Schedule one, and share the link."
        action={<ButtonLink href="/host/new/meeting">Schedule a meeting</ButtonLink>}
      />
    );
  }
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
  const now = Date.now();
  const narrowed = DEV_BYPASS_WEBINARS.filter((w) => {
    if ((w.kind === "meeting") !== (p.kind === "meeting")) return false;
    if (q && !w.topic.toLowerCase().includes(q)) return false;
    const day = w.startsAt.slice(0, 10);
    if (p.from && day < p.from) return false;
    if (p.to && day > p.to) return false;
    return true;
  }).map((w) => presentForHostList(w, now));

  const counts: HostWebinarCounts = {
    upcoming: narrowed.filter(
      (w) => w.status === "scheduled" || w.status === "live",
    ).length,
    past: narrowed.filter((w) => w.status === "ended").length,
    drafts: narrowed.filter((w) => w.status === "draft").length,
  };

  // The fixtures carry no recordings: "with" is empty and "without" is everything.
  const noneRecorded = p.tab === "past" && p.recording === "with";
  if (noneRecorded) counts.past = 0;

  const inTab = narrowed
    .filter(() => !noneRecorded)
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
