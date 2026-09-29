"use client";

import { DEFAULT_REMINDERS, ReminderTimes, describeReminders } from "./reminder-times";
import { useEffect, useLayoutEffect, useState } from "react";
import { CopyField, Spinner, Tabs } from "./controls";
import { ApprovalQueue } from "./approval-queue";
import { RecordingsTab } from "./recordings-tab";
import { EngagementTab } from "./engagement/engagement-tab";
import { CalendarIcon, PlusIcon, TrashIcon } from "./icons";
import { useAppConfig, useSession, useShareOrigin, useToast } from "./providers";
import { Avatar, Badge, Button, ButtonLink, Card, ListPager, SectionTitle } from "./ui";
import {
  formatCount,
  formatDay,
  formatTimeRange,
  googleCalendarInviteUrl,
  tzLabel,
} from "@/lib/format";
import { ApiError, api } from "@/lib/api";
import {
  ChannelEmail,
  FeatureCloudRecording,
  FeatureJoinWithoutRegistration,
  type CustomQuestion,
  type EngagementTierCounts,
  type Recording,
  type RegistrantPage,
  type RegistrantRow,
  type Webinar,
} from "@/lib/api-types";
import { answerText } from "@/lib/registration-questions";
import { DEV_BYPASS_REGISTRANTS } from "@/lib/dev-bypass";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import {
  defaultTab,
  engagementSection,
  tabFromQuery,
  allowedTab,
  tabsFor,
  type HostTab,
} from "@/lib/host-tabs";
import {
  RosterContactsLink,
  RosterWhatsAppCells,
  RosterWhatsAppHeaders,
  ScheduleMessagesTab,
  WebinarWhatsAppOverview,
  WebinarWhatsAppMetrics,
  EngagementFollowUpPage,
  reminderMinutes,
  useRosterMessaging,
  useRosterWhatsAppColumns,
  useWebinarMessageSlots,
  followupGroups,
} from "@/engage";
/* Per-webinar management. Every tab here operates on real data — the share links
 * are built from the operator's configured public URL rather than a placeholder
 * domain, and the settings shown are the ones the session will actually run with.
 *
 * Which tabs a webinar has, and how ?tab= maps onto them (including the old
 * ?tab=report, now Engagement, and an ended webinar's ?tab=attendees / ?tab=survey, now
 * Engagement's sections), is lib/host-tabs.ts.
 */

export type RosterCounts = {
  total: number;
  approved: number;
  declined: number;
  pending: number;
  guests: number;
};

const PEOPLE_PAGE = 25;

