"use client";

import type { ReactNode } from "react";
import type { EngagementTierCounts } from "@/lib/api-types";
import { EngagementFollowUp } from "./engagement-follow-up";
import { WebinarMessagesTab } from "./webinar-messages";

/* An ended webinar's Follow up tab: the one place to message people after it. The groups
 * (by how they took part) with Review & send and the automatic switch, then everything
 * WhatsApp sent for this webinar and the replies waiting. afterGroups is the webinar
 * screen's slot for this webinar's WhatsApp numbers, under the group cards. */
export function EngagementFollowUpPage({
  slug,
  tiers,
  afterGroups,
}: {
  slug: string;
  tiers: EngagementTierCounts | null;
  afterGroups?: ReactNode;
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
      {afterGroups}
      <section className="grid gap-2">
        <h2 className="text-[15px] font-semibold text-ink">
          What was sent, and replies
        </h2>
        <WebinarMessagesTab slug={slug} ended />
      </section>
    </div>
  );
}
