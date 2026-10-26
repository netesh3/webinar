"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { AdminSFUPool } from "@/lib/api-types";
import { poolPercent, poolStateLabel, poolTone } from "@/lib/box-pool";
import { regionLabel } from "@/lib/box-regions";
import { Alert } from "./controls";
import { Card } from "./ui";

const TONE = { ok: "bg-brand", warn: "bg-amber-500", over: "bg-live" } as const;

/* Admin → Dashboard: the video server pool (GET /api/admin/sfu-pool). Each box with its state,
 * its load in points against its capacity, and the sessions holding those points. Shown only
 * when there is more than one box: with one, the cost calculator's box line says it all. */
export function AdminBoxPoolPanel() {
  const [data, setData] = useState<AdminSFUPool | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Writes inside .then(), as in AdminDashboard, for react-hooks/set-state-in-effect.
  useEffect(() => {
    let live = true;
    api
      .adminSfuPool()
      .then((next) => {
        if (!live) return;
        setData(next);
        setError(null);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : "Could not load the video servers.");
      });
    return () => {
      live = false;
    };
  }, []);

  if (!error && (!data || !data.enabled || data.boxes.length < 2)) return null;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold tracking-[0.01em] text-ink">Video servers</h2>
        {data && (
          <p className="text-[12px] text-ink-3">
            Points are estimates: webinar {data.points.mix + data.points.extra} + 1 per{" "}
            {data.points.viewersPerPoint} seats, meeting {data.points.meetingBase} up to{" "}
            {data.points.meetingBaseSize} people.
          </p>
        )}
      </div>
      <Card className="divide-y divide-line p-0">
        {error && (
          <div className="p-4">
            <Alert tone="error">{error}</Alert>
          </div>
        )}
        {data?.boxes.map((box) => {
          const pct = poolPercent(box);
          return (
            <div key={box.project} className="p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[13px] font-medium text-ink">
                  {box.name}{" "}
                  <span className="font-normal text-ink-3">
                    · {regionLabel(box.area)} · {box.size} · {poolStateLabel(box.actual)}
                  </span>
                </p>
                <p className="text-[12px] tabular-nums text-ink-2">
                  {box.used} / {box.capacity} points ({pct}%)
                </p>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                <div
                  className={`h-full ${TONE[poolTone(box)]}`}
                  style={{ width: `${Math.min(100, pct)}%` }}
                />
              </div>
              {box.sessions.length > 0 ? (
                <ul className="mt-2 space-y-0.5 text-[12px] text-ink-2">
                  {box.sessions.map((s) => (
                    <li key={s.slug} className="flex justify-between gap-3">
                      <span className="truncate">
                        {s.topic || s.slug}{" "}
                        <span className="text-ink-3">
                          · {s.kind} · {s.status === "live" ? "live" : startsText(s.startsAt)}
                        </span>
                      </span>
                      <span className="tabular-nums">{s.points}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[12px] text-ink-3">No sessions on it.</p>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}

// When a session not yet live starts, in the admin's own clock.
function startsText(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "scheduled"
    : `starts ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
