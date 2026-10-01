"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Spinner } from "@/components/controls";
import { HostPeopleTab } from "@/engage";

/* Audience, reached from the sidebar. The list, filters and summary are the
 * same screen that used to sit on Your webinars as ?tab=people. */

function AudienceRoute() {
  const search = useSearchParams();
  const webinar = (search.get("webinar") ?? "").trim();
  const filter = (search.get("filter") ?? "").trim();
  return (
    <div className="grid gap-4">
      <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Audience</h1>
      <HostPeopleTab
        key={`${webinar}:${filter}`}
        initialWebinar={webinar}
        initialFilter={filter}
        summary
      />
    </div>
  );
}

export default function HostAudiencePage() {
  return (
    <Suspense
      fallback={
        <div className="grid place-items-center py-20">
          <Spinner className="size-6 text-ink-3" />
        </div>
      }
    >
      <AudienceRoute />
    </Suspense>
  );
}
