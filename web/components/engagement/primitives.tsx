import type { ReactNode } from "react";
import { Card } from "@/components/ui";
import { hueFor, initialsOf } from "@/lib/avatar";
import { TIER_META, asTier } from "@/lib/engagement/score";

/* Small shared pieces of the Engagement page. Presentational only. */

export function Section({
  title,
  hint,
  action,
  children,
  className = "",
  id,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <Card className={`h-full min-w-0 p-4 sm:p-5 ${className}`}>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id={headingId} className="text-[14px] font-semibold">
              {title}
            </h2>
            {hint && <p className="mt-0.5 text-[12px] text-ink-2">{hint}</p>}
          </div>
          {action}
        </div>
        {children}
      </Card>
    </section>
  );
}

export function TierChip({ tier }: { tier: string }) {
  const meta = TIER_META[asTier(tier)];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${meta.chip}`}
    >
      <span className={`size-1.5 rounded-full ${meta.dot}`} aria-hidden />
      {meta.label}
    </span>
  );
}

export function ScorePill({ score, tier }: { score: number; tier: string }) {
  return (
    <span
      className="inline-grid h-7 w-9 place-items-center rounded-md text-[12.5px] font-semibold text-white tabular-nums"
      style={{ background: TIER_META[asTier(tier)].color }}
    >
      <span className="sr-only">Score </span>
      {score}
    </span>
  );
}

export function Initials({ name, seed, size = 30 }: { name: string; seed: string; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white"
      style={{ background: hueFor(seed), width: size, height: size, fontSize: size * 0.37 }}
      aria-hidden
    >
      {initialsOf(name)}
    </span>
  );
}

export function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className="text-[17px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function Icon({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span className={`material-symbols-outlined !text-[16px] ${className}`} aria-hidden>
      {name}
    </span>
  );
}
