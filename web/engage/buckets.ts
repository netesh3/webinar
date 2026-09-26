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
  test: (r: RegistrantRow) => boolean;
};

export function watchBuckets(durationMin: number): WatchBucket[] {
  const stayed = Math.max(5, Math.min(30, Math.round((durationMin || 60) / 2)));
  return [
    {
      id: "stayed",
      label: `Watched ${stayed}+ min`,
      segment: { attendance: SegmentJoined, minWatchMin: stayed },
      test: (r) => r.joined && r.watchMin >= stayed,
    },
    {
      id: "left",
      label: `Left before ${stayed} min`,
      segment: { attendance: SegmentJoined, maxWatchMin: stayed - 1 },
      test: (r) => r.joined && r.watchMin < stayed,
    },
    {
      id: "no_show",
      label: "Didn't join",
      segment: { attendance: SegmentNoShow },
      test: (r) => !r.joined,
    },
  ];
}
