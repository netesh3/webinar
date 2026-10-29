"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { AudienceDevices } from "@/lib/api-types";
import { deviceRows, devicesNote, type DeviceRow } from "@/lib/audience-devices";
import { Alert } from "./controls";
import { Card } from "./ui";

/* The audience by device: phone, tablet or desktop, then OS and browser. Exact counts from the
 * join requests (GET /api/host/webinars/{slug}/devices, GET /api/admin/devices), one per
 * person; the frontend error tracking's sessions are page loads and miss ad-blocked browsers. */

export function Bars({ title, rows }: { title: string; rows: DeviceRow[] }) {
  return (
    <div>
      <h4 className="text-[12px] font-medium text-ink-2">{title}</h4>
      {rows.length === 0 ? (
        <p className="mt-1.5 text-[12.5px] text-ink-3">—</p>
      ) : (
        <ul className="mt-1.5 grid gap-1.5">
          {rows.map((r) => (
            <li key={r.key} className="grid grid-cols-[minmax(0,7.5rem)_1fr_auto] items-center gap-2 text-[12.5px]">
              <span className="truncate text-ink">{r.label}</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                <span className="block h-full rounded-full bg-brand" style={{ width: `${r.pct}%` }} />
              </span>
              <span className="tabular-nums text-ink-2">
                {r.count.toLocaleString("en-IN")} · {r.pct}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AudienceDevicesBreakdown({ data }: { data: AudienceDevices }) {
  return (
    <div className="grid gap-4">
      <p className="text-[12px] text-ink-2">{devicesNote(data)}</p>
      {data.recorded > 0 && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Bars title="Device" rows={deviceRows(data.classes, data.recorded)} />
          <Bars title="Operating system" rows={deviceRows(data.os, data.recorded)} />
          <Bars title="Browser" rows={deviceRows(data.browsers, data.recorded)} />
        </div>
      )}
    </div>
  );
}

/** One webinar's audience devices, for the host's Engagement page. Loads on mount. */
export function WebinarAudienceDevices({ load }: { load: (signal: AbortSignal) => Promise<AudienceDevices> }) {
  const [data, setData] = useState<AudienceDevices | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    load(ctl.signal)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Could not load devices.");
      });
    return () => ctl.abort();
  }, [load]);
  return (
    <div className="mt-4 rounded-xl border border-line bg-surface p-4">
      <h3 className="text-[13.5px] font-semibold">Audience devices</h3>
      <div className="mt-2">
        {error && <Alert tone="error">{error}</Alert>}
        {!data && !error && <p className="text-[12.5px] text-ink-3">Loading…</p>}
        {data && <AudienceDevicesBreakdown data={data} />}
      </div>
    </div>
  );
}

export type Days = 7 | 30 | 90;
const WINDOWS: Days[] = [7, 30, 90];

/** The admin's 7 / 30 / 90 days toggle; the audience-locations panel has the same one. */
export function WindowPicker({ days, onChange }: { days: Days; onChange: (d: Days) => void }) {
  return (
    <div role="radiogroup" aria-label="Window" className="flex gap-1">
      {WINDOWS.map((d) => (
        <button
          key={d}
          type="button"
          role="radio"
          aria-checked={days === d}
          onClick={() => onChange(d)}
          className={`rounded-md px-2 py-0.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
            days === d ? "bg-brand-soft font-medium text-brand" : "text-ink-2 hover:bg-surface-2"
          }`}
        >
          {d} days
        </button>
      ))}
    </div>
  );
}

/** Every webinar's audience devices, for the Admin dashboard. */
export function AdminAudienceDevicesPanel() {
  const [days, setDays] = useState<Days>(30);
  const [data, setData] = useState<AudienceDevices | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Writes inside .then(), as in AdminDashboard, for react-hooks/set-state-in-effect.
  useEffect(() => {
    let live = true;
    api
      .adminDevices(days)
      .then((next) => {
        if (!live) return;
        setData(next);
        setError(null);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : "Could not load devices.");
      });
    return () => {
      live = false;
    };
  }, [days]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold tracking-[0.01em] text-ink">Audience devices</h2>
        <WindowPicker days={days} onChange={setDays} />
      </div>
      <Card className="p-4">
        {error && <Alert tone="error">{error}</Alert>}
        {!data && !error && <p className="py-6 text-center text-[13px] text-ink-2">Loading…</p>}
        {data && <AudienceDevicesBreakdown data={data} />}
      </Card>
    </div>
  );
}
