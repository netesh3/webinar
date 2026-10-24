"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { countdownTarget } from "@/lib/simulive-host";
import { serverNow } from "@/lib/server-clock";
import { waitingLabel, waitingPollMs } from "@/lib/simulive-replay";
import { useServerClock } from "@/lib/use-server-clock";

/* A simulive before its start: no video at all, because a player with no shared start would
 * begin at 0:00 on a clock of its own (lib/simulive-replay.ts, simuliveWaiting). A countdown
 * to the scheduled start; the chat and Q&A beside it work while the doors are open.
 *
 * The room learns of the start from room metadata (the server pushes it when the session goes
 * live). This also asks the server now and then — with no scheduler, asking is what starts an
 * automatic simulive — and hands back the start when it has one. It counts down to the start
 * the host set from the room when there is one (lib/simulive-host.ts countdownTarget); the
 * host team's controls are SimuliveHostBar, above this. */
export function SimuliveWaiting({
  slug,
  startsAt,
  pendingStartAt,
  manual,
  coverUrl,
  onStarted,
}: {
  slug: string;
  startsAt?: string;
  /** A start the host set from the room ("Start in 5 min", "Delay"), from room metadata. */
  pendingStartAt?: string | null;
  manual: boolean;
  coverUrl?: string;
  onStarted: (startedAt: string) => void;
}) {
  // The start counted down to is the server's clock, so the countdown runs on it as well.
  const offset = useServerClock();
  const [clientNow, setClientNow] = useState(() => Date.now());
  const now = serverNow(clientNow, offset);
  const target = countdownTarget(startsAt, pendingStartAt, manual) ?? undefined;
  const waitsForHost = target == null;

  useEffect(() => {
    const id = setInterval(() => setClientNow(Date.now()), 1000);
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
          else timer = setTimeout(ask, waitingPollMs(target, serverNow(), waitsForHost));
        })
        .catch(() => {
          if (!cancelled) timer = setTimeout(ask, 10_000);
        });
    };
    timer = setTimeout(ask, waitingPollMs(target, serverNow(), waitsForHost));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slug, target, waitsForHost, onStarted]);

  return (
    <div
      className="absolute inset-0 grid place-items-center bg-black bg-cover bg-center"
      style={coverUrl ? { backgroundImage: `linear-gradient(rgba(0,0,0,.65), rgba(0,0,0,.75)), url(${coverUrl})` } : undefined}
    >
      <div className="flex max-w-sm flex-col items-center px-6 text-center" role="status" aria-live="polite">
        <p className="text-[11px] font-semibold tracking-[0.08em] text-white/60 uppercase">Starting soon</p>
        <p className="mt-2 text-[20px] font-semibold text-white tabular-nums">{waitingLabel(target, now, waitsForHost)}</p>
        <p className="mt-2 text-[13px] leading-relaxed text-white/65">
          Everyone starts together. Say hello in the chat while you wait.
        </p>
      </div>
    </div>
  );
}
