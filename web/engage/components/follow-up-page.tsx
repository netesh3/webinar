"use client";

import type { EngagementTierCounts } from "@/lib/api-types";
import { EngagementFollowUp } from "./engagement-follow-up";
import { WebinarMessagesTab } from "./webinar-messages";

/* An ended webinar's Follow up tab: the one place to message people after it. The groups
 * (by how they took part) with Review & send and the automatic switch, then everything
 * WhatsApp sent for this webinar and the replies waiting. */
export function EngagementFollowUpPage({
  slug,
  tiers,
}: {
  slug: string;
  tiers: EngagementTierCounts | null;
}) {
  return (
    <div className="grid gap-6">
      <section className="grid gap-2">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">Who to message</h2>
          <p className="text-[12.5px] text-ink-2">
            Everyone lands in one group by how they took part. Send each group
            what fits, now or after every webinar.
          </p>
        </div>
        {tiers ? (
          <EngagementFollowUp slug={slug} tiers={tiers} />
        ) : (
          <p className="text-[12.5px] text-ink-3">Working out who took part…</p>
        )}
      </section>
      <section className="grid gap-2">
        <h2 className="text-[15px] font-semibold text-ink">
          What was sent, and replies
        </h2>
        <WebinarMessagesTab slug={slug} ended />
      </section>
    </div>
  );
}
