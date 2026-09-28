"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EngagementAttendeeRow, EngagementSummary } from "@/lib/api-types";
import { Spinner } from "@/components/controls";
import { useToast } from "@/components/providers";
import { Badge, Button, Card } from "@/components/ui";
import { formatTime } from "@/lib/format";
import { useEngagementSummary, useSessionRecord, LIVE_REFRESH_MS } from "@/lib/engagement/hooks";
import { exportOptions } from "@/lib/engagement/exports";
import type { SectionId } from "@/lib/engagement/sections";
import type { EngagementSource } from "@/lib/engagement/source";
import { pct } from "@/lib/engagement/viz";
import { AttendeeDrawer } from "./attendee-drawer";
import { AttendeeHeatmap, type HeatmapClock } from "./attendee-heatmap";
import { ActivityHeatmap, Bars, RetentionChart } from "./charts";
import { ChatPanel, PollsPanel, QAPanel, ReactionsPanel, SurveyPanel } from "./detail-tabs";
import { ExportMenu } from "./export-menu";
import { TierLevels } from "./follow-up";
import { Hero } from "./hero";
import { KpiGrid } from "./kpi-grid";
import { Icon } from "./primitives";
import { StageAttendance, useFullQuestions } from "./record-panels";
import { Deferred, FoldAllButton, PageSection, revealSection } from "./page-section";
import { DashboardSkeleton, EmptyState, ErrorState, errorMessage } from "./states";

/* One webinar's engagement, read top to bottom in the order a coach asks: how did it go,
 * who came and stayed, when people took part, who took part (table → drawer), what they
 * said, and what to do next — one section under the next, in a single scroll. Every section
 * after Overview folds to a one-line summary, so a coach can keep just the ones they read.
 * Composition only — every number arrives through `source`. */

const card = "p-4 sm:p-5";

