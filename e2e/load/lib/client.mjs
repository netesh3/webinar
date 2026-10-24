/* HTTP for the load tools: a fetch with a timeout and timing, a one-cookie session (the API's
 * webcast_session; Node's fetch keeps no jar), and the safety checks every tool runs first. */

/** Timed fetch: resolves { status, ok, ms, bytes, body (text unless stream), headers, res }. */
export async function timed(url, { method = "GET", headers = {}, body, timeoutMs = 20000, stream = false, signal } = {}) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined && typeof body !== "string" ? { "Content-Type": "application/json", ...headers } : headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      signal: ctl.signal,
      redirect: "follow",
    });
    if (stream) {
      clearTimeout(timer);
      return { status: res.status, ok: res.ok, ms: performance.now() - t0, res, headers: res.headers };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      status: res.status,
      ok: res.ok,
      ms: performance.now() - t0,
      bytes: buf.byteLength,
      buf,
      get body() {
        return new TextDecoder().decode(buf);
      },
      headers: res.headers,
      res,
    };
  } catch (err) {
    const aborted = ctl.signal.aborted && !signal?.aborted;
    return { status: aborted ? "timeout" : "neterr", ok: false, ms: performance.now() - t0, bytes: 0, error: err, body: "" };
  } finally {
    clearTimeout(timer);
    // A stream's body is still being read: the caller's signal must still be able to end it.
    if (!stream) signal?.removeEventListener("abort", onAbort);
  }
}

/* Session is a signed-in account against the API (`<api>` is e.g. https://webinarliv.com/api).
 * It keeps the cookies the API sets and sends them back. */
export class Session {
  constructor(api, label = "session") {
    this.api = api.replace(/\/$/, "");
    this.label = label;
    this.cookies = new Map();
  }
  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  keep(res) {
    for (const c of res.headers?.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  /** call(method, path, body?) -> parsed JSON (or null); throws ApiError on a non-2xx. */
  async call(method, path, body, { okStatuses = [] } = {}) {
    const r = await timed(this.api + path, { method, body, headers: { cookie: this.cookieHeader() } });
    if (r.res) this.keep(r.res);
    if (!r.ok && !okStatuses.includes(r.status)) throw new ApiError(method, path, r.status, r.body);
    const text = r.body;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  async login(email, password) {
    await this.call("POST", "/auth/login", { email, password });
    if (!this.cookies.size) throw new Error(`${this.label}: login set no session cookie`);
    return this;
  }
}

export class ApiError extends Error {
  constructor(method, path, status, body) {
    // The API's errors are {"error": "<code>", "message": "...", "fields": {...}} (httpx.Error).
    let code = "";
    let detail = "";
    try {
      const j = JSON.parse(body);
      code = typeof j?.error === "string" ? j.error : "";
      detail = [j?.message, j?.fields ? JSON.stringify(j.fields) : ""].filter(Boolean).join(" ");
    } catch {
      detail = String(body ?? "").slice(0, 200);
    }
    super(`${method} ${path} -> ${status}${code ? ` ${code}` : ""}${detail ? `: ${detail}` : ""}`);
    this.status = status;
    this.code = code;
  }
}

/* Production guard. A host is production when it is webinarliv.com (or a subdomain) or a
 * Cloud Run URL or the production video box; anything else (localhost, staging) is not. It needs
 * --i-know-this-is-prod. */
export function isProduction(url) {
  let h = "";
  try {
    h = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    h === "webinarliv.com" ||
    h.endsWith(".webinarliv.com") ||
    h.endsWith(".run.app") ||
    // The production video box's reserved IP (its origin is https://152.42.156.192.sslip.io/live).
    h.includes(PROD_BOX_IP)
  );
}

const PROD_BOX_IP = "152.42.156.192";

export function assertSafeTarget(urls, flags) {
  const prod = urls.filter(Boolean).filter(isProduction);
  if (prod.length && !flags.iKnowThisIsProd) {
    throw new Error(
      `refusing to run against production (${prod.join(", ")}). This puts real load on the ` +
        `live service and the video box customers use. Re-run with --i-know-this-is-prod ` +
        `once you have checked no customer session is live (docs/LOAD-TESTING.md).`,
    );
  }
  return prod.length > 0;
}

/** API base for a web origin: <web>/api, unless --api is given. */
export function apiBase(web, flags) {
  return String(flags.api || `${String(web).replace(/\/$/, "")}/api`).replace(/\/$/, "");
}

/** Hard ceiling on simulated viewers per tool run, whatever the flags say. */
export const ABSOLUTE_MAX_VIEWERS = 5000;
