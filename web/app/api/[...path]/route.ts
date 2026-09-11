import { type NextRequest, NextResponse } from "next/server";

/**
 * Local `next dev` proxy for `/api/*` → `API_INTERNAL_URL`.
 *
 * Production Workers use `worker.ts` for the same job (that entry wins on CF).
 * Here we also soften Cloud Run's `Secure; SameSite=None` session cookies when
 * the page is served over plain HTTP (`localhost`), otherwise the browser
 * refuses to store `webcast_session` and sign-in appears to "succeed" then
 * bounce straight back to logged-out.
 */

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
  "content-length",
]);

function softenCookieForHttp(cookie: string): string {
  return cookie
    .replace(/;\s*Secure/gi, "")
    .replace(/;\s*SameSite=None/gi, "; SameSite=Lax");
}

async function proxy(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const apiBase = (process.env.API_INTERNAL_URL || "").replace(/\/+$/, "");
  if (!apiBase) {
    return NextResponse.json(
      { error: "misconfigured", message: "API_INTERNAL_URL is not set" },
      { status: 500 },
    );
  }

  const { path } = await ctx.params;
  const target = new URL(
    `/api/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`,
    `${apiBase}/`,
  );

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set("host", new URL(apiBase).host);
  headers.set("x-forwarded-host", req.nextUrl.host);
  headers.set("x-forwarded-proto", req.nextUrl.protocol.replace(":", ""));

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = Buffer.from(await req.arrayBuffer());
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : "upstream fetch failed";
    return new NextResponse(`API proxy error: ${message}`, { status: 502 });
  }

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;
    if (lower.startsWith("access-control-")) return;
    if (lower === "set-cookie") return;
    out.append(key, value);
  });

  const setCookies =
    typeof upstream.headers.getSetCookie === "function"
      ? upstream.headers.getSetCookie()
      : [];
  const httpPage = req.nextUrl.protocol === "http:";
  for (const cookie of setCookies) {
    out.append("set-cookie", httpPage ? softenCookieForHttp(cookie) : cookie);
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
