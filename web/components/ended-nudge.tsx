"use client";

import { useEffect, useState } from "react";
import { ButtonLink, Card } from "./ui";
import { api } from "@/lib/api";
import type { Webinar } from "@/lib/api-types";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import {
  FOLLOW_UP_FETCH_LIMIT,
  FOLLOW_UP_VISIBLE,
  eligibleFollowUps,
} from "@/lib/follow-up-nudge";
import { formatRelative } from "@/lib/format";

/* On Hosting's Upcoming tab: webinars that just ended, and the one next step.
 * The first days after a webinar are when a follow-up works, and the Completed
 * tab is one click too far to remember it. Shown for a week after the end.
 * The first five sit in view; the rest of that week scroll inside the column. */

export function EndedNudge() {
  const [rows, setRows] = useState<Webinar[] | null>(null);
  useEffect(() => {
    if (isDevAuthBypassActive()) return;
    let cancelled = false;
    api
      .hostWebinars({ tab: "past", limit: FOLLOW_UP_FETCH_LIMIT })
      .then((page) => {
        if (!cancelled) setRows(eligibleFollowUps(page.items, Date.now()));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  if (!rows || rows.length === 0) return null;
  const scrollable = rows.length > FOLLOW_UP_VISIBLE;
  return (
    <aside
      aria-label="Follow up"
      className="w-full min-[900px]:w-[17.5rem] min-[900px]:shrink-0"
    >
      {/* The hidden copies are the height of the first five cards, whatever
          those titles wrap to. The list on top of them scrolls once a sixth
          session is still inside the week. */}
      <div className="relative">
        <div
          className="invisible grid gap-3 overflow-y-auto [scrollbar-gutter:stable]"
          inert
          aria-hidden
        >
          {rows.slice(0, FOLLOW_UP_VISIBLE).map((w) => (
            <FollowUpCard key={w.id} webinar={w} />
          ))}
        </div>
        <div
          className="absolute inset-0 grid content-start gap-3 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
          tabIndex={scrollable ? 0 : undefined}
        >
          {rows.map((w) => (
            <FollowUpCard key={w.id} webinar={w} />
          ))}
        </div>
      </div>
    </aside>
  );
}

function FollowUpCard({ webinar }: { webinar: Webinar }) {
  if (!webinar.endedAt) return null;
  const came = webinar.report?.attended ?? 0;
  const missed = Math.max(0, webinar.registrantCount - came);
  const title = `${webinar.topic} ended ${formatRelative(webinar.endedAt, new Date())}`;
  const detail = `${came} came${missed > 0 ? ` · ${missed} missed it` : ""} — follow up while it's fresh.`;
  const href = `/host/${encodeURIComponent(webinar.id)}?tab=follow-up`;
  return (
    <Card className="grid gap-3 border-brand-line bg-brand-soft/40 p-4">
      <span
        className="grid size-9 place-items-center rounded-lg bg-brand text-white"
        aria-hidden
      >
        ✦
      </span>
      <div className="min-w-0">
        <p className="text-[13.5px] font-semibold text-ink">{title}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{detail}</p>
      </div>
      <ButtonLink href={href} size="sm" className="w-full">
        Follow up
      </ButtonLink>
    </Card>
  );
}
