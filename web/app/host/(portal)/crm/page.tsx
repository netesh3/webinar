"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Spinner } from "@/components/controls";
import { MESSAGES_HREF, PEOPLE_HREF, WhatsAppScreen } from "@/engage";

/* The WhatsApp page: Automations, Templates, Number & billing.
 *
 * People and Messages are Hosting tabs, so the old Contacts links — ?webinar=, ?status=,
 * ?view=contacts — land on People (with the webinar filter carried over), and
 * ?view=inbox on Messages. Everything else opens here: a plain /host/crm on Automations,
 * ?view=setup on Number & billing (Account settings links to it), and the builders by
 * ?view=sequences / bots / broadcasts.
 *
 * A static segment beside /host/[id], so it shadows a webinar whose slug is literally
 * "crm" — the same trade /host/new and /host/login already make. */

const MOVED = new Set(["contacts", "inbox"]);

function CRMRoute() {
  const router = useRouter();
  const search = useSearchParams();
  const view = (search.get("view") ?? "").trim();
  const keep =
    !MOVED.has(view) && !search.get("webinar") && !search.get("status");

  useEffect(() => {
    if (keep) return;
    if (view === "inbox") {
      router.replace(MESSAGES_HREF);
      return;
    }
    const webinar = (search.get("webinar") ?? "").trim();
    router.replace(
      webinar
        ? `${PEOPLE_HREF}&webinar=${encodeURIComponent(webinar)}`
        : PEOPLE_HREF,
    );
  }, [keep, view, search, router]);

  if (!keep) return <Loading />;
  return <WhatsAppScreen />;
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
