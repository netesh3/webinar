"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { EngagementSummary, SurveyResults } from "@/lib/api-types";
import type { EngagementSource } from "@/lib/engagement/source";
import { Spinner } from "../controls";
import { ClipboardIcon } from "../icons";
import { useToast } from "../providers";
import { SurveyResultsView } from "../survey/survey-results";
import { Badge, Button, ButtonLink } from "../ui";
import { pct } from "@/lib/engagement/viz";
import { Bars, HBar } from "./charts";
import { MiniStat } from "./primitives";

const TABS = [
  { id: "chat", label: "Chat" },
  { id: "qa", label: "Q&A" },
  { id: "polls", label: "Polls & quizzes" },
  { id: "reactions", label: "Reactions" },
  { id: "survey", label: "Survey" },
] as const;
export type DetailTabId = (typeof TABS)[number]["id"];
type TabId = DetailTabId;

const None = ({ children }: { children: string }) => <p className="py-8 text-center text-[13px] text-ink-3">{children}</p>;

function ChatPanel({ s }: { s: EngagementSummary }) {
  const { chat, kpis } = s;
  if (kpis.chatMessages === 0) return <None>No one used chat this session.</None>;
  const top = chat.topChatters[0]?.count ?? 1;
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          <MiniStat label="Messages" value={String(kpis.chatMessages)} />
          <MiniStat label="People who chatted" value={`${pct(kpis.chatters, kpis.attended)}%`} />
          <MiniStat label="Per chatter" value={kpis.chatters ? (kpis.chatMessages / kpis.chatters).toFixed(1) : "0"} />
        </div>
        <div>
          <h4 className="mb-2 text-[12.5px] font-semibold">Top chatters</h4>
          <div className="space-y-2">
            {chat.topChatters.map((c) => (
              <HBar key={c.label} label={c.label} value={c.count} total={top} suffix=" msgs" />
            ))}
          </div>
        </div>
      </div>
      <div>
        <h4 className="mb-2 text-[12.5px] font-semibold">Messages per {chat.bucketMin} minutes</h4>
        <Bars height={130} data={chat.perBucket.map((v, i) => ({ key: String(i), label: String(i * chat.bucketMin), value: v }))} />
        <h4 className="mt-4 mb-2 text-[12.5px] font-semibold">Latest messages</h4>
        <ul className="divide-y divide-line rounded-lg border border-line text-[12.5px]">
          {chat.latest.map((c, i) => (
            <li key={`${c.minute}-${i}`} className="flex gap-3 px-3 py-2">
              <span className="w-8 shrink-0 tabular-nums text-ink-3">{c.minute}m</span>
              <span className="min-w-0 break-words">
                <span className="font-medium">{c.name}</span> <span className="text-ink-2">{c.text}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function QAPanel({ s }: { s: EngagementSummary }) {
  const [filter, setFilter] = useState<"all" | "open" | "answered">("all");
  const { kpis } = s;
  if (kpis.questions === 0) return <None>No questions were asked.</None>;
  const qs = s.questions.filter((q) => filter === "all" || (filter === "answered" ? q.answered : !q.answered));
  const open = kpis.questions - kpis.answeredQuestions;
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div className="space-y-2">
        <MiniStat label="Questions asked" value={String(kpis.questions)} />
        <MiniStat label="Answered live" value={`${kpis.answeredQuestions} of ${kpis.questions}`} />
        <MiniStat label="Upvotes" value={String(kpis.upvotes)} />
        {open > 0 && (
          <p className="rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-[12px] text-warn">
            {open} {open === 1 ? "question wasn't" : "questions weren't"} answered — a great follow-up message.
          </p>
        )}
      </div>
      <div>
        <div className="mb-2 flex gap-1.5" role="group" aria-label="Filter questions">
          {(["all", "open", "answered"] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`h-7 rounded-full border px-3 text-[12px] font-medium capitalize outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                filter === f ? "border-ink bg-ink text-white" : "border-line-2 text-ink-2 hover:bg-surface-2"
              }`}
            >
              {f === "open" ? "Unanswered" : f}
            </button>
          ))}
        </div>
        {qs.length === 0 ? (
          <None>Nothing here.</None>
        ) : (
          <ul className="max-h-[420px] divide-y divide-line overflow-y-auto rounded-lg border border-line text-[13px]">
            {qs.map((q) => (
              <li key={q.id} className="flex items-start gap-3 px-3 py-2.5">
                <span className="grid w-10 shrink-0 place-items-center rounded-md bg-surface-2 py-1 text-[12px] font-semibold tabular-nums">
                  <span aria-hidden>▲ {q.upvotes}</span>
                  <span className="sr-only">{q.upvotes} upvotes</span>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="break-words">{q.text}</p>
                  <p className="mt-0.5 text-[11.5px] text-ink-3">
                    {q.name || "Anonymous"} · {q.minute}m
                  </p>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${q.answered ? "bg-ok-soft text-ok" : "bg-surface-2 text-ink-2"}`}>
                  {q.answered ? "Answered" : "Open"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PollsPanel({ s }: { s: EngagementSummary }) {
  if (s.polls.length === 0) return <None>No polls or quizzes were run.</None>;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {s.polls.map((p) => {
        const total = p.votes.reduce((a, b) => a + b, 0);
        const quiz = p.kind === "quiz" && p.correct !== undefined;
        const correctPct = quiz ? pct(p.votes[p.correct!], total) : 0;
        return (
          <article key={p.id} className="rounded-xl border border-line p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${quiz ? "bg-[#f1ebfe] text-[#7c3aed]" : "bg-warn-soft text-warn"}`}>
                {quiz ? "Quiz" : "Poll"}
              </span>
              <span className="text-[11.5px] text-ink-3 tabular-nums">
                at {p.minute}m · {total} of {p.liveAtOpen} live answered ({pct(total, p.liveAtOpen)}%)
              </span>
            </div>
            <h4 className="mt-2 text-[13.5px] font-semibold">{p.question}</h4>
            <div className="mt-3 space-y-2.5">
              {p.options.map((o, i) => (
                <HBar
                  key={`${p.id}-${i}`}
                  label={quiz && i === p.correct ? `✓ ${o}` : o}
                  value={p.votes[i] ?? 0}
                  total={total}
                  color={quiz ? (i === p.correct ? "#0b8a4b" : "#d3dae0") : "#a15c00"}
                  highlight={quiz && i === p.correct}
                />
              ))}
            </div>
            {quiz && total > 0 && (
              <p className="mt-3 text-[12px] text-ink-2">
                <strong className="text-ink">{correctPct}% correct</strong>
                {correctPct < 60 ? " — worth revisiting this topic in your follow-up." : " — the message landed."}
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}

function ReactionsPanel({ s }: { s: EngagementSummary }) {
  const { series, bucketMin } = s.reactions;
  const total = s.kpis.reactions;
  if (total === 0 || series.length === 0) return <None>No reactions this session.</None>;
  const max = Math.max(1, ...series.flatMap((e) => e.counts));
  const columns = Math.max(...series.map((e) => e.counts.length));
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
      <ul className="grid grid-cols-3 content-start gap-2">
        {series.map((e) => (
          <li key={e.emoji} className="rounded-xl border border-line px-2 py-3 text-center">
            <div className="text-[26px] leading-none">{e.emoji}</div>
            <div className="mt-1.5 text-[15px] font-semibold tabular-nums">{e.total}</div>
            <div className="text-[11px] text-ink-3 tabular-nums">{pct(e.total, total)}%</div>
          </li>
        ))}
      </ul>
      <div className="overflow-x-auto">
        <h4 className="mb-2 text-[12.5px] font-semibold">Reactions over time</h4>
        <table className="w-full min-w-[480px] border-separate border-spacing-[3px] text-[11px]">
          <thead>
            <tr>
              <th scope="col" className="sr-only">Reaction</th>
              {Array.from({ length: columns }, (_, b) => (
                <th key={b} scope="col" className="font-normal text-ink-3 tabular-nums">
                  {b * bucketMin}m
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {series.map((e) => (
              <tr key={e.emoji}>
                <th scope="row" className="w-7 text-[15px] font-normal">
                  {e.emoji}
                </th>
                {e.counts.map((n, i) => (
                  <td
                    key={i}
                    className="h-7 rounded-[4px] text-center tabular-nums"
                    style={{ background: n ? `rgba(190,24,93,${0.12 + 0.8 * (n / max)})` : "#f2f5f7", color: n / max > 0.55 ? "#fff" : "#5c6670" }}
                  >
                    {n || ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* The feedback survey's results — the same view the room's host sees, read through the page's
 * source so the sample dashboard shows sample answers. Read when the section first opens.
 *
 * This is the survey's only home after a webinar (there is no separate Survey tab), so the
 * two things a host might still do here live here too: send a survey that never went out,
 * and stop or reopen answers. */
function SurveyPanel({ source, ended }: { source: EngagementSource; ended: boolean }) {
  const { notify } = useToast();
  const [state, setState] = useState<{ id: string; data?: SurveyResults; error?: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const status = state?.id === source.id ? state.data?.status : undefined;

  useEffect(() => {
    const ctl = new AbortController();
    const read = () =>
      source
        .surveyResults(ctl.signal)
        .then((data) => setState({ id: source.id, data }))
        .catch((e: unknown) => {
          if (!ctl.signal.aborted) setState({ id: source.id, error: e instanceof Error ? e.message : "Could not load the survey." });
        });
    void read();
    // Late answers keep arriving from the ended screen while it is open.
    const t = status === "live" && source.slug ? window.setInterval(read, 15000) : undefined;
    return () => {
      ctl.abort();
      if (t) window.clearInterval(t);
    };
  }, [source, revision, status]);

  async function run(action: "launch" | "close") {
    if (!source.setSurvey) return;
    setBusy(true);
    try {
      await source.setSurvey(action);
      notify(action === "launch" ? "Survey sent" : "Survey closed — no new answers", "ok");
      setRevision((r) => r + 1);
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(false);
    }
  }

  const current = state?.id === source.id ? state : null;
  if (!current) return <div className="grid place-items-center py-10"><Spinner className="size-5 text-ink-3" /></div>;
  if (current.error) return <None>{current.error}</None>;
  const r = current.data!;

  if (!r.configured) {
    return (
      <div className="grid justify-items-center gap-2 px-6 py-10 text-center">
        <span className="grid size-10 place-items-center rounded-xl bg-surface-2 text-ink-3">
          <ClipboardIcon className="size-5" />
        </span>
        <p className="text-[14px] font-semibold">No feedback survey for this webinar</p>
        <p className="max-w-md text-[13px] text-ink-2">
          Next time, switch on &ldquo;Ask attendees for feedback&rdquo; when you schedule — ratings and comments
          show up here, and answering counts towards each person&apos;s engagement score.
        </p>
        {source.slug && (
          <ButtonLink href="/host/new" size="sm" variant="secondary" className="mt-2">
            Schedule a webinar
          </ButtonLink>
        )}
      </div>
    );
  }

  if (r.status === "draft") {
    return (
      <div className="flex flex-wrap items-center gap-4">
        <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${ended ? "bg-warn-soft text-warn" : "bg-brand-soft text-brand"}`}>
          <ClipboardIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold">{ended ? "The survey wasn't sent" : "Not sent yet"}</p>
          <p className="mt-0.5 text-[13px] text-ink-2">
            {ended
              ? "The webinar ended before it went out. Send it now and attendees see it on the ended page and the replay."
              : "Send it from the room when you're ready — answers appear here as they come in."}
          </p>
        </div>
        {ended && source.setSurvey && (
          <Button size="sm" onClick={() => void run("launch")} disabled={busy}>
            {busy && <Spinner className="size-3.5" />}
            Send survey now
          </Button>
        )}
      </div>
    );
  }

  const live = r.status === "live";
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {live ? <Badge tone="ok" dot>Taking answers</Badge> : <Badge>Closed</Badge>}
          <p className="text-[12.5px] text-ink-2">
            {live
              ? "People who missed it can still answer from the ended page."
              : "No new answers are being collected."}
          </p>
        </div>
        {source.setSurvey && (
          <Button size="sm" variant="secondary" onClick={() => void run(live ? "close" : "launch")} disabled={busy}>
            {busy && <Spinner className="size-3.5" />}
            {live ? "Stop taking answers" : "Reopen"}
          </Button>
        )}
      </div>
      <SurveyResultsView slug={source.slug ?? ""} results={r} preview={!source.slug} />
    </div>
  );
}

export function DetailTabs({
  summary,
  source,
  initialTab = "polls",
}: {
  summary: EngagementSummary;
  source: EngagementSource;
  initialTab?: TabId;
}) {
  const [tab, setTab] = useState<TabId>(initialTab);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const t = TABS[(next + TABS.length) % TABS.length];
    setTab(t.id);
    refs.current[t.id]?.focus();
  };

  return (
    <div>
      <div role="tablist" aria-label="Interaction details" className="flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`eng-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`eng-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={`-mb-px border-b-2 px-3 py-2.5 text-[13px] font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
              tab === t.id ? "border-brand text-brand" : "border-transparent text-ink-2 hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`eng-panel-${tab}`} aria-labelledby={`eng-tab-${tab}`} tabIndex={0} className="pt-4 outline-none">
        {tab === "chat" && <ChatPanel s={summary} />}
        {tab === "qa" && <QAPanel s={summary} />}
        {tab === "polls" && <PollsPanel s={summary} />}
        {tab === "reactions" && <ReactionsPanel s={summary} />}
        {tab === "survey" && <SurveyPanel source={source} ended={summary.webinar.status === "ended"} />}
      </div>
    </div>
  );
}

/* Each panel on its own, for the Engagement tab's one-section-per-topic layout. DetailTabs
 * stays as the tabbed composition of the same panels. */
export { ChatPanel, QAPanel, PollsPanel, ReactionsPanel, SurveyPanel };
