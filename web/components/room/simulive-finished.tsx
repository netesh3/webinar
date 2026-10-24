"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { serverNow } from "@/lib/server-clock";
import { msUntilFinished } from "@/lib/simulive-host";
import { useServerClock } from "@/lib/use-server-clock";
import { Spinner } from "../controls";

/** Whether a simulive's recording has reached its end on the shared clock: flips once, at
 *  that moment, so the player is taken away for everyone together (lib/simulive-host.ts). */
export function useSimuliveFinished(startedAt: string | null | undefined, lengthMs: number | null | undefined): boolean {
  const [doneFor, setDoneFor] = useState<string | null>(null);
  const key = startedAt && lengthMs ? `${startedAt}|${lengthMs}` : null;
  // The start is the server's clock; the end is read on it too (re-timed once it is measured).
  const offset = useServerClock(key != null);
  useEffect(() => {
    if (!key) return;
    const left = msUntilFinished(startedAt, lengthMs, serverNow(Date.now(), offset));
    const timer = setTimeout(() => setDoneFor(key), left ?? 0);
    return () => clearTimeout(timer);
  }, [key, startedAt, lengthMs, offset]);
  return key != null && doneFor === key;
}

/* The recording has played to its end. Nothing plays — no loop, no rewind, no last frame —
 * while the server decides what comes next: with the host team in the room it carries on
 * live with them (onLive: every client re-joins for the live room), without them it ends
 * (onEnded). Room metadata says so; this also asks, because with no scheduler asking is
 * what makes the server decide (api/internal/api/simulive_live.go). */
export function SimuliveFinished({
  slug,
  coverUrl,
  onLive,
  onEnded,
}: {
  slug: string;
  coverUrl?: string;
  onLive: (hostName?: string) => void;
  onEnded: () => void;
}) {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const ask = () => {
      api
        .getWebinar(slug)
        .then((wb) => {
          if (cancelled) return;
          if (wb.status === "ended") onEnded();
          else if (wb.simuliveLiveAt) onLive(wb.host?.name);
          else timer = setTimeout(ask, 5_000);
        })
        .catch(() => {
          if (!cancelled) timer = setTimeout(ask, 10_000);
        });
    };
    timer = setTimeout(ask, 3_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slug, onLive, onEnded]);

  return (
    <div
      className="absolute inset-0 grid place-items-center bg-black bg-cover bg-center"
      style={coverUrl ? { backgroundImage: `linear-gradient(rgba(0,0,0,.7), rgba(0,0,0,.8)), url(${coverUrl})` } : undefined}
    >
      <div className="flex max-w-sm flex-col items-center px-6 text-center" role="status" aria-live="polite">
        <Spinner className="size-6 text-white/70" />
        <p className="mt-3 text-[17px] font-semibold text-white">That&apos;s the end of the recording</p>
        <p className="mt-2 text-[13px] leading-relaxed text-white/65">Stay a moment — the host may join you live.</p>
      </div>
    </div>
  );
}
