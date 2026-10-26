/* A side prober on each generator: plays the stream's playlist the way a plain-HLS player does
 * (reload the media playlist, fetch the newest segment), timing every request and keeping what
 * the CDN says about it. The browser viewers report what a person saw; this says what the edge
 * in that region did while they saw it (time to first byte, total, status, Bunny's edge and
 * cache result). Plain HLS since 2026-10-26: no parts, no blocking reloads.
 *
 * new CdnProbe(url, { everyMs }).start() ... .stop() -> { requests: [...], summary() }. */

const sleep = (ms, signal) =>
  new Promise((r) => {
    const t = setTimeout(r, Math.max(0, ms));
    signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });

/* timedFetch(url) -> { at, kind, status, ttfbMs, totalMs, bytes, edge, cache, error? }. TTFB
 * is to the response headers; total includes the body. */
export async function timedFetch(url, kind, { timeoutMs = 10_000 } = {}) {
  const t0 = performance.now();
  const at = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "Cache-Control": "no-cache" } });
    const ttfb = performance.now() - t0;
    const body = kind === "playlist" ? await r.text() : await r.arrayBuffer();
    return {
      at, kind, status: r.status,
      ttfbMs: Math.round(ttfb), totalMs: Math.round(performance.now() - t0),
      bytes: typeof body === "string" ? body.length : body.byteLength,
      edge: r.headers.get("server") || "",
      cache: r.headers.get("cdn-cache") || r.headers.get("x-cache") || "",
      body: kind === "playlist" ? body : undefined,
    };
  } catch (e) {
    return { at, kind, status: 0, ttfbMs: null, totalMs: Math.round(performance.now() - t0), bytes: 0, edge: "", cache: "", error: e.name };
  }
}

/** The first media playlist a multivariant playlist names (or the playlist itself), absolute. */
export function mediaPlaylistUrl(master, base) {
  if (!/#EXT-X-STREAM-INF/.test(master)) return base;
  const line = master.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  return line ? new URL(line, base).href : base;
}

/** The newest segment a media playlist lists, absolute (null when it lists none). */
export function newestSegment(media, base) {
  const lines = media.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return lines.length ? new URL(lines[lines.length - 1], base).href : null;
}

export class CdnProbe {
  constructor(url, { everyMs = 2000, label = "" } = {}) {
    Object.assign(this, { url, everyMs, label });
    this.requests = [];
    this.ctl = new AbortController();
    this.done = null;
  }

  start() {
    this.done = (async () => {
      let media = null;
      let lastSeg = null;
      while (!this.ctl.signal.aborted) {
        // keep() drops the body, so read the playlist out of it first.
        if (!media) {
          const m = await timedFetch(this.url, "playlist");
          if (m.status === 200) media = mediaPlaylistUrl(m.body, this.url);
          this.keep(m);
        }
        if (media) {
          const p = await timedFetch(media, "playlist");
          const seg = p.status === 200 ? newestSegment(p.body, media) : null;
          this.keep(p);
          if (seg && seg !== lastSeg) {
            lastSeg = seg;
            this.keep(await timedFetch(seg, "segment"));
          }
        }
        await sleep(this.everyMs, this.ctl.signal);
      }
    })();
    return this;
  }

  keep(r) {
    delete r.body;
    this.requests.push(r);
  }

  async stop() {
    this.ctl.abort();
    await this.done;
    return this.requests;
  }
}

const pct = (values, p) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))] : null;
};

/* summariseProbe(requests) -> per kind: count, status counts, TTFB and total p50/p95/max,
 * error and slow counts (TTFB over 1 s), edges and cache results seen. */
export function summariseProbe(requests) {
  const out = {};
  for (const kind of ["playlist", "segment"]) {
    const rs = requests.filter((r) => r.kind === kind);
    const count = (key) => rs.reduce((m, r) => ((m[r[key] || "-"] = (m[r[key] || "-"] ?? 0) + 1), m), {});
    out[kind] = {
      requests: rs.length,
      status: count("status"),
      ttfbP50Ms: pct(rs.map((r) => r.ttfbMs), 50),
      ttfbP95Ms: pct(rs.map((r) => r.ttfbMs), 95),
      ttfbMaxMs: rs.length ? Math.max(...rs.map((r) => r.ttfbMs ?? 0)) : null,
      totalP95Ms: pct(rs.map((r) => r.totalMs), 95),
      slowOver1s: rs.filter((r) => (r.ttfbMs ?? 0) > 1000).length,
      errors: rs.filter((r) => r.status === 0 || r.status >= 400).length,
      edges: count("edge"),
      cache: count("cache"),
    };
  }
  return out;
}
