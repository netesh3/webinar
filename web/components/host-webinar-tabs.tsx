"use client";

import { DEFAULT_REMINDERS, describeReminders } from "./reminder-times";
import { Fragment, useEffect, useState } from "react";
import { Alert, CopyField, Spinner, Tabs } from "./controls";
import { ApprovalQueue } from "./approval-queue";
import { RecordingsTab } from "./recordings-tab";
import { CalendarIcon, ChevronDownIcon, PlusIcon, TrashIcon } from "./icons";
import { useShareOrigin, useToast } from "./providers";
import { Avatar, Badge, Button, ButtonLink, Card, SectionTitle } from "./ui";
import {
  formatCount,
  formatDay,
  formatDuration,
  formatTime,
  formatTimeRange,
  googleCalendarInviteUrl,
  tzLabel,
} from "@/lib/format";
import { ApiError, api } from "@/lib/api";
import type {
  AttendanceRow,
  Recording,
  RegistrantRow,
  SessionReport,
  Webinar,
} from "@/lib/api-types";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import {
  RosterContactsLink,
  RosterWhatsAppCells,
  RosterWhatsAppHeaders,
  useRosterWhatsAppColumns,
} from "@/engage";

/* Per-webinar management. Every tab here operates on real data — the share links
 * are built from the operator's configured public URL rather than a placeholder
 * domain, and the settings shown are the ones the session will actually run with.
 */

const TABS = [
  "Admit",
  "Attendees",
  "Share",
  "Stage",
  "Recordings",
  "Settings",
] as const;
type Tab = (typeof TABS)[number] | "Report";

const ENDED_TABS = ["Recordings", "Attendees", "Report"] as const;

function tabsFor(ended: boolean): readonly Tab[] {
  return ended ? ENDED_TABS : TABS;
}

/** An old link, or the Host list, can still ask for a tab this webinar no
 *  longer has. Anything not on offer resolves to null so the caller can fall
 *  back rather than render an empty page. */
function allowedTab(tab: Tab | null, ended: boolean): Tab | null {
  return tab && tabsFor(ended).includes(tab) ? tab : null;
}

function tabFromQuery(raw: string | null | undefined): Tab | null {
  if (!raw) return null;
  const key = raw.toLowerCase();
  if (key === "admit" || key === "registrants") return "Admit";
  if (key === "attendees" || key === "attendance") return "Attendees";
  if (key === "share") return "Share";
  if (key === "stage") return "Stage";
  if (key === "recordings") return "Recordings";
  if (key === "settings") return "Settings";
  if (key === "report") return "Report";
  return null;
}

export function HostWebinarTabs({
  webinar: w,
  registrants,
  recordings,
  onChanged,
  initialTab,
}: {
  webinar: Webinar;
  registrants: RegistrantRow[];
  recordings: Recording[];
  onChanged: () => void | Promise<void>;
  /** Deep-link from Host list: admit | attendees | share | … */
  initialTab?: string | null;
}) {
  const pending = registrants.filter((r) => r.state === "pending");
  const ended = w.status === "ended";
  const tabs = tabsFor(ended);

  const defaultTab: Tab =
    allowedTab(tabFromQuery(initialTab), ended) ??
    (ended
      ? recordings.length > 0
        ? "Recordings"
        : "Attendees"
      : pending.length > 0
        ? "Admit"
        : "Attendees");
  const [tab, setTab] = useState<Tab>(defaultTab);

  // Follow ?tab= when the host clicks Admit / Attendees from the list.
  useEffect(() => {
    const next = allowedTab(tabFromQuery(initialTab), ended);
    if (next) setTab(next);
  }, [initialTab, ended]);

  return (
    <>
      <div className="mb-4">
        <Tabs
          tabs={tabs}
          value={tab}
          onChange={setTab}
          counts={{
            Admit: pending.length,
            Attendees: registrants.length,
            Recordings: recordings.length,
          }}
        />
      </div>

      {tab === "Admit" && (
        <AdmitTab webinar={w} registrants={registrants} onChanged={onChanged} />
      )}
      {tab === "Attendees" && (
        <AttendeesTab webinar={w} registrants={registrants} />
      )}
      {tab === "Share" && <ShareTab webinar={w} />}
      {tab === "Stage" && <StageTab webinar={w} onChanged={onChanged} />}
      {tab === "Recordings" && (
        <RecordingsTab
          webinar={w}
          recordings={recordings}
          onChanged={onChanged}
        />
      )}
      {tab === "Settings" && <SettingsTab webinar={w} />}
      {tab === "Report" && <ReportTab webinar={w} />}
    </>
  );
}

