"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { ATTENDEE_SCOPES, type AttendeeScope } from "@/lib/attendee-export";
import { Icon } from "./engagement/primitives";
import { Card } from "./ui";

/** "Export attendees (CSV)" for an ended session, at the top of Results' Attendees section. The link is a real
 *  download (the server answers with an attachment); the toggle picks whether registrants
 *  who never joined get a row too. Host and co-hosts only — the server enforces it. */
export function AttendeeExportCard({ slug }: { slug: string }) {
  const [scope, setScope] = useState<AttendeeScope>("attended");
  return (
    <Card className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ink">Attendee list</p>
        <p className="mt-0.5 text-[12px] text-ink-3">
          Join and leave times, watch time, how they joined, questions, chat, polls, raised
          hands and registration answers. Times are in the session&apos;s time zone.
        </p>
      </div>
      <div
        role="radiogroup"
        aria-label="Who to include"
        className="inline-flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5"
      >
        {ATTENDEE_SCOPES.map((o) => {
          const active = o.id === scope;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setScope(o.id)}
              className={`inline-flex h-7 items-center rounded-[6px] px-2.5 text-[12px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                active ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      <a
        href={api.attendeesCsvUrl(slug, scope)}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 text-[12.5px] font-medium text-ink outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <Icon name="download" />
        Export attendees (CSV)
      </a>
    </Card>
  );
}
