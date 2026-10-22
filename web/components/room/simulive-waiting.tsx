"use client";

import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { waitingLabel, waitingPollMs } from "@/lib/simulive-replay";
import { Spinner } from "../controls";
import { useToast } from "../providers";

/* A simulive before its start: no video at all, because a player with no shared start would
 * begin at 0:00 on a clock of its own (lib/simulive-replay.ts, simuliveWaiting). A countdown
 * to the scheduled start; the chat and Q&A beside it work while the doors are open.
 *
 * The room learns of the start from room metadata (the server pushes it when the session goes
 * live). This also asks the server now and then — with no scheduler, asking is what starts an
 * automatic simulive — and hands back the start when it has one. The host or a co-host of a
 * simulive they start themselves gets the Start Simulive button. */
export function SimuliveWaiting({
  slug,
  startsAt,
  manual,
  canStart,
  coverUrl,
  onStarted,
}: {
  slug: string;
  startsAt?: string;
  manual: boolean;
  canStart: boolean;
  coverUrl?: string;
  onStarted: (startedAt: string) => void;
}) {
  const { notify } = useToast();
  const [now, setNow] = useState(() => Date.now());
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const ask = () => {
      api
        .getWebinar(slug)
        .then((wb) => {
          if (cancelled) return;
          if (wb.startedAt) onStarted(wb.startedAt);
          else timer = setTimeout(ask, waitingPollMs(startsAt, Date.now(), manual));
        })
        .catch(() => {
          if (!cancelled) timer = setTimeout(ask, 10_000);
        });
    };
    timer = setTimeout(ask, waitingPollMs(startsAt, Date.now(), manual));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slug, startsAt, manual, onStarted]);

  const start = async () => {
    setStarting(true);
    try {
      const wb = await api.startWebinar(slug);
      if (wb.startedAt) onStarted(wb.startedAt);
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "Could not start the session.", "error");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div
      className="absolute inset-0 grid place-items-center bg-black bg-cover bg-center"
      style={coverUrl ? { backgroundImage: `linear-gradient(rgba(0,0,0,.65), rgba(0,0,0,.75)), url(${coverUrl})` } : undefined}
    >
      <div className="flex max-w-sm flex-col items-center px-6 text-center" role="status" aria-live="polite">
        <p className="text-[11px] font-semibold tracking-[0.08em] text-white/60 uppercase">Starting soon</p>
        <p className="mt-2 text-[20px] font-semibold text-white tabular-nums">{waitingLabel(startsAt, now, manual)}</p>
        <p className="mt-2 text-[13px] leading-relaxed text-white/65">
          Everyone starts together. Say hello in the chat while you wait.
        </p>
        {canStart && (
          <button
            type="button"
            onClick={() => void start()}
            disabled={starting}
            className="mt-5 inline-flex h-11 items-center gap-2 rounded-xl bg-brand px-5 text-[14px] font-semibold text-stage hover:bg-brand-hover disabled:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            {starting ? <Spinner className="size-4" /> : <span aria-hidden>▶</span>}
            Start Simulive
          </button>
        )}
      </div>
    </div>
  );
}
