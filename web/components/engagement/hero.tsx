"use client";

import { useId, useState } from "react";
import type { EngagementSummary, EngagementWeight } from "@/lib/api-types";
import { Badge, Card } from "@/components/ui";
import { formatDay, formatTime, tzLabel } from "@/lib/format";
import { BAND_META, asBand } from "@/lib/engagement/score";
import { pct } from "@/lib/engagement/viz";
import { ScoreGauge } from "./charts";

const KIND_LABEL: Record<string, string> = {
  chat: "busiest chat",
  qa: "questions & upvotes",
  poll: "poll & quiz answers",
  reaction: "a wave of reactions",
};

function Callouts({ s }: { s: EngagementSummary }) {
  const { bestMoment, biggestDrop, needsRecap } = s.callouts;
  const items = [
    bestMoment && {
      key: "best",
      title: "Best moment",
      tone: "text-ok",
      text: `${bestMoment.minute} min — ${KIND_LABEL[bestMoment.kind] ?? "busiest minute"} (${bestMoment.actions} actions)`,
    },
    biggestDrop && {
      key: "drop",
      title: "Biggest drop",
      tone: "text-live",
      text: `${biggestDrop.minute}–${biggestDrop.minute + 5} min, ${biggestDrop.lost} ${biggestDrop.lost === 1 ? "person" : "people"} left`,
    },
    needsRecap && {
      key: "recap",
      title: "Needs a recap",
      tone: "text-warn",
      text: `${needsRecap.question.replace(/\?$/, "")} — ${needsRecap.correctPct}% correct`,
    },
  ].filter((x): x is { key: string; title: string; tone: string; text: string } => !!x);
  if (items.length === 0) return null;
  return (
    <ul className="mt-4 grid gap-2 text-[12.5px] sm:grid-cols-3">
      {items.map((c) => (
        <li key={c.key} className="rounded-lg border border-line bg-surface-2/60 px-3 py-2">
          <span className={`block text-[11px] font-medium ${c.tone}`}>{c.title}</span>
          {c.text}
        </li>
      ))}
    </ul>
  );
}

function FormulaStrip({ weights }: { weights: EngagementWeight[] }) {
  return (
    <div className="border-t border-line bg-surface-2/40 px-5 py-4 text-[12.5px] text-ink-2 sm:px-6">
      <p>
        Each attendee gets a score out of 100; the session&apos;s index is their average. Points are capped so spamming
        chat can&apos;t win, and a tool you didn&apos;t use hands its points to the rest.
      </p>
      <ul className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-4">
        {weights.map((w) => (
          <li key={w.key} className={w.weight > 0 ? "" : "text-ink-3"}>
            <span className={w.weight > 0 ? "text-ink" : ""}>{w.label}</span> —{" "}
            {w.weight > 0 ? (
              <>
                <span className="tabular-nums">{Math.round(w.weight)}</span> pts <span className="text-ink-3">({w.rule})</span>
              </>
            ) : w.key === "survey" ? (
              "coming soon"
            ) : (
              "not used this session"
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Hero({ summary: s, showTitle = true }: { summary: EngagementSummary; showTitle?: boolean }) {
  const [showFormula, setShowFormula] = useState(false);
  const formulaId = useId();
  const band = asBand(s.band, s.index);
  const w = s.webinar;
  const live = w.status === "live";

  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
            <Badge tone={live ? "live" : "neutral"} dot={live}>
              {live ? "Live now" : "Ended"}
            </Badge>
            {w.startedAt && (
              <span>
                {formatDay(w.startedAt, w.timeZone)} · {formatTime(w.startedAt, w.timeZone)} {tzLabel(w.startedAt, w.timeZone)}
              </span>
            )}
            <span aria-hidden>·</span>
            <span>{w.sessionMin} min</span>
            {w.hostName && (
              <>
                <span aria-hidden>·</span>
                <span>Hosted by {w.hostName}</span>
              </>
            )}
          </div>
          {/* Inside the host screen the webinar's title is already the page heading. */}
          {showTitle && (
            <h1 className="mt-2 text-[22px] leading-tight font-semibold tracking-[-0.02em] sm:text-[24px]">{w.title}</h1>
          )}
          <p className={`${showTitle ? "mt-2" : "mt-3"} max-w-2xl text-[14px] text-ink-2`}>
            <strong className="text-ink">{BAND_META[band].label} session</strong> — {s.kpis.stayedPastHalfPct}% of attendees
            stayed past the halfway mark, and {pct(s.kpis.chatters, s.kpis.attended)}% joined the conversation.
          </p>
          <Callouts s={s} />
        </div>
        <div className="flex flex-col items-center justify-center gap-2 border-t border-line bg-surface-2/50 px-8 py-5 md:border-t-0 md:border-l">
          <span className="text-[12px] font-medium text-ink-2">Engagement index</span>
          <ScoreGauge score={s.index} band={band} />
          <button
            type="button"
            onClick={() => setShowFormula((v) => !v)}
            aria-expanded={showFormula}
            aria-controls={formulaId}
            className="rounded text-[12px] font-medium text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            How is this calculated?
          </button>
        </div>
      </div>
      <div id={formulaId} hidden={!showFormula}>
        {showFormula && <FormulaStrip weights={s.weights} />}
      </div>
    </Card>
  );
}
