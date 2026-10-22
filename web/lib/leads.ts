/* Hot leads and the follow-up writer, the pure half: tags, the signal chips, the CSV, the
 * groups, the empty states, and turning a follow-up draft into WhatsApp template wording.
 *
 * The ranking itself is the server's (api/internal/leads); nothing here re-scores anybody.
 *
 * No imports but types, so node runs the tests as they are:
 *   node --experimental-strip-types --no-warnings lib/leads.test.mts */
import type { CRMParam, CRMSegment, Lead, LeadSignals } from "./api-types";

export type LeadTag = "hot" | "warm" | "cold";
export type FollowupGroupKey = "hot" | "attended" | "left_early" | "no_show";

/** The four groups, in the order the follow-up writer shows them. */
export const FOLLOWUP_GROUPS: FollowupGroupKey[] = ["hot", "attended", "left_early", "no_show"];

export function tagLabel(tag: string): string {
  if (tag === "hot") return "Hot";
  if (tag === "warm") return "Warm";
  return "Cold";
}

/** The Badge tone for a tag: hot reads as the live red, warm as amber, cold quiet. */
export function tagTone(tag: string): "live" | "warn" | "neutral" {
  if (tag === "hot") return "live";
  if (tag === "warm") return "warn";
  return "neutral";
}

