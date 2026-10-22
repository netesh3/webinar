/* The host home's list filters, in the address bar.
 *
 * ?tab= picks the list (upcoming, past, drafts, attending), and ?q=, ?from=,
 * ?to= narrow it — the same three on every tab. Kept in the URL so a refresh,
 * the back button from a webinar page, or a copied link opens the same list
 * narrowed the same way. Defaults are left out, so the bare /host is still the
 * unfiltered Upcoming list.
 *
 * ?recording=with|without narrows Completed (tab=past) to sessions that do, or
 * do not, have a playable recording. It means nothing on the other tabs, so it
 * is only read and written alongside tab=past.
 *
 * Pure, so it is tested without a browser: lib/host-list-url.test.mts. */

export type ListUrlState = {
  /** As written in the address, "" when absent. The screen decides which tabs exist. */
  tab: string;
  q: string;
  from: string;
  to: string;
  /** Completed only: "" is every session. */
  recording: RecordingFilter;
};

/** The Completed tab's recording filter, the API's ?recording= spelled the same. */
export type RecordingFilter = "" | "with" | "without";

/** The tab the recording filter belongs to. */
export const RECORDING_TAB = "past";

/** A value the API takes, or "" — a hand-edited ?recording=yes is not a 422. */
export function urlRecording(raw: string | null | undefined): RecordingFilter {
  const v = (raw ?? "").trim();
  return v === "with" || v === "without" ? v : "";
}

/** The tab the bare address means. Not written to the URL. */
export const DEFAULT_LIST_TAB = "upcoming";

/** A real calendar date in the form the API takes, or "". A hand-edited
 *  ?from=March would otherwise be a 422 the host never asked for. */
export function urlDate(raw: string | null | undefined): string {
  const v = (raw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return "";
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : "";
}

export function parseListUrl(params: { get(name: string): string | null }): ListUrlState {
  const tab = params.get("tab") ?? "";
  return {
    tab,
    q: params.get("q") ?? "",
    from: urlDate(params.get("from")),
    to: urlDate(params.get("to")),
    recording: tab === RECORDING_TAB ? urlRecording(params.get("recording")) : "",
  };
}

/** The query string (no leading "?") for one list state. Empty for the default. */
export function listUrlQuery(s: ListUrlState): string {
  const qs = new URLSearchParams();
  if (s.tab && s.tab !== DEFAULT_LIST_TAB) qs.set("tab", s.tab);
  const q = s.q.trim();
  if (q) qs.set("q", q);
  const from = urlDate(s.from);
  const to = urlDate(s.to);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const recording = s.tab === RECORDING_TAB ? urlRecording(s.recording) : "";
  if (recording) qs.set("recording", recording);
  return qs.toString();
}

/** basePath plus the state's query, the href the screen writes with replaceState. */
export function listUrl(basePath: string, s: ListUrlState): string {
  const qs = listUrlQuery(s);
  return qs ? `${basePath}?${qs}` : basePath;
}

/** Whether two states ask for the same list. q compares trimmed: "abc " and "abc"
 *  are the same request. */
export function sameListState(a: ListUrlState, b: ListUrlState): boolean {
  return listUrlQuery(a) === listUrlQuery(b);
}

/** Any narrowing at all, the "Clear" button and the "No sessions match" empty state. */
export function filtersActive(
  s: Pick<ListUrlState, "q" | "from" | "to"> & { recording?: RecordingFilter },
): boolean {
  return s.q.trim() !== "" || s.from !== "" || s.to !== "" || (s.recording ?? "") !== "";
}

/** The date ends ordered rather than validated: a range picked later-date-first
 *  is still a range. */
export function orderedRange(from: string, to: string): { from: string; to: string } {
  return from !== "" && to !== "" && from > to ? { from: to, to: from } : { from, to };
}
