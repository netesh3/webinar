"use client";

import { Fragment, useState } from "react";
import type { AttendanceRow } from "@/lib/api-types";
import { Badge } from "@/components/ui";
import { ChevronDownIcon } from "@/components/icons";
import { formatDuration, formatTime } from "@/lib/format";

/* Who was in the room, when, and for how long — the old Report's attendance table, kept for
 * the rows the engagement numbers leave out on purpose: the host and panelists.
 *
 * One row per person with their visits folded in. In and Out bracket the whole session;
 * Total is the SUM of the visits, so for somebody who left and came back it is less than Out
 * minus In, and that gap is the point. Rejoins are a click away, and only rows with more than
 * one visit offer the click. */
export function AttendanceTable({ rows, timeZone }: { rows: AttendanceRow[]; timeZone: string }) {
  // Keyed by identity rather than a flag on the row, so a refetch keeps what was open.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (identity: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(identity)) next.add(identity);
      return next;
    });

  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[560px] text-[12.5px]">
        <thead>
          <tr className="border-b border-line text-left text-[11.5px] text-ink-3">
            <th scope="col" className="py-2 pr-3 font-medium">Name</th>
            <th scope="col" className="py-2 pr-3 font-medium">In</th>
            <th scope="col" className="py-2 pr-3 font-medium">Out</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">Total</th>
            <th scope="col" className="py-2 text-right font-medium">Visits</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const expandable = a.visits.length > 1;
            const isOpen = open.has(a.identity);
            return (
              <Fragment key={a.identity}>
                <tr className="border-b border-line">
                  <td className="py-2.5 pr-3">
                    <div className="flex items-center gap-1.5">
                      {expandable ? (
                        <button
                          type="button"
                          onClick={() => toggle(a.identity)}
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? "Hide" : "Show"} ${a.name}'s ${a.visits.length} visits`}
                          className="grid size-5 place-items-center rounded text-ink-3 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/40"
                        >
                          <ChevronDownIcon className={`size-3.5 transition-transform ${isOpen ? "" : "-rotate-90"}`} />
                        </button>
                      ) : (
                        <span aria-hidden className="size-5 shrink-0" />
                      )}
                      <span className="font-medium">{a.name}</span>
                      {a.role !== "attendee" && (
                        <Badge tone={a.role === "host" ? "brand" : "neutral"}>
                          {a.role === "host" ? "Host" : "Panelist"}
                        </Badge>
                      )}
                    </div>
                    {a.email && <div className="pl-[26px] text-[11.5px] text-ink-3">{a.email}</div>}
                  </td>
                  <td className="py-2.5 pr-3 text-ink-2 tabular-nums">
                    {a.firstJoinedAt ? formatTime(a.firstJoinedAt, timeZone) : "—"}
                  </td>
                  <td className="py-2.5 pr-3 text-ink-2 tabular-nums">
                    {a.lastLeftAt ? formatTime(a.lastLeftAt, timeZone) : <span className="text-ink-3">still in</span>}
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{formatDuration(a.watchMin)}</td>
                  <td className="py-2.5 text-right text-ink-2 tabular-nums">{a.visits.length}</td>
                </tr>
                {expandable && isOpen && (
                  <tr className="border-b border-line bg-surface-2/40">
                    <td colSpan={5} className="px-3 py-2">
                      <ul className="grid gap-1">
                        {a.visits.map((v, i) => (
                          <li key={`${v.joinedAt}-${i}`} className="flex items-center gap-2 text-[11.5px] text-ink-2 tabular-nums">
                            <span className="text-ink-3">{i + 1}.</span>
                            <span>{formatTime(v.joinedAt, timeZone)}</span>
                            <span aria-hidden className="text-ink-3">→</span>
                            <span>{v.leftAt ? formatTime(v.leftAt, timeZone) : <span className="text-ink-3">still in</span>}</span>
                            <span className="text-ink-3">({formatDuration(v.minutes)})</span>
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {rows.some((a) => a.visits.length > 1) && (
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-3">
          Total is time actually present, so it is less than In to Out for anyone who left and came back. Time spent
          waiting before the webinar went live is not counted.
        </p>
      )}
    </div>
  );
}
