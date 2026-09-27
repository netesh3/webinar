import { SegmentJoined, SegmentNoShow, type CRMSegment, type RegistrantRow } from "@/lib/api-types";

/* The watch-time buckets a host follows up by, after a webinar.
 *
 * Shared by the Attendees tab's chips and the Messages tab's "Follow up" cards, so a
 * chip and a card with the same name are the same people: each is both a test a row
 * on screen passes and a segment the server resolves for the send. "Stayed" is half
 * the planned length, capped at 30 minutes, because a host thinking "the ones who
 * stayed" means the ones who saw the pitch, not the ones who stayed to the last slide.
 */
export type WatchBucket = {
  id: string;
  label: string;
  segment: CRMSegment;
  /** Words a template for this group tends to use, to put the best one first. */
  hints: string[];
  /** What to say to them, as the suggestion on the Messages tab's card. */
  suggestion: string;
  test: (r: RegistrantRow) => boolean;
};

export function watchBuckets(durationMin: number): WatchBucket[] {
  const stayed = Math.max(5, Math.min(30, Math.round((durationMin || 60) / 2)));
  return [
    {
      id: "stayed",
      label: `Watched ${stayed}+ min`,
      segment: { attendance: SegmentJoined, minWatchMin: stayed },
      hints: ["thank", "stay", "offer", "workbook", "program"],
      suggestion: "Thank them for staying and make your offer.",
      test: (r) => r.joined && r.watchMin >= stayed,
    },
    {
      id: "left",
      label: `Left before ${stayed} min`,
      segment: { attendance: SegmentJoined, maxWatchMin: stayed - 1 },
      hints: ["missed", "left", "replay", "part"],
      suggestion: "Send the replay, starting from the part they missed.",
      test: (r) => r.joined && r.watchMin < stayed,
    },
    {
      id: "no_show",
      label: "Didn't join",
      segment: { attendance: SegmentNoShow },
      hints: ["missed", "sorry", "replay", "recording"],
      suggestion: "Sorry we missed you — here's the replay.",
      test: (r) => !r.joined,
    },
  ];
}
