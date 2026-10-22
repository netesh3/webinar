"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { engageApi } from "../api";
import { Spinner } from "@/components/controls";
import { useToast } from "@/components/providers";
import { Badge, Button } from "@/components/ui";
import { ApiError } from "@/lib/api";
import type { FollowupTemplateResponse } from "@/lib/api-types";
import { templateStatusText } from "@/lib/followup-send";

/* Our "session follow-up" WhatsApp template: its wording, its status on the host's WABA,
 * and one click to submit it to Meta. Until Meta approves it, a follow-up to somebody
 * outside the 24-hour window cannot go on WhatsApp (Results offers email instead).
 *
 * Shown in WhatsApp setup and in the follow-up review screen. onStatus tells the caller
 * the status whenever it is read. */
export function FollowupTemplateCard({
  compact = false,
  onStatus,
}: {
  compact?: boolean;
  onStatus?: (status: string) => void;
}) {
  const { notify } = useToast();
  const [data, setData] = useState<FollowupTemplateResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Held in a ref: a caller's inline callback must not make this read Meta again.
  const statusRef = useRef(onStatus);
  useEffect(() => {
    statusRef.current = onStatus;
  });
  const show = useCallback((r: FollowupTemplateResponse) => {
    setData(r);
    statusRef.current?.(r.status ?? "");
  }, []);

  useEffect(() => {
    let cancelled = false;
    engageApi
      .followupTemplate()
      .then((r) => {
        if (!cancelled) show(r);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't read the follow-up template.");
      });
    return () => {
      cancelled = true;
    };
  }, [show]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await engageApi.submitFollowupTemplate();
      show(r);
      notify("Submitted to Meta. Approval usually takes a few minutes, sometimes a day.", "ok");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't submit it.");
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    try {
      show(await engageApi.followupTemplate());
    } catch {
      setError("Couldn't read the follow-up template.");
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return error ? <p className="text-[12px] text-ink-3">{error}</p> : null;
  }
  const st = templateStatusText(data.status);
  return (
    <div className={compact ? "rounded-lg border border-line px-3 py-2.5" : "px-5 py-4"}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-ink">Follow-up template</span>
        <Badge tone={st.tone}>{st.label}</Badge>
        <span className="text-[11.5px] text-ink-3">{data.category.toLowerCase()}</span>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
        {st.approved
          ? "Follow-ups from Results reach people outside the 24-hour window with this template."
          : "Needed to send a follow-up on WhatsApp to somebody who hasn't written to you in the last 24 hours. Until Meta approves it, those people get the email instead."}
      </p>
      {!compact && (
        <pre className="mt-2 whitespace-pre-wrap rounded-md bg-surface-2 px-3 py-2 font-sans text-[12px] text-ink-2">
          {data.body}
          {"\n\n"}
          <span className="text-ink-3">{data.footer}</span>
        </pre>
      )}
      {!compact && (
        <p className="mt-1 text-[11.5px] text-ink-3">
          {"{{1}}"} is the first name, {"{{2}}"} the session, {"{{3}}"} your message on one line. Marketing,
          because it is your own message rather than a receipt for something they asked for, so it only goes to
          people who opted in.
        </p>
      )}
      {error && <p className="mt-1 text-[12px] text-live">{error}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {!data.connected ? (
          <p className="text-[12px] text-ink-3">Connect WhatsApp first.</p>
        ) : !data.status ? (
          <Button type="button" size="sm" onClick={() => void submit()} disabled={busy}>
            {busy && <Spinner />}
            Submit our follow-up template to Meta
          </Button>
        ) : (
          !st.approved && (
            <Button type="button" size="sm" variant="secondary" onClick={() => void refresh()} disabled={busy}>
              {busy && <Spinner />}
              Check again
            </Button>
          )
        )}
      </div>
    </div>
  );
}