export function HostWebinarTabs({
  webinar: w,
  counts,
  pending,
  rosterToken,
  recordings,
  onChanged,
  initialTab,
  onTabChange,
}: {
  webinar: Webinar;
  counts: RosterCounts | null;
  pending: RegistrantRow[];
  /** Bumped when the webinar is reloaded, so the People page refetches. */
  rosterToken: number;
  recordings: Recording[];
  onChanged: () => void | Promise<void>;
  /** Deep-link from Host list: people | setup | results | follow-up | … (old names too) */
  initialTab?: string | null;
  /** Tells the page header which tab is open. A layout effect, so the header never paints
   *  a stale button first. */
  onTabChange?: (tab: HostTab) => void;
}) {
  const { whatsappConnect } = useAppConfig();
  const { account } = useSession();
  const cloudRecording = (account?.features ?? []).includes(FeatureCloudRecording);
  const tabs = tabsFor(w.status, whatsappConnect, cloudRecording);

  const [tab, setTab] = useState<HostTab>(() =>
    defaultTab(w.status, {
      whatsapp: whatsappConnect,
      requested: initialTab,
      cloudRecording,
    }),
  );

  // Follow ?tab= when a link names a tab. Adjusted during render when the inputs change,
  // not in an effect after it. cloudRecording is one of those inputs: the session arrives
  // after the first paint, and a host who has the switch should not stay on the fallback.
  const queryInputs = JSON.stringify([
    initialTab ?? null,
    w.status,
    whatsappConnect,
    cloudRecording,
  ]);
  const [seenQueryInputs, setSeenQueryInputs] = useState(queryInputs);
  if (queryInputs !== seenQueryInputs) {
    setSeenQueryInputs(queryInputs);
    const next = allowedTab(
      tabFromQuery(initialTab),
      w.status,
      whatsappConnect,
      cloudRecording,
    );
    if (next) setTab(next);
    // A status change (the webinar just ended) can take the open tab away.
    else if (!tabs.includes(tab))
      setTab(defaultTab(w.status, { whatsapp: whatsappConnect, cloudRecording }));
  }

  useLayoutEffect(() => {
    onTabChange?.(tab);
  }, [tab, onTabChange]);

  const ended = w.status === "ended";
  return (
    <>
      <div className="mb-4">
        <Tabs
          tabs={tabs}
          value={tab}
          onChange={setTab}
          counts={{
            People: counts?.total ?? w.registrantCount,
            Recording: recordings.length,
          }}
        />
      </div>

      {tab === "Overview" && (
        <OverviewTab
          webinar={w}
          counts={counts}
          pending={pending}
          onChanged={onChanged}
          onOpenPeople={() => setTab("People")}
        />
      )}
      {tab === "People" && (
        <div className="grid gap-4">
          {w.approval === "manual" && pending.length > 0 && (
            <Card className="p-5">
              <SectionTitle>Waiting to admit · {pending.length}</SectionTitle>
              <ApprovalQueue
                slug={w.id}
                pending={pending}
                onChanged={onChanged}
              />
            </Card>
          )}
          <AttendeesTab webinar={w} counts={counts} rosterToken={rosterToken} />
        </div>
      )}
      {tab === "Setup" && (
        <div className="grid gap-4">
          <Card className="p-5">
            <SectionTitle>Messages & follow-ups</SectionTitle>
            <p className="mt-1 mb-4 text-[12.5px] text-ink-2">
              The same editor as scheduling. Changes here apply to this webinar.
            </p>
            <ScheduleMessagesTab
              slug={w.id}
              webinar={{
                topic: w.topic,
                startsAt: new Date(w.startsAt),
                timeZone: w.timeZone,
              }}
              reminderTimes={({ value, onChange, disabled }) => (
                <ReminderTimes
                  value={value}
                  onChange={onChange}
                  disabled={disabled}
                />
              )}
            />
          </Card>
          <SettingsTab webinar={w} />
          <StageTab webinar={w} onChanged={onChanged} />
          <HostLinkCard webinar={w} />
        </div>
      )}
      {tab === "Follow up" && <FollowUpTab webinar={w} />}
      {tab === "Recording" && cloudRecording && (
        <RecordingsTab
          webinar={w}
          recordings={recordings}
          onChanged={onChanged}
        />
      )}
      {tab === "Results" && (
        <EngagementTab
          webinar={w}
          approved={w.approval === "manual" ? counts?.approved : undefined}
          onOpenAttendees={!ended ? () => setTab("People") : undefined}
          initialSection={engagementSection(initialTab, w.status)}
          // After the end, following up is its own tab.
          hideFollowUp={ended && whatsappConnect}
          onOpenFollowUp={
            ended && whatsappConnect ? () => setTab("Follow up") : undefined
          }
        />
      )}
    </>
  );
}

/* Email reminder rows on the plain schedule. Times come from the resolved reminder
 * slot when it sends email. options.reminders is only the list when that request
 * has not come back — the same fallback as the WhatsApp on/off badge. */
function EmailReminders({ webinar }: { webinar: Webinar }) {
  const slots = useWebinarMessageSlots(webinar.id);
  const fromSlots = reminderMinutes(slots, ChannelEmail);
  // Missing key means on, same as the API. Off means the legacy schedule sends nothing.
  const legacy =
    webinar.options.emailReminders === false
      ? []
      : (webinar.options.reminders ?? DEFAULT_REMINDERS);
  const minutes = fromSlots ?? legacy;
  return (
    <>
      {minutes.map((m) => (
        <li key={m} className="flex justify-between gap-3">
          <span>Reminder</span>
          <span className="text-ink-3">{describeReminders([m])}</span>
        </li>
      ))}
    </>
  );
}

// ------------------------------------------------------------- admit / attendees

/* Overview: the one screen before a webinar. The link to share, the numbers, what goes out
 * on its own, and anything waiting on the host — approvals are answered here. */
