"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { RecordingStorage } from "@/lib/api-types";
import { storageMeter } from "@/lib/recording-retention";
import { Badge, Card } from "./ui";
import { useIOSApp } from "./ios-app";

/* The recording storage meter: "6.2 of 10 GB", on the Recording tab and in Settings.
 *
 * Bytes of ready cloud recordings across the host's webinars, against their plan's quota
 * (or an admin's for this account). Past 100%, "Keep longer" is refused and new recordings
 * get the standard window only; see api/internal/api/recording_retention.go. */

/** Reads the signed-in host's meter. `reload` after anything that changes it. */
export function useRecordingStorage(enabled = true) {
  const [storage, setStorage] = useState<RecordingStorage | null>(null);
  const reload = useCallback(() => {
    if (!enabled) return;
    api
      .recordingStorage()
      .then(setStorage)
      .catch(() => {
        // Ambient: no meter is better than an error over the recordings.
      });
  }, [enabled]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { storage, reload };
}

const BAR: Record<"ok" | "warn" | "over", string> = {
  ok: "bg-brand",
  warn: "bg-warn",
  over: "bg-live",
};

export function RecordingStorageMeter({ storage }: { storage: RecordingStorage }) {
  const m = storageMeter(storage.usedBytes, storage.quotaBytes);
  // No "upgrade" link in the iOS app (App Store guideline 3.1.1, components/ios-app.tsx).
  // The meter is client-only (it waits for the fetch), so the hook alone is enough. (29 Oct 2026)
  const iosApp = useIOSApp();
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
        <span className="font-medium text-ink">Recording storage</span>
        <span className={`tabular-nums ${m.tone === "ok" ? "text-ink-2" : m.tone === "warn" ? "text-warn" : "text-live"}`}>
          {m.label}
        </span>
      </div>
      <div
        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
        role="meter"
        aria-label="Recording storage used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={m.percent}
      >
        <div className={`h-full ${BAR[m.tone]} transition-all`} style={{ width: `${m.percent}%` }} />
      </div>
      {m.tone === "over" ? (
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-live">
          Full. Recordings can&apos;t be kept longer, and new ones are kept {storage.retentionDays} days. Delete
          recordings you don&apos;t need{iosApp ? " or let others expire." : ", let others expire, or "}
          {!iosApp && (
            <>
              <Link href="/pricing#pricing" className="font-medium underline">
                upgrade
              </Link>
              .
            </>
          )}
        </p>
      ) : m.tone === "warn" ? (
        <p className="mt-1.5 text-[11.5px] text-warn">Almost full.</p>
      ) : null}
    </div>
  );
}

/** Settings → Account: the meter and the rules, for a host. */
export function RecordingStorageCard() {
  const { storage } = useRecordingStorage();
  if (!storage) return null;
  return (
    <Card className="mt-4 grid max-w-lg gap-3 p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] font-medium">Cloud recordings</div>
        {storage.quotaOverride && <Badge tone="brand">Custom limit</Badge>}
      </div>
      <RecordingStorageMeter storage={storage} />
      {storage.retentionDays > 0 && (
        <p className="text-[12px] leading-relaxed text-ink-2">
          Recordings are kept {storage.retentionDays} days after they end. Press &ldquo;Keep longer&rdquo; on a
          recording to keep it {storage.keepMonths} more months — as often as you like while you have space. We
          email you a week and a day before one is deleted.
        </p>
      )}
    </Card>
  );
}
