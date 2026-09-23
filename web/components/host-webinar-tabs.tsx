"use client";

import { useEffect, useState } from "react";
import { Alert, CopyField, Spinner, Tabs } from "./controls";
import { ApprovalQueue } from "./approval-queue";
import { RecordingsTab } from "./recordings-tab";
import { CalendarIcon, PlusIcon, TrashIcon } from "./icons";
import { useShareOrigin, useToast } from "./providers";
import { Avatar, Badge, Button, ButtonLink, Card, SectionTitle } from "./ui";
import {
  formatCount,
  formatDay,
  formatTimeRange,
  googleCalendarInviteUrl,
  tzLabel,
} from "@/lib/format";
import { ApiError, api } from "@/lib/api";
import type { Recording, RegistrantRow, SessionReport, Webinar } from "@/lib/api-types";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";

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

        {registrants.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-ink-3">
            Nobody has registered yet.
          </p>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[520px] text-[12.5px]">
              <thead>
                <tr className="border-b border-line text-left text-[11.5px] text-ink-3">
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="py-2 pr-3 font-medium">Company</th>
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
                    </td>
                    <td className="py-2.5 pr-3 text-ink-2">
                      {r.company || "—"}
                      {r.jobTitle && (
                        <div className="text-[11.5px] text-ink-3">
                          {r.jobTitle}
                        </div>
                      )}
                    </td>
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
        attendees: [],
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
              <ul className="mt-3 divide-y divide-line text-[13px]">
                {rep.attendees.map((a) => (
                  <li
                    key={a.identity}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <span>
                      <span className="font-medium">{a.name}</span>
                      {a.email ? (
                        <span className="ml-2 text-ink-3">{a.email}</span>
                      ) : null}
                    </span>
                    <span className="text-ink-3">{a.watchMin} min</span>
                  </li>
                ))}
              </ul>
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
