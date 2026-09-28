"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { engageApi } from "../api";
import { useAppConfig } from "@/components/providers";
import type { CRMWebinarMessagesResponse } from "@/lib/api-types";
import { useNow } from "@/lib/clock";
import { Timeline, timelineRows } from "./messages-parts";

/* The webinar's Overview, WhatsApp part: what goes out on its own before the webinar
 * (confirmation, each reminder, the replay) with how many are sent or queued, and replies
 * waiting. A slot: absent where this deployment cannot send WhatsApp. */
export function WebinarWhatsAppOverview({
  slug,
  ended,
  fallback = null,
}: {
  slug: string;
  ended: boolean;
  /** Shown when WhatsApp is not in play: the plain email schedule. */
  fallback?: ReactNode;
}) {
  const { whatsappConnect } = useAppConfig();
  const [data, setData] = useState<CRMWebinarMessagesResponse | null>(null);
  const now = useNow();

  useEffect(() => {
    if (!whatsappConnect) return;
    let cancelled = false;
    engageApi
      .crmWebinarMessages(slug)
      .then((r) => !cancelled && setData(r))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug, whatsappConnect]);

  if (!whatsappConnect) return <>{fallback}</>;
  if (!data) return null;
  if (!data.whatsappConnected) {
    return (
      <>
        {fallback}
        <p className="rounded-xl border border-line bg-surface px-4 py-3 text-[12.5px] text-ink-2">
          Send the confirmation and reminders on WhatsApp too — most people read
          them within minutes.{" "}
          <Link
            href="/host/crm?view=setup"
            className="font-medium text-brand hover:underline"
          >
            Connect WhatsApp
          </Link>
        </p>
      </>
    );
  }
  const rows = timelineRows({
    automatic: data.automatic,
    templates: data.templates,
    broadcasts: data.broadcasts,
    ended,
    now,
    engagementHref: `/host/${encodeURIComponent(slug)}?tab=follow-up`,
    onCancel: () => {},
  }).filter((r) => r.key !== "follow");
  const waiting = data.waiting.length;
  return (
    <Timeline
      title={
        ended ? "Everything sent for this webinar" : "What goes out on its own"
      }
      rows={rows}
      footer={
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[11.5px] text-ink-3">
          <span>
            By email to everyone and on WhatsApp to {data.audience.recipients}{" "}
            of{" "}
            {data.audience.recipients +
              data.audience.noOptIn +
              data.audience.optedOut +
              data.audience.noNumber}{" "}
            registered ·{" "}
            <Link
              href={`/host/${encodeURIComponent(slug)}/edit`}
              className="font-medium text-brand hover:underline"
            >
              change the times
            </Link>
          </span>
          {waiting > 0 && (
            <Link
              href="/host?tab=messages"
              className="font-medium text-brand hover:underline"
            >
              {waiting} {waiting === 1 ? "reply" : "replies"} waiting →
            </Link>
          )}
        </div>
      }
    />
  );
}
