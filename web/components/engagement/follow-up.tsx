"use client";

import type { EngagementTierCounts } from "@/lib/api-types";
import { TIER_META, TIER_ORDER } from "@/lib/engagement/score";
import { pct } from "@/lib/engagement/viz";

/* The engagement levels: how the attendees split across the four tiers. The Follow up
 * section's fallback when this deployment cannot send WhatsApp — with it, the CRM's
 * Follow up cards (EngagementFollowUp from "@/engage") take the section instead. */

export function TierLevels({ tiers }: { tiers: EngagementTierCounts }) {
  const attended = TIER_ORDER.reduce((s, t) => s + tiers[t], 0);
  return (
    <>
      <div className="flex h-4 overflow-hidden rounded-full bg-surface-2" aria-hidden>
        {TIER_ORDER.map((t) => (
          <div key={t} style={{ width: `${pct(tiers[t], attended)}%`, background: TIER_META[t].color }} />
        ))}
      </div>
      <ul className="mt-4 grid grid-cols-2 gap-3">
        {TIER_ORDER.map((t) => (
          <li key={t} className="rounded-lg border border-line px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
              <span className={`size-2 rounded-full ${TIER_META[t].dot}`} aria-hidden />
              {TIER_META[t].label}
            </div>
            <div className="mt-0.5 text-[20px] font-semibold tabular-nums">
              {tiers[t]} <span className="text-[12px] font-normal text-ink-3">· {pct(tiers[t], attended)}%</span>
            </div>
            <div className="text-[11px] text-ink-3">{TIER_META[t].hint}</div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[12px] text-ink-3">
        Plus {tiers.noShow} registrants who never joined — they&apos;re in the follow-up list.
      </p>
    </>
  );
}
