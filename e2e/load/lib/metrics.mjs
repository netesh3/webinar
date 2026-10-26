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

/* Per phase of a browser run (run.mjs --viewers browser): each series over the phase's window,
 * as avg / p95 / max of 15 s points, from the queries the overview dashboard uses
 * (docs/observability.md). "$box" is the video box, "$captions" its captions box. A query that
 * returns several series (by service) is reported per label value. */
export const PHASE_QUERIES = {
  boxCpuPct: '100 - avg(rate(node_cpu_seconds_total{box="$box",mode="idle"}[1m])) * 100',
  boxCpuByService: 'sum by (service) (rate(container_cpu_usage_seconds_total{box="$box",service=~"egress|livekit|mediamtx|caddy"}[1m]))',
  boxMemPct: '(1 - max(node_memory_MemAvailable_bytes{box="$box"}) / max(node_memory_MemTotal_bytes{box="$box"})) * 100',
  boxTxMbps: 'sum(rate(node_network_transmit_bytes_total{box="$box",device!~"lo|docker.*|veth.*|br-.*"}[1m])) * 8 / 1e6',
  boxRxMbps: 'sum(rate(node_network_receive_bytes_total{box="$box",device!~"lo|docker.*|veth.*|br-.*"}[1m])) * 8 / 1e6',
  hlsOutMbps: 'sum(rate(hls_muxers_outbound_bytes{box="$box"}[1m])) * 8 / 1e6',
  livekitLossP95Pct: 'histogram_quantile(0.95, sum by (le) (rate(livekit_packet_loss_percent_bucket[2m])))',
  livekitRttP95Ms: 'histogram_quantile(0.95, sum by (le) (rate(livekit_rtt_ms_bucket[2m])))',
  captionsCpuCores: 'sum(rate(container_cpu_usage_seconds_total{box="$captions",service="captions"}[1m]))',
  captionsMemMB: 'sum(container_memory_working_set_bytes{box="$captions",service="captions"}) / 1e6',
  apiInstances: 'count(count by (service_instance_id) (rate(http_server_request_duration_seconds_count{job="webcast-api"}[2m]) > 0))',
  apiRps: 'sum(rate(http_server_request_duration_seconds_count{job="webcast-api"}[1m]))',
  apiP95Sec: 'histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{job="webcast-api",http_route!~".*/events.*|/api/internal/.*"}[2m])))',
  api5xxPerSec: 'sum(rate(http_server_request_duration_seconds_count{job="webcast-api",http_response_status_code=~"5.."}[1m])) or vector(0)',
  apiJoinP95Sec: 'histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{job="webcast-api",http_route=~".*/join"}[2m])))',
  apiSayP95Sec: 'histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{job="webcast-api",http_route=~".*/say"}[2m])))',
  apiVoteP95Sec: 'histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{job="webcast-api",http_route=~".*/vote"}[2m])))',
  apiGoroutines: 'max({__name__=~"go_goroutine_count|process_runtime_go_goroutines|go_goroutines",job="webcast-api"})',
  edgeViewers: 'max(webinarliv_edge_viewers_cluster)',
  dbSizeMB: 'max(webinarliv_db_size_bytes) / 1e6',
};

/** avg / p95 / max of a series' values, rounded. */
export function stats(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const r = (x) => Math.round(x * 100) / 100;
  return { avg: r(v.reduce((a, b) => a + b, 0) / v.length), p95: r(v[Math.min(v.length - 1, Math.ceil(0.95 * v.length) - 1)]), max: r(v[v.length - 1]) };
}

async function range(cfg, query, fromSec, toSec, stepSec = 15) {
  const u = `${cfg.base}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${fromSec}&end=${toSec}&step=${stepSec}`;
  const r = await fetch(u, { headers: { Authorization: cfg.auth }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`prometheus ${r.status}`);
  const j = await r.json();
  return (j?.data?.result ?? []).map((s) => ({ labels: s.metric ?? {}, values: s.values.map((x) => Number(x[1])) }));
}

/* phaseMetrics(phases, cfg, { captionsBox }) -> [{ phase, start, end, <name>: {avg,p95,max} |
 * { <label>: {avg,p95,max} } | null, errors? }]. Never throws: a failed query is null + error. */
export async function phaseMetrics(phases, cfg = promConfig(), { captionsBox = process.env.GRAFANA_PROM_CAPTIONS_BOX || "captions-blr-1", queries = PHASE_QUERIES } = {}) {
  if (!cfg || !phases?.length) return null;
  const out = [];
  for (const ph of phases) {
    const from = Math.floor(Date.parse(ph.start) / 1000);
    const to = Math.ceil(Date.parse(ph.end ?? new Date().toISOString()) / 1000);
    const row = { phase: ph.name, start: ph.start, end: ph.end };
    for (const [name, q] of Object.entries(queries)) {
      try {
        const series = await range(cfg, q.replaceAll("$box", cfg.box).replaceAll("$captions", captionsBox), from, Math.max(to, from + 30));
        if (series.length <= 1) row[name] = series.length ? stats(series[0].values) : null;
        else {
          row[name] = {};
          for (const s of series) row[name][Object.values(s.labels).join(",") || "series"] = stats(s.values);
        }
      } catch (e) {
        row[name] = null;
        (row.errors ??= {})[name] = e.message;
      }
    }
    out.push(row);
  }
  return out;
}

/* Caption latency from the captions box's log (Loki), once a minute per room:
 * "caption latency <room>: finals N, partials N | e2e p50 X p90 Y | ...". Needs
 * GRAFANA_LOKI_URL (+ GRAFANA_LOKI_USER, GRAFANA_PROM_TOKEN or GRAFANA_LOKI_TOKEN); null without. */
export function parseCaptionLatency(line) {
  const m = /caption latency (\S+): finals (\d+).*?e2e p50 (\d+) p90 (\d+)/.exec(line);
  return m ? { room: m[1], finals: Number(m[2]), e2eP50Ms: Number(m[3]), e2eP90Ms: Number(m[4]) } : null;
}

export async function captionLatency({ from, to, room }, env = process.env) {
  const url = env.GRAFANA_LOKI_URL;
  const token = env.GRAFANA_LOKI_TOKEN || env.GRAFANA_PROM_TOKEN;
  if (!url || !token) return null;
  const auth = env.GRAFANA_LOKI_USER ? `Basic ${Buffer.from(`${env.GRAFANA_LOKI_USER}:${token}`).toString("base64")}` : `Bearer ${token}`;
  const q = `{role="captions", service="captions"} |= "caption latency"${room ? ` |= ${JSON.stringify(room)}` : ""}`;
  const u = `${url.replace(/\/$/, "")}/loki/api/v1/query_range?query=${encodeURIComponent(q)}&start=${from * 1e6}&end=${to * 1e6}&limit=5000`;
  const r = await fetch(u, { headers: { Authorization: auth }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`loki ${r.status}`);
  const j = await r.json();
  const rows = (j?.data?.result ?? []).flatMap((s) => s.values.map((v) => parseCaptionLatency(v[1]))).filter(Boolean);
  return {
    minutes: rows.length,
    finals: rows.reduce((a, x) => a + x.finals, 0),
    e2eP50Ms: stats(rows.map((x) => x.e2eP50Ms)),
    e2eP90Ms: stats(rows.map((x) => x.e2eP90Ms)),
  };
}
