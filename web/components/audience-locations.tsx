"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { AudienceLocations } from "@/lib/api-types";
import { cityRows, countryRows, indiaStateRows, locationsNote } from "@/lib/audience-locations";
import { Bars, WindowPicker, type Days } from "./audience-devices";
import { Alert } from "./controls";
import { Card } from "./ui";

/* The audience by location: the top countries, India by state, and the top cities. Counts from
 * the join requests, as Cloudflare places each person's network (GET
 * /api/host/webinars/{slug}/locations, GET /api/admin/locations), one per person. Beside the
 * devices card, built the same way. Recorded from 29 Oct 2026, the city too. */

export function AudienceLocationsBreakdown({ data }: { data: AudienceLocations }) {
  const india = data.countries.some((c) => c.key === "IN");
  return (
    <div className="grid gap-4">
      <p className="text-[12px] text-ink-2">{locationsNote(data)}</p>
      {data.recorded > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Bars title="Country" rows={countryRows(data)} />
          {india && <Bars title="India by state" rows={indiaStateRows(data)} />}
          <Bars title="Top cities" rows={cityRows(data)} />
        </div>
      )}
    </div>
  );
}

/** One webinar's audience locations, for the host's Engagement page. Loads on mount. */
export function WebinarAudienceLocations({ load }: { load: (signal: AbortSignal) => Promise<AudienceLocations> }) {
  const [data, setData] = useState<AudienceLocations | null>(null);
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
        setError(e instanceof Error ? e.message : "Could not load locations.");
      });
    return () => ctl.abort();
  }, [load]);
  return (
    <div className="mt-4 rounded-xl border border-line bg-surface p-4">
      <h3 className="text-[13.5px] font-semibold">Audience by location</h3>
      <div className="mt-2">
        {error && <Alert tone="error">{error}</Alert>}
        {!data && !error && <p className="text-[12.5px] text-ink-3">Loading…</p>}
        {data && <AudienceLocationsBreakdown data={data} />}
      </div>
    </div>
  );
}

/** Every webinar's audience locations, for the Admin dashboard. */
export function AdminAudienceLocationsPanel() {
  const [days, setDays] = useState<Days>(30);
  const [data, setData] = useState<AudienceLocations | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Writes inside .then(), as in AdminAudienceDevicesPanel, for react-hooks/set-state-in-effect.
  useEffect(() => {
    let live = true;
    api
      .adminLocations(days)
      .then((next) => {
        if (!live) return;
        setData(next);
        setError(null);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : "Could not load locations.");
      });
    return () => {
      live = false;
    };
  }, [days]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold tracking-[0.01em] text-ink">Audience by location</h2>
        <WindowPicker days={days} onChange={setDays} />
      </div>
      <Card className="p-4">
        {error && <Alert tone="error">{error}</Alert>}
        {!data && !error && <p className="py-6 text-center text-[13px] text-ink-2">Loading…</p>}
        {data && <AudienceLocationsBreakdown data={data} />}
      </Card>
    </div>
  );
}
