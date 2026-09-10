# Deploying on one server

> **For a real deployment, use [`DEPLOY-ANYWHERE.md`](DEPLOY-ANYWHERE.md) instead.**
> It scripts this whole page — `infra/portable/bootstrap.sh` on any cloud — and uses the
> stack shape that production actually runs: `network_mode: host` for the SFU, no Redis,
> and the firewall ranges read out of `livekit.yaml` so they cannot drift.
>
> `docker-compose.prod.yml`, which the rest of this page describes, has two media defects
> that are easy to miss because **neither produces an error**: it publishes
> `50000-50060/udp` against a config of `50000-60060` (a 100× typo, media silently falls
> back to TCP), and it omits the TURN relay range `30000-30009/udp` entirely (a client
> allocates a relay on 3478 and then every packet it sends is dropped, so TURN looks like
> it is working). Publishing ten thousand UDP ports individually is also the wrong
> mechanism — it spawns a `docker-proxy` per port. Host networking is why the deployed
> stack does not have these problems.

> Deploying into an existing Kubernetes cluster instead, for a throwaway test?
> See [`k8s/README.md`](k8s/README.md). Different shape: the app is mounted under a
> path on a hostname somebody else already owns, and WebRTC media needs a load
> balancer of its own because an HTTP ingress cannot carry it.


Everything on a single box behind automatic TLS: Caddy, the Next.js frontend, the
Go API, Postgres, Redis and the LiveKit SFU. Six containers, one compose file.

This is the shape the 500-attendee ceiling was designed around. Only the host and
panelists publish, so the load is **egress**: roughly 500 × 2 Mbps ≈ **1 Gbps**.
One machine with unmetered gigabit handles a full house; past that you add the
LL-HLS tier rather than more SFU nodes.

---

## What you need

| | |
|---|---|
| A server | 2 vCPU / 4 GB is enough for the software. **Unmetered 1 Gbps is the number that matters** — a 500-person webinar moves ~450 GB an hour, so a metered plan is the thing that will actually stop you. |
| A domain | Not optional. `getUserMedia` and `getDisplayMedia` only work on a secure origin, and the API refuses to start unless it can hand the browser a `wss://` SFU URL. An IP address with a self-signed certificate will fight you on every device. |
| Docker | Engine 24+ with the compose plugin. |
| Open ports | 80, 443, 7881 (TCP) and 3478, 30000–30009, 50000–60060 (UDP). All six, and the UDP ones are not optional — see below. |

**Get the UDP right or nothing else matters.** This table said `50000–50060` for a while, which
is a hundred-fold typo for `50000–60060`, and the symptom of getting it wrong is not an error
anywhere: media silently falls back to TCP on 7881, which works, and is slower and dies when
idle. What each one is for:

| port | why |
|---|---|
| `50000–60060/udp` | the SFU's own media. Must match `rtc.port_range_start/end`. |
| `3478/udp` | TURN, for clients that cannot send media directly. |
| `30000–30009/udp` | where TURN **relays** that media. Closed, a client allocates a relay on 3478 and then every packet it sends is dropped — the failure looks like TURN working. Must match `turn.relay_range_start/end`. |

One kernel setting goes with them:

```
# /etc/sysctl.d/99-livekit-ports.conf
net.ipv4.ip_local_reserved_ports = 50000-60060
```

`ip_local_port_range` is `32768–60999` by default, so without this the kernel hands the SFU's
own media ports out for its outbound sockets too, and a bind collides now and then. The
failures are intermittent and look like a network problem.

Two DNS records, both pointing at the server's IPv4:

```
A    events.example.com        ->  203.0.113.10
A    sfu.events.example.com    ->  203.0.113.10
```

The second one is the SFU's signalling endpoint. Without it the app loads and no
call ever connects.

## Deploy

```bash
git clone <your repo> webcast && cd webcast

cp .env.prod.example .env.prod
openssl rand -hex 32          # POSTGRES_PASSWORD
openssl rand -hex 32          # SESSION_SECRET
openssl rand -hex 32          # LIVEKIT_API_SECRET
$EDITOR .env.prod             # paste those in, set DOMAIN and ACME_EMAIL

docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

First boot takes a few minutes: two images to build, and Caddy has to get
certificates. Watch it:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f caddy api
```

Then open `https://events.example.com`, sign up at `/signup?host=1`, schedule a
webinar and start it. The API applies its own migrations at boot, so there is no
separate migration step.

**Close the door behind you.** Once your accounts exist, set `SIGNUP_OPEN=false` in
`.env.prod` and `docker compose ... up -d api`. Otherwise anyone who finds the URL
can create an account.

## Check it from a second device

The local test suite proves the plumbing; a phone on mobile data proves the
deployment. From a network that is not your office:

