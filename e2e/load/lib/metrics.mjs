/* Server-side numbers per step, from Grafana Cloud's Prometheus (optional, read-only).
 *
 *   GRAFANA_PROM_URL    the query base, e.g. https://prometheus-prod-43-prod-ap-south-1.grafana.net/api/prom
 *                       (the push URL without /push; /api/v1/query is appended)
 *   GRAFANA_PROM_TOKEN  a token with metrics:read
 *   GRAFANA_PROM_USER   the stack's Prometheus user id (Basic auth); without it the token is sent as Bearer
 *   GRAFANA_PROM_BOX    the box label to filter on (default sfu-blr-1)
 *   GRAFANA_PROM_QUERIES  JSON {name: promql} replacing the defaults. "$box" and "$window" (the
 *                       step's length, e.g. 150s) are substituted. This is the hook for the API's
 *                       p95/5xx: the API itself exports no Prometheus series today (Cloud Run's
 *                       request metrics live in Cloud Monitoring), so add them here once they are
 *                       scraped into the stack.
 *
 * Each query is evaluated once per step, at the step's end, averaged over the step's window.
 * Without the variables nothing is queried and results.json says so. */

export const DEFAULT_QUERIES = {
  // Busy cores on the box over the step.
  boxCpuCores: 'avg_over_time((sum(rate(node_cpu_seconds_total{box="$box",mode!="idle"}[1m])))[$window:15s])',
  // What the box sent and received, Mbit/s (the CDN shield's pulls, or every viewer with --origin).
  boxTxMbps: 'avg_over_time((sum(rate(node_network_transmit_bytes_total{box="$box",device!~"lo|docker.*|veth.*|br-.*"}[1m])) * 8 / 1e6)[$window:15s])',
  boxRxMbps: 'avg_over_time((sum(rate(node_network_receive_bytes_total{box="$box",device!~"lo|docker.*|veth.*|br-.*"}[1m])) * 8 / 1e6)[$window:15s])',
  // What MediaMTX served as HLS, Mbit/s: the origin's own view of viewer traffic.
  hlsOutMbps: 'avg_over_time((sum(rate(hls_muxers_outbound_bytes{box="$box"}[1m])) * 8 / 1e6)[$window:15s])',
};

export function promConfig(env = process.env) {
  const url = env.GRAFANA_PROM_URL;
  const token = env.GRAFANA_PROM_TOKEN;
  if (!url || !token) return null;
  let queries = DEFAULT_QUERIES;
  if (env.GRAFANA_PROM_QUERIES) queries = JSON.parse(env.GRAFANA_PROM_QUERIES);
  return {
    base: url.replace(/\/push\/?$/, "").replace(/\/$/, ""),
    auth: env.GRAFANA_PROM_USER ? `Basic ${Buffer.from(`${env.GRAFANA_PROM_USER}:${token}`).toString("base64")}` : `Bearer ${token}`,
    box: env.GRAFANA_PROM_BOX || "sfu-blr-1",
    queries,
  };
}

/** The query text for one step: $box and $window filled in. */
export function fillQuery(q, { box, windowSec }) {
  return q.replaceAll("$box", box).replaceAll("$window", `${Math.max(30, Math.round(windowSec))}s`);
}

async function instant(cfg, query, atSec) {
  const u = `${cfg.base}/api/v1/query?query=${encodeURIComponent(query)}&time=${atSec}`;
  const r = await fetch(u, { headers: { Authorization: cfg.auth }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`prometheus ${r.status}`);
  const j = await r.json();
  const v = j?.data?.result?.[0]?.value?.[1];
  return v === undefined ? null : Math.round(Number(v) * 100) / 100;
}

/* stepMetrics(steps, cfg) -> [{ step, at, <name>: value|null, errors? }]: one row per step of
 * hls results (startedAt, seconds). Never throws: a failed query is null plus its error. */
export async function stepMetrics(steps, cfg = promConfig()) {
  if (!cfg) return null;
  const rows = [];
  for (const s of steps ?? []) {
    const start = Date.parse(s.startedAt) / 1000;
    const windowSec = s.seconds ?? 60;
    const at = Math.round(start + windowSec);
    const row = { step: s.name, at: new Date(at * 1000).toISOString() };
    for (const [name, q] of Object.entries(cfg.queries)) {
      try {
        row[name] = await instant(cfg, fillQuery(q, { box: cfg.box, windowSec }), at);
      } catch (e) {
        row[name] = null;
        (row.errors ??= {})[name] = e.message;
      }
    }
    rows.push(row);
  }
  return rows;
}
