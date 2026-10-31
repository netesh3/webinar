"use client";

import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { onHostListsDropped } from "@/lib/host-list-cache";
import { useVisibleRefresh } from "@/lib/visible-refresh";

/** The public webinar / meeting page is a Server Component. While it is open
 *  and the session is not already ended, poll for a status change and refresh
 *  so "live" / "ended" updates without leaving the page. */
export function WebinarStatusRefresh({
  slug,
  status,
}: {
  slug: string;
  status: string;
}) {
  const router = useRouter();
  const refresh = useCallback(() => {
    if (status === "ended") return;
    api
      .getWebinar(slug)
      .then((w) => {
        if (w.status !== status) router.refresh();
      })
      .catch(() => {});
  }, [slug, status, router]);
  useVisibleRefresh(refresh);
  useEffect(() => onHostListsDropped(refresh), [refresh]);
  return null;
}
