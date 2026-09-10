# Temporary deployment: EKS `agent-fabric-dev`

A throwaway Webcast in the `platform` namespace of an existing cluster, mounted at
`https://dev.agentfabric.platformbmc.com/platform/webcast` — enough to test from
three laptops on three networks, and removable in one command.

```bash
aws sso login                 # in your own shell; the script cannot do this for you
./k8s/deploy.sh preflight     # reads the cluster, changes nothing
./k8s/deploy.sh up            # build amd64, push to a temp ECR repo, deploy, add routes
./k8s/deploy.sh down          # take the routes out, delete everything, drop the ECR repo
```

`preflight` is not a formality — it answers the questions this deployment depends on
and cannot assume. Read its output before running `up`.

## What that hostname already is

Worth knowing, because it shapes everything below. `dev.agentfabric.platformbmc.com`
is an ALB in front of an Istio ingress gateway, and **every path on it already
returns the BMC Orchestration Platform login page** — `/`, `/platform/`,
`/zzz-nonexistent`, all the same 834-byte `index.html`. It is a Vite SPA with a
catch-all route; its client-side router doesn't recognise `/platform/webcast`, so
before this is deployed that URL shows a login form. TLS is a wildcard ACM
certificate (`*.agentfabric.platformbmc.com`), so nothing here needs cert-manager.

## The one thing this changes that it does not own

Istio merges VirtualServices for a host in creation-timestamp order, first match
wins. The existing VirtualService for this hostname ends in a catch-all `/`, so a
new VirtualService of ours — being newer — would sit entirely behind it and never
match a single request. There is no annotation that fixes this.

So `deploy.sh` **prepends three routes to the existing VirtualService**. What keeps
that safe:

| | |
|---|---|
| Backed up first | `k8s/.backup/<ns>-<name>-<timestamp>.yaml`, before any edit |
| Every route is named `webcast-*` | which is how `remove` finds exactly its own work |
| Idempotent | both operations start by dropping every `webcast-*` route present |
| Nothing else is touched | only `spec.http`; hosts, gateways and other routes are untouched |
| Optimistic concurrency | `resourceVersion` is kept, so a concurrent edit by the owner fails loudly instead of being clobbered |
| Tested | `python3 k8s/istio_test.py` — 25 checks, including that the catch-all keeps its place and that `remove` is an exact inverse of `add` |

`preflight` also reports whether that object is managed by Helm, Argo CD or Flux. If
it is, a GitOps sync will revert the routes; `./k8s/deploy.sh routes add` puts them
back without rebuilding anything.

## Why it is shaped this way

**Signalling goes through the gateway; media cannot.** The SFU's control channel is
a WebSocket, so it rides the existing hostname like any other HTTP route. Media is
RTP over UDP, and a reverse proxy has no way to carry it. The nodes here are on
private subnets, so a browser on the internet has no route to a pod at all.
`00-media-lb.yaml` is that route: an internet-facing NLB on 7881/tcp and 7882/udp.
The `k8s-`-prefixed ALB name confirms the AWS Load Balancer Controller is installed,
which is what makes the UDP listener possible.

**The SFU has to advertise the NLB's address.** `use_external_ip: true` — correct on
a VPS — is actively wrong here: STUN would return the NAT gateway's address, which
accepts nothing inbound. Candidates never pair and the symptom is a call that
connects and then shows black video. So `deploy.sh` creates the Service first, with
no pods behind it, waits for AWS to assign an address, and renders it into
`node_ip`. An NLB has one address per zone and the SFU can only name one, which is
why cross-zone load balancing is switched on.

**Nothing joins the mesh.** All four pods set `sidecar.istio.io/inject: "false"`. For
the SFU that is load-bearing rather than tidiness: a sidecar would intercept inbound
TCP 7881, which is ICE/TCP media arriving straight from a browser, and under STRICT
mTLS it would reject it — so the corporate attendees who can only reach us over TCP
would fail while everyone on UDP worked. `20-istio.yaml` is the other half: three
DestinationRules with `tls: DISABLE`, so a mesh-wide `ISTIO_MUTUAL` rule cannot make
the gateway attempt mTLS against a pod with nothing to terminate it.

**The mount path is a build-time fact.** Next rewrites every asset URL, `<Link>` and
router path against `basePath`, so `/platform/webcast` is baked into the image
(`BASE_PATH` build arg → `web/next.config.ts`). Two values must agree with it:

```
NEXT_PUBLIC_API_BASE=/platform/webcast                                    # browser fetches
WEB_BASE_URL=https://dev.agentfabric.platformbmc.com/platform/webcast     # share links
```

Verified on the built amd64 image: `/` is 404, `/platform/webcast` and
`/platform/webcast/login` are 200, and `…/_next/static/…` assets resolve.

