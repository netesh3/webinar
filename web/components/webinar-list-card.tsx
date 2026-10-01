import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "./ui";

/* One row for a finished host webinar and for a webinar this person is
 * attending.
 *
 * They used to be two cards. The attending one kept a coloured stripe along
 * the top — the host's hue — and a different date line, so a session you
 * signed up for no longer looked like the Completed list once it was over.
 * Callers still choose the badge, the line under the date, and the button
 * (See results, View, or Join). The chrome stays here so those don't drift. */
export function WebinarListCard({
  href,
  title,
  badge,
  when,
  meta,
  action,
  titleDataTour = false,
}: {
  href: string;
  title: string;
  badge?: ReactNode;
  when: string;
  meta?: ReactNode;
  action?: ReactNode;
  /** Host-list tour anchor. Attending is not part of that tour. */
  titleDataTour?: boolean;
}) {
  return (
    <Card className="group relative p-4 transition-colors hover:border-line-2 hover:bg-surface-2/40 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          {badge ? (
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">{badge}</div>
          ) : null}
          <h3 className="text-[15px] font-semibold tracking-[-0.01em]">
            {/* Stretched over the card so anywhere on it opens the row. The
                action sits later, and positioned, so it keeps its own click. */}
            <Link
              href={href}
              {...(titleDataTour ? { "data-tour": "webinar-title" } : {})}
              className="outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] group-hover:text-brand focus-visible:after:ring-2 focus-visible:after:ring-brand/40"
            >
              {title}
            </Link>
          </h3>
          <p className="mt-1 text-[13px] text-ink-2">{when}</p>
          {meta}
        </div>
        {action ? <div className="relative shrink-0">{action}</div> : null}
      </div>
    </Card>
  );
}