// ------------------------------------------------------------- admit / attendees

function AdmitTab({
  webinar: w,
  registrants,
  onChanged,
}: {
  webinar: Webinar;
  registrants: RegistrantRow[];
  onChanged: () => void | Promise<void>;
}) {
  const pending = registrants.filter((r) => r.state === "pending");

  if (w.approval !== "manual") {
    return (
      <Card className="p-6">
        <h2 className="text-[15px] font-semibold">Automatic approval</h2>
        <p className="mt-2 max-w-md text-[13.5px] leading-relaxed text-ink-2">
          Registrants are admitted as soon as they sign up. Switch this webinar
          to manual approval in Edit if you want a waiting queue here.
        </p>
      </Card>
    );
  }

  return (
    <div className="grid gap-4">
      <div>
        <h2 className="text-[15px] font-semibold">Waiting to admit</h2>
        <p className="mt-1 text-[13px] text-ink-2">
          {pending.length === 0
            ? "Nobody is waiting. New registrations will appear here."
            : `${pending.length} ${pending.length === 1 ? "person needs" : "people need"} a decision before they can join.`}
        </p>
      </div>
      <ApprovalQueue slug={w.id} pending={pending} onChanged={onChanged} />
    </div>
  );
}

function AttendeesTab({
  webinar: w,
  registrants,
}: {
  webinar: Webinar;
  registrants: RegistrantRow[];
}) {
  const bypass = isDevAuthBypassActive();
  // The CRM's two columns, when the host has connected WhatsApp. See engage/slots.tsx.
  const whatsappOn = useRosterWhatsAppColumns();
  const approved = registrants.filter((r) => r.state === "approved");
  const declined = registrants.filter((r) => r.state === "declined");
  const ended = w.status === "ended";

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Registered"
          value={formatCount(w.registrantCount)}
          note={`of ${formatCount(w.attendeeLimit)} seats`}
        />
        <Stat
          label={ended ? "Attended" : "Approved"}
          value={
            ended && w.report
              ? formatCount(w.report.attended)
              : formatCount(approved.length)
          }
          note={
            ended && w.report
              ? `avg watch ${w.report.avgWatchMin} min`
              : `${formatCount(declined.length)} declined`
          }
        />
        <Stat
          label="Contactable"
          value={formatCount(registrants.filter((r) => !r.isGuest).length)}
          note={`${formatCount(
            registrants.filter((r) => r.isGuest).length,
          )} guests`}
        />
      </div>

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <SectionTitle>
            {ended ? "Who registered / attended" : "Registrants"}
          </SectionTitle>
          <div className="flex flex-wrap items-center gap-2">
            {/* The other thing a host wants to do with this list: talk to it — the
                same people as contacts, with tags, notes and history. */}
            <RosterContactsLink slug={w.id} />
            {!bypass && (
              <ButtonLink
                href={api.registrantsCsvUrl(w.id)}
                size="sm"
                variant="secondary"
                prefetch={false}
              >
                Export CSV
              </ButtonLink>
            )}
          </div>
        </div>

        {registrants.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-ink-3">
            Nobody has registered yet.
          </p>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[680px] text-[12.5px]">
              <thead>
                <tr className="border-b border-line text-left text-[11.5px] text-ink-3">
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="py-2 pr-3 font-medium">Company</th>
                  {whatsappOn && <RosterWhatsAppHeaders />}
                  <th className="py-2 pr-3 font-medium">Registered</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {registrants.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0">
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium">{r.name}</span>
                        {r.isGuest && <Badge>Guest</Badge>}
                      </div>
                      <div className="text-[11.5px] text-ink-3">
                        {r.isGuest ? "No email — joined as a guest" : r.email}
                      </div>
                      {/* The number was on the wire all along and never rendered,
                          which left the WhatsApp columns beside it unexplainable:
                          "no number" is only an answer if the numbers are visible.
                          Under the email because it is the same kind of fact. */}
                      {r.phone && (
                        <div className="text-[11.5px] text-ink-3">{r.phone}</div>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-ink-2">
                      {r.company || "—"}
                      {r.jobTitle && (
                        <div className="text-[11.5px] text-ink-3">
                          {r.jobTitle}
                        </div>
                      )}
                    </td>
                    {whatsappOn && <RosterWhatsAppCells row={r} />}
                    <td className="py-2.5 pr-3 text-ink-2">
                      {new Date(r.createdAt).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                      })}
                    </td>
                    <td className="py-2.5">
                      {r.state === "approved" ? (
                        <Badge tone="ok">Approved</Badge>
                      ) : r.state === "pending" ? (
                        <Badge tone="warn">Pending</Badge>
                      ) : (
                        <Badge>Declined</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// -------------------------------------------------------------------- share

function ShareTab({ webinar: w }: { webinar: Webinar }) {
  // From the operator's configured public URL, falling back to this browser's
  // origin — never a placeholder domain, which is worse than no link at all.
  const origin = useShareOrigin();

  return (
    <div className="grid gap-4">
      <Card className="p-5">
        <SectionTitle>Registration page</SectionTitle>
        {w.status === "draft" ? (
          <Alert tone="warn">
            This webinar is still a draft, so the page isn&apos;t public yet.
          </Alert>
        ) : (
          <>
            <CopyField value={`${origin}/webinars/${w.id}`} />
            <p className="mt-2.5 text-[12px] leading-relaxed text-ink-3">
              Anyone with this link can register. Approval is{" "}
              {w.approval === "manual" ? "manual" : "automatic"}
              {w.registrationRequired
                ? "."
                : ", and registration is not required to join."}
            </p>
          </>
        )}
      </Card>

      <Card className="p-5">
        <SectionTitle>Details for a calendar invite</SectionTitle>
        <div className="grid gap-3">
          <CopyField label="Webinar ID" value={w.webinarId} />
          {w.passcode && <CopyField label="Passcode" value={w.passcode} />}
          <CopyField
            label="Full invitation"
            value={
              `${w.topic}\n` +
              `${formatDay(w.startsAt, w.timeZone)}, ` +
              `${formatTimeRange(w.startsAt, w.durationMin, w.timeZone)} ` +
              `${tzLabel(w.startsAt, w.timeZone)}\n\n` +
              `Register: ${origin}/webinars/${w.id}\n` +
              `Webinar ID: ${w.webinarId}` +
              (w.passcode ? `\nPasscode: ${w.passcode}` : "")
            }
          />
          <ButtonLink
            href={googleCalendarInviteUrl({
              topic: w.topic,
              description: w.description,
              startsAt: w.startsAt,
              durationMin: w.durationMin,
              timeZone: w.timeZone,
              webinarId: w.webinarId,
              registrationUrl: `${origin}/webinars/${w.id}`,
            })}
            target="_blank"
            rel="noopener noreferrer"
            variant="secondary"
            size="sm"
            className="justify-self-start"
          >
            <CalendarIcon className="size-4" />
            Add to Google Calendar
          </ButtonLink>
        </div>
      </Card>

      <Card className="p-5">
        <SectionTitle>Host and panelist link</SectionTitle>
        <CopyField value={`${origin}/host/${w.id}/room`} />
        <p className="mt-2.5 text-[12px] leading-relaxed text-ink-3">
          Only you and the panelists on this webinar can use it — the server
          refuses to mint a publishing token for anyone else, so sharing it does
          not give anyone the stage.
        </p>
      </Card>
    </div>
  );
}

// -------------------------------------------------------------------- stage

function StageTab({
  webinar: w,
  onChanged,
}: {
  webinar: Webinar;
  onChanged: () => void | Promise<void>;
}) {
  const { notify } = useToast();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFieldError(null);
    try {
      const person = await api.addPanelist(w.id, email);
      notify(`${person.name} can now present.`, "ok");
      setEmail("");
      await onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.fields?.email)
        setFieldError(err.fields.email);
      else
        setFieldError(
          err instanceof Error ? err.message : "Could not add them.",
        );
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string, name: string) {
    setBusy(true);
    try {
      await api.removePanelist(w.id, userId);
      notify(`Removed ${name} from the stage.`, "ok");
      await onChanged();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not remove them.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <SectionTitle>On the stage · {w.panelists.length + 1}</SectionTitle>

      <div className="grid gap-2">
        <div className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5">
          <Avatar person={w.host} size={32} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">
              {w.host.name}
            </div>
            <div className="truncate text-[11.5px] text-ink-3">
              {[w.host.title, w.host.org].filter(Boolean).join(" · ")}
            </div>
          </div>
          <Badge tone="brand">Host</Badge>
        </div>

        {w.panelists.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5"
          >
            <Avatar person={p} size={32} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{p.name}</div>
              <div className="truncate text-[11.5px] text-ink-3">
                {[p.title, p.org].filter(Boolean).join(" · ")}
              </div>
            </div>
            <Badge>Panelist</Badge>
            <button
              type="button"
              onClick={() => void remove(p.id, p.name)}
              disabled={busy}
              aria-label={`Remove ${p.name} from the stage`}
              className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-live-soft hover:text-live disabled:opacity-40"
            >
              <TrashIcon className="size-4" />
            </button>
          </div>
        ))}
      </div>

      <form onSubmit={add} className="mt-4 border-t border-line pt-4">
        <label className="label" htmlFor="panelist-email">
          Invite a panelist
        </label>
        <div className="flex flex-wrap items-start gap-2">
          <input
            id="panelist-email"
            type="email"
            className={`field h-9 flex-1 text-[13px] ${fieldError ? "border-live" : ""}`}
            placeholder="colleague@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Button type="submit" size="sm" disabled={busy || !email}>
            {busy ? (
              <Spinner className="size-3.5" />
            ) : (
              <PlusIcon className="size-3.5" />
            )}
            Add
          </Button>
        </div>
        {fieldError ? (
          <p className="mt-1.5 text-[12px] font-medium text-live">
            {fieldError}
          </p>
        ) : (
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
            They need an account first: a publishing token is minted from a
            signed-in session, so there is nothing to grant an address with no
            account behind it.
          </p>
        )}
      </form>

      <p className="mt-4 rounded-lg bg-surface-2 px-3 py-2.5 text-[12px] leading-relaxed text-ink-2">
        You can also promote an attendee onto the stage while the webinar is
        running, from the participants panel.
      </p>
    </Card>
  );
}

function ReportTab({ webinar: w }: { webinar: Webinar }) {
  const bypass = isDevAuthBypassActive();
  const [rep, setRep] = useState<SessionReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (bypass) {
      setRep({
        registered: 4,
        approved: 4,
        attended: 3,
        avgWatchMin: 18,
        questions: 2,
        pollVoters: 2,
        questionRows: [],
        /* Not an empty list any more, and each row is here for a reason: the table has four
         * states worth looking at and none of them were reachable in preview.
         *
         * A rejoiner whose total is much less than their brackets (the case the whole change
         * exists for), an early arrival whose waiting time is not counted, somebody still in
         * the room, and the host — listed, labelled, and deliberately absent from the
         * attended count above. */
        attendees: BYPASS_ATTENDANCE,
      });
      return;
    }
    void api
      .sessionReport(w.id)
      .then(setRep)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Could not load the report."),
      );
  }, [w.id, bypass]);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">Session report</h2>
          <p className="mt-1 text-[13px] text-ink-2">
            Who showed up, how long they stayed, and what they asked.
          </p>
        </div>
        {!bypass && (
          <ButtonLink
            href={api.reportCsvUrl(w.id)}
            size="sm"
            variant="secondary"
            prefetch={false}
          >
            Export CSV
          </ButtonLink>
        )}
        {!bypass && (
          <ButtonLink
            href={api.transcriptUrl(w.id)}
            size="sm"
            variant="secondary"
            prefetch={false}
          >
            Transcript
          </ButtonLink>
        )}
      </div>
      {error && <Alert>{error}</Alert>}
      {!rep ? (
        <Spinner className="size-5" />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Registered" value={formatCount(rep.registered)} note="" />
            <Stat
              label="Attended"
              value={formatCount(rep.attended)}
              note={`${formatCount(rep.approved)} approved`}
            />
            <Stat
              label="Avg. watch"
              value={`${rep.avgWatchMin} min`}
              note={`${formatCount(rep.pollVoters)} poll voters`}
            />
          </div>
          <Card className="p-4">
            <SectionTitle>Who attended</SectionTitle>
            {rep.attendees.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-ink-3">
                Nobody was recorded in the room.
              </p>
            ) : (
              <AttendanceTable rows={rep.attendees} timeZone={w.timeZone} />
            )}
          </Card>
          <Card className="p-4">
            <SectionTitle>Questions</SectionTitle>
            {rep.questionRows.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-ink-3">
                No questions were asked.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-line text-[13px]">
                {rep.questionRows.map((q) => (
                  <li key={q.id} className="py-2">
                    <p>{q.text}</p>
                    <p className="mt-0.5 text-[12px] text-ink-3">
                      {q.anonymous ? "Anonymous" : q.name}
                      {q.answered ? " · answered" : ""}
                      {q.upvotes ? ` · ${q.upvotes} upvotes` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

/* The preview's attendance rows, in the local-UI mode that has no API behind it.
 *
 * Times are fixed rather than relative to now: they are only ever read through
 * formatTime(webinar.timeZone), the fixture webinar is two weeks in the past, and a clock that
 * moved would make the one screen whose job is looking at a table impossible to compare
 * against itself.
 */
const BYPASS_ATTENDANCE: AttendanceRow[] = [
  {
    identity: "att_preview_1",
    name: "Amlesh Kumar",
    email: "amlesh177@gmail.com",
    role: "attendee",
    // Watched the open and the close, nothing in the middle: brackets say 58 minutes, the
    // total says 20, and the difference is the point of the table.
    watchMin: 20,
    firstJoinedAt: "2026-09-08T09:32:00Z",
    lastLeftAt: "2026-09-08T10:30:00Z",
    visits: [
      { joinedAt: "2026-09-08T09:32:00Z", leftAt: "2026-09-08T09:44:00Z", minutes: 12 },
      { joinedAt: "2026-09-08T10:05:00Z", leftAt: "2026-09-08T10:11:00Z", minutes: 6 },
      { joinedAt: "2026-09-08T10:28:00Z", leftAt: "2026-09-08T10:30:00Z", minutes: 2 },
    ],
  },
  {
    identity: "att_preview_2",
    name: "Sunayana G",
    email: "sunayana.g23@gmail.com",
    role: "attendee",
    // Arrived twelve minutes early and sat on the waiting screen, which is not watching: in
    // at 09:18, live at 09:30, so 42 minutes rather than 54.
    watchMin: 42,
    firstJoinedAt: "2026-09-08T09:18:00Z",
    lastLeftAt: "2026-09-08T10:12:00Z",
    visits: [
      { joinedAt: "2026-09-08T09:18:00Z", leftAt: "2026-09-08T10:12:00Z", minutes: 42 },
    ],
  },
  {
    identity: "att_preview_3",
    name: "Guest",
    email: "",
    role: "attendee",
    // No departure: their laptop went to sleep and the SFU never said they left, so the row
    // has to read as "still in" rather than inventing a time.
    watchMin: 30,
    firstJoinedAt: "2026-09-08T10:00:00Z",
    lastLeftAt: "",
    visits: [{ joinedAt: "2026-09-08T10:00:00Z", leftAt: "", minutes: 30 }],
  },
  {
    identity: "user_preview_host",
    name: "Preview Host",
    email: "host@example.com",
    role: "host",
    watchMin: 60,
    firstJoinedAt: "2026-09-08T09:28:00Z",
    lastLeftAt: "2026-09-08T10:31:00Z",
    visits: [
      { joinedAt: "2026-09-08T09:28:00Z", leftAt: "2026-09-08T10:31:00Z", minutes: 60 },
    ],
  },
];

/* Who was in the room, when, and for how long.
 *
 * One row per person with their visits folded into it, rather than one row per visit. A person
 * who dropped out three times is one attendee and reads as one line; flattening the visits
 * would put them in the table three times and make "how long did they watch" a sum the reader
 * has to do. The rejoins are the interesting part, so they are a click away rather than a
 * column away — and the row says how many there were, so nobody has to open rows to find out
 * which ones have anything behind them.
 *
 * In and Out are the brackets of the whole session: first arrival, last departure. Total is the
 * sum of the visits, which for a rejoiner is LESS than Out minus In — and that gap is the
 * entire point of the table. Before this, Total was Out minus In, so somebody who watched the
 * first five minutes and the last five of an hour was reported as having watched the hour.
 */
function AttendanceTable({
  rows,
  timeZone,
}: {
  rows: AttendanceRow[];
  timeZone: string;
}) {
  /* Which rows are open, by identity. A Set rather than a flag on the row: the rows come from
   * the server on every poll of the report, and state keyed to the data would be lost each
   * time one arrived. */
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (identity: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(identity)) next.add(identity);
      return next;
    });

  return (
    <div className="-mx-4 mt-3 overflow-x-auto px-4">
      <table className="w-full min-w-[560px] text-[12.5px]">
        <thead>
          <tr className="border-b border-line text-left text-[11.5px] text-ink-3">
            <th className="py-2 pr-3 font-medium">Name</th>
            <th className="py-2 pr-3 font-medium">In</th>
            <th className="py-2 pr-3 font-medium">Out</th>
            <th className="py-2 pr-3 text-right font-medium">Total</th>
            <th className="py-2 text-right font-medium">Visits</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const expandable = a.visits.length > 1;
            const isOpen = open.has(a.identity);
            return (
              <Fragment key={a.identity}>
                <tr
                  className={`border-b border-line ${
                    expandable ? "cursor-pointer hover:bg-surface-2" : ""
                  }`}
                  onClick={expandable ? () => toggle(a.identity) : undefined}
                >
                  <td className="py-2.5 pr-3">
                    <div className="flex items-center gap-1.5">
                      {/* Only where there is something to open. A disclosure arrow on a row
                          that does nothing is a promise the row cannot keep. */}
                      {expandable ? (
                        <ChevronDownIcon
                          className={`size-3.5 shrink-0 text-ink-3 transition-transform ${
                            isOpen ? "" : "-rotate-90"
                          }`}
                        />
                      ) : (
                        <span aria-hidden className="size-3.5 shrink-0" />
                      )}
                      <span className="font-medium">{a.name}</span>
                      {/* The stage is in this list, labelled, because "was my panelist there
                          for the whole hour?" is a real question — but the counts above are
                          attendees only, so a host is never in their own audience figures. */}
                      {a.role !== "attendee" && (
                        <Badge tone={a.role === "host" ? "brand" : "neutral"}>
                          {a.role === "host" ? "Host" : "Panelist"}
                        </Badge>
                      )}
                    </div>
                    {a.email && (
                      <div className="text-[11.5px] text-ink-3">{a.email}</div>
                    )}
                  </td>
                  <td className="py-2.5 pr-3 text-ink-2 tabular-nums">
                    {a.firstJoinedAt ? formatTime(a.firstJoinedAt, timeZone) : "—"}
                  </td>
                  <td className="py-2.5 pr-3 text-ink-2 tabular-nums">
                    {/* No departure means they were still in the room when this was read,
                        which is a different fact from "left at the end" and has to look
                        different. */}
                    {a.lastLeftAt ? (
                      formatTime(a.lastLeftAt, timeZone)
                    ) : (
                      <span className="text-ink-3">still in</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">
                    {formatDuration(a.watchMin)}
                  </td>
                  <td className="py-2.5 text-right text-ink-2 tabular-nums">
                    {a.visits.length}
                  </td>
                </tr>

                {expandable && isOpen && (
                  <tr className="border-b border-line bg-surface-2/40">
                    <td colSpan={5} className="px-3 py-2">
                      <ul className="grid gap-1">
                        {a.visits.map((v, i) => (
                          <li
                            key={`${v.joinedAt}-${i}`}
                            className="flex items-center gap-2 text-[11.5px] text-ink-2 tabular-nums"
                          >
                            <span className="text-ink-3">{i + 1}.</span>
                            <span>{formatTime(v.joinedAt, timeZone)}</span>
                            <span aria-hidden className="text-ink-3">
                              →
                            </span>
                            <span>
                              {v.leftAt ? (
                                formatTime(v.leftAt, timeZone)
                              ) : (
                                <span className="text-ink-3">still in</span>
                              )}
                            </span>
                            <span className="text-ink-3">
                              ({formatDuration(v.minutes)})
                            </span>
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {/* Said once, under the table, rather than as a footnote on every row that shows it.
          Somebody comparing Total against In and Out will notice they disagree, and the reason
          is the feature rather than a bug. */}
      {rows.some((a) => a.visits.length > 1) && (
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-3">
          Total is time actually present, so it is less than In to Out for anyone who left and
          came back. Time spent waiting before the webinar went live is not counted.
        </p>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- settings

/** The settings the session will run with, read from the webinar record. Editing
 *  them is the schedule form's job; showing them here is so a host can confirm
 *  what they are about to go live with without opening it. */
function SettingsTab({ webinar: w }: { webinar: Webinar }) {
  const rows: [string, boolean | string][] = [
    ["Attendees hidden from each other", w.controls.hideAttendees],
    ["Panelists muted on entry", w.controls.muteOnEntry],
    ["Panelists may unmute themselves", w.controls.allowUnmute],
    ["Attendee chat", w.controls.chatEnabled],
    ["Q&A", w.controls.qaEnabled],
    ["Raise hand", w.controls.raiseHandEnabled],
    ["Reactions", w.controls.reactionsEnabled],
    ["Locked to new attendees", w.controls.locked],
    ["Registration required", w.registrationRequired],
    ["Practice session", w.options.practiceSession],
    ["Record automatically", w.options.autoRecord],
    ["Live captions", w.options.captions],
    ["Email reminders", w.options.emailReminders !== false],
    // Shown whether or not it is on, because "no WhatsApp message will be sent" is
    // the fact a host is checking here — and the default is off.
    ["WhatsApp reminders", w.options.whatsappReminders === true],
    ["Reminder times", describeReminders(w.options.reminders ?? DEFAULT_REMINDERS)],
    ["Attendee limit", formatCount(w.attendeeLimit)],
    ["Time zone", w.timeZone],
  ];

  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>Session settings</SectionTitle>
        <ButtonLink href={`/host/${w.id}/edit`} size="sm" variant="secondary">
          Edit
        </ButtonLink>
      </div>

      <dl className="divide-y divide-line">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex items-center justify-between gap-6 py-2.5"
          >
            <dt className="text-[13px] text-ink-2">{label}</dt>
            <dd className="shrink-0 text-[13px]">
              {typeof value === "boolean" ? (
                value ? (
                  <Badge tone="ok">On</Badge>
                ) : (
                  <Badge>Off</Badge>
                )
              ) : (
                <span className="text-ink-2">{value}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-4 border-t border-line pt-3 text-[12px] leading-relaxed text-ink-3">
        Everything under &ldquo;how the session starts&rdquo; can also be
        changed live from the host controls once the webinar is running.
      </p>
    </Card>
  );
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <Card className="p-4">
      <div className="text-[12px] text-ink-2">{label}</div>
      <div className="mt-1.5 text-[22px] font-semibold tracking-[-0.02em] tabular-nums">
        {value}
      </div>
      <div className="mt-0.5 text-[11.5px] text-ink-3">{note}</div>
    </Card>
  );
}
