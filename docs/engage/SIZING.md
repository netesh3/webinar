# Engage / API sizing (Cloud Run + Supabase free)

This is capacity for **`webcast-api`**, not LiveKit. Media RAM/CPU is a different
machine ([`../CAPACITY.md`](../CAPACITY.md)).

Engage does **not** need a bigger Cloud Run container. It **does** stress
Supabase Nano (free) on **disk, IOPS, and backend connections**, not on Go heap.

## What is already deployed

| Knob | Value | Where |
| --- | --- | --- |
| Cloud Run memory | **1 GiB** | `deploy/cloudrun-deploy.sh` `MEMORY:-1Gi` |
| CPU | 1 (+ CPU boost on start) | same |
| min / max instances | 0 / **3** | same |
| `DB_MAX_CONNS` | **4** | `store.Open` |
| `DB_MIN_CONNS` | **1** | same |
| Conn lifetime / idle | 1 h / 10 min | same |
| Sweeper | every 30 s, **in every instance** | `sweeper.go` |

Keep **1 GiB / 1 CPU**. Do not bump to 2 GiB because of CRM. Do not drop below
512 MiB unless you also cap concurrency (see below).

---

## RAM: Cloud Run (Go)

The process is a request/response API plus a sequential sweeper. CRM data lives
in Postgres. There is no in-memory contact graph, no Realtime fan-out, no
template cache of all hosts.

### Steady state (one instance)

| Piece | Order of magnitude |
| --- | --- |
| Go binary + runtime + HTTP | 40–80 MiB RSS idle |
| 4 pgx conns + TLS | ~8–16 MiB |
| Rate-limit maps | small, per instance |
| Sweep batch (100 outbox rows) | tens of KB |

Idle is **well under 128 MiB**. 1 GiB is ~8–10× idle on purpose: spikes, not
the CRM working set.

### Spikes (this is what 1 GiB is for)

| Event | Extra RAM | Notes |
| --- | --- | --- |
| Password hash/verify | **64 MiB per concurrent login** | Argon2id `m=65536` in `auth/password.go`. Google OAuth does **not** do this. |
| Cover image upload | **3 MiB** | `maxWebinarImageBytes` |
| JSON body / WhatsApp webhook | **≤ 1 MiB** | `httpx.maxBodyBytes`, `whatsappWebhookMaxBytes` |
| Inbox GET (200 contacts + 300 messages) | **~1–3 MiB** JSON | Capped; not unbounded |
| Create broadcast N recipients | **~O(N) in Go** | A few MB at 10k; the heavy part is the **one Postgres transaction**, not RSS |
| Bot on webhook | one flow JSON | Tiny vs the Graph HTTP that follows |

Worst reasonable mix on one instance: a few password logins + a couple of
uploads + inbox polls. 5 concurrent Argon2 hashes ≈ **320 MiB**. That plus
runtime still fits in **512 MiB**; 1 GiB is the safe default so a login burst
does not OOM next to a deploy.

Cloud Run default concurrency is 80. With 1 CPU you will hit **CPU** before
heap on CRM routes. The sweeper sends WhatsApp **one Graph call at a time**
(100/tick) — latency, not RAM.

### Recommendation

| Hosts / traffic | Cloud Run |
| --- | --- |
| Now – tens of hosts, polls + webhooks | **1 GiB / 1 CPU**, max 3 instances (current) |
| Cost-cut experiment | 512 MiB **and** `--concurrency=20` so Argon2 cannot stack |
| Do not | 2 GiB “for Engage”, or raising max-instances without revisiting the pool |

Watch `container/memory/utilizations` in Cloud Run. If p99 stays under ~40%,
RAM is not the constraint.

---

## Connections: the real sizing problem

Three different numbers. Mixing them up is how deploys died with
`max clients reached`.

| Limit | Nano (Supabase **free**) today | What it means for us |
| --- | --- | --- |
| Postgres `max_connections` | **60** (shared with Auth, Storage, dashboards) | Backends the database will accept |
| Pooler **max clients** | **200** (Supavisor) | How many TCP clients may sit on `:5432` / `:6543` |
| Pooler **pool size** (Dashboard) | Often **15** — **check this** | How many **real** Postgres backends the session pooler keeps |

