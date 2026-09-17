/**
 * Cloudflare Worker entry (wrangler `main`).
 *
 * OpenNext generates `.open-next/worker.js` with the Next fetch handler. We wrap
 * it so `/api/*` is proxied to the Go API (Cloud Run). That makes the session
 * cookie first-party on this Worker origin — middleware can see it, and Host /
 * Admin / My webinars stop bouncing to login when the UI and API are on
 * different sites (workers.dev vs run.app).
 *
 * Browser calls use same-origin `/api/...` (NEXT_PUBLIC_API_BASE empty at build).
 * SSR / middleware still talk to API_INTERNAL_URL directly.
 */
// @ts-expect-error `.open-next/worker.js` is generated at build time
import { default as handler } from "./.open-next/worker.js";

interface ApiEnv {
  API_INTERNAL_URL?: string;
}

export default {
  async fetch(
    request: Request,
    env: ApiEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    // http://webinarliv.com served a plain 200 with no redirect — confirmed live,
    // not a hypothetical. That's not just a padlock/trust issue: getUserMedia and
    // every other media API are restricted to secure contexts, so a browser that
    // landed here over http had `navigator.mediaDevices` come back `undefined`,
    // which is exactly the "Couldn't open your microphone" a granted-to-speak
    // attendee hit. Enforced here, in the Worker itself, rather than relying only
    // on Cloudflare's dashboard-level "Always Use HTTPS" toggle — that setting
    // should also be on, but this doesn't depend on remembering it's still set.
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return proxyApi(request, env);
    }
    const res = await handler.fetch(request, env, ctx);
    return withFedcmPermission(res);
  },
};

// Re-export OpenNext Durable Object handlers when caching features are enabled.
// @ts-expect-error generated at build time
export {
  DOQueueHandler,
  DOShardedTagCache,
  BucketCachePurge,
} from "./.open-next/worker.js";

const FEDCM_PERMISSION =
  'identity-credentials-get=(self "https://accounts.google.com")';

/** Chrome One Tap (FedCM) is a no-op unless this permission is granted. */
function withFedcmPermission(res: Response): Response {
  if (res.headers.has("Permissions-Policy")) return res;
  const headers = new Headers(res.headers);
  headers.set("Permissions-Policy", FEDCM_PERMISSION);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-proto",
  "x-forwarded-for",
]);

async function proxyApi(request: Request, env: ApiEnv): Promise<Response> {
  const apiBase = (env.API_INTERNAL_URL ?? "").replace(/\/+$/, "");
  if (!apiBase) {
    return new Response("API_INTERNAL_URL is not configured", { status: 500 });
  }

  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, `${apiBase}/`);

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  headers.set("host", new URL(apiBase).host);
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));
  // Upstream CORS is for browser→run.app; same-origin proxy must not claim the
  // Workers origin as an allowed cross-origin caller when we re-emit headers.
  // Leave upstream ACAO as-is — browsers ignore CORS on same-origin responses.

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    // Required by the Fetch spec when streaming a request body.
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), init);
  } catch (err) {
    const message = err instanceof Error ? err.message : "upstream fetch failed";
    return new Response(`API proxy error: ${message}`, { status: 502 });
  }

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;
    // Drop upstream CORS — response is same-origin to the Worker.
    if (lower.startsWith("access-control-")) return;
    out.append(key, value);
  });

  // Preserve multiple Set-Cookie headers (session + any future cookies).
  const setCookies =
    typeof upstream.headers.getSetCookie === "function"
      ? upstream.headers.getSetCookie()
      : [];
  if (setCookies.length > 0) {
    out.delete("set-cookie");
    for (const cookie of setCookies) {
      out.append("set-cookie", cookie);
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}
