import {
  SegmentJoined,
  SegmentNoShow,
  TierNoShow,
  type CRMSegment,
  type EngagementTier,
  type RegistrantRow,
} from "@/lib/api-types";
import { TIER_META, TIER_ORDER } from "@/lib/engagement/score";

/* The groups a host follows up by, after a webinar: the Engagement tab's four score tiers
 * and the no-shows.
 *
 * Shared by the Attendees tab's chips and the Engagement tab's Follow up cards, so a chip
 * and a card with the same name are the same people: each is both a test a row on screen
 * passes (the row's tier, from the same engagement_scores) and a segment the server
 * resolves for the send.
 */
export type FollowupGroup = {
  id: EngagementTier;
  label: string;
  segment: CRMSegment;
  /** Words a template for this group tends to use, to put the best one first. */
  hints: string[];
  test: (r: RegistrantRow) => boolean;
};

const HINTS: Record<string, string[]> = {
  high: ["offer", "program", "thank", "spot", "enrol"],
  engaged: ["thank", "replay", "offer", "attend"],
  passive: ["replay", "recap", "highlight"],
  risk: ["replay", "missed", "left", "part"],
  [TierNoShow]: ["missed", "sorry", "replay", "recording"],
};

export function followupGroups(): FollowupGroup[] {
  return [
    ...TIER_ORDER.map<FollowupGroup>((t) => ({
      id: t,
      label: TIER_META[t].label,
      segment: { attendance: SegmentJoined, tiers: [t] },
      hints: HINTS[t],
      test: (r) => r.joined && r.tier === t,
    })),
    {
      id: TierNoShow,
      label: "Didn't join",
      segment: { attendance: SegmentNoShow },
      hints: HINTS[TierNoShow],
      test: (r) => !r.joined,
    },
  ];
}