We use the **session** pooler (`:5432`). Each `pgx` connection in `MaxConns`
holds one **pool-size** slot for up to an hour. Client-cap 200 does **not**
mean 200 API connections.

The 15 in `store.go` comments is this **pool size / observed session ceiling**,
not the 200 client figure in current docs.

### Formula (do not break this)

```
instances × DB_MAX_CONNS  ≤  pool_size  −  reserved
```

Reserve **≥ 3** for: SQL editor, migrate job, a rolling fourth instance’s ping
(`MinConns=1`).

Current: `3 × 4 = 12`, plus ~3 spare on a pool of 15.

| If you change… | Then… |
| --- | --- |
| `--max-instances` → 5 | `DB_MAX_CONNS` → **2** (5×2=10) |
| `--max-instances` → 2 | `DB_MAX_CONNS` can stay 4 (or 5) |
| Pool size in Dashboard → 25 | Still leave reserved; Nano only has **60** backends for **everyone** (Auth included). Do not set pool size to 50. |
| Switch to **transaction** pooler `:6543` | Need `default_query_exec_mode=simple_protocol`; then many short Cloud Run tasks can share backends. **Migrations still want session mode.** |

### Why 4 is enough for CPU

Queries are indexed lookups (ms). Four in-flight per instance is plenty for
inbox polls + webhook + one sweeper. Graph waits **do not** hold a DB conn:
`PendingWhatsApp` returns, then each send is `Template` / `MarkDelivered` /
`AppendMessage` as separate pool checkouts.

The sweeper **does** take one of the four during those SQL calls, every 30 s,
on **every** instance. That is why duplicate sends exist (architecture §10.3),
not why RAM grows.

---

## RAM: Supabase free (Nano) — this is the wall

| Resource | Free Nano | Effect on Engage |
| --- | --- | --- |
| Instance RAM | **~0.5 GB** for **all of Postgres** | `work_mem × connections` + `shared_buffers` + OS. A 10k-row broadcast insert in one transaction is a **database** memory/IO event. |
| Recommended DB size | **500 MB** | `crm_messages` will hit this first. ~0.5–1 KB/row ⇒ **~0.5–1M messages** fills the disk allotment. |
| Disk IOPS baseline | **250** | Sweeper + 200 inbox polls is fine; a full-table analytics scan is not. |
| Direct connections | 60 | We should not use direct from Cloud Run (IPv6). |

**Do not raise `DB_MAX_CONNS` on free.** More backends × sorts = Nano OOM /
restart, which looks like “API 500s”.

When `crm_messages` + `notifications` approach a few hundred MB: upgrade
compute (Micro ~$10, 1 GB RAM, 10 GB disk) **before** adding Cloud Run RAM.

---

## Sweeper vs pool (Engage-specific)

Each tick, sequentially: webinar sweeps → email 100 → drips 100 → bots 50 →
WhatsApp 100. One instance, one goroutine. Extra RAM is negligible.

Cost is **connection occupancy during SQL** and **duplicate Graph sends** if
two instances tick together. The fix is River (plan 0 in [PLANS.md](PLANS.md)):
jobs are claimed with `SKIP LOCKED`, so instances share work without double
sends. River workers hold at most the connections its pool is given; budget
~2 of the 4 per instance for River, and keep `instances × DB_MAX_CONNS` under
the pooler limit.

On a dedicated server (possible move; see Hosting in [PLANS.md](PLANS.md)):
one box running the same container replaces the 3 Cloud Run instances. Size
the pool for one process (`DB_MAX_CONNS` ≈ 10–12 on the same Supabase
limit), and grow the box before adding a second one.

---

## Checklist

1. Cloud Run: leave **1Gi / 1 CPU / max 3**.
2. Dashboard → Database → pooling: note **pool size**. Confirm
   `max_instances × DB_MAX_CONNS + 3 ≤ pool_size`.
3. Do not point PostgREST or the Next.js client at CRM tables (would steal
   pooler clients and bypass Go).
4. Size **disk** for message volume; size **API RAM** for Argon2 + uploads only.
5. First paid upgrade, if any: **Supabase Micro**, not Cloud Run 2Gi.
