"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import type { SurveyNPS, SurveyQuestionResult, SurveyResults, SurveyTextAnswer } from "@/lib/api-types";
import { barWidths, formatAverage, npsTone, shares, starLabel } from "@/lib/survey";
import { Spinner } from "../controls";
import { StarIcon } from "../icons";
import { Card, SectionTitle, Stat } from "../ui";

/* What the audience said: the headline numbers, the rating and NPS breakdowns, each extra
 * question, and the comments — paged per question from the server rather than shipped whole.
 *
 * Shared by the webinar's Survey tab and the engagement dashboard's Survey tab, so the two
 * never disagree. `preview` disables paging for fixture data. */

export function SurveyResultsView({
  slug,
  results: r,
  preview,
}: {
  slug: string;
  results: SurveyResults;
  preview?: boolean;
}) {
  const link = r.mode === "link";
  const ratingShown = r.ratings > 0 || !link;
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Responses"
          value={String(r.responses)}
          note={r.responseRatePct >= 0 ? `${r.responseRatePct}% of ${r.attended} attendees` : "Nobody attended yet"}
          tone="brand"
        />
        {ratingShown && (
          <Stat
            label="Average rating"
            value={formatAverage(r.averageRating, 5)}
            note={r.ratings ? `${starLabel(Math.round(r.averageRating))} · ${r.ratings} ratings` : "No ratings yet"}
            tone={r.averageRating >= 4 ? "ok" : r.averageRating >= 3 || r.averageRating < 0 ? "neutral" : "warn"}
          />
        )}
        {link && (
          <Stat
            label="Opened the survey"
            value={String(r.linkClicks)}
            note={r.clickThroughPct >= 0 ? `${r.clickThroughPct}% click-through` : "Nobody attended yet"}
          />
        )}
        {r.nps && (
          <Stat
            label="NPS"
            value={r.nps.responses ? signed(r.nps.score) : "—"}
            note={r.nps.responses ? `${r.nps.responses} answers` : "No answers yet"}
            tone={r.nps.responses ? npsTone(r.nps.score) : "neutral"}
          />
        )}
      </div>

      {r.responses === 0 && r.linkClicks === 0 ? (
        <Card className="px-6 py-12 text-center">
          <p className="text-[14px] font-medium text-ink">No responses yet</p>
          <p className="mx-auto mt-1.5 max-w-md text-[13px] text-ink-2">
            {r.status === "live"
              ? "The survey is live. Answers appear here as they arrive."
              : "Answers appear here once the survey has been sent."}
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {ratingShown && r.ratings > 0 && (
            <Card className="p-4">
              <SectionTitle>Overall rating</SectionTitle>
              <RatingBars counts={r.ratingDistribution} />
            </Card>
          )}
          {r.nps && r.nps.responses > 0 && (
            <Card className="p-4">
              <SectionTitle>Net Promoter Score</SectionTitle>
              <NpsBreakdown nps={r.nps} />
            </Card>
          )}
          {r.questions
            .filter((q) => q.kind !== "text" && !(r.nps && q.id === firstNps(r)?.id))
            .map((q) => (
              <Card key={q.id} className="p-4">
                <QuestionResult q={q} />
              </Card>
            ))}
          {r.questions
            .filter((q) => q.kind === "text")
            .map((q) => (
              <Card key={q.id} className="p-4 lg:col-span-2">
                <TextAnswers slug={slug} q={q} initial={r.comments.filter((c) => c.questionId === q.id)} preview={preview} />
              </Card>
            ))}
        </div>
      )}
    </div>
  );
}

