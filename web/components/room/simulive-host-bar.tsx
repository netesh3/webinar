"use client";

import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { DefaultSimuliveDoorsOpenMin, type Webinar } from "@/lib/api-types";
import { formatTime, localTimeZone } from "@/lib/format";
import { DELAY_MINUTES, doorsOpenAtMs, hostControls, type SimuliveView } from "@/lib/simulive-host";
import { formatOffset } from "@/lib/simulive-replay";
import { ConfirmModal, Spinner } from "../controls";
import { useToast } from "../providers";

/* The host team's controls in a simulive's room (api/internal/api/simulive_host.go): before
 * the start, Start now / Start in 2·5·10 min / Delay 5 min / Cancel and Open doors now, with
 * who is waiting; once it plays, End Simulive. Every change goes to the server, which tells
 * the room — so every waiting screen's countdown (this one's too) follows it from room
 * metadata. Which buttons show is lib/simulive-host.ts's hostControls. */
export function SimuliveHostBar({
  slug,
  view,
  manual,
  startsAt,
  pendingStartAt,
  doorsOpen,
  waiting,
  onStarted,
}: {
  slug: string;
  view: SimuliveView;
  manual: boolean;
  startsAt?: string;
  /** The pending start, from room metadata (or the join until metadata arrives). */
  pendingStartAt?: string | null;
  doorsOpen?: boolean;
  /** How many of the audience are in the room. */
  waiting: number;
  onStarted: (startedAt: string) => void;
}) {
  const { notify } = useToast();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [doorsOpenMin, setDoorsOpenMin] = useState(DefaultSimuliveDoorsOpenMin);
  /* The answer to this browser's own last action, used until room metadata reports a change
   * (keyed by the metadata value it was made against, so no effect has to clear it). */
  const [mine, setMine] = useState<{ against: string | null; doorsAgainst: boolean; wb: Webinar } | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .hostWebinar(slug)
      .then((wb) => {
        if (!cancelled && wb.options?.simuliveDoorsOpenMin != null) setDoorsOpenMin(wb.options.simuliveDoorsOpenMin);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const metaPending = pendingStartAt ?? null;
  const fresh = mine && mine.against === metaPending && mine.doorsAgainst === Boolean(doorsOpen) ? mine.wb : null;
  const pending = fresh ? fresh.simuliveStartAt || null : metaPending;
  const doors = fresh ? Boolean(fresh.simuliveDoorsOpen) : Boolean(doorsOpen);

  const controls = hostControls({ view, manual, startsAt, pendingStartAt: pending, doorsOpenMin, doorsOpen: doors, nowMs: now });
  const opens = doorsOpenAtMs({ startsAt, pendingStartAt: pending, doorsOpenMin, doorsOpen: doors });
  const tz = localTimeZone();

  const act = async (key: string, run: () => Promise<Webinar>) => {
    setBusy(key);
    try {
      const wb = await run();
      setMine({ against: metaPending, doorsAgainst: Boolean(doorsOpen), wb });
      if (wb.startedAt && wb.status === "live") onStarted(wb.startedAt);
      return wb;
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "That didn't work. Try again.", "error");
      return null;
    } finally {
      setBusy(null);
    }
  };

  if (!controls.startNow && !controls.end) return null;

  let line: string;
  if (view !== "waiting") line = "The recording is playing for everyone.";
  else if (pending) line = `Starts in ${formatOffset(Math.max(0, Date.parse(pending) - now))}`;
  else if (manual) line = "Not started. It starts when you do.";
  else if (startsAt && Date.parse(startsAt) > now) line = `Starts automatically at ${formatTime(startsAt, tz)}`;
  else line = "Starting any moment";

  const pill =
    "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-60";

  return (
    <div
      className="absolute inset-x-2 top-2 z-20 mx-auto flex max-w-3xl flex-wrap items-center gap-2 rounded-xl bg-black/75 px-3 py-2 text-white shadow-lg backdrop-blur"
      role="region"
      aria-label="Simulive host controls"
    >
      <div className="mr-auto min-w-0">
        <p className="text-[13px] font-semibold tabular-nums">{line}</p>
        {view === "waiting" && (
          <p className="text-[11.5px] text-white/65">
            {waiting === 1 ? "1 person waiting" : `${waiting} people waiting`}
            {opens != null && opens > now
              ? ` · Doors open at ${formatTime(new Date(opens).toISOString(), tz)}, only your team is in`
              : " · Doors are open"}
          </p>
        )}
      </div>
      {controls.startNow && (
        <button
          type="button"
          className={`${pill} bg-brand text-stage hover:bg-brand-hover`}
          disabled={busy != null}
          onClick={() => void act("now", () => api.simuliveStartNow(slug))}
        >
          {busy === "now" ? <Spinner className="size-3.5" /> : <span aria-hidden>▶</span>}
          Start now
        </button>
      )}
      {controls.startIn.map((m) => (
        <button
          key={m}
          type="button"
          className={`${pill} bg-white/12 hover:bg-white/20`}
          disabled={busy != null}
          onClick={() => void act(`in${m}`, () => api.simuliveStartAt(slug, { inMin: m }))}
        >
          {busy === `in${m}` && <Spinner className="size-3.5" />}
          In {m} min
        </button>
      ))}
      {controls.delay && (
        <button
          type="button"
          className={`${pill} bg-white/12 hover:bg-white/20`}
          disabled={busy != null}
          onClick={() => void act("delay", () => api.simuliveStartAt(slug, { delayMin: DELAY_MINUTES }))}
        >
          {busy === "delay" && <Spinner className="size-3.5" />}
          Delay {DELAY_MINUTES} min
        </button>
      )}
      {controls.cancel && (
        <button
          type="button"
          className={`${pill} bg-white/12 hover:bg-white/20`}
          disabled={busy != null}
          onClick={() => void act("cancel", () => api.simuliveCancelStart(slug))}
        >
          {busy === "cancel" && <Spinner className="size-3.5" />}
          Cancel start
        </button>
      )}
      {controls.openDoors && (
        <button
          type="button"
          className={`${pill} bg-white/12 hover:bg-white/20`}
          disabled={busy != null}
          onClick={() => void act("doors", () => api.simuliveOpenDoors(slug))}
        >
          {busy === "doors" && <Spinner className="size-3.5" />}
          Open doors now
        </button>
      )}
      {controls.end && (
        <button
          type="button"
          className={`${pill} bg-live text-on-live hover:bg-live/90`}
          disabled={busy != null}
          onClick={() => setConfirmEnd(true)}
        >
          End Simulive
        </button>
      )}
      <ConfirmModal
        open={confirmEnd}
        onClose={() => setConfirmEnd(false)}
        onConfirm={() =>
          void act("end", () => api.simuliveEnd(slug)).then(() => setConfirmEnd(false))
        }
        title="End the simulive?"
        body="The recording stops for everyone and the session ends."
        confirmLabel="End Simulive"
        busy={busy === "end"}
        dark
      />
    </div>
  );
}
