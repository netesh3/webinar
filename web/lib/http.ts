/* The fetch plumbing every API client in this app shares: base URL, credentials, and the
 * structured error. Kept apart from lib/api.ts so a module with its own client (see
 * engage/api.ts) uses the same request path without importing the webinar client. */
import type { APIError } from "./api-types";

const PUBLIC_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080";
const INTERNAL_BASE = process.env.API_INTERNAL_URL || PUBLIC_BASE;

/** The browser-facing base. Exported for the handful of places that build a URL
 *  for the browser to fetch directly — a `<video src>`, a download link. */
export const API_BASE = PUBLIC_BASE;

export function baseFor(): string {
  return typeof window === "undefined" ? INTERNAL_BASE : PUBLIC_BASE;
}

/** Thrown for any non-2xx. Carries the API's structured error so forms can
 *  render per-field messages. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseFor()}${path}`, {
      ...init,
      // The session is an httpOnly cookie, so it must be sent cross-origin
      // (:3000 -> :8080).
      credentials: "include",
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    // fetch only rejects on network failure — surface that as something the UI
    // can distinguish from a 500.
    throw new ApiError(0, "network", "Could not reach the server.");
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // A non-JSON body on an error status (a proxy's HTML 502 page, say) must
      // not turn into a SyntaxError that hides the real status code.
      if (!res.ok) {
        throw new ApiError(
          res.status,
          "unexpected_response",
          `Request failed (${res.status})`,
        );
      }
      throw new ApiError(
        res.status,
        "unexpected_response",
        "The server sent something unreadable.",
      );
    }
  }

  if (!res.ok) {
    const err = (body ?? {}) as APIError;
    throw new ApiError(
      res.status,
      err.error ?? "unknown",
      err.message ?? `Request failed (${res.status})`,
      err.fields,
    );
  }
  return body as T;
}

export const seg = (s: string) => encodeURIComponent(s);

export const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

export const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "PATCH", body: JSON.stringify(body) });

export const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "PUT", body: JSON.stringify(body) });

export const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

/** Reads the browser must not keep: a live badge, the room, the inbox, alerts. */
export const fresh = { cache: "no-store" } as const;

/** Kept until dropCache. Profile, integrations, message defaults, registrations. */
export const TTL_SESSION = Number.POSITIVE_INFINITY;
/** GET /api/config. The server render already supplied it; skip a second fetch. */
export const TTL_CONFIG = 5 * 60_000;
/** One page of a host list or the people table. */
export const TTL_LIST = 30_000;
/** Audience summary cards above the people table. */
export const TTL_AUDIENCE = 60_000;

type CacheSlot = { at: number; body: unknown };

const memory = new Map<string, CacheSlot>();
const flying = new Map<string, Promise<unknown>>();

/** A stored GET, including one that is past its TTL. `fresh` is false once `ttl` has passed. */
export function readCache<T>(key: string, ttl: number): { value: T; fresh: boolean } | null {
  const hit = memory.get(key);
  if (!hit) return null;
  return { value: hit.body as T, fresh: Date.now() - hit.at < ttl };
}

export function writeCache(key: string, body: unknown): void {
  memory.set(key, { at: Date.now(), body });
}

export function dropCache(key: string): void {
  memory.delete(key);
}

export function dropCachePrefix(prefix: string): void {
  for (const key of memory.keys()) {
    if (key.startsWith(prefix)) memory.delete(key);
  }
}

/** A GET kept in memory. A fresh hit skips the network. `force` replaces the slot.
 *  Two callers of the same key share one request. */
export async function cachedGet<T>(
  path: string,
  opts: { ttl: number; key?: string; force?: boolean },
): Promise<T> {
  const key = opts.key ?? path;
  if (!opts.force) {
    const hit = readCache<T>(key, opts.ttl);
    if (hit?.fresh) return hit.value;
    const pending = flying.get(key);
    if (pending) return pending as Promise<T>;
  }
  const run = request<T>(path, fresh)
    .then((body) => {
      writeCache(key, body);
      return body;
    })
    .finally(() => {
      if (flying.get(key) === run) flying.delete(key);
    });
  flying.set(key, run);
  return run;
}