function firstNps(r: SurveyResults) {
  return r.questions.find((q) => q.kind === "nps_10");
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export function RatingBars({ counts }: { counts: readonly number[] }) {
  const widths = barWidths(counts);
  const pct = shares(counts);
  return (
    <ul className="grid gap-1.5">
      {[4, 3, 2, 1, 0].map((i) => (
        <li key={i} className="flex items-center gap-2.5 text-[12.5px]">
          <span className="flex w-10 shrink-0 items-center gap-1 font-medium text-ink-2 tabular-nums">
            {i + 1}
            <StarIcon className="size-3.5 fill-warn text-warn" />
          </span>
          <span className="relative h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-warn transition-[width] duration-500"
              style={{ width: `${widths[i]}%` }}
            />
          </span>
          <span className="w-16 shrink-0 text-right text-ink-3 tabular-nums">
            {counts[i] ?? 0} · {pct[i]}%
          </span>
        </li>
      ))}
    </ul>
  );
}

export function NpsBreakdown({ nps }: { nps: SurveyNPS }) {
  const pct = shares([nps.promoters, nps.passives, nps.detractors]);
  const parts = [
    { label: "Promoters", sub: "9–10", n: nps.promoters, p: pct[0], cls: "bg-ok" },
    { label: "Passives", sub: "7–8", n: nps.passives, p: pct[1], cls: "bg-ink-3/50" },
    { label: "Detractors", sub: "0–6", n: nps.detractors, p: pct[2], cls: "bg-live" },
  ];
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span
          className={`text-[28px] font-semibold tracking-[-0.02em] tabular-nums ${
            { ok: "text-ok", warn: "text-warn", live: "text-live" }[npsTone(nps.score)]
          }`}
        >
          {signed(nps.score)}
        </span>
        <span className="text-[12px] text-ink-3">from −100 to +100 · {nps.responses} answers</span>
      </div>
      <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-surface-2" aria-hidden>
        {parts.map((x) => (
          <span key={x.label} className={x.cls} style={{ width: `${x.p}%` }} />
        ))}
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-[12px]">
        {parts.map((x) => (
          <div key={x.label}>
            <dt className="flex items-center gap-1.5 text-ink-2">
              <span className={`size-2 rounded-full ${x.cls}`} aria-hidden />
              {x.label} <span className="text-ink-3">{x.sub}</span>
            </dt>
            <dd className="mt-0.5 font-semibold text-ink tabular-nums">
              {x.n} <span className="font-normal text-ink-3">· {x.p}%</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function QuestionResult({ q }: { q: SurveyQuestionResult }) {
  return (
    <>
      <h3 className="text-[13px] font-semibold text-ink">{q.prompt}</h3>
      <p className="mt-0.5 mb-3 text-[11.5px] text-ink-3">
        {q.answered} answered
        {q.average >= 0 && ` · average ${q.average.toFixed(1)}`}
      </p>
      {q.kind === "rating_5" && <RatingBars counts={q.distribution} />}
      {q.kind === "nps_10" && q.nps && <NpsBreakdown nps={q.nps} />}
      {q.kind === "single_choice" && <ChoiceBars choices={q.choices ?? []} />}
    </>
  );
}

function ChoiceBars({ choices }: { choices: { label: string; count: number }[] }) {
  const counts = choices.map((c) => c.count);
  const widths = barWidths(counts);
  const pct = shares(counts);
  return (
    <ul className="grid gap-2">
      {choices.map((c, i) => (
        <li key={i} className="text-[12.5px]">
          <div className="flex justify-between gap-2">
            <span className="min-w-0 truncate text-ink">{c.label}</span>
            <span className="shrink-0 text-ink-3 tabular-nums">
              {c.count} · {pct[i]}%
            </span>
          </div>
          <span className="relative mt-1 block h-2 overflow-hidden rounded-full bg-surface-2">
            <span className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: `${widths[i]}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function TextAnswers({
  slug,
  q,
  initial,
  preview,
}: {
  slug: string;
  q: SurveyQuestionResult;
  initial: SurveyTextAnswer[];
  preview?: boolean;
}) {
  const [rows, setRows] = useState<SurveyTextAnswer[] | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = rows ?? initial;
  const more = rows ? Boolean(cursor) : q.answered > initial.length;

  async function load() {
    if (preview || loading) return;
    setLoading(true);
    setError(null);
    try {
      const page = await api.surveyAnswers(slug, q.id, rows ? cursor : undefined);
      setRows((prev) => [...(prev ?? []), ...page.answers]);
      setCursor(page.nextCursor || undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more answers.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h3 className="text-[13px] font-semibold text-ink">{q.prompt}</h3>
      <p className="mt-0.5 text-[11.5px] text-ink-3">{q.answered} answers</p>
      {shown.length === 0 ? (
        <p className="py-4 text-[12.5px] text-ink-3">No written answers yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {shown.map((a, i) => (
            <li key={`${a.submittedAt}-${i}`} className="py-2.5">
              <p className="text-[13px] leading-relaxed whitespace-pre-wrap break-words text-ink">{a.text}</p>
              {/* Local time: the server's render and the browser's may disagree on the zone. */}
              <p className="mt-0.5 text-[11.5px] text-ink-3" suppressHydrationWarning>
                {a.name || "Attendee"} · {formatWhen(a.submittedAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-[12px] text-live">{error}</p>}
      {more && !preview && (
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="mt-2 inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-[12.5px] font-medium text-brand hover:bg-brand-soft disabled:opacity-50"
        >
          {loading && <Spinner className="size-3.5" />}
          {rows ? "Show more" : `Show all ${q.answered}`}
        </button>
      )}
    </>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