**Three routes, and they want three different things done to the URL.**

```
/platform/webcast/sfu/  ->  webcast-livekit:7880  rewrite /      (WebSocket, no timeout)
/platform/webcast/api   ->  webcast-api:8080      rewrite /api
/platform/webcast       ->  webcast-web:3000      no rewrite
```

The trailing slashes are load-bearing. Envoy swaps the *matched prefix* for the
rewrite value, so matching `…/sfu` and rewriting to `/` would yield `//rtc/v1`;
matching `…/sfu/` yields `/rtc/v1`. The API pair has no trailing slash on either
side for the same reason in reverse. The SFU path works at all because the LiveKit
client SDK *appends* `/rtc/v1` to whatever pathname it is given rather than
replacing it — see `appendUrlPath` in `livekit-client`.

**Two response headers are overridden on the frontend route**, and one of them is
the difference between a working webinar and a dead one. Responses on this hostname
carry `permissions-policy: geolocation=(), camera=(), microphone=()`. An empty
allowlist does not mean "prompt the user", it means the feature is denied to the
document — `getUserMedia` would reject with `NotAllowedError` and nobody could ever
speak. The evidence says that header comes from the SPA's own static server rather
than the gateway (its sibling CSP whitelists exactly the Google Fonts that one page
loads, which is not something a host-wide filter would do), so a different upstream
should never see it — but setting it explicitly costs nothing and removes the doubt.
The inherited CSP would also block Next's inline hydration scripts, so that is
replaced with the same policy widened to what this app actually uses.

## What is temporary about it

| | |
|---|---|
| **Storage is `emptyDir`** | Accounts, webinars and recordings live as long as the pod. A node drain loses them. Download any recording worth keeping before `down`. |
| **One replica of everything** | Rate limiting is in-memory and recordings are written to the API pod's own disk, so a second replica would be wrong, not just redundant. |
| **Everything is labelled** | `app.kubernetes.io/part-of=webcast-temp`, and named `webcast-*`. That is what makes `down` safe in a namespace that already runs `identity-*` and `odin-*`. |
| **The ECR repo is created and deleted** | `webcast-temp`, one repository, two tags per build. |
| **One resource costs money by the hour** | The media NLB. Nothing else is chargeable beyond node capacity. |

## What preflight is checking

- **The VirtualService serving the hostname** — which one, its full route table, and
  whether a GitOps controller owns it.
- **Pod Security admission on `platform`.** Everything here runs non-root with `ALL`
  capabilities dropped, which satisfies `restricted`; Postgres as uid 999 on an
  `emptyDir` is the pod most likely to be refused.
- **PeerAuthentication and wildcard DestinationRules**, i.e. whether mTLS would be
  forced onto services whose pods have no sidecar.
- **The AWS Load Balancer Controller**, without which `type: LoadBalancer` yields an
  in-tree CLB that cannot do UDP and media falls back to ICE/TCP only.
- **Anything already named `webcast-*`** in the namespace.

## Operating it

```bash
./k8s/deploy.sh status          # pods, services, our routes, the advertised media IP
./k8s/deploy.sh logs api        # or web, livekit, postgres
./k8s/deploy.sh up              # redeploy; rebuilds and rolls with a fresh tag
./k8s/deploy.sh routes add      # re-add the routes after a GitOps sync removed them
```

Secrets are generated once into `k8s/.secrets.env` (gitignored) and reused, so a
redeploy does not invalidate every session cookie or orphan the database password.
Delete that file to rotate everything on the next `up`.

## Testing from three laptops

1. Laptop 1: `…/platform/webcast/signup?host=1`, schedule a webinar, start it.
2. Laptops 2 and 3: open the registration link the host page shows, register, join.
   They arrive muted and cannot unmute themselves — that is the design.
3. Raise a hand on laptop 2. Allow it from laptop 1. Unmute on laptop 2.
4. Mute laptop 2 from the host roster and confirm it cannot unmute again until the
   host allows it.
5. Share a screen from laptop 1 and confirm both others see it.
6. Press **Record** on laptop 1, stop it, and download the file from the webinar's
   Recordings tab.

Step 5 is the one that exercises the media path. If the room connects and video
stays black, the NLB is where to look — `status` prints the address the SFU is
handing out, and it has to be the NLB's.

If a browser refuses the microphone before any of this, that is the
`permissions-policy` question above, and it means the header is gateway-level after
all rather than the SPA's. The fix is then an `EnvoyFilter` at the gateway, or
moving to a subdomain of its own.

## Then close the door

`SIGNUP_OPEN` is `true` so accounts can be made, on a public hostname. Once the
three test accounts exist:

```bash
kubectl --context webcast-agent-fabric-dev -n platform \
  set env deploy/webcast-api SIGNUP_OPEN=false
```