function OverviewTab({
  webinar: w,
  counts,
  pending,
  onChanged,
  onOpenPeople,
}: {
  webinar: Webinar;
  counts: RosterCounts | null;
  pending: RegistrantRow[];
  onChanged: () => void | Promise<void>;
  onOpenPeople: () => void;
}) {
  const origin = useShareOrigin();
  const { notify } = useToast();
  const approved = counts?.approved ?? 0;
  const link = `${origin}/webinars/${w.id}`;
  const invite =
    `${w.topic}\n` +
    `${formatDay(w.startsAt, w.timeZone)}, ${formatTimeRange(w.startsAt, w.durationMin, w.timeZone)} ${tzLabel(w.startsAt, w.timeZone)}\n\n` +
    `Register: ${link}` +
    (w.passcode ? `\nPasscode: ${w.passcode}` : "");

  if (w.status === "draft") {
    return (
      <Card className="p-6">
        <h2 className="text-[15px] font-semibold">
          Finish setup to open registration
        </h2>
        <p className="mt-2 max-w-md text-[13.5px] leading-relaxed text-ink-2">
          This webinar is a draft, so its page isn&apos;t public yet. Schedule
          it and you get a link to share.
        </p>
        <ButtonLink href={`/host/${w.id}/edit`} className="mt-4">
          Finish setup
        </ButtonLink>
      </Card>
    );
  }

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="grid gap-4">
        <Card className="p-5">
          <SectionTitle>Share this link</SectionTitle>
          <CopyField value={link} />
          <div className="mt-3 flex flex-wrap gap-2">
            <ButtonLink
              href={`https://wa.me/?text=${encodeURIComponent(`${w.topic} — register here: ${link}`)}`}
              target="_blank"
              rel="noopener noreferrer"
              size="sm"
              variant="secondary"
            >
              WhatsApp
            </ButtonLink>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                void navigator.clipboard
                  .writeText(invite)
                  .then(() => notify("Invitation copied.", "ok"))
                  .catch(() => notify("Could not copy.", "error"))
              }
            >
              Copy invitation
            </Button>
            <ButtonLink
              href={googleCalendarInviteUrl({
                topic: w.topic,
                description: w.description,
                startsAt: w.startsAt,
                durationMin: w.durationMin,
                timeZone: w.timeZone,
                webinarId: w.webinarId,
                registrationUrl: link,
              })}
              target="_blank"
              rel="noopener noreferrer"
              size="sm"
              variant="secondary"
            >
              <CalendarIcon className="size-4" />
              Add to calendar
            </ButtonLink>
            <ButtonLink
              href={`/webinars/${w.id}`}
              target="_blank"
              rel="noopener noreferrer"
              size="sm"
              variant="ghost"
            >
              Preview page ↗
            </ButtonLink>
          </div>
          <p className="mt-2.5 text-[12px] text-ink-3">
            Anyone with this link can register · approval is{" "}
            {w.approval === "manual" ? "manual" : "automatic"}
            {w.passcode ? ` · passcode ${w.passcode}` : ""}.
          </p>
        </Card>

        <div className="grid gap-3 sm:grid-cols-3">
          <Stat
            label="Registered"
            value={formatCount(w.registrantCount)}
            note={`of ${formatCount(w.attendeeLimit)} seats`}
          />
          <Stat
            label="Approved"
            value={counts ? formatCount(approved) : "—"}
            note={pending.length ? `${pending.length} waiting` : "none waiting"}
          />
          <Stat
            label="On WhatsApp"
            value="—"
            note="see People for who opted in"
          />
        </div>

        {/* One list of what is sent automatically. With WhatsApp on, the CRM's timeline is
            that list (sent / read / queued per message); otherwise the plain schedule. */}
        <WebinarWhatsAppOverview
          slug={w.id}
          ended={false}
          fallback={
            <Card className="p-5">
              <SectionTitle>Automated messages</SectionTitle>
              <ul className="grid gap-2 text-[13px]">
                <li className="flex justify-between gap-3">
                  <span>Confirmation, with their join link</span>
                  <span className="text-ink-3">when they register</span>
                </li>
                <EmailReminders webinar={w} />
                <li className="flex justify-between gap-3">
                  <span>Replay link</span>
                  <span className="text-ink-3">
                    when you publish the recording
                  </span>
                </li>
              </ul>
              <p className="mt-3 text-[12px] text-ink-3">
                By email. Change the times in{" "}
                <a
                  href={`/host/${w.id}/edit`}
                  className="font-medium text-brand hover:underline"
                >
                  Edit
                </a>
                .
              </p>
            </Card>
          }
        />
      </div>

      <div className="grid gap-4">
        <Card className="p-5">
          <div className="flex items-center justify-between gap-2">
            <SectionTitle>Waiting for you</SectionTitle>
            {pending.length > 0 && (
              <button
                type="button"
                onClick={onOpenPeople}
                className="text-[12px] font-medium text-brand hover:underline"
              >
                See all
              </button>
            )}
          </div>
          {pending.length === 0 ? (
            <p className="text-[13px] text-ink-3">
              {w.approval === "manual"
                ? "Nobody is waiting to be admitted."
                : "Nothing to do — people are admitted as they register."}
            </p>
          ) : (
            <ApprovalQueue
              slug={w.id}
              pending={pending.slice(0, 5)}
              onChanged={onChanged}
            />
          )}
        </Card>
      </div>
    </div>
  );
}

