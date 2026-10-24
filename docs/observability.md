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
