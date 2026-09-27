"use client";

import { useMemo } from "react";
import type { EngagementQuestion, EngagementSummary, SessionQuestion } from "@/lib/api-types";
import { Spinner } from "@/components/controls";
import { Button } from "@/components/ui";
import type { useSessionRecord } from "@/lib/engagement/hooks";
import { AttendanceTable } from "./attendance-table";
import { ErrorState } from "./states";

type Record = ReturnType<typeof useSessionRecord>;

/* The two lists the engagement numbers leave out on purpose — the stage, and questions past
 * the audience's top 50 — read from the attendance log only when the host asks. */

export function StageAttendance({ record, timeZone, onLoad }: { record: Record; timeZone: string; onLoad: () => void }) {
  if (!record.available) return null;
  const rows = record.data?.stage;
  return (
    <div className="mt-4 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[13.5px] font-semibold">Hosts &amp; panelists</h3>
          <p className="mt-0.5 text-[12px] text-ink-2">
            When the stage was in the room. Not counted in any number above — those are your audience only.
          </p>
        </div>
        {!rows && !record.loading && (
          <Button size="sm" variant="secondary" onClick={onLoad}>
            Show
          </Button>
        )}
      </div>
      {record.loading && <Spinner className="mt-3 size-4 text-ink-3" />}
      {record.error != null && (
        <div className="mt-3">
          <ErrorState error={record.error} onRetry={record.retry} compact />
        </div>
      )}
      {rows &&
        (rows.length === 0 ? (
          <p className="mt-3 text-[12.5px] text-ink-3">No host or panelist was recorded in the room.</p>
        ) : (
          <div className="mt-3">
            <AttendanceTable rows={rows} timeZone={timeZone} />
          </div>
        ))}
    </div>
  );
}

function asEngagementQuestion(q: SessionQuestion, startedAt: string | undefined): EngagementQuestion {
  const t0 = startedAt ? Date.parse(startedAt) : NaN;
  const at = q.createdAt ? Date.parse(q.createdAt) : NaN;
  const minute = Number.isNaN(t0) || Number.isNaN(at) ? 0 : Math.max(0, Math.floor((at - t0) / 60_000));
  const who = q.anonymous ? "" : q.name;
  return {
    id: q.id,
    minute,
    name: q.role && q.role !== "attendee" ? `${who || "Anonymous"} (${q.role === "host" ? "host" : "panelist"})` : who,
    text: q.text,
    upvotes: q.upvotes,
    answered: q.answered,
  };
}

/** The summary with its question list swapped for every question the session kept — stage
 *  questions included, the ones dismissed live left out, as the old Report counted them. */
export function useFullQuestions(s: EngagementSummary | null, record: Record): EngagementSummary | null {
  const all = record.data?.questions;
  return useMemo(() => {
    if (!s || !all) return null;
    const kept = all.filter((q) => !q.dismissed);
    const questions = kept
      .map((q) => asEngagementQuestion(q, s.webinar.startedAt))
      .sort((a, b) => b.upvotes - a.upvotes || a.minute - b.minute);
    return {
      ...s,
      questions,
      kpis: {
        ...s.kpis,
        questions: kept.length,
        answeredQuestions: kept.filter((q) => q.answered).length,
        upvotes: kept.reduce((n, q) => n + q.upvotes, 0),
      },
    };
  }, [s, all]);
}
