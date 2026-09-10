# Deploying on any cloud

The stack was never AWS-specific. `infra/ec2/docker-compose.yml` contains no AWS at all —
five services, all standard images or local builds, wired together with environment
variables. The *directory name is historical* and the file runs unchanged on any Linux box
with a public IP.

What was AWS-specific was the **process** around it. This document replaces that process
with one that works anywhere, and lists the per-provider traps that will otherwise cost
you an afternoon each.

```
scp/git the repo to the box, then:

  sudo DOMAIN=events.example.com ACME_EMAIL=you@example.com \
    infra/portable/bootstrap.sh

then from your laptop:

  node infra/portable/preflight.mjs events.example.com
```

---

## 1 · What was coupled, and what replaces it

| Was | Now | Why it matters |
|---|---|---|
| **ECR** held the images | `bootstrap.sh` builds them **on the box** | The only genuinely AWS-shaped dependency. Building locally also solves cross-architecture for free — Oracle's free tier is arm64, and a native build needs no buildx, no manifest lists, no QEMU. |
| **SSM Run Command** ran the deploy | plain `ssh` | SSM needs an IAM role, an agent and a VPC endpoint. Nothing else has it. |
| **Security group** opened the ports | provider console (§4) + `bootstrap.sh` for the host firewall | Every cloud has two firewall layers and people routinely open one. See the trap in §4. |
| `node_ip: __PUBLIC_IP__` **sed by hand** | `bootstrap.sh` discovers it | Asks the internet what address it sees rather than reading a metadata service, because every cloud's metadata path differs — and on AWS, Oracle and GCP the NIC only ever holds a *private* address, so reading the interface would advertise something unroutable in every ICE candidate. |
| `3.82.201.244.sslip.io` as the hostname | a real domain | `sslip.io` bakes the IP into the hostname, so any IP change dead-links every invitation already sent. `bootstrap.sh` refuses a bare IP for this reason. |
| Firewall ports written down twice | read out of `livekit.yaml` | Not hypothetical: `DEPLOY.md` documented `50000-50060` against a config of `50000-60060` for a while. The symptom of that mismatch is **no error anywhere** — media silently falls back to TCP. One source of truth removes the whole class of bug. |

**Unchanged, and deliberately so:** `infra/ec2/docker-compose.yml`, `infra/Caddyfile`,
`infra/ec2/livekit.yaml`. Those three are already portable and are what production has
been proving for weeks. Nothing here forks them.

---

## 2 · What you need, on any provider

| | |
|---|---|
| **A box** | 2 vCPU / 4 GB is plenty of *compute*. The spec that decides everything is **port speed** — see §3. |
| **A domain** | Not optional. `getUserMedia` needs a secure origin and the API refuses to boot unless it can hand the browser a `wss://` SFU URL. ~₹800/year. |
| **Two DNS A records** | `events.example.com` and `sfu.events.example.com`, both at the box's IP. Forgetting the second is the single most common mistake: the app loads perfectly and no call ever connects. |
| **Ubuntu 22.04/24.04 or Debian 12** | Or any distro `get.docker.com` supports. arm64 and x86_64 both fine. |
| **Six port ranges open** | In *both* firewalls. §4. |

---

## 3 · Size it by port speed, not by CPU

This app's cost is fan-out: an SFU sends **one copy per subscriber**, so egress is linear
in the audience and CPU barely moves.

```
concurrent students × 1.71 Mbps = the port speed you must buy
```

1.71 Mbps is a 720p15 screen share + the presenter's 180p camera thumbnail + audio.
Numbers per `docs/CAPACITY.md`.

| Concurrent students | Sustained egress | Realistic port | CPU actually used |
|---|---|---|---|
| 100 | 171 Mbps | 300 Mbit/s | <1 core |
| 200 | 342 Mbps | 600 Mbit/s | ~1 core |
| 500 | 854 Mbps | 1 Gbit/s | ~2.5 cores |
| 1,000 | 1.7 Gbps | 2.5 Gbit/s+ | ~5 cores |

Two things worth internalising:

- **You are buying the NIC, not the cores.** Every plan above needs 1–3 cores. Cheap VPS
  providers only sell fast ports bundled with cores you will never use — that is the
  structural reason a per-core-bandwidth cloud fits this workload better.
