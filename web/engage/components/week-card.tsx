"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { engageApi } from "../api";
import { WhatsAppIcon } from "@/components/icons";
import { useSession } from "@/components/providers";
import type { CRMSummaryResponse } from "@/lib/api-types";
import { formatRelative } from "@/lib/format";
import { messagesHref } from "../hrefs";
import { pct } from "./wa-kit";

/* "WhatsApp this week", over the Hosting home's Upcoming list (Engage v2): what the
 * coach's messages did in the last seven days, what is waiting, and what goes next.
 * Hidden for a host with no WhatsApp at all, and for one with nothing to report. */
export function WhatsAppWeekCard() {
  const { account } = useSession();
  const enabled = Boolean(account?.canHost && account?.whatsapp?.connected);
  const [data, setData] = useState<CRMSummaryResponse | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    engageApi
      .crmSummary()
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  if (!enabled || !data) return null;
  if (data.sent === 0 && data.replied === 0 && data.needsReply === 0 && !data.nextSendAt) return null;

  const cells = [
    { n: String(data.sent), label: "messages sent" },
    { n: pct(data.read, data.sent), label: "read" },
    { n: String(data.replied), label: data.replied === 1 ? "person replied" : "people replied" },
    { n: String(data.newOptIns), label: "new opt-ins" },
  ];

  return (
    <section className="mb-4 overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
        <span className="grid size-7 place-items-center rounded-lg bg-ok-soft text-ok">
          <WhatsAppIcon className="size-4" />
        </span>
        <h2 className="text-[13px] font-semibold text-ink">WhatsApp this week</h2>
        {data.needsReply > 0 && (
          <Link
            href={messagesHref()}
            className="ml-auto rounded-full bg-ok px-2.5 py-1 text-[11.5px] font-semibold text-white hover:brightness-110"
          >
            {data.needsReply} {data.needsReply === 1 ? "reply" : "replies"} to answer →
          </Link>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4">
        {cells.map((c, i) => (
          <div
            key={c.label}
            className={`px-4 py-3 ${i > 0 ? "sm:border-l" : ""} ${i % 2 ? "border-l" : ""} ${i > 1 ? "border-t sm:border-t-0" : ""} border-line`}
          >
            <div className="text-[19px] font-semibold text-ink tabular-nums">{c.n}</div>
            <div className="text-[11.5px] text-ink-3">{c.label}</div>
          </div>
        ))}
      </div>
      {data.nextSendAt && (
        <p className="border-t border-line bg-surface-2 px-4 py-2 text-[12px] text-ink-2">
          Next: <span className="font-medium text-ink">{data.nextSendLabel}</span>{" "}
          {formatRelative(data.nextSendAt, new Date())}
        </p>
      )}
    </section>
  );
}
