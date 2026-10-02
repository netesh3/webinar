"use client";

import { useEffect, useId, useState } from "react";
import { ButtonLink, Card } from "./ui";
import { api } from "@/lib/api";
import type { Webinar } from "@/lib/api-types";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { FOLLOW_UP_FETCH_LIMIT, recentFollowUps } from "@/lib/follow-up-nudge";
import { formatRelative } from "@/lib/format";

/* On Hosting's Upcoming tab: the three webinars that just ended, and the one
 * next step. The first days after a webinar are when a follow-up works, and
 * the Completed tab is one click too far to remember it. Shown for a week
 * after the end. Three cards, then stop — a fourth is not drawn. */

export function EndedNudge({ className = "" }: { className?: string }) {
  const titleId = useId();
  const [rows, setRows] = useState<Webinar[] | null>(null);
  useEffect(() => {
    if (isDevAuthBypassActive()) return;
    let cancelled = false;
    api
      .hostWebinars({ tab: "past", limit: FOLLOW_UP_FETCH_LIMIT })
      .then((page) => {
        if (!cancelled) setRows(recentFollowUps(page.items, Date.now()));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  if (!rows || rows.length === 0) return null;
  return (
    <aside
      aria-labelledby={titleId}
      className={`w-full min-[900px]:w-[17.5rem] min-[900px]:shrink-0 ${className}`}
    >
      <div className="mb-2.5">
        <h2
          id={titleId}
          className="text-[14px] font-semibold tracking-[-0.01em] text-ink"
        >
          Recent webinars
        </h2>
        <p className="mt-0.5 text-[12.5px] leading-snug text-ink-2">
          Follow up while it&apos;s fresh
        </p>
      </div>
      <div className="grid gap-2.5">
        {rows.map((w) => (
          <FollowUpCard key={w.id} webinar={w} />
        ))}
      </div>
    </aside>
  );
}

function FollowUpCard({ webinar }: { webinar: Webinar }) {
  if (!webinar.endedAt) return null;
  const came = webinar.report?.attended ?? 0;
  const missed = Math.max(0, webinar.registrantCount - came);
  const when = formatRelative(webinar.endedAt, new Date());
  const attendance = `${came} came${missed > 0 ? ` · ${missed} missed it` : ""}`;
  const href = `/host/${encodeURIComponent(webinar.id)}?tab=follow-up`;
  return (
    <Card className="grid gap-2.5 bg-surface p-3">
      <div className="min-w-0">
        <p className="text-[14px] font-semibold leading-snug tracking-[-0.01em] text-ink">
          {webinar.topic}
        </p>
        <p className="mt-0.5 text-[13px] text-ink-2">ended {when}</p>
        <p className="mt-1 text-[14px] leading-snug text-ink-2">{attendance}</p>
      </div>
      <ButtonLink
        href={href}
        size="sm"
        className="w-full"
        aria-label={`Follow up on ${webinar.topic}`}
      >
        Follow up
      </ButtonLink>
    </Card>
  );
}
