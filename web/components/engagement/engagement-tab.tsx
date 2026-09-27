"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { RegistrantRow, Webinar } from "@/lib/api-types";
import { apiSource } from "@/lib/engagement/api-source";
import { fixtureSource } from "@/lib/engagement/source";
import { useDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { formatDay, formatTime, tzLabel } from "@/lib/format";
import { EngagementDashboard } from "./engagement-dashboard";
import { DashboardSkeleton } from "./states";

const noSubscribe = () => () => {};

/** The host screen's Engagement tab: picks the data source, then hands off to the dashboard.
 *  Local preview (dev bypass) has no API behind it, so it reads the sample webinar in the
 *  preview webinar's state — scheduled, live or ended. */
export function EngagementTab({
  webinar: w,
  registrants,
  onOpenAttendees,
}: {
  webinar: Webinar;
  registrants: RegistrantRow[];
  onOpenAttendees?: () => void;
}) {
  const bypass = useDevAuthBypassActive();
  // Bypass is only knowable after hydration; choosing a source before then would fire an
  // API request the preview has no backend to answer.
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  const previewStatus = w.status === "live" ? "live" : w.status === "ended" ? "ended" : "scheduled";
  const source = useMemo(
    () => (bypass ? fixtureSource(previewStatus) : apiSource(w.id)),
    [bypass, previewStatus, w.id],
  );
  const approved = useMemo(
    () => (w.approval === "manual" ? registrants.filter((r) => r.state === "approved").length : undefined),
    [w.approval, registrants],
  );

  if (!hydrated) return <DashboardSkeleton />;
  return (
    <EngagementDashboard
      source={source}
      sample={bypass}
      approved={approved}
      showTitle={false}
      notStartedDetail={`Scheduled for ${formatDay(w.startsAt, w.timeZone)}, ${formatTime(w.startsAt, w.timeZone)} ${tzLabel(w.startsAt, w.timeZone)}`}
      onOpenAttendees={onOpenAttendees}
      signInHref={`/login?next=${encodeURIComponent(`/host/${w.id}?tab=engagement`)}`}
    />
  );
}
