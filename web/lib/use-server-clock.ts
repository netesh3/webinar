"use client";

/* The server's clock in a component (lib/server-clock.ts). Measured once per page, on the
 * first mount that asks, against GET /api/time: a few round trips, the shortest one wins.
 * Every later caller shares that measurement. Until it lands the offset is 0 — the device
 * clock — and the component re-renders when it does, so a simulive player that started a
 * few seconds off is put back by its next clock check (lib/simulive-clock.ts). */

import { useEffect, useState } from "react";
import { api } from "./api";
import { clockOffset, measureClock, serverOffsetMs, setServerOffsetMs } from "./server-clock";

const SAMPLES = 5;

let measuring: Promise<number> | null = null;

function measureOnce(): Promise<number> {
  if (!measuring) {
    measuring = measureClock(async () => (await api.serverTime()).now, SAMPLES).then((samples) => {
      // Nothing came back: leave the device clock, and let the next mount try again.
      if (samples.length === 0) {
        measuring = null;
        return serverOffsetMs();
      }
      const offset = clockOffset(samples);
      setServerOffsetMs(offset);
      return offset;
    });
  }
  return measuring;
}

/** The measured offset (ms to add to Date.now()), 0 until measured. Use serverNow() from
 *  lib/server-clock.ts for the time itself; this hook makes sure it is measured and
 *  re-renders the caller when it is. */
export function useServerClock(enabled = true): number {
  const [offset, setOffset] = useState(serverOffsetMs);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void measureOnce().then((ms) => {
      if (!cancelled) setOffset(ms);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return offset;
}