function n(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What somebody did, as short chips, most telling first. */
export function leadChips(s: LeadSignals): string[] {
  const out: string[] = [];
  if (!s.joined) {
    out.push("No-show");
  } else {
    out.push(`Watched ${s.watchMin} min (${s.watchPct}%)`);
  }
  if (s.offerClicks) out.push("Clicked offer");
  if (s.questions) out.push(n(s.questions, "question"));
  if (s.upvotes) out.push(n(s.upvotes, "upvote"));
  if (s.onStage) out.push("Came on stage");
  if (s.raisedHand) out.push("Raised hand");
  if (s.chats) out.push(n(s.chats, "chat message"));
  if (s.pollAnswers) out.push(n(s.pollAnswers, "poll answer"));
  if (s.replayMin) out.push(`Replay ${s.replayMin} min`);
  else if (s.replayOpened) out.push("Opened replay");
  return out;
}

export function groupLabel(group: string): string {
  switch (group) {
    case "hot":
      return "Hot leads";
    case "attended":
      return "Attended";
    case "left_early":
      return "Left early";
    case "no_show":
      return "Didn't join";
  }
  return group;
}

export function groupHint(group: string): string {
  switch (group) {
    case "hot":
      return "The most engaged: stayed, asked, chatted.";
    case "attended":
      return "Stayed for at least half the session.";
    case "left_early":
      return "Joined, but left before half-way.";
    case "no_show":
      return "Registered, never joined.";
  }
  return "";
}

/** The people in one follow-up group. Hot overlaps the others. */
export function leadsInGroup(leads: readonly Lead[], group: string): Lead[] {
  return leads.filter((l) => (group === "hot" ? l.tag === "hot" : l.group === group));
}

/** A cell a spreadsheet will not run as a formula, quoted when it needs to be. */
export function csvCell(v: string | number | boolean): string {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEADER = [
  "Rank",
  "Name",
  "Email",
  "Phone",
  "Score",
  "Tag",
  "Group",
  "Watch min",
  "Watch %",
  "Questions",
  "Upvotes",
  "Chat messages",
  "Poll answers",
  "Raised hand",
  "On stage",
  "Reason",
];

/** The ranked list as CSV, in the order given, with a header row. */
export function leadsCsv(leads: readonly Lead[]): string {
  const rows = leads.map((l, i) =>
    [
      i + 1,
      l.name,
      l.email ?? "",
      l.phone ?? "",
      l.score,
      tagLabel(l.tag),
      groupLabel(l.group),
      l.signals.watchMin,
      l.signals.joined ? l.signals.watchPct : 0,
      l.signals.questions ?? 0,
      l.signals.upvotes ?? 0,
      l.signals.chats ?? 0,
      l.signals.pollAnswers ?? 0,
      l.signals.raisedHand ? "yes" : "no",
      l.signals.onStage ? "yes" : "no",
      l.reason ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  return [CSV_HEADER.join(","), ...rows].join("\r\n") + "\r\n";
}

/** A file name for an export: "hot-leads-money-basics.csv". */
export function csvFileName(prefix: string, topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${prefix}${slug ? `-${slug}` : ""}.csv`;
}

/** A line under the hot leads when the AI reasons are not there; null when they are. */
export function leadsAINote(aiStatus: string): string | null {
  switch (aiStatus) {
    case "ready":
    case "empty":
      return null;
    case "not_ended":
      return "AI reasons are added once the session ends.";
    case "ai_off":
      return "AI is switched off for this account, so there are no AI reasons. The ranking is counted from what people did.";
    case "ai_session_off":
      return "AI was off for this session, so there are no AI reasons. Sessions with the AI switch on get them automatically. The ranking is counted from what people did.";
    case "ai_limit":
      return "AI limit reached for this month, so there are no AI reasons. The ranking is counted from what people did.";
    case "ai_unavailable":
      return "AI reasons aren't available right now. They'll appear when you open Results again.";
    case "processing":
      return "Writing the AI reasons…";
  }
  return "The AI reasons couldn't be written just now. They'll be tried again when you open Results.";
}

export type FollowupsEmpty = { title: string; detail: string; pending?: boolean };

/** What the follow-up writer says with no drafts; null when it has them. */
export function followupsEmptyState(status: string): FollowupsEmpty | null {
  switch (status) {
    case "ready":
      return null;
    case "not_ended":
      return { title: "Not yet", detail: "Follow-up drafts are written once the session ends." };
    case "ai_off":
      return {
        title: "AI is switched off for this account",
        detail: "Ask us to turn on AI writing to get follow-up drafts after every session.",
      };
    case "ai_session_off":
      return {
        title: "AI was off for this session",
        detail: "AI was off for this session, so there are no AI drafts. Sessions with the AI switch on get them automatically. You can still export each group below.",
      };
    case "ai_limit":
      return {
        title: "AI limit reached for this month",
        detail: "Follow-up drafts will be written again next month. You can still export each group below.",
      };
    case "ai_unavailable":
      return { title: "AI isn't available right now", detail: "Open Results again in a minute." };
    case "empty":
      return { title: "Nobody to follow up", detail: "Nobody registered for or joined this session." };
    case "processing":
      return { title: "Writing the drafts…", detail: "This takes a few seconds.", pending: true };
  }
  return { title: "The drafts couldn't be written", detail: "They'll be tried again when you open Results." };
}

/** The sentence for an API refusal of the follow-ups. */
export function followupsErrorStatus(code: string | undefined): string {
  if (code === "ai_limit") return "ai_limit";
  if (code === "ai_unavailable") return "ai_unavailable";
  return "failed";
}

/* waTemplateWording turns a WhatsApp draft into wording for a template, which is what a
 * business-initiated WhatsApp to a group must be (Meta's 24-hour rule): {{first_name}}
 * becomes the template's {{1}}, filled from the contact's first name; the replay link,
 * which a broadcast cannot fill per person, is written in as it is (or the placeholder
 * dropped when there is no replay); {{offer_link}} is dropped. */
export function waTemplateWording(
  text: string,
  replayLink: string | undefined,
): { body: string; params: CRMParam[] } {
  let body = text.replace(/\{\{\s*first_name\s*\}\}/g, "{{1}}");
  body = body.replace(/\{\{\s*replay_link\s*\}\}/g, replayLink ?? "");
  body = body.replace(/\{\{\s*offer_link\s*\}\}/g, "");
  body = body
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const params: CRMParam[] = body.includes("{{1}}") ? [{ field: "first_name" }] : [];
  return { body, params };
}

/** The CRM segment for a group by watch time, for "Send to this group" (hot is sent as the
 *  picked contacts instead). Half the session, rounded up, is the line. */
export function groupSegment(group: string, sessionMin: number): CRMSegment | null {
  const half = Math.max(1, Math.ceil(sessionMin / 2));
  switch (group) {
    case "attended":
      return { attendance: "joined", minWatchMin: half };
    case "left_early":
      return { attendance: "joined", maxWatchMin: half };
    case "no_show":
      return { attendance: "no_show" };
  }
  return null;
}

/** Downloads a CSV in the browser, as lib/calendar.ts's downloadIcs does: the object URL is
 *  revoked on the next tick, since revoking it in the same frame cancels Safari's download.
 *  A byte-order mark first, so Excel reads names in any script as UTF-8. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}

/** The CRM contacts of a group's people, for a WhatsApp send to exactly them. */
export function groupContactIds(leads: readonly Lead[], group: string): string[] {
  return leadsInGroup(leads, group)
    .map((l) => l.contactId ?? "")
    .filter(Boolean);
}
