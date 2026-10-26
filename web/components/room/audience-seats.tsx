"use client";

/* "N / limit seats" in the host's participants panel during a live webinar: the attendee
 * count the join check turns people away with, against the webinar's attendee limit. Raising
 * the limit is in the webinar's settings (or an admin's override past 300). */

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { seatsView, type SeatsView } from "@/lib/audience-seats";

const POLL_MS = 15_000;

export function AudienceSeats({ slug }: { slug: string }) {
  const [view, setView] = useState<SeatsView | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const status = await api.hostEdgeStatus(slug);
        if (!cancelled) setView(seatsView(status.audience, status.audienceLimit));
      } catch {
        // A panelist without access, or a blip: the readout just stays as it was.
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slug]);

  if (!view) return null;
  const bar =
    view.tone === "full" ? "bg-live" : view.tone === "near" ? "bg-amber-500" : "bg-brand";
  return (
    <div className="flex items-center gap-2 text-[12px] text-ink-2" title="Attendees holding a seat now, against this webinar's attendee limit">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
        <div className={`h-full ${bar}`} style={{ width: `${view.percent}%` }} />
      </div>
      <span className={view.tone === "full" ? "font-medium text-live" : undefined}>
        {view.tone === "full" ? `Full · ${view.text}` : view.text}
      </span>
    </div>
  );
}
