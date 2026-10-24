# Observability: audience gauges

The API sends traces, request metrics and logs over OTLP to Grafana Cloud when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set (`api/internal/observe`, see the package comment for the
environment variables). Without it, telemetry is off and so are these gauges: nothing is
registered on a real meter and the database is never queried for them.

On top of the HTTP and Go runtime metrics, the API reports who is watching right now
(`api/internal/observe/gauges.go`, registered in `cmd/server/main.go`). Every gauge is
exported every 15 seconds by every instance. None carries a webinar or a person: at most one
series per kind per instance.

## Metrics

Grafana Cloud's OTLP ingest turns the dots in a name into underscores. The units are
annotations (`{viewer}`) and add no suffix. `service.instance.id` (a fresh id per process)
becomes the `instance` label, `service.name` the `job` label.

| OTel name | Prometheus name | Attributes | What it counts | Across instances |
|---|---|---|---|---|
| `webinarliv.edge_viewers` | `webinarliv_edge_viewers` | none | Edge (LL-HLS) event streams open on **this** instance (`/api/webinars/{slug}/events`, the in-process hub) | **sum** |
| `webinarliv.edge_viewers_cluster` | `webinarliv_edge_viewers_cluster` | `scope="cluster"` | Edge viewers whose browser beat in the last 150 s, every live webinar (Postgres `attendance_visits`; the number behind the host's badge and `GET /api/host/webinars/{slug}/edge`'s `viewers`) | **max** |
| `webinarliv.live_sessions` | `webinarliv_live_sessions` | `scope="cluster"`, `kind` = `webinar` \| `meeting` \| `simulive` | Sessions with status live (a recurring session counts as `webinar`) | **max by (kind)** |
| `webinarliv.webrtc_participants` | `webinarliv_webrtc_participants` | `scope="cluster"` | People in the video server's rooms of live sessions: open visits kept by LiveKit's participant_joined/left webhooks, hosts and attendees only (no recorder, caption agent or egress; no Zoom-venue sessions) | **max** |

### Why two edge numbers

Each edge viewer's event stream is held by exactly one Cloud Run instance, so the
per-instance `webinarliv_edge_viewers` adds up correctly with `sum()`. It is the live
"connected right now" figure, but it can run high: behind the CDN a tab that closed can leave
its stream open on the server until the stream's 25-minute life ends (see the comment in
`handleEdgeEvents`).

The authoritative count is the beat-based one in Postgres, which is what the host sees. It is
cluster-wide, so every instance reads and reports the same value; summing it would count the
audience once per instance. There is no leader to export it from one place (instances come and
go), so all of them export it with `scope="cluster"` and the dashboard takes `max()`, which
stays right whichever instances are up. The same holds for the other two cluster gauges.

The database read behind the cluster gauges is one query, cached for 15 seconds per instance.
A failed read drops the cluster series for that export rather than reporting zero.

## PromQL for the dashboard

```promql
# Edge (LL-HLS) viewers right now: the host-visible number (recommended headline)
max(webinarliv_edge_viewers_cluster)

# Edge event streams connected, summed over instances (and per instance, for balance)
sum(webinarliv_edge_viewers)
sum by (instance) (webinarliv_edge_viewers)

# Live sessions by kind
max by (kind) (webinarliv_live_sessions)

# People on the video server (WebRTC)
max(webinarliv_webrtc_participants)

# Everyone attending, either way
max(webinarliv_edge_viewers_cluster) + max(webinarliv_webrtc_participants)
```

If more than one environment reports to the same stack, add the environment's resource
attribute to each selector (for example `{deployment_environment_name="prod"}`, from
`OTEL_RESOURCE_ATTRIBUTES`), and put it in the `by ()` clause of the `max`.

Caveats:

- Cloud Run only gives an instance CPU while it serves a request, so an idle instance may skip
  exports. During a live session the beats keep every instance with viewers busy, so this
  only shows as gaps when nothing is happening.
