/* A read-out for the load-test kit's browser viewers (e2e/load/browser-viewers.mjs).
 *
 * The kit's simulated viewers proved the server's capacity but not what a viewer sees, and a
 * customer webinar then stalled (2026-10-25). Its browser viewers play the stream with this
 * player, in real Chromium, and read how it went from here. Nothing happens unless the page
 * was opened by the kit: its init script defines window.__LOAD_PROBE__ before the app loads, so
 * for everyone else loadProbe() is null and both functions do nothing.
 *
 * `preferPath` lets one run take the CDN path from a generator the join would send to the box
 * (run.mjs --path cdn). It only swaps the two URLs the join already offered this viewer, so it
 * grants nothing a viewer could not get from the fallback anyway. */

export type DeliveryPath = "direct" | "cdn" | string;

export type LoadProbeState = {
  /** Seconds behind live, as the player measures it (null until it knows). */
  latencySec: number | null;
  /** The path playing now, after any fallback. */
  path: DeliveryPath;
  /** The URL playing now. */
  url: string;
  /** The Reconnecting badge is up. */
  reconnecting: boolean;
  /** Times the player moved to the other path. */
  fallbacks: number;
  /** When this was written (epoch ms). */
  at: number;
};

export type LoadProbe = {
  preferPath?: DeliveryPath;
  state?: Partial<LoadProbeState>;
};

export function loadProbe(): LoadProbe | null {
  if (typeof window === "undefined") return null;
  const p = (window as unknown as { __LOAD_PROBE__?: LoadProbe }).__LOAD_PROBE__;
  return p && typeof p === "object" ? p : null;
}

/** Merges `patch` into the probe's state, stamped with the time. A no-op without the kit. */
export function reportLoadProbe(patch: Partial<LoadProbeState>, now = Date.now()): void {
  const p = loadProbe();
  if (!p) return;
  p.state = { ...p.state, ...patch, at: now };
}

/* The URL to start on, its fallback and its path: the join's choice, or the other one when
 * the kit prefers it and the join offered both. */
export function startingPath(
  playbackUrl: string,
  fallbackUrl: string | undefined,
  deliveryPath: DeliveryPath | undefined,
  prefer: DeliveryPath | undefined,
): { url: string; fallback: string | undefined; path: DeliveryPath } {
  const path = deliveryPath ?? "";
  if (!prefer || !fallbackUrl || prefer === path || (path !== "direct" && path !== "cdn")) {
    return { url: playbackUrl, fallback: fallbackUrl, path };
  }
  return { url: fallbackUrl, fallback: playbackUrl, path: path === "direct" ? "cdn" : "direct" };
}
