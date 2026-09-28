"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { engageApi } from "../api";
import { Spinner } from "@/components/controls";
import { useToast } from "@/components/providers";
import { Empty } from "@/components/ui";
import { ApiError } from "@/lib/api";
import type {
  CRMBroadcast,
  CRMWebinarMessagesResponse,
} from "@/lib/api-types";
import { useNow } from "@/lib/clock";
import {
  NextStepCard,
  RemindersHelp,
  Timeline,
  WaitingList,
  WhatsAppKpis,
  replyClosing,
  timelineRows,
} from "./messages-parts";
import { SendDialog, type SendTarget } from "./send-dialog";

/* A webinar's Messages tab: what WhatsApp sent for this one webinar, and who answered.
 *
 * Only what WhatsApp knows — reach, every message sent or queued in the order the
 * attendee gets them, replies waiting, whether reminders moved show-up. Who to follow up
 * with is decided on the Engagement tab, by the same groups the page scores people into;
 * attendance is shown there too. See docs/engage/V2.md, "v2.1".
 */
export function WebinarMessagesTab({
  slug,
  ended,
}: {
  slug: string;
  ended: boolean;
  /** Unused since follow-ups moved to Engagement; kept so callers need not change. */
  durationMin?: number;
}) {
  const { notify } = useToast();
  const [data, setData] = useState<CRMWebinarMessagesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [target, setTarget] = useState<SendTarget | null>(null);
  const now = useNow();

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmWebinarMessages(slug)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(
            e instanceof ApiError
              ? e.message
              : "Could not load this webinar's messages.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [slug, tick]);

  async function cancel(b: CRMBroadcast) {
    try {
      await engageApi.cancelCrmBroadcast(b.id);
      notify("Scheduled follow-up cancelled.", "ok");
      refresh();
    } catch (e) {
      notify(
        e instanceof ApiError ? e.message : "Could not cancel it.",
        "error",
      );
    }
  }

  if (error && !data) return <Empty title={error} />;
  if (!data)
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );

  if (!data.whatsappConnected) {
    return (
      <Empty
        title="WhatsApp isn't connected"
        hint="Connect your WhatsApp Business number to send confirmations, reminders and follow-ups for this webinar."
        action={
          <Link
            href="/account"
            className="font-medium text-brand hover:underline"
          >
            Account settings
          </Link>
        }
      />
    );
  }

  const closing = now === null ? null : replyClosing(data.waiting, now);
  const rows = timelineRows({
    automatic: data.automatic,
    templates: data.templates,
    broadcasts: data.broadcasts,
    ended,
    now,
    engagementHref: `/host/${encodeURIComponent(slug)}?tab=follow-up`,
    onCancel: cancel,
  });

  return (
    <div className="grid grid-cols-1 gap-4">
      {closing && <NextStepCard step={closing} tone="ok" />}

      <WhatsAppKpis
        audience={data.audience}
        results={data.results}
        broadcasts={data.broadcasts}
        waiting={data.waiting.length}
      />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="grid gap-3">
          <Timeline
            rows={rows}
            footer={
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[11.5px] text-ink-3">
                <span>
                  Templates for these messages are on the{" "}
                  <Link
                    href="/host/crm?view=templates"
                    className="font-medium text-brand hover:underline"
                  >
                    WhatsApp page
                  </Link>
                  .
                </span>
                <button
                  type="button"
                  className="font-medium text-brand hover:underline"
                  onClick={() =>
                    setTarget({
                      kind: "segment",
                      webinarId: slug,
                      segment: {},
                      label: "Everyone registered",
                    })
                  }
                >
                  Message everyone registered
                </button>
              </div>
            }
          />
        </div>
        <div className="grid gap-4">
          <WaitingList waiting={data.waiting} />
          {ended && <RemindersHelp r={data.results} />}
        </div>
      </div>

      <SendDialog
        open={target !== null}
        target={target}
        onClose={() => setTarget(null)}
        onSent={refresh}
      />
    </div>
  );
}
