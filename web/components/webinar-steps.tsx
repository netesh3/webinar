"use client";

import type { Webinar } from "@/lib/api-types";
import { formatDay, formatTime } from "@/lib/format";
import { stepFor, type Step } from "@/lib/host-tabs";

/* The four steps of a webinar — Create, Invite, Go live, Follow up — with where this one
 * is. The same words the coach thinks in, so the page says what is next without a tour. */
const STEPS: { id: Step; title: string }[] = [
  { id: "create", title: "Create" },
  { id: "invite", title: "Invite" },
  { id: "live", title: "Go live" },
  { id: "follow", title: "Follow up" },
];

export function StepBar({ webinar: w, registrants }: { webinar: Webinar; registrants: number }) {
  const now = stepFor(w.status);
  const at = STEPS.findIndex((s) => s.id === now);
  const report = w.report;
  const sub: Record<Step, string> = {
    create: w.status === "draft" ? "Finish setup" : "Page is live",
    invite: `${registrants} registered`,
    live:
      w.status === "ended"
        ? report
          ? `${report.attended} came · ${report.avgWatchMin} min avg`
          : "Done"
        : w.status === "live"
          ? "On now"
          : `${formatDay(w.startsAt, w.timeZone).split(",")[0]} ${formatTime(w.startsAt, w.timeZone)}`,
    follow: w.status === "ended" ? "Message who came, and who missed it" : "After it ends",
  };
  return (
    <ol className="mb-5 grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-surface sm:grid-cols-4">
      {STEPS.map((s, i) => {
        const done = i < at;
        const current = i === at;
        return (
          <li
            key={s.id}
            aria-current={current ? "step" : undefined}
            className="flex items-center gap-2.5 border-line px-3.5 py-2.5 not-last:border-r max-sm:odd:border-r max-sm:[&:nth-child(-n+2)]:border-b"
          >
            <span
              className={`grid size-6 shrink-0 place-items-center rounded-full text-[11.5px] font-bold ${
                done
                  ? "bg-ok text-white"
                  : current
                    ? "bg-brand text-white ring-4 ring-brand/15"
                    : "bg-surface-2 text-ink-3"
              }`}
            >
              {done ? "✓" : i + 1}
            </span>
            <span className="min-w-0">
              <span className={`block text-[13px] font-semibold ${current || done ? "text-ink" : "text-ink-3"}`}>
                {s.title}
              </span>
              <span className="block truncate text-[11.5px] text-ink-3">{sub[s.id]}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
