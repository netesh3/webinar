# Edge egress workers

One Edge webinar's composite (headless Chrome + 1080p encoder) per worker VM, so mixes never
compete for the SFU box's CPU and parallel webinars do not slow each other down.

```
Host ─WebRTC─▶ SFU box (LiveKit, Redis, MediaMTX) ──▶ Bunny ──▶ audience
                  ▲ jobs (Redis :6379, VPC)   ▲ RTMP :1935 (VPC)
                  └──── egress worker VM ×N ──┘
```

- **SFU box:** `EGRESS_REMOTE=true` and `EGRESS_VPC_CIDR=<subnet>` in `/opt/livekit/.env`, then
  `redeploy.sh`. Redis gets a password (`REDIS_PASSWORD` in `.env.keys`) and binds the private
  IP; MediaMTX accepts RTMP publishes from the subnet; ufw opens 6379/1935 to the subnet only;
  the local egress container is not run (no fallback).
- **Workers:** created by the **Egress pool: add workers** workflow (`.github/workflows/egress-pool.yml`),
  labelled `egress-pool=<project id>`, kept stopped. `startup.sh` runs on every boot and starts
  the egress from instance metadata. Each takes exactly one composite (`cpu_cost` in the script).
- **The API** starts a stopped worker when a host clicks Start on an Edge webinar on that
  project, stops workers when no Edge webinar has been live there for a while, and emails the
  operators when the pool is full or GCP cannot start a worker.
- **Pool size** = number of worker VMs. Add more with the workflow; delete a VM to shrink it.
- **Server captions (optional):** with instance metadata `captions-image` and `captions-secret`
  set, `startup.sh` also runs the caption agent (`deploy/captions`) beside egress, capped at half
  the vCPUs at low priority. See `deploy/captions/README.md`.
