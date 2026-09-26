"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Spinner } from "@/components/controls";
import { CRMScreen, MESSAGES_HREF, PEOPLE_HREF } from "@/engage";

/* What is left of the old Contacts page.
 *
 * People and Messages are Hosting tabs now, so a plain /host/crm link — every one
 * already sent out, and old bookmarks — lands on People (with its webinar filter
 * carried over), and ?view=inbox on Messages. What stays here is the setup checklist
 * (Account settings links to it) and the parked automations — broadcasts, sequences,
 * bots — reachable by ?view= but no longer in the nav.
 *
 * A static segment beside /host/[id], so it shadows a webinar whose slug is literally
 * "crm" — the same trade /host/new and /host/login already make. */

const KEPT = new Set(["setup", "broadcasts", "sequences", "bots"]);

function CRMRoute() {
  const router = useRouter();
  const search = useSearchParams();
  const view = (search.get("view") ?? "").trim();
  const keep = KEPT.has(view);

  useEffect(() => {
    if (keep) return;
    if (view === "inbox") {
      router.replace(MESSAGES_HREF);
      return;
    }
    const webinar = (search.get("webinar") ?? "").trim();
    router.replace(webinar ? `${PEOPLE_HREF}&webinar=${encodeURIComponent(webinar)}` : PEOPLE_HREF);
  }, [keep, view, search, router]);

  if (!keep) return <Loading />;
  return <CRMScreen />;
}

function Loading() {
  return (
    <div className="grid place-items-center py-20">
      <Spinner className="size-6 text-ink-3" />
    </div>
  );
}

export default function HostCRMPage() {
  return (
    <Suspense fallback={<Loading />}>
      <CRMRoute />
    </Suspense>
  );
}