- **Exceeding the port does not fail cleanly.** Packets queue, then drop, then WebRTC's
  congestion control backs off for *everybody* at once. Nobody sees an error; the class
  just turns to mush. Size for 40%+ headroom.

If egress is the binding cost, the one lever with real leverage is
`ScreenSharePresets.h720fps5` in `web/lib/media.ts` — 1,500 → 800 kbps per student. Right
for a deck that never animates, wrong for a presenter who scrolls or plays video.

---

## 4 · Provider notes

**Every cloud has two firewalls.** One in their console, one on the machine.
`bootstrap.sh` does the machine. You must do the console. Opening only one is the most
common cause of "it connects but the video is black", because signalling goes over TCP 443
(which people always open) and media goes over UDP (which they often do not).

Open in the console:

```
tcp   22  80  443  7881
udp   3478   30000-30009   50000-60060
```

### Oracle Cloud — free, fastest for India

| | |
|---|---|
| Shape | `VM.Standard.A1.Flex`, 4 OCPU / 24 GB — **Always Free**, arm64 |
| Region | Mumbai or Hyderabad → **10–30 ms** from Indian students |
| Bandwidth | ~1 Gbps per OCPU, so ~4 Gbps |
| Egress | **10 TB/month free**, then ~$0.0085/GB — roughly 10× cheaper than AWS |

Three traps, in the order you will hit them:

1. **"Out of host capacity."** Free arm64 is heavily contended. Retry, and try each
   availability domain. This is the main reason to have a paid fallback picked out.
2. **Two firewalls, and the host one is hostile.** OCI's stock Ubuntu image ships an INPUT
   chain that `REJECT`s everything after SSH, persisted in `/etc/iptables/rules.v4`. Rules
   *appended* after that REJECT are never reached — a naive script "succeeds" and nothing
   gets through. `bootstrap.sh` inserts with `iptables -I` for exactly this reason. You
   still have to add ingress rules to the **VCN Security List** by hand.
3. **Always Free instances can be reclaimed** when idle. Not an SLA. Take backups (§6).

### Hetzner — best paid price per TB

`CPX31` (4 vCPU / 8 GB) or `CCX23` (4 dedicated). Singapore is nearest to India at 60–90 ms.
Cloud Firewall is a separate object from the host firewall. **Verify the traffic allowance
for your location** — EU locations include 20 TB; US and APAC have historically differed.
NIC is typically 1 Gbps, which caps you around 500 concurrent students.

### Contabo — cheapest, with a catch

**Choose the plan by the "Port Speeds" row, not by cores or price.** Cloud VPS 4 is
200 Mbit/s (≈117 students), VPS 6 is 300 (≈175), VPS 8 is 600 (≈351), VPS 12 is 800
(≈468). "Unlimited Traffic" is a near-meaningless claim at 200 Mbit/s — the port caps you
long before any fair-use policy does. Promotional pricing is 24 months, then it steps up.
No cloud firewall layer by default, so `bootstrap.sh`'s host rules are load-bearing.
vCPUs are shared and oversubscribed: jitter is the one thing real-time media cannot
absorb, so treat this as the budget option, not the safe one.

### DigitalOcean / Vultr — India regions, mid price

Bangalore (`BLR1`) and Mumbai respectively, so 15–35 ms. Cloud Firewall is optional and
separate. DO bundles ~5 TB then $0.01/GB — 9× cheaper than AWS, 10× dearer than Hetzner.

### AWS — works, costs the most

`c5n` rather than `c5`: the `n` variants have genuinely higher *sustained* network
throughput, which is the binding axis. Egress at $0.09–0.11/GB is what makes this
expensive — at 500 students it is ~4× the instance bill. **Allocate an Elastic IP**;
without one, any stop changes the address, and since 2024 you pay for a public IPv4 either
way, so it is free to fix.

---

## 5 · The deploy, step by step

```bash
# 1 — get the code onto the box
ssh user@your-box
sudo apt-get update && sudo apt-get install -y git
git clone <your repo> webcast && cd webcast

# 2 — everything else
sudo DOMAIN=events.example.com ACME_EMAIL=you@example.com \
  infra/portable/bootstrap.sh
```

