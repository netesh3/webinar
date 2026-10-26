/* Bunny's request log for a run's window (bunny-log.mjs, docs/LOAD-TESTING.md).
 *
 * The log is what proved the 25 Oct stalls: viewers' requests that hung at an edge until the
 * player gave up are 499s there, and nothing on our side sees them. One line per request:
 *
 *   cache|status|epoch ms|bytes|pull zone id|client ip|referer|url|edge|user agent|request id|country
 *
 * Pure parsing and summing here; fetching is in bunny-log.mjs. */

/** One log line -> a record, or null for a line that isn't one. */
export function parseLine(line) {
  const f = line.replace(/\r?\n$/, "").split("|");
  if (f.length < 12) return null;
  const at = Number(f[2]);
  if (!Number.isFinite(at)) return null;
  const url = f[7];
  const kind = /\.m3u8(\?|$)/.test(url) ? "playlist" : /\.(m4s|mp4|ts)(\?|$)/.test(url) ? "segment" : "other";
  return { cache: f[0], status: Number(f[1]), at, bytes: Number(f[3]), ip: f[5], url, kind, edge: f[8], country: f[11] };
}

/* summarise(records, { from, to, slug }) -> totals, per-minute and per-edge rows: requests,
 * status counts, 499 and 504 percentages (viewers giving up; the edge timing out on us), the cache
 * HIT ratio, by kind. `slug` keeps only that webinar's stream. */
export function summarise(records, { from = -Infinity, to = Infinity, slug } = {}) {
  const rs = records.filter((r) => r.at >= from && r.at < to && (!slug || r.url.includes(`/${slug}/`)));
  const row = (list) => {
    const status = {};
    for (const r of list) status[r.status] = (status[r.status] ?? 0) + 1;
    const n = list.length;
    const hits = list.filter((r) => r.cache === "HIT").length;
    return {
      requests: n,
      status,
      // Percentages, two decimals: 2.3% of 499s was a wave everyone saw (25 Oct).
      pct499: n ? Math.round((10000 * (status[499] ?? 0)) / n) / 100 : 0,
      pct504: n ? Math.round((10000 * (status[504] ?? 0)) / n) / 100 : 0,
      hitPct: n ? Math.round((10000 * hits) / n) / 100 : 0,
      viewers: new Set(list.map((r) => r.ip)).size,
    };
  };
  const group = (key) => {
    const m = new Map();
    for (const r of rs) {
      const k = key(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, list]) => ({ key: k, ...row(list) }));
  };
  return {
    all: row(rs),
    byKind: group((r) => r.kind),
    byEdge: group((r) => r.edge || "-"),
    byMinute: group((r) => new Date(Math.floor(r.at / 60_000) * 60_000).toISOString().slice(11, 16)),
  };
}

/** The log's URL for a date (UTC) and pull zone: https://logging.bunnycdn.com/MM-DD-YY/<zone>.log */
export function logUrl(date, zoneId) {
  const d = new Date(date);
  const p = (n) => String(n).padStart(2, "0");
  return `https://logging.bunnycdn.com/${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${String(d.getUTCFullYear()).slice(2)}/${zoneId}.log`;
}
