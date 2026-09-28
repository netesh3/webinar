"use client";

import { useEffect, useState } from "react";
import { ButtonLink, Card } from "./ui";
import { api } from "@/lib/api";
import type { Webinar } from "@/lib/api-types";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { formatRelative } from "@/lib/format";

/* On Hosting's Upcoming tab: the webinar that just ended, and its one next step. The
 * first days after a webinar are when a follow-up works, and the Completed tab is one
 * click too far to remember it. Shown for a week after the end. */
const WEEK = 7 * 24 * 3_600_000;

export function EndedNudge() {
  const [w, setW] = useState<Webinar | null>(null);
  useEffect(() => {
    if (isDevAuthBypassActive()) return;
    let cancelled = false;
    api
      .hostWebinars({ tab: "past", limit: 1 })
      .then((page) => {
        const last = page.items[0];
        const ended = last?.endedAt ? Date.parse(last.endedAt) : NaN;
        if (!cancelled && last && Date.now() - ended < WEEK) setW(last);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  if (!w || !w.endedAt) return null;
  const came = w.report?.attended ?? 0;
  const missed = Math.max(0, w.registrantCount - came);
  return (
    <Card className="mb-4 flex flex-wrap items-center gap-3 border-brand-line bg-brand-soft/40 px-4 py-3">
      <span
        className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand text-white"
        aria-hidden
      >
        ✦
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-semibold text-ink">
          {w.topic} ended {formatRelative(w.endedAt, new Date())}
        </p>
        <p className="text-[12px] text-ink-2">
          {came} came{missed > 0 ? ` · ${missed} missed it` : ""} — follow up
          while it&apos;s fresh.
        </p>
      </div>
      <ButtonLink
        href={`/host/${encodeURIComponent(w.id)}?tab=follow-up`}
        size="sm"
      >
        Follow up
      </ButtonLink>
    </Card>
  );
}
