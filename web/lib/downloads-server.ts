/* Fetching the release manifest for /download, on the server.
 *
 * `next: { revalidate }` puts it in Next's data cache for five minutes. On Cloudflare
 * Workers the OpenNext config has no incremental cache (open-next.config.ts), so that
 * cache does not persist there; the module-level copy below covers it instead, for as
 * long as the isolate lives. Either way the manifest is fetched about once per five
 * minutes, not once per visit, and a slow or missing manifest never holds the page up
 * for more than the timeout: it renders as "coming soon".
 *
 * DOWNLOADS_MANIFEST_URL points at another manifest outside production (a local file
 * served for testing the page). It is read uncached so a change shows on reload.
 */

import { MANIFEST_URL, parseManifest, type Manifest } from "./downloads";

const REVALIDATE_SECONDS = 300;
/** A failed fetch is retried sooner than a good one is refreshed. */
const RETRY_SECONDS = 60;
const TIMEOUT_MS = 3000;

let memo: { at: number; ttl: number; value: Manifest | null } | null = null;

function overrideUrl(): string | null {
  if (process.env.NODE_ENV === "production") return null;
  return process.env.DOWNLOADS_MANIFEST_URL?.trim() || null;
}

async function fetchManifest(url: string, cached: boolean): Promise<Manifest | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(cached ? { next: { revalidate: REVALIDATE_SECONDS } } : { cache: "no-store" as const }),
    });
    if (!res.ok) return null;
    return parseManifest(await res.json());
  } catch {
    // Network error, timeout, or not JSON: no manifest.
    return null;
  }
}

/** The current manifest, or null when there is none or it is not valid. Never throws. */
export async function loadDownloadsManifest(): Promise<Manifest | null> {
  const override = overrideUrl();
  if (override) return fetchManifest(override, false);

  const now = Date.now();
  if (memo && now - memo.at < memo.ttl * 1000) return memo.value;
  const value = await fetchManifest(MANIFEST_URL, true);
  // Keep showing the last good manifest through a failed refresh.
  if (!value && memo?.value) {
    memo = { at: now, ttl: RETRY_SECONDS, value: memo.value };
    return memo.value;
  }
  memo = { at: now, ttl: value ? REVALIDATE_SECONDS : RETRY_SECONDS, value };
  return value;
}
