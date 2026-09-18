# Server-Side Webinar Recording: LiveKit Egress + Backblaze B2 + Cloudflare CDN

This guide explains the architecture, deployment, and configuration for zero-client-overhead webinar recording with a Zoom-style side-by-side layout, storing to Backblaze B2 and distributing via Cloudflare CDN.

---

## 1. Architecture & Data Flow

```
+-----------------------------------------------------------------------------------+
| PRESENTER BROWSER                                                                 |
|   Presses "Record" -> The Cloud                                                   |
|   (Zero upload bandwidth used; no canvas compositing CPU load on host's machine) |
+-----------------------------------------------------------------------------------+
                                         |
                                         v POST /api/host/webinars/:slug/recordings
+-----------------------------------------------------------------------------------+
| GO API (Cloud Run)                                                                |
|   1. Creates database row in `recordings` (status: 'recording')                   |
|   2. Calls LiveKit SFU: StartRoomCompositeEgress(...)                             |
|      - S3 Upload Options: Backblaze B2 (ForcePathStyle: true)                     |
|      - Custom Base URL: https://webinarliv.com/recorder-template                  |
|      - Layout: custom (Zoom Side-by-Side)                                         |
|      - Preset: 1080p (or 720p)                                                    |
+-----------------------------------------------------------------------------------+
                                         |
                                         v psrpc RPC over Redis
+-----------------------------------------------------------------------------------+
| HETZNER SERVER                                                                    |
|   1. LiveKit SFU (livekit-server:v1.9.1) dispatches job to Redis queue            |
|   2. Redis (redis:7-alpine, in-memory queue, ~15MB RAM)                           |
|   3. LiveKit Egress (livekit/egress:v1.8.8)                                       |
|      - Launches Headless Chromium pointing to:                                    |
|        https://webinarliv.com/recorder-template?url=...&token=...                 |
|      - Zoom Layout: Screenshare on left (78%), active speakers on right (22%)     |
|      - Encodes audio/video directly to MP4 container                              |
|      - Streams chunks directly to Backblaze B2 S3 API                             |
+-----------------------------------------------------------------------------------+
                                         |
                                         v S3 Upload (Direct to Bucket)
+-----------------------------------------------------------------------------------+
| BACKBLAZE B2                                                                      |
|   Bucket: <RECORDINGS_S3_BUCKET>                                                  |
|   Key: webinars/<slug>/<recording_id>.mp4                                         |
+-----------------------------------------------------------------------------------+
                                         |
                                         | Webhook: EGRESS_ENDED
                                         v
+-----------------------------------------------------------------------------------+
| GO API (Cloud Run) - /api/webhooks/livekit                                        |
|   - Verifies LiveKit auth signature                                               |
|   - Updates recording: status = 'ready', duration_ms = ..., size_bytes = ...      |
+-----------------------------------------------------------------------------------+
                                         |
                                         | User requests download / playback
                                         v GET /api/host/webinars/:slug/recordings/:id/file
+-----------------------------------------------------------------------------------+
| CLOUDFLARE CDN DELIVERY                                                           |
|   - Go API responds with HTTP 307 Temporary Redirect to:                          |
|     https://recordings.webinarliv.com/webinars/<slug>/<recording_id>.mp4          |
|   - Cloudflare Edge serves cached bytes directly to users                         |
|   - 100% Free Egress via Cloudflare + Backblaze Bandwidth Alliance ($0/GB)        |
+-----------------------------------------------------------------------------------+
```

---

## 2. Hetzner Server Setup (LiveKit SFU + Egress + Redis)

### Step 1: Update `docker-compose` on Hetzner
Copy `deploy/livekit-hetzner/docker-compose.egress.yml` to the Hetzner server (e.g. `/root/livekit/docker-compose.egress.yml`).

### Step 2: Configure Redis in `livekit.yaml`
Edit `/root/livekit/livekit.yaml` and add the `redis` block and `webhook` block:

```yaml
# Add to /root/livekit/livekit.yaml
redis:
  address: 127.0.0.1:6379

webhook:
  api_key: <YOUR_LIVEKIT_API_KEY>
  urls:
    - https://api.webinarliv.com/api/webhooks/livekit
```

### Step 3: Create `egress.yaml`
Create `/root/livekit/egress.yaml`:

```yaml
api_key: <YOUR_LIVEKIT_API_KEY>
api_secret: <YOUR_LIVEKIT_API_SECRET>
ws_url: ws://127.0.0.1:7880

redis:
  address: 127.0.0.1:6379

log_level: info
prom_port: 8088
in_proc_session: false
```

### Step 4: Start the Extended Stack
Run:
```bash
cd /root/livekit
docker compose -f docker-compose.yml -f docker-compose.egress.yml up -d
```

Verify services are healthy:
```bash
docker compose -f docker-compose.yml -f docker-compose.egress.yml ps
docker logs -f livekit-egress-1
```

---

