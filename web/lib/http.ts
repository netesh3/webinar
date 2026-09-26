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

export const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

/** Reads are never cached: a stale registrant count or a stale "live" badge is
 *  worse than a round trip. */
export const fresh = { cache: "no-store" } as const;