- An instance that is shut down stops reporting; its last `webinarliv_edge_viewers` stays in
  `sum()` until the series goes stale (Prometheus's 5-minute lookback). Its viewers reconnect
  to another instance within seconds, so for a few minutes after a deploy or scale-down the
  summed figure can read high. The `max()` of the cluster gauge is not affected.

## Series budget (Grafana Cloud free tier: 10,000 active series)

On 2026-10-24 the stack sat at ~11,762 active series: `webcast-api` 10,685, `livekit` 815,
`node` 107, `mediamtx` 37. Measured on the API (one instance, instant query):

| What | Series per instance | Why |
|---|---|---|
| `http_server_request_body_size_bytes` (16 buckets + sum + count) | ~1,200 | otelhttp default, never charted |
| `http_server_response_body_size_bytes` | ~1,200 | same |
| `http_server_request_duration_seconds` (15 buckets) | ~1,150 | ~68 route × method × status combos |
| `http_client_request_body_size_bytes` + `_duration_seconds` | ~280 | by host, method, status, protocol |
| Go runtime, audience gauges, `target_info` | ~30 | |

That is ~3,900 per instance. `service.instance.id` is a fresh id per process, and it has to
stay (several instances writing cumulative counters under one identity would overwrite each
other), so every Cloud Run instance alive in the active-series window repeats the lot: 24
instances over the day, ~2.7 at a time on average. On top come the series Grafana derives in
the stack from these (`asserts:*` ~650, `traces_spanmetrics_*` ~100, also `job="webcast-api"`).

### What is exported now (`api/internal/observe/metrics.go`)

- **`http.server.request.duration`** is recorded by `observe.RouteTag`, not otelhttp (whose
  handler now gets a no-op meter), with two attributes only:
  - `http.route`, the chi pattern, with rarely-called families folded into one route each:
    `/api/admin/*` (except `/api/admin/sales/{id}/join`), `/api/auth/*` (except
    `/api/auth/me`), `/api/billing/*`, `/api/me/*` (except `/api/me/registrations`),
    `/api/host/crm/*` (except `/api/host/crm/replies`),
    `/api/host/webinars/{slug}/{recordings,polls,engagement,survey}/*`,
    `/api/internal/clip-jobs/*`, `/api/internal/mix-recordings/*`. Over the day, 146 routes in
    167 route × status combinations became 98.
  - `http.response.status_code`: `1xx`/`2xx`/`3xx`/`4xx` for anything below 500, the **exact
    code** for 5xx (`500`, `503`, ...). Same label name, so every existing selector still
    works: `=~"5.."` matches `500` and `503`, `="503"` matches 503, and Grafana's Asserts
    rules (`=~"4.."`, `=~"5.."`) still match.
  - No `http.request.method`, `url.scheme`, `server.address`, `network.protocol.*`.
  - Buckets: `0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30` s (10 with `+Inf`, was 15).
- **`http.client.request.duration`**: by `server.address` only, same buckets.
- **No body-size histograms** (server or client).
- **Go runtime**: `go_goroutine_count`, `go_memory_used_bytes` (and `go_memory_limit_bytes`
  under a GOMEMLIMIT). The allocation counters, GC goal, GOGC and processor limit are dropped.
- Traces are unchanged: spans keep the method, the exact status code and the exact route.

### Before and after

| | Before | After |
|---|---|---|
| Server request histogram, per instance | ~68 combos × 17 = ~1,150 | ~52 combos × 12 = ~620 |
| Server body-size histograms, per instance | ~2,450 | 0 |
| Client histograms, per instance | ~280 | ~7 hosts × 12 = ~85 |
| Runtime + gauges + `target_info`, per instance | ~30 | ~15 |
| **Per instance** | **~3,900** | **~720** |
| `webcast-api` active (× ~2.7 instances in the window) | 10,685 | ~1,950 |
| Grafana-derived `asserts:*` + `traces_spanmetrics_*` | ~750 | ~550 (they follow the routes) |
| `livekit` (Alloy, `deploy/livekit-hetzner/alloy/config.alloy`) | 815 | ~300 |
| `node` + `cadvisor` + `mediamtx` | ~220 | ~220 |
| **Total** | **~11,800** | **~3,000** |

LiveKit's drop: all `livekit_psrpc_*` (its internal RPC) and the `_bucket` series of
`node_twirp_request_latency_ms`, `pubsubtime_ms`, `packet_out_of_order_percent`, `jitter_us`,
`forward_latency_ns`, `webhook_queue_length`, `session_start_time_ms` and
`session_duration_ms` (their `_sum`/`_count` stay). `rtt_ms` and `packet_loss_percent` (this
dashboard) and `room_duration_seconds` and `session_join_latency_ms` (the box's own
`livekit.json`) keep their buckets.

If the stack still runs close to the limit, the next lever is in Grafana, not here: the
Asserts / Application Observability recording rules (`asserts:*`, `traces_spanmetrics_*`) are
~550 series on their own and can be switched off in the stack.

### Dashboard and alert PromQL

**No query has to change.** The label names are the same and every selector used matches the
new values. Panel by panel (dashboard `webinarliv-overview`):

| Panel / alert | Query | After the change |
|---|---|---|
| Requests / s by status | `sum by (http_response_status_code) (rate(http_server_request_duration_seconds_count{job="webcast-api"}[5m]))` | unchanged; the legend reads `2xx`, `3xx`, `4xx` and exact 5xx codes |
| p50 / p95 latency | `histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{job="webcast-api",http_route!~".*/events.*\|/api/internal/.*"}[5m])))` (and 0.5) | unchanged; interpolated over the new buckets |
| Top routes by p95 | `topk(8, histogram_quantile(0.95, sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket{job="webcast-api",http_route!~".*/events.*\|/api/internal/.*"}[15m]))))` | unchanged; folded families show as e.g. `/api/admin/*` |
| 5xx by route | `sum by (http_route) (rate(http_server_request_duration_seconds_count{job="webcast-api",http_response_status_code=~"5.."}[5m]))` | unchanged |
| Tick calls / 10 min | `sum(increase(http_server_request_duration_seconds_count{job="webcast-api",http_route="/api/internal/tick"}[10m]))` | unchanged (`/api/internal/tick` is not folded) |
| Goroutines and heap | `sum(go_goroutine_count{job="webcast-api"})`, `sum(go_memory_used_bytes{job="webcast-api"})/1e6` | unchanged (both kept) |
| Attendee gauges | `max(webinarliv_edge_viewers_cluster)` etc. | unchanged |
| Alert: API 5xx errors | `sum(rate(...{http_response_status_code=~"5.."}[5m])) - (sum(rate(...{http_response_status_code="503",http_route=~".*/join.*"}[5m])) or vector(0))` | unchanged (5xx keep their exact code; no join route is folded) |
| Alert: API slow (p95 > 3s) | as the p95 panel, `[10m]` | unchanged; 3 s lies between the 2.5 and 5 s buckets, as it did with the old ones |
| Alert: Tick stopped | as the tick panel | unchanged |
| Alert: Video box CPU high | `node_cpu_seconds_total` | unchanged (Alloy host metrics untouched) |
| LiveKit quality panel | `livekit_packet_loss_percent_bucket`, `livekit_rtt_ms_bucket` | unchanged (kept) |

A query that grouped or filtered by `http_request_method`, or matched an exact 1xx-4xx code
(`http_response_status_code="404"`), would now come back empty; none in the dashboard or the
alert rules does. Use `="4xx"` (or `=~"4.."`) instead. For five minutes after the deploy the
old instances' series (exact codes, with method) and the new ones overlap; sums across both
stay right.

To check the budget:

```promql
count({job="webcast-api"})                                   # all API series right now
sort_desc(count by (__name__) ({job="webcast-api"}))         # by metric
count by (service_instance_id) (http_server_request_duration_seconds_count)  # combos per instance
```
