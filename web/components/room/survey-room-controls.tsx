"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { HostSurvey } from "@/lib/api-types";
import { Spinner } from "../controls";
import { ClipboardIcon, PlayIcon, StopIcon } from "../icons";
import { useToast } from "../providers";
import { useRoomUI } from "./context";

/* The post-event survey, from inside the room: where it stands and one button.
 *
 * Setup lives on the webinar's Survey tab (host-survey-tab.tsx); mid-session a host only
 * needs "Send now" and "Close", so that is all this is. Sits at the top of the host's
 * Polls panel because that is where a host already goes to put a question to the room. */

export function SurveyRoomControls() {
  const { slug, realtime } = useRoomUI();
  const { notify } = useToast();
  const [host, setHost] = useState<HostSurvey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(() => {
    api
      .hostSurvey(slug)
      .then(setHost)
      .catch(() => undefined);
  }, [slug]);

  useEffect(() => {
    read();
  }, [read, realtime.surveyRevision]);

  const sv = host?.survey;
  useEffect(() => {
    if (sv?.status !== "live") return;
    const t = window.setInterval(read, 15000);
    return () => window.clearInterval(t);
  }, [sv?.status, read]);

  if (!host) return null;

  const manage = `/host/${encodeURIComponent(slug)}?tab=survey`;

  if (!sv) {
    return (
      <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-dashed border-line-2 px-3 py-2.5">
        <ClipboardIcon className="size-4 shrink-0 text-ink-3" />
        <p className="min-w-0 flex-1 text-[12.5px] text-ink-2">No post-event survey yet.</p>
        <a
          href={manage}
          target="_blank"
          rel="noopener"
          className="shrink-0 text-[12.5px] font-medium text-brand hover:underline"
        >
          Set up
        </a>
      </div>
    );
  }

  async function run(action: "launch" | "close") {
    setBusy(true);
    setError(null);
    try {
      const next = action === "launch" ? await api.launchSurvey(slug) : await api.closeSurvey(slug);
      setHost((h) => ({ attended: h?.attended ?? 0, survey: next }));
      notify(action === "launch" ? "Survey sent — attendees see it now" : "Survey closed", "ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  const live = sv.status === "live";
  const line = live
    ? `Live · ${sv.responses} of ${host.attended} answered${sv.mode === "link" ? ` · ${sv.linkClicks} opened` : ""}`
    : sv.status === "closed"
      ? `Closed · ${sv.responses} answered`
      : sv.sendAt === "on_end"
        ? "Sends when you end the webinar"
        : "Draft — not sent yet";

  return (
    <div className={`mb-3 rounded-xl border px-3 py-2.5 ${live ? "border-ok/30 bg-ok-soft/40" : "border-line bg-surface-2/40"}`}>
      <div className="flex items-center gap-2.5">
        <span
          className={`grid size-8 shrink-0 place-items-center rounded-lg ${live ? "bg-ok-soft text-ok" : "bg-brand-soft text-brand"}`}
        >
          <ClipboardIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-semibold text-ink">
            Survey · {sv.mode === "link" ? "link" : "rating"}
          </p>
          <p className="truncate text-[11.5px] text-ink-3">{line}</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(live ? "close" : "launch")}
          className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold transition-colors disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
            live ? "border border-line-2 text-ink hover:bg-surface-2" : "bg-brand text-stage hover:bg-brand-hover"
          }`}
        >
          {busy ? <Spinner className="size-3.5" /> : live ? <StopIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
          {live ? "Close" : sv.status === "closed" ? "Reopen" : "Send now"}
        </button>
      </div>
      {error && <p className="mt-1.5 text-[11.5px] text-live">{error}</p>}
      <a href={manage} target="_blank" rel="noopener" className="mt-1.5 inline-block text-[11.5px] font-medium text-brand hover:underline">
        Edit questions &amp; see results
      </a>
    </div>
  );
}