function AttendeesTab({
  webinar: w,
  counts,
  rosterToken,
}: {
  webinar: Webinar;
  counts: RosterCounts | null;
  rosterToken: number;
}) {
  const bypass = isDevAuthBypassActive();
  const whatsappOn = useRosterWhatsAppColumns();
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<RegistrantPage | null>(null);
  const [seenOffset, setSeenOffset] = useState(0);
  if (offset !== seenOffset) {
    setSeenOffset(offset);
    setPage(null);
  }
  useEffect(() => {
    if (bypass) return;
    let cancelled = false;
    api
      .hostRegistrants(w.id, { limit: PEOPLE_PAGE, offset })
      .then((next) => {
        if (!cancelled) setPage(next);
      })
      .catch(() => {
        if (!cancelled) {
          setPage({
            items: [],
            total: 0,
            offset,
            approved: 0,
            declined: 0,
            pending: 0,
            guests: 0,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bypass, w.id, offset, rosterToken]);

  const registrants = bypass ? DEV_BYPASS_REGISTRANTS : (page?.items ?? []);
  const roster = bypass
    ? {
        total: DEV_BYPASS_REGISTRANTS.length,
        approved: DEV_BYPASS_REGISTRANTS.filter((r) => r.state === "approved").length,
        declined: DEV_BYPASS_REGISTRANTS.filter((r) => r.state === "declined").length,
        guests: DEV_BYPASS_REGISTRANTS.filter((r) => r.isGuest).length,
      }
    : page
      ? {
          total: page.total,
          approved: page.approved,
          declined: page.declined,
          guests: page.guests,
        }
      : counts
        ? {
            total: counts.total,
            approved: counts.approved,
            declined: counts.declined,
            guests: counts.guests,
          }
        : null;
  const ended = w.status === "ended";
  const asked = w.customQuestions ?? [];

  /* After the webinar: chips by engagement level, the Engagement tab's Follow up groups,
   * so "Message these N" here and there reach the same people. Empty groups are left
   * out; before the scores are computed only "Didn't join" can have anyone in it. */
  const buckets = ended
    ? followupGroups().filter((g) => registrants.some(g.test))
    : [];
  const [bucketId, setBucketId] = useState("");
  const bucket = buckets.find((b) => b.id === bucketId) ?? null;
  const rows = bucket ? registrants.filter(bucket.test) : registrants;
  const messaging = useRosterMessaging({
    webinarId: w.id,
    rows,
    bucket: bucket
      ? { segment: bucket.segment, label: bucket.label, hints: bucket.hints }
      : null,
  });

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Registered"
          value={formatCount(roster?.total ?? w.registrantCount)}
          note={`of ${formatCount(w.attendeeLimit)} seats`}
        />
        <Stat
          label={ended ? "Attended" : "Approved"}
          value={
            ended && w.report
              ? formatCount(w.report.attended)
              : roster
                ? formatCount(roster.approved)
                : "—"
          }
          note={
            ended && w.report
              ? `avg watch ${w.report.avgWatchMin} min`
              : roster
                ? `${formatCount(roster.declined)} declined`
                : ""
          }
        />
        <Stat
          label="Contactable"
          value={
            roster ? formatCount(Math.max(0, roster.total - roster.guests)) : "—"
          }
          note={roster ? `${formatCount(roster.guests)} guests` : ""}
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
            {[{ id: "", label: "Everyone", test: () => true }, ...buckets].map(
              (b) => (
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
              ),
            )}
          </div>
        )}

        {!bypass && !page ? (
          <div className="grid place-items-center py-10">
            <Spinner className="size-5 text-ink-3" />
          </div>
        ) : registrants.length === 0 && offset === 0 ? (
          <p className="py-8 text-center text-[13px] text-ink-3">
            Nobody has registered yet.
          </p>
        ) : registrants.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-ink-3">
            Nobody on this page
          </p>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-ink-3">
            Nobody in this group.
          </p>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[680px] text-[12.5px]">
              <thead>
                <tr className="border-b border-line text-left text-[11.5px] text-ink-3">
                  {messaging.headerCell}
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="py-2 pr-3 font-medium">Company</th>
                  {asked.length > 0 && (
                    <th className="py-2 pr-3 font-medium">Answers</th>
                  )}
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
                        <div className="text-[11.5px] text-ink-3">
                          {r.phone}
                        </div>
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
                    {asked.length > 0 && (
                      <td className="max-w-[260px] py-2.5 pr-3 text-[11.5px] text-ink-2">
                        <RegistrantAnswers questions={asked} answers={r.answers} />
                      </td>
                    )}
                    {ended && (
                      <td className="py-2.5 pr-3 text-ink-2 tabular-nums">
                        {r.joined ? (
                          `${r.watchMin} min`
                        ) : (
                          <span className="text-ink-3">Didn&apos;t join</span>
                        )}
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
        {roster && (bypass || page) && (
          <ListPager
            layout="split"
            range="inline"
            className="mt-3 border-t border-line pt-3"
            page={Math.floor(offset / PEOPLE_PAGE) + 1}
            pages={Math.max(1, Math.ceil(roster.total / PEOPLE_PAGE))}
            pageSize={PEOPLE_PAGE}
            start={registrants.length === 0 ? 0 : offset + 1}
            end={registrants.length === 0 ? 0 : offset + registrants.length}
            total={roster.total}
            onPrevious={() => setOffset((n) => Math.max(0, n - PEOPLE_PAGE))}
            onNext={() => setOffset((n) => n + PEOPLE_PAGE)}
          />
        )}
      </Card>
      {messaging.dialog}
    </div>
  );
}

// -------------------------------------------------------------------- share

/** The host and panelist room link, in Setup. */
function HostLinkCard({ webinar: w }: { webinar: Webinar }) {
  const origin = useShareOrigin();
  return (
    <Card className="p-5">
      <SectionTitle>Host and panelist link</SectionTitle>
      <CopyField value={`${origin}/host/${w.id}/room`} />
      <p className="mt-2.5 text-[12px] leading-relaxed text-ink-3">
        Only you and the panelists on this webinar can use it — the server
        refuses to mint a publishing token for anyone else, so sharing it does
        not give anyone the stage.
      </p>
    </Card>
  );
}

/* Follow up: the group cards need the tier counts, which are the webinar's engagement
 * numbers — loaded here, on the webinar side, and handed to the CRM's slot. */
function FollowUpTab({ webinar: w }: { webinar: Webinar }) {
  const [tiers, setTiers] = useState<EngagementTierCounts | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    api
      .engagementSummary(w.id, ctrl.signal)
      .then((s) => setTiers(s.tiers))
      .catch(() => {});
    return () => ctrl.abort();
  }, [w.id]);
  return (
    <EngagementFollowUpPage
      slug={w.id}
      tiers={tiers}
      afterGroups={<WebinarWhatsAppMetrics slug={w.id} topic={w.topic} />}
    />
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
  const { account } = useSession();
  const cloudRecording = (account?.features ?? []).includes(FeatureCloudRecording);
  const openJoin = (account?.features ?? []).includes(
    FeatureJoinWithoutRegistration,
  );
  const rows: [string, boolean | string][] = [
    ["Attendees hidden from each other", w.controls.hideAttendees],
    ["Panelists muted on entry", w.controls.muteOnEntry],
    ["Panelists may unmute themselves", w.controls.allowUnmute],
    ["Attendee chat", w.controls.chatEnabled],
    ["Q&A", w.controls.qaEnabled],
    ["Raise hand", w.controls.raiseHandEnabled],
    ["Reactions", w.controls.reactionsEnabled],
    ["Locked to new attendees", w.controls.locked],
    ...(openJoin
      ? ([["Registration required", w.registrationRequired]] as [string, boolean][])
      : []),
    ...(cloudRecording
      ? ([["Record automatically", w.options.autoRecord]] as [string, boolean][])
      : []),
    ["Live captions", w.options.captions],
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

function RegistrantAnswers({
  questions,
  answers,
}: {
  questions: CustomQuestion[];
  answers?: Record<string, string>;
}) {
  const given = questions
    .map((q) => ({ q, text: answerText(q, answers?.[q.id]) }))
    .filter((a) => a.text);
  if (given.length === 0) return <span className="text-ink-3">—</span>;
  return (
    <dl className="grid gap-0.5">
      {given.map(({ q, text }) => (
        <div key={q.id} className="truncate" title={`${q.label}: ${text}`}>
          <dt className="inline text-ink-3">{q.label}: </dt>
          <dd className="inline">{text}</dd>
        </div>
      ))}
    </dl>
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