export function EngagementDashboard({
  source,
  sample = false,
  signInHref,
  approved,
  showTitle = true,
  notStartedDetail,
  onOpenAttendees,
  initialSection,
  followUp,
  onFollowUp,
}: {
  source: EngagementSource;
  sample?: boolean;
  signInHref?: string;
  /** Approved registrations, from the host screen's registrant list (no extra request). */
  approved?: number;
  /** False inside the host screen, whose heading is already the webinar's title. */
  showTitle?: boolean;
  /** Shown under the "not started" message, e.g. the scheduled start. */
  notStartedDetail?: string;
  /** Jump to the host screen's registrant list — where no-shows are listed by name. */
  onOpenAttendees?: () => void;
  /** Unfold and scroll to this section once the numbers are in; deep links such as ?tab=survey. */
  initialSection?: SectionId;
  /** The Follow up section's actions — the CRM's slot, handed the tier counts. Without
   *  it the section shows the engagement levels only. */
  followUp?: (tiers: EngagementSummary["tiers"], levels: ReactNode) => ReactNode;
  /** Where the header's Follow up button goes, when following up is another tab. */
  onFollowUp?: () => void;
}) {
  const { notify } = useToast();
  const summary = useEngagementSummary(source);
  const [open, setOpen] = useState<EngagementAttendeeRow | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [wantRecord, setWantRecord] = useState(false);
  const closeDrawer = useCallback(() => setOpen(null), []);
  const loadRecord = useCallback(() => setWantRecord(true), []);
  const record = useSessionRecord(source, wantRecord);

  const s = summary.data;
  const fullQs = useFullQuestions(s, record);
  const ended = s?.webinar.status === "ended";
  const ready = s?.state === "ready";
  const started = !!s?.webinar.startedAt;

  // Once, when the dashboard first has numbers, a frame later so the sections exist.
  const landed = useRef(false);
  useEffect(() => {
    if (!initialSection || !ready || landed.current) return;
    landed.current = true;
    revealSection(initialSection, "auto");
  }, [initialSection, ready]);

  const exports = useMemo(
    () =>
      exportOptions(
        {
          engagementCsv: source.csvUrl,
          attendanceCsv: source.attendanceCsvUrl,
          chatCsv: source.chatCsvUrl,
          transcriptTxt: source.transcriptUrl,
        },
        { started, sample },
      ),
    [source, started, sample],
  );
  const clock = useMemo<HeatmapClock | undefined>(
    () => (s ? { startedAt: s.webinar.startedAt, timeZone: s.webinar.timeZone, live: summary.live } : undefined),
    [s, summary.live],
  );
  const joinBars = useMemo(
    () =>
      (s?.joinHistogram ?? []).map((h) => ({
        key: String(h.fromMin),
        label: `${h.fromMin < 0 ? h.fromMin : `+${h.fromMin}`}${h.open ? "+" : ""}`,
        value: h.count,
        color: h.fromMin < 0 ? "#0b8a4b" : h.fromMin < 5 ? "#0b5cff" : "#e0a54a",
      })),
    [s?.joinHistogram],
  );

  async function recompute() {
    if (!source.recompute) return;
    setRecomputing(true);
    try {
      summary.replace(await source.recompute());
      notify("Engagement recomputed.", "ok");
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setRecomputing(false);
    }
  }

  const actions = (
    <>
      {source.recompute && ended && (
        <Button size="sm" variant="secondary" onClick={() => void recompute()} disabled={recomputing}>
          {recomputing ? <Spinner className="size-3.5" /> : <Icon name="refresh" />}
          Recompute
        </Button>
      )}
      {ready && (
        <Button size="sm" onClick={onFollowUp ?? (() => revealSection("follow-up"))}>
          <Icon name="schedule_send" />
          Follow up
        </Button>
      )}
      {/* Last, so its right-anchored menu stays on screen when the row wraps on a phone. */}
      <ExportMenu options={exports} />
    </>
  );

  if (!s) {
    return summary.error != null && !summary.loading ? (
      <ErrorState error={summary.error} onRetry={summary.refresh} signInHref={signInHref} />
    ) : (
      <DashboardSkeleton />
    );
  }

  if (!ready) {
    return (
      <div className="grid gap-4">
        {sample && <SampleNote />}
        <EmptyState
          state={s.state}
          detail={s.state === "not_started" ? notStartedDetail : undefined}
          action={
            onOpenAttendees && (
              <Button size="sm" variant="secondary" onClick={onOpenAttendees}>
                {s.state === "not_started" ? "See who registered" : "See registrants"}
              </Button>
            )
          }
        />
        {exports.length > 0 && (
          <div className="flex justify-center">
            <ExportMenu options={exports} />
          </div>
        )}
      </div>
    );
  }

  const k = s.kpis;
  const questionsSummary = fullQs ?? s;
  const capped = !fullQs && record.available && k.questions > s.questions.length;
  const openQs = k.questions - k.answeredQuestions;
  const t = s.tiers;
  // Where "See who didn't join" goes: the registrant list if this screen has one, else
  // Follow up, whose "Didn't join" group lists and messages them.
  const seeNoShows = onOpenAttendees ?? (followUp ? () => revealSection("follow-up") : undefined);
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <StatusLine s={s} live={summary.live} sample={sample} refreshing={summary.loading} onRefresh={summary.refresh} />
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>
        </div>
        {summary.error != null && <ErrorState error={summary.error} onRetry={summary.refresh} compact />}
      </div>

      <PageSection id="overview" title="Overview" hint="The headline numbers. Every figure counts your audience only — not you or your panelists.">
        <div className="grid gap-4">
          <Hero summary={s} showTitle={showTitle} />
          <KpiGrid kpis={k} approved={approved} />
        </div>
      </PageSection>

      <div className="-mb-2 flex items-center justify-between gap-3 border-t border-line pt-4">
        <p className="text-[12.5px] text-ink-3">Fold what you don&apos;t need — this page remembers.</p>
        <FoldAllButton />
      </div>

      <PageSection
        id="attendance"
        title="Attendance"
        hint="Who came, when they arrived and how long they stayed."
        summary={`${k.attended} attended · ${k.attendanceRatePct}% turnout · ${k.avgWatchMin} min average`}
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Card className={card}>
            <SubTitle title="Who stayed" hint="People in the room, minute by minute. Dots mark polls, quizzes, Q&A and your offer." />
            <RetentionChart series={s.retention} markers={s.markers} sessionMin={s.webinar.sessionMin} attended={k.attended} />
          </Card>
          <Card className={card}>
            <SubTitle title="When people joined" hint="Minutes relative to the start." />
            <div className="mb-3 flex gap-2 text-center text-[12px]">
              {[
                { key: "early", label: "Early", n: s.joinSplit.early, tone: "text-ok" },
                { key: "on", label: "On time", n: s.joinSplit.onTime, tone: "text-brand" },
                { key: "late", label: "Late (5m+)", n: s.joinSplit.late, tone: "text-warn" },
              ].map((x) => (
                <div key={x.key} className="flex-1 rounded-lg bg-surface-2 py-2">
                  <div className={`text-[17px] font-semibold tabular-nums ${x.tone}`}>{pct(x.n, k.attended)}%</div>
                  <div className="text-ink-3">{x.label}</div>
                </div>
              ))}
            </div>
            <Bars height={150} data={joinBars} />
          </Card>
        </div>
        {k.noShows > 0 && (
          <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-2">
            <Icon name="person_off" className="text-ink-3" />
            {k.noShows} of {k.registered} registrants didn&apos;t join.
            {seeNoShows && (
              <button type="button" onClick={seeNoShows} className="font-medium text-brand hover:underline">
                See who
              </button>
            )}
          </p>
        )}
      </PageSection>

      <PageSection
        id="activity"
        title="Activity"
        hint="Interactions per minute. Darker means busier — your best moments stand out."
        summary={`Peak of ${k.peakLive} in the room at minute ${k.peakMinute}`}
      >
        <Deferred minHeight={220}>
          <Card className={card}>
            <ActivityHeatmap activity={s.activity} markers={s.markers} sessionMin={s.webinar.sessionMin} />
          </Card>
        </Deferred>
      </PageSection>

      <PageSection
        id="attendees"
        title="Attendees"
        hint={`One row per person across the ${s.webinar.sessionMin}-minute session, with when they came in and left. Sort, filter, or open a row for their full timeline.`}
        summary={`${plural(k.attended, "person", "people")} · ${t.high} highly engaged · ${t.risk} at risk`}
      >
        <Deferred minHeight={480}>
          <Card className={card}>
            <AttendeeHeatmap
              source={source}
              axis={s.axis}
              tiers={s.tiers}
              sessionMin={s.webinar.sessionMin}
              refreshKey={summary.live ? undefined : s.computedAt}
              onOpen={setOpen}
              clock={clock}
            />
          </Card>
          <StageAttendance record={record} timeZone={s.webinar.timeZone} onLoad={loadRecord} />
        </Deferred>
      </PageSection>

      <DetailSection
        id="chat"
        title="Chat"
        hint="How much people talked, and who talked most."
        summary={
          k.chatMessages
            ? `${plural(k.chatMessages, "message")} from ${plural(k.chatters, "person", "people")}`
            : k.stageChatMessages
              ? `No attendee chat · ${plural(k.stageChatMessages, "stage message")}`
              : "No chat"
        }
      >
        <ChatPanel s={s} />
      </DetailSection>

      <DetailSection
        id="qa"
        title="Q&A"
        hint="Every question, most upvoted first. Unanswered ones make a great follow-up."
        summary={
          k.questions ? (
            <>
              {plural(k.questions, "question")}
              {openQs > 0 && <span className="font-medium text-warn"> · {openQs} unanswered</span>}
            </>
          ) : (
            "No questions"
          )
        }
        action={
          capped && (
            <Button size="sm" variant="secondary" onClick={loadRecord} disabled={record.loading}>
              {record.loading && <Spinner className="size-3.5" />}
              Show all {k.questions}
            </Button>
          )
        }
      >
        <QAPanel s={questionsSummary} />
      </DetailSection>

      <DetailSection
        id="polls"
        title="Polls & quizzes"
        hint="What people answered, and how many of those in the room took part."
        summary={
          s.polls.length
            ? `${plural(s.polls.length, "run")}${k.pollResponsePct >= 0 ? ` · ${k.pollResponsePct}% answered` : ""}${k.quizAccuracyPct >= 0 ? ` · ${k.quizAccuracyPct}% correct` : ""}`
            : "None run"
        }
      >
        <PollsPanel s={s} />
      </DetailSection>

      <DetailSection
        id="reactions"
        title="Reactions"
        hint="Emoji reactions over the session."
        summary={k.reactions ? plural(k.reactions, "reaction") : "No reactions"}
      >
        <ReactionsPanel s={s} />
      </DetailSection>

      <DetailSection
        id="survey"
        title="Feedback survey"
        hint="Ratings and comments from the feedback survey."
        summary="Ratings and comments"
      >
        <SurveyPanel source={source} ended={ended} />
      </DetailSection>

      <PageSection
        id="follow-up"
        title="Follow up"
        hint="Everyone lands in one group by how they took part. Message each group what fits."
        summary={`${t.high} highly engaged · ${t.risk} at risk · ${t.noShow} didn't join`}
      >
        {(() => {
          const levels = (
            <Card className={card}>
              <SubTitle title="Engagement levels" hint="Based on each attendee's score." />
              <TierLevels tiers={s.tiers} />
            </Card>
          );
          return followUp ? followUp(s.tiers, levels) : levels;
        })()}
      </PageSection>

      <AttendeeDrawer source={source} row={open} lobbyMin={Math.max(0, -s.axis.startMin)} onClose={closeDrawer} clock={clock} />
    </div>
  );
}

function SubTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-[14px] font-semibold">{title}</h3>
      {hint && <p className="mt-0.5 text-[12px] text-ink-2">{hint}</p>}
    </div>
  );
}

function DetailSection({
  id,
  title,
  hint,
  action,
  summary,
  children,
}: {
  id: SectionId;
  title: string;
  hint: string;
  action?: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
}) {
  return (
    <PageSection id={id} title={title} hint={hint} action={action} summary={summary}>
      <Deferred minHeight={200}>
        <Card className={card}>{children}</Card>
      </Deferred>
    </PageSection>
  );
}

function SampleNote() {
  return (
    <p className="flex items-center gap-2 text-[12.5px] text-ink-2">
      <Badge tone="warn">Sample data</Badge>
      Local preview — these numbers come from a sample webinar, not this one.
    </p>
  );
}

/** Live: a pulsing dot, the refresh cadence and a manual refresh. Ended: when the numbers
 *  were last computed. Either way the host knows how fresh what they are reading is. */
function StatusLine({
  s,
  live,
  sample,
  refreshing,
  onRefresh,
}: {
  s: EngagementSummary;
  live: boolean;
  sample: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const at = s.computedAt ? formatTime(s.computedAt, s.webinar.timeZone) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-2" role="status" aria-live="polite">
      {sample && <Badge tone="warn">Sample data</Badge>}
      {live ? (
        <>
          <span className="inline-flex items-center gap-1.5 font-medium text-live">
            <span className="size-2 animate-pulse rounded-full bg-live motion-reduce:animate-none" aria-hidden />
            Live
          </span>
          <span>
            Updates every {LIVE_REFRESH_MS / 1000}s{at ? ` · last at ${at}` : ""}
          </span>
          <button type="button" onClick={onRefresh} disabled={refreshing} className="inline-flex items-center gap-1 font-medium text-brand hover:underline disabled:opacity-50">
            {refreshing ? <Spinner className="size-3" /> : <Icon name="refresh" className="!text-[14px]" />}
            Refresh now
          </button>
        </>
      ) : (
        at && <span className="text-ink-3">Numbers as of {at}</span>
      )}
    </div>
  );
}