`bootstrap.sh` then: discovers the public IP, warns if DNS does not already point at it,
reads the port ranges out of `livekit.yaml`, installs Docker, reserves the media ports
from the kernel's ephemeral range, opens the host firewall, stages `/opt/webcast`,
generates secrets **once**, builds both images natively, and starts the stack.

Re-running it is safe. Secrets are generated on first run and never replaced —
regenerating `POSTGRES_PASSWORD` would lock the API out of its own database, which is
precisely what a carelessly "idempotent" script does.

### Verify in this order — each rules out a different layer

```bash
# from your laptop: DNS, TCP, a real STUN probe on 3478/udp, TLS, and /api/healthz
node infra/portable/preflight.mjs events.example.com

# then the only check that actually matters
node e2e/probe-room.mjs https://events.example.com
```

`preflight.mjs` sends a genuine 20-byte STUN Binding Request to 3478/udp. That is the one
cheap, unambiguous test of whether UDP traverses the whole path — TCP checks prove almost
nothing, since a provider can pass all TCP and drop every UDP packet. It cannot test
50000–60060, because nothing listens on those until a participant is assigned one;
`probe-room.mjs` settles that by joining a real room and printing the selected ICE
candidate pair. **You want `udp` and `SELECTED` on the same line.** If it says `tcp`,
media is on the slow fallback that also dies when idle.

### Close the door

```bash
sed -i 's/^SIGNUP_OPEN=true/SIGNUP_OPEN=false/' /opt/webcast/.env
docker compose -f /opt/webcast/docker-compose.yml up -d api
```

---

## 6 · Migrating off the current AWS box

Do it in this order so the URL only changes once:

1. **Buy the domain.** Everything else depends on it.
2. **Bring the new box up** on the new provider and point DNS at it. The old box keeps
   serving `3.82.201.244.sslip.io` throughout — no downtime yet.
3. **Verify** with both probes above, and run one real class on the new host in parallel.
4. **Move the data.** Downtime starts here, and it is a couple of minutes:
   ```bash
   # on AWS
   docker compose exec -T postgres pg_dump -U webcast webcast | gzip > webcast.sql.gz
   docker run --rm -v webcast_recordings:/d -v "$PWD":/b alpine \
     tar czf /b/recordings.tar.gz -C /d .

   # on the new box
   gunzip -c webcast.sql.gz | docker compose exec -T postgres psql -U webcast -d webcast
   docker run --rm -v webcast_recordings:/d -v "$PWD":/b alpine \
     tar xzf /b/recordings.tar.gz -C /d
   ```
5. **Cut DNS over**, watch for an hour, then destroy the AWS box.

**Set up ongoing backups while you are in here.** There are currently none, on a database
holding every coach's student roster. A nightly `pg_dump` to Cloudflare R2 or Backblaze B2
costs roughly ₹100/month and is the single highest-value thing on this page.

---

## 7 · What this still does not do

Honest gaps, so nothing is a surprise later:

- **Multi-node.** One box, one SFU. A room lives entirely on one node, so extra nodes buy
  more *concurrent* webinars, never a bigger single one. Under ~500 concurrent this is not
  a limitation, it is the correct shape. The Redis block that enables it is written out and
  commented in `infra/ec2/livekit.yaml:104`, with the hard rule attached: **no load
  balancer in the media path** — signalling WebSocket only, because each node advertises
  its own public IP for ICE.
- **No CI.** Images are built on the target. Fine for one box; wrong past two.
- **No IaC.** Instance creation is still console clicks. Deliberate — the interesting
  differences between these providers are their firewall models and NIC speeds, not their
  APIs, and a Terraform module per provider would triple the surface for no gain at this
  scale.
- **No load test at target scale.** The largest audience ever *observed* on this stack is
  10. Every capacity figure here is arithmetic. Run `e2e/probe-load.mjs` from a second
  cheap instance in the same region — not from a laptop, which folds long before the
  server notices — before a real class of 200.
- **Clients are offered no TURN candidate** (`iceServers=[]`), so a student on a network
  that blocks UDP falls back to TCP rather than relaying. TURN is running and its ports
  are open; it just is not advertised. Worth fixing before a large audience.
