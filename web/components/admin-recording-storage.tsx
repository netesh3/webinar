"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { MaxRecordingQuotaGB, MaxRecordingRetentionDays } from "@/lib/api-types";
import type { AdminUser } from "@/lib/api-types";
import { gbText, parseQuotaGB } from "@/lib/recording-retention";
import { useToast } from "./providers";

const GB = 1024 ** 3;

/* Admin -> Accounts: one host's recording storage (GB, blank = the plan's) and default
 * retention (days, blank = the deployment's). Both are sent on every save, so the request
 * says the whole setting; the server's PATCH has replace semantics. */
export function RecordingStorageField({
  user: u,
  onSaved,
}: {
  user: AdminUser;
  onSaved: (patch: Pick<AdminUser, "recordingQuotaBytes" | "recordingLimitBytes" | "recordingRetentionDays">) => void;
}) {
  const { notify } = useToast();
  const gbCurrent = u.recordingQuotaBytes === undefined ? "" : String(Math.round((u.recordingQuotaBytes / GB) * 10) / 10);
  const daysCurrent = u.recordingRetentionDays === undefined ? "" : String(u.recordingRetentionDays);
  // The row is keyed by the saved values, so a save starts the drafts over.
  const [gb, setGB] = useState(gbCurrent);
  const [days, setDays] = useState(daysCurrent);
  const [busy, setBusy] = useState(false);
  const over = u.recordingUsedBytes > u.recordingLimitBytes;

  async function commit() {
    if (gb.trim() === gbCurrent && days.trim() === daysCurrent) return;
    const quota = parseQuotaGB(gb, MaxRecordingQuotaGB);
    const d = days.trim() === "" ? null : Number(days.trim());
    if (quota === undefined || (d !== null && (!Number.isInteger(d) || d < 1 || d > MaxRecordingRetentionDays))) {
      setGB(gbCurrent);
      setDays(daysCurrent);
      notify(`Recording storage is 0.1 to ${MaxRecordingQuotaGB} GB and retention 1 to ${MaxRecordingRetentionDays} days, or blank for the default.`, "error");
      return;
    }
    setBusy(true);
    try {
      const st = await api.setUserRecordingStorage(u.id, quota, d);
      onSaved({
        recordingQuotaBytes: quota ?? undefined,
        recordingLimitBytes: st.quotaBytes,
        recordingRetentionDays: d ?? undefined,
      });
      notify(`Recording storage for ${u.name || u.email}: ${gbText(st.quotaBytes)}${quota === null ? " (plan)" : ""}, kept ${st.retentionDays} days.`, "ok");
    } catch (e) {
      setGB(gbCurrent);
      setDays(daysCurrent);
      notify(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(false);
    }
  }

  const input =
    "rounded-md border border-line bg-surface-0 px-2 py-1 text-[12px] text-ink-1 outline-none focus-visible:ring-2 focus-visible:ring-brand/40";
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
  };

  return (
    <span
      className="flex items-center gap-1.5 text-[12px] text-ink-2"
      title={`Recording storage: ${gbText(u.recordingUsedBytes)} used of ${gbText(u.recordingLimitBytes)}. Blank uses the plan's (${gbText(u.planRecordingLimitBytes)}) and the default retention (${u.defaultRecordingRetentionDays} days).`}
    >
      <span className={over ? "text-live" : ""}>Recordings {gbText(u.recordingUsedBytes)} /</span>
      <input
        type="number"
        inputMode="decimal"
        min={0.1}
        max={MaxRecordingQuotaGB}
        step="any"
        aria-label="Recording storage in GB"
        placeholder={`${Math.round(u.planRecordingLimitBytes / GB)} (plan)`}
        value={gb}
        disabled={busy}
        onChange={(e) => setGB(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={onKey}
        className={`w-[86px] ${input}`}
      />
      <span>GB ·</span>
      <input
        type="number"
        inputMode="numeric"
        min={1}
        max={MaxRecordingRetentionDays}
        step={1}
        aria-label="Recording retention in days"
        placeholder={`${u.defaultRecordingRetentionDays} (default)`}
        value={days}
        disabled={busy}
        onChange={(e) => setDays(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={onKey}
        className={`w-[92px] ${input}`}
      />
      <span>days</span>
    </span>
  );
}