## 3. Backblaze B2 & Cloudflare CDN Setup

### Step 1: Backblaze B2 Bucket
1. Log in to [Backblaze B2 Console](https://secure.backblaze.com/b2_buckets.htm).
2. Create a bucket (e.g., `webinar-recordings-prod`).
3. Set bucket access to **Public** (files will be served via Cloudflare CDN).
4. Create an Application Key scoped to this bucket with `readFiles`, `writeFiles`, `deleteFiles`, and `listFiles`.
   - Note the `keyID` (`RECORDINGS_S3_ACCESS_KEY`) and `applicationKey` (`RECORDINGS_S3_SECRET_KEY`).
   - Endpoint: `https://s3.<region>.backblazeb2.com` (e.g., `https://s3.us-east-005.backblazeb2.com`).

### Step 2: Cloudflare CDN Subdomain
1. In Cloudflare DNS for `webinarliv.com`, create a CNAME record:
   - **Type:** `CNAME`
   - **Name:** `recordings`
   - **Target:** `s3.<region>.backblazeb2.com` (or `<bucket-name>.s3.<region>.backblazeb2.com`)
   - **Proxy Status:** **Proxied (Orange Cloud ON)**
2. In Cloudflare **Rules** -> **Transform Rules** -> **Rewrite URL**:
   - Match: `Hostname equals recordings.webinarliv.com`
   - Rewrite path: Prepend `/<RECORDINGS_S3_BUCKET>` (e.g., `/webinar-recordings-prod` + `http.request.uri.path`)
   - This allows URLs like `https://recordings.webinarliv.com/webinars/...` to map cleanly to `https://s3.<region>.backblazeb2.com/webinar-recordings-prod/webinars/...`.
3. In Cloudflare **Caching** -> **Cache Rules**:
   - Match: `Hostname equals recordings.webinarliv.com`
   - Cache Eligibility: **Cache Everything**
   - Edge Cache TTL: **1 month** (recordings are immutable once finalized).
4. **Bandwidth Alliance:** Because Cloudflare and Backblaze are Bandwidth Alliance partners, all egress traffic from Backblaze B2 through Cloudflare CDN is **100% free** ($0/GB egress).

---

## 4. Cloud Run & GitHub Secrets Configuration

Ensure the following secrets are configured in GitHub Actions (Repository Settings -> Secrets -> Actions):

| Secret Name | Value Example | Description |
| :--- | :--- | :--- |
| `RECORDINGS_ENABLED` | `true` | Enables recording features |
| `RECORDINGS_BACKEND` | `s3` | S3-compatible backend (Backblaze B2) |
| `RECORDINGS_MODE` | `egress` | Server-side recording via LiveKit Egress |
| `RECORDINGS_S3_BUCKET` | `webinar-recordings-prod` | Backblaze B2 bucket name |
| `RECORDINGS_S3_ENDPOINT` | `https://s3.us-east-005.backblazeb2.com` | Backblaze B2 S3 endpoint |
| `RECORDINGS_S3_REGION` | `us-east-005` | Backblaze B2 region |
| `RECORDINGS_S3_ACCESS_KEY` | `005...` | Scoped Application Key ID |
| `RECORDINGS_S3_SECRET_KEY` | `K005...` | Scoped Application Key Secret |
| `RECORDINGS_EGRESS_TEMPLATE_URL` | `https://webinarliv.com/recorder-template` | Zoom-style recording template |
| `RECORDINGS_EGRESS_PRESET` | `1080p` | `1080p` (default) or `720p` |
| `RECORDINGS_CDN_BASE_URL` | `https://recordings.webinarliv.com` | Cloudflare CDN endpoint |

---

## 5. Verification Checklist

1. **Start Webinar & Recording:**
   - Join webinar as host or panelist.
   - Click **Record** -> Select **The cloud** (notes: "Recorded server-side directly to Backblaze B2 cloud storage. Zero extra upload bandwidth or CPU on your device").
   - Confirm the REC indicator appears for all participants.
   - Check `docker logs -f livekit-egress-1` on Hetzner: confirm Chromium launches and loads `https://webinarliv.com/recorder-template`.
2. **Present Content & Speakers:**
   - Share a screen/tab: verify the template renders the screen share on the left (78%) and speakers on the right (22%) with active speaker highlight and nameplates.
   - Stop screen share: verify template transitions smoothly to centered active speaker.
3. **Stop Recording & Webhook:**
   - Click **Stop** on recording button.
   - Confirm LiveKit sends `EGRESS_ENDED` webhook to `/api/webhooks/livekit`.
   - Verify row in `recordings` updates to status `ready` with correct size and duration.
4. **Download & CDN Playback:**
   - Go to Webinar Dashboard -> Recordings.
   - Click Download or Play: verify network inspector shows `307 Temporary Redirect` to `https://recordings.webinarliv.com/...`.
   - Verify video plays smoothly and response headers contain `cf-cache-status: HIT` on subsequent requests.
