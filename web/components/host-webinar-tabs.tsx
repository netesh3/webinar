"use client";

import { DEFAULT_REMINDERS, describeReminders } from "./reminder-times";
import { useLayoutEffect, useState } from "react";
import { Alert, CopyField, Spinner, Tabs } from "./controls";
import { ApprovalQueue } from "./approval-queue";
import { RecordingsTab } from "./recordings-tab";
import { EngagementTab } from "./engagement/engagement-tab";
import { HostSurveyTab } from "./survey/host-survey-tab";
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
import type { Recording, RegistrantRow, Webinar } from "@/lib/api-types";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { defaultTab, tabFromQuery, allowedTab, tabsFor, type HostTab } from "@/lib/host-tabs";
import {
  RosterContactsLink,
  RosterWhatsAppCells,
  RosterWhatsAppHeaders,
  WebinarMessagesTab,
  useRosterMessaging,
  useRosterWhatsAppColumns,
  followupGroups,
} from "@/engage";
import { useAppConfig } from "./providers";

/* Per-webinar management. Every tab here operates on real data — the share links
 * are built from the operator's configured public URL rather than a placeholder
 * domain, and the settings shown are the ones the session will actually run with.
 *
 * Which tabs a webinar has, and how ?tab= maps onto them (including the old
 * ?tab=report, now Engagement), is lib/host-tabs.ts.
 */

export function HostWebinarTabs({
  webinar: w,
  registrants,
  recordings,
  onChanged,
  initialTab,
  onTabChange,
}: {
  webinar: Webinar;
  registrants: RegistrantRow[];
  recordings: Recording[];
  onChanged: () => void | Promise<void>;
  /** Deep-link from Host list: admit | attendees | share | engagement | … */
  initialTab?: string | null;
  /** Tells the page header which tab is open. A layout effect, so the header never paints
   *  a stale button first. */
  onTabChange?: (tab: HostTab) => void;
}) {
  const pending = registrants.filter((r) => r.state === "pending");
  const { whatsappConnect } = useAppConfig();
  const tabs = tabsFor(w.status, whatsappConnect);

  const [tab, setTab] = useState<HostTab>(() =>
    defaultTab(w.status, { pending: pending.length, whatsapp: whatsappConnect, requested: initialTab }),
  );

  // Follow ?tab= when the host clicks Admit / Attendees from the list. Adjusted
  // during render when the inputs change, not in an effect after it.
  const queryInputs = JSON.stringify([initialTab ?? null, w.status, whatsappConnect]);
  const [seenQueryInputs, setSeenQueryInputs] = useState(queryInputs);
  if (queryInputs !== seenQueryInputs) {
    setSeenQueryInputs(queryInputs);
    const next = allowedTab(tabFromQuery(initialTab), w.status, whatsappConnect);
    if (next) setTab(next);
    // A status change (the webinar just ended) can take the open tab away.
    else if (!tabs.includes(tab)) setTab(defaultTab(w.status, { pending: pending.length, whatsapp: whatsappConnect }));
  }

  useLayoutEffect(() => {
    onTabChange?.(tab);
  }, [tab, onTabChange]);

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
      {tab === "Messages" && (
        <WebinarMessagesTab slug={w.id} ended={w.status === "ended"} durationMin={w.durationMin} />
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
      {tab === "Survey" && <HostSurveyTab webinar={w} />}
      {tab === "Settings" && <SettingsTab webinar={w} />}
      {tab === "Engagement" && (
        <EngagementTab
          webinar={w}
          registrants={registrants}
          onOpenAttendees={() => setTab("Attendees")}
        />
      )}
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

  /* After the webinar: chips by engagement level, the Engagement tab's Follow up groups,
   * so "Message these N" here and there reach the same people. Empty groups are left
   * out; before the scores are computed only "Didn't join" can have anyone in it. */
  const buckets = ended ? followupGroups().filter((g) => registrants.some(g.test)) : [];
  const [bucketId, setBucketId] = useState("");
  const bucket = buckets.find((b) => b.id === bucketId) ?? null;
  const rows = bucket ? registrants.filter(bucket.test) : registrants;
  const messaging = useRosterMessaging({
    webinarId: w.id,
    rows,
    bucket: bucket ? { segment: bucket.segment, label: bucket.label, hints: bucket.hints } : null,
  });

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
            {messaging.bar}
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

        {buckets.length > 0 && registrants.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {[{ id: "", label: "Everyone", test: () => true }, ...buckets].map((b) => (
              <button
                key={b.id || "all"}
                type="button"
                onClick={() => setBucketId(b.id)}
                className={`rounded-full border px-3 py-1 text-[12px] font-medium transition ${
                  bucketId === b.id
                    ? "border-brand bg-brand-soft text-brand"
                    : "border-line text-ink-2 hover:border-line-2"
                }`}
              >
                {b.label}{" "}
                <span className="tabular-nums opacity-70">
                  {registrants.filter(b.test).length}
                </span>
              </button>
            ))}
          </div>
        )}

        {registrants.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-ink-3">
            Nobody has registered yet.
          </p>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-ink-3">Nobody in this group.</p>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[680px] text-[12.5px]">
              <thead>
                <tr className="border-b border-line text-left text-[11.5px] text-ink-3">
                  {messaging.headerCell}
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="py-2 pr-3 font-medium">Company</th>
                  {ended && <th className="py-2 pr-3 font-medium">Watched</th>}
                  {whatsappOn && <RosterWhatsAppHeaders />}
                  <th className="py-2 pr-3 font-medium">Registered</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0">
                    {messaging.cell(r)}
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
                    {ended && (
                      <td className="py-2.5 pr-3 text-ink-2 tabular-nums">
                        {r.joined ? `${r.watchMin} min` : <span className="text-ink-3">Didn&apos;t join</span>}
                      </td>
                    )}
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
      {messaging.dialog}
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
