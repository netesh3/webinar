"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { engageApi } from "../api";
import { useSession } from "@/components/providers";
import type { CRMRepliesResponse } from "@/lib/api-types";
import { formatRelative } from "@/lib/format";

/* WhatsApp replies waiting on the host, for the top bar's bell.
 *
 * One bell, not two: the webinar app's bell adds this count to its badge and renders
 * ReplyAlerts at the top of its panel. It polls slowly while the tab is visible; the
 * reply email (sent after a quiet spell) covers the host who is not in the app at all.
 */

const POLL_MS = 60_000;

export function useReplies(): CRMRepliesResponse | null {
  const { account } = useSession();
  const enabled = Boolean(account?.canHost && account?.whatsapp);
  const [data, setData] = useState<CRMRepliesResponse | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () =>
      engageApi
        .crmReplies()
        .then((res) => {
          if (!cancelled) setData(res);
        })
        .catch(() => {});
    load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);

  return enabled ? data : null;
}

/** The bell panel's WhatsApp section: replies waiting, newest first. Rendered by the
 *  webinar app's bell (components/host-alerts), which adds `needsReply` to its badge. */
export function ReplyAlerts({
  data,
  onNavigate,
}: {
  data: CRMRepliesResponse | null;
  onNavigate: () => void;
}) {
  if (!data || data.needsReply === 0) return null;
  return (
    <div className="border-b border-line">
      <Link
        href="/host?tab=messages"
        onClick={onNavigate}
        className="flex items-center justify-between px-3 py-2 text-[12px] font-semibold text-ok hover:bg-surface-2"
      >
        <span>
          {data.needsReply} WhatsApp {data.needsReply === 1 ? "reply" : "replies"} to answer
        </span>
        <span className="font-medium text-brand">Open Messages</span>
      </Link>
      <ul className="divide-y divide-line/60">
        {data.recent.slice(0, 4).map((r) => (
          <li key={r.contactId}>
            <Link
              href={`/host?tab=messages&contact=${encodeURIComponent(r.contactId)}`}
              onClick={onNavigate}
              className="block bg-ok/5 px-3 py-2 hover:bg-surface-2"
            >
              <div className="flex items-center gap-2 text-[12.5px]">
                <span className="truncate font-medium">{r.name} replied</span>
                <span className="ml-auto shrink-0 text-[11px] text-ink-3">
                  {formatRelative(r.at, new Date())}
                </span>
              </div>
              {r.webinar && (
                <div className="mt-0.5 truncate text-[11.5px] text-ink-3">{r.webinar}</div>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
