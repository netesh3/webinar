"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { AdminWhatsAppUsage } from "@/lib/api-types";
import { formatCount } from "@/lib/format";
import { featureShare, whatsAppUsageLine } from "@/lib/whatsapp-usage";
import { Alert } from "./controls";
import { Card } from "./ui";

/* WhatsApp usage, for one pricing decision: do hosts use the CRM, or only the
 * automatic reminders? If most only send reminders, reminders can be sold as an
 * add-on on Professional instead of being bundled into Business.
 * Every figure comes from GET /api/admin/stats/whatsapp. */

type Days = 7 | 30 | 90;
const WINDOWS: Days[] = [7, 30, 90];

const PLAN_NAME: Record<string, string> = {
  basic: "Basic",
  starter: "Starter",
  professional: "Professional",
  business: "Business",
  enterprise: "Enterprise",
};

export function AdminWhatsAppUsagePanel() {
  const [days, setDays] = useState<Days>(30);
  const [usage, setUsage] = useState<AdminWhatsAppUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Writes inside .then(), as in AdminDashboard, for react-hooks/set-state-in-effect.
  const load = useCallback(() => {
    api
      .adminWhatsAppUsage(days)
      .then((next) => {
        setUsage(next);
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Could not load WhatsApp usage.");
      });
  }, [days]);

  useEffect(load, [load]);

  const s = usage?.summary;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold tracking-[0.01em] text-ink">WhatsApp usage</h2>
        <div role="radiogroup" aria-label="Window" className="flex gap-1">
          {WINDOWS.map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={days === d}
              onClick={() => setDays(d)}
              className={`rounded-md px-2 py-0.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                days === d ? "bg-brand-soft font-medium text-brand" : "text-ink-2 hover:bg-surface-2"
              }`}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>
      <Card className="p-3">
        {error && <Alert tone="error">{error}</Alert>}
        {!usage && !error && <p className="px-1 py-6 text-center text-[13px] text-ink-2">Loading…</p>}
        {usage && s && (
          <div className="grid gap-3">
            <div className="px-1">
              <p className="text-[13.5px] font-medium text-ink">{whatsAppUsageLine(s)}</p>
              {s.hosts > 0 && (
                <p className="mt-0.5 text-[12px] text-ink-2">
                  Broadcasts {featureShare(s.broadcasts, s.hosts)} · Drips {featureShare(s.drips, s.hosts)} ·
                  Chatbot {featureShare(s.chatbot, s.hosts)} · Inbox replies {featureShare(s.inbox, s.hosts)}
                </p>
              )}
            </div>
            {usage.hosts.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-[12.5px]">
                  <thead className="text-[11.5px] text-ink-3">
                    <tr className="border-b border-line">
                      <th className="px-2 py-1.5 font-medium">Host</th>
                      <th className="px-2 py-1.5 font-medium">Plan</th>
                      <th className="px-2 py-1.5 text-right font-medium">Reminders</th>
                      <th className="px-2 py-1.5 text-right font-medium">Broadcasts</th>
                      <th className="px-2 py-1.5 text-right font-medium">Drips</th>
                      <th className="px-2 py-1.5 text-right font-medium">Chatbot</th>
                      <th className="px-2 py-1.5 text-right font-medium" title="Replies the host typed, then replies received">
                        Inbox
                      </th>
                      <th className="px-2 py-1.5 font-medium">Last active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.hosts.map((h) => (
                      <tr key={h.userId} className="border-b border-line last:border-0">
                        <td className="px-2 py-1.5">
                          <div className="font-medium text-ink">{h.name || h.email}</div>
                          <div className="text-[11.5px] text-ink-3">
                            {h.email}
                            {!h.connected && " · not connected"}
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-ink-2">{PLAN_NAME[h.plan ?? ""] ?? "No plan"}</td>
                        <Num n={h.reminders} />
                        <Num n={h.broadcasts} />
                        <Num n={h.drips} />
                        <td className="px-2 py-1.5 text-right tabular-nums" title={`${h.botMessages} bot messages`}>
                          {formatCount(h.botSessions)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums" title="Typed / received">
                          {formatCount(h.manualReplies)} / {formatCount(h.inboundReplies)}
                        </td>
                        <td className="px-2 py-1.5 text-ink-2">
                          {h.lastActiveAt
                            ? new Date(h.lastActiveAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function Num({ n }: { n: number }) {
  return (
    <td className={`px-2 py-1.5 text-right tabular-nums ${n === 0 ? "text-ink-3" : "text-ink"}`}>
      {formatCount(n)}
    </td>
  );
}
