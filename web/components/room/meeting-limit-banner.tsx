"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppConfig } from "@/components/providers";

interface Props {
  startedAt: string | null;
  maxDurationMin: number | null;
  endedByLimit?: boolean;
}

const WARNING_MS = 15 * 60 * 1000;

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function minutesToHuman(min: number): string {
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"}`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  if (rem === 0) return `${h} hour${h === 1 ? "" : "s"}`;
  return `${h}h ${rem}m`;
}

function useSupportEmail(): string {
  const config = useAppConfig();
  return config.supportEmail ?? "support@webinarliv.com";
}

export function MeetingLimitBanner({ startedAt, maxDurationMin, endedByLimit }: Props) {
  const supportEmail = useSupportEmail();
  const [remaining, setRemaining] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const computeRemaining = useCallback(() => {
    if (!startedAt || !maxDurationMin) return null;
    const startMs = new Date(startedAt).getTime();
    const limitMs = startMs + maxDurationMin * 60 * 1000;
    return limitMs - Date.now();
  }, [startedAt, maxDurationMin]);

  useEffect(() => {
    if (!startedAt || !maxDurationMin) {
      setRemaining(null);
      return;
    }
    setRemaining(computeRemaining());
    intervalRef.current = setInterval(() => {
      setRemaining(computeRemaining());
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [startedAt, maxDurationMin, computeRemaining]);

  if (endedByLimit) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="limit-modal-title"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
      >
        <div className="max-w-sm w-full rounded-2xl bg-surface-1 p-6 shadow-xl border border-line">
          <div className="flex flex-col items-center gap-3 text-center">
            <span
              className="material-symbols-outlined select-none text-live"
              style={{ fontSize: "2.5rem" }}
              aria-hidden="true"
            >
              timer_off
            </span>
            <h2 id="limit-modal-title" className="text-[15px] font-semibold">
              Maximum Meeting Length Reached
            </h2>
            <p className="text-[13px] leading-relaxed text-ink-2">
              This meeting has ended because it reached the maximum allowed
              duration of{" "}
              <strong>{minutesToHuman(maxDurationMin ?? 0)}</strong>. Please
              reach out to support for increased limits.
            </p>
            <a
              href={`mailto:${supportEmail}`}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
            >
              <span
                className="material-symbols-outlined select-none leading-none"
                style={{ fontSize: "1rem" }}
                aria-hidden="true"
              >
                mail
              </span>
              Contact Support
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (remaining === null || remaining > WARNING_MS || dismissed) {
    return null;
  }

  const elapsedMin = maxDurationMin
    ? Math.max(0, maxDurationMin - Math.ceil(remaining / 60000))
    : 0;

  return (
    <div
      role="alert"
      aria-live="polite"
      className="fixed top-0 left-0 right-0 z-40 flex items-center justify-between gap-3 bg-amber-500/95 backdrop-blur px-4 py-2.5 text-[13px] text-white shadow-md"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="material-symbols-outlined select-none shrink-0"
          style={{ fontSize: "1.1rem" }}
          aria-hidden="true"
        >
          warning
        </span>
        <span>
          <strong>Meeting ending in {formatCountdown(remaining)}</strong> — this
          meeting has been running for{" "}
          <strong>{minutesToHuman(elapsedMin)}</strong> and the maximum limit has
          been reached. Please reach out to{" "}
          <a
            href={`mailto:${supportEmail}`}
            className="underline decoration-white/60 hover:decoration-white transition-colors"
          >
            support
          </a>{" "}
          for increased limits.
        </span>
      </div>
      <button
        type="button"
        aria-label="Dismiss meeting limit warning"
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded p-1 opacity-80 hover:opacity-100 transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        <span
          className="material-symbols-outlined select-none"
          style={{ fontSize: "1.1rem" }}
          aria-hidden="true"
        >
          close
        </span>
      </button>
    </div>
  );
}