1. Open the webinar's registration page, register, join.
2. As the host, share a screen and confirm the attendee sees it.
3. Press **Record**, stop, and download the file from the webinar's Recordings tab.

If the room connects but the video stays black, it is the UDP range — see below.

## What is where

```
                        :443  ┌─────────┐
   browser ────────────────── │  caddy  │  TLS, automatic renewal
                              └────┬────┘
                    /api/*  ┌──────┴───────┐  everything else
                            │              │
                       ┌────▼────┐    ┌────▼────┐
                       │   api   │    │   web   │  Next.js, standalone
                       └──┬───┬──┘    └─────────┘
              recordings  │   │  ┌──────────┐
                 volume ◄─┘   └─►│ postgres │
                                 └──────────┘

   sfu.DOMAIN :443 ── caddy ──► livekit :7880      signalling (wss)
   browser ──────────────────► livekit :50000-60060/udp, :7881/tcp   media
```

**One origin, deliberately.** Caddy sends `/api/*` to the API and everything else
to Next, so the session cookie is plainly first-party and there is no CORS
preflight on the join path when 500 people arrive at the same minute. The browser
bundle contains no hostname at all — `NEXT_PUBLIC_API_BASE` is built empty, so every
request is relative and the same image works for any domain.

**Media never touches Caddy.** RTP is UDP; a reverse proxy cannot carry it. That is
why the SFU publishes its own ports and why they have to be open in both the
server's firewall and any cloud security group.

## Operating it

```bash
C="docker compose -f docker-compose.prod.yml --env-file .env.prod"

$C ps                          # what is running
$C logs -f api                 # follow the API
$C up -d --build web api       # deploy a change
$C exec postgres psql -U webcast -d webcast    # a psql shell
$C down                        # stop (volumes survive)
```

**Backups.** Two things are irreplaceable: the database and the recordings.

```bash
$C exec -T postgres pg_dump -U webcast webcast | gzip > webcast-$(date +%F).sql.gz
docker run --rm -v webcast_recordings:/data -v "$PWD:/out" alpine \
  tar czf /out/recordings-$(date +%F).tar.gz -C /data .
```

Put both somewhere else, on a schedule. `caddy_data` is worth keeping too —
re-issuing certificates is rate-limited by Let's Encrypt.

## When something is wrong

| Symptom | Cause |
|---|---|
| Certificate never issues | DNS is not pointing here yet, or 80 is blocked. Let's Encrypt rate-limits failures, so uncomment `acme_ca` staging in `infra/Caddyfile` while sorting DNS out. |
| App loads, call connects, **video is black** | The UDP range is not reaching the container. Check the firewall and the security group, and that `port_range_start/end` in `infra/livekit.prod.yaml` matches the published range in the compose file. |
| Some attendees cannot join at all, usually corporate | They are behind a UDP-blocking firewall and falling back to ICE/TCP on 7881 — make sure it is open. For networks that allow nothing but HTTPS you need TURN over TLS on 443; see the note at the bottom of `infra/livekit.prod.yaml`. |
| Everyone connects, but video is jerky and dies when nobody is speaking | Media is on TCP, not UDP. `use_ice_lite` must be **false** or the SFU never probes back and the UDP pair never completes. `node e2e/probe-room.mjs <url>` prints the selected candidate pair. |
| "Connecting…" forever, console mentions mixed content | `LIVEKIT_URL` is not `wss://`. The API refuses to boot in this state, so it means the container is running an old environment — recreate it. |
| API exits at startup | It validates its configuration and says exactly what is wrong. `$C logs api` will name the variable. |
| Recording button does nothing | `RECORDINGS_ENABLED=false`, or the `recordings` volume is not writable. The API write-probes it at boot and refuses to start if it cannot, so check the logs. |
| Whole audience gets 429 on join | `JOIN_RATE_PER_MIN` is below the real audience size. It is per IP, and an office shares one. |

## What this does not do

Honest list, so nothing is a surprise in front of a customer:

- **One node.** No load balancer, no failover; restarting the API drops in-flight
  requests and a redeploy interrupts a live webinar. Fine for testing and for a
  first customer, not for an SLA.
- **Rate limiting is in-memory**, so it is per-process. Running two API containers
  multiplies the effective limit. Move it to Redis first.
- **Recording is client-side** — the browser of whoever pressed record. It stops if
  that tab closes. Server-side capture (LiveKit Egress) is the next step.
- **Recordings are on the server's disk.** `RECORDINGS_BACKEND=s3` is a config value
  the API deliberately refuses until the backend exists.
- **No email.** Registration shows the join link; nothing is sent.
- **No metrics or alerting.** `/healthz` and `/readyz` exist for a probe to use.
