#!/usr/bin/env bash
# Temporary Webcast deployment into an existing EKS cluster, mounted on a path of a
# hostname another application already owns.
#
#   ./k8s/deploy.sh preflight    # look, change nothing — run this first
#   ./k8s/deploy.sh up           # build amd64 images, push, deploy, add routes
#   ./k8s/deploy.sh status       # what is running
#   ./k8s/deploy.sh logs api     # follow a component
#   ./k8s/deploy.sh down         # remove the routes, then everything else
#
# Everything it creates is named `webcast-*` and labelled
# `app.kubernetes.io/part-of=webcast-temp`, so `down` is one selector and the shared
# namespace it lands in is never at risk.
#
# Three things are worth knowing before running `up`:
#   - It edits one object it does not own: the VirtualService that currently serves
#     the hostname. Istio merges VirtualServices for a host in creation order and
#     that one ends in a catch-all, so a separate object of ours would never match.
#     The edit is a prepend of three named routes, backed up first, and `down`
#     removes exactly those. See istio.py.
#   - Storage is emptyDir. Losing a pod loses the accounts and any recording.
#   - It creates an internet-facing NLB for WebRTC media, because an HTTP ingress
#     cannot carry RTP. That is the one resource with an hourly cost.
set -euo pipefail

# ------------------------------------------------------------------ settings

CLUSTER=${CLUSTER:-agent-fabric-dev}
REGION=${REGION:-us-east-1}
ACCOUNT=${ACCOUNT:-253155928537}
NS=${NS:-platform}
HOST=${HOST:-dev.agentfabric.platformbmc.com}

# The mount point. Baked into the web image as Next's basePath, so changing it
# means a rebuild — `up` handles that, but it is not a free switch.
BASE_PATH=${BASE_PATH:-/platform/webcast}

# The single public subnet the media NLB lives in. One subnet means one address,
# which is the only arrangement that works when the SFU can advertise exactly one
# — see the long note in 00-media-lb.yaml. Defaults to the AZ of whichever node the
# SFU lands on, resolved at deploy time.
MEDIA_SUBNET=${MEDIA_SUBNET:-}

ECR_REPO=${ECR_REPO:-webcast-temp}
CTX=${CTX:-webcast-$CLUSTER}

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
SECRETS=$HERE/.secrets.env
RENDER=$HERE/.rendered
BACKUP=$HERE/.backup

SELECTOR=app.kubernetes.io/part-of=webcast-temp
REGISTRY=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com

# ECR Public mirrors the official base images; Docker Hub has refused manifests
# from this network before. See api/Dockerfile.
BASE_REGISTRY=${BASE_REGISTRY:-public.ecr.aws/docker/library}

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
warn() { printf '\033[33m   ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m\nerror: %s\033[0m\n' "$*" >&2; exit 1; }

k()  { kubectl --context "$CTX" -n "$NS" "$@"; }
kc() { kubectl --context "$CTX" "$@"; }

# ------------------------------------------------------------------ preflight

need_tools() {
  for t in aws kubectl docker dig python3; do
    command -v "$t" >/dev/null || die "$t is not on PATH"
  done
  python3 -c 'import yaml' 2>/dev/null || die "istio.py needs PyYAML: pip3 install pyyaml"
  docker info >/dev/null 2>&1 || die "docker is not running"
}

need_aws() {
  aws sts get-caller-identity >/dev/null 2>&1 ||
    die "no AWS credentials. Log in first, in your own shell:
       aws sso login
     then re-run this."
  local have
  have=$(aws sts get-caller-identity --query Account --output text)
  [ "$have" = "$ACCOUNT" ] ||
    die "credentials are for account $have, expected $ACCOUNT"
}

need_kubeconfig() {
  kubectl config get-contexts "$CTX" >/dev/null 2>&1 || {
    say "Adding kubeconfig context $CTX"
    # --alias names the context so teardown can delete exactly ours. It does NOT
    # leave the previous selection alone, though: update-kubeconfig makes the new
    # context current. Save the old one so `down` can put it back.
    kubectl config current-context > "$HERE/.prev-context" 2>/dev/null || true
    aws eks update-kubeconfig --name "$CLUSTER" --region "$REGION" --alias "$CTX" >/dev/null
  }
  kc get ns >/dev/null 2>&1 || die "cannot reach the cluster as $CTX"
}

# find_vs prints "namespace name" for each VirtualService that serves $HOST, most
# specific first. See istio.py, which is tested — istio_test.py.
find_vs() {
  kc get virtualservice -A -o json 2>/dev/null | python3 "$HERE/istio.py" find "$HOST"
}

preflight() {
  need_tools
  need_aws
  need_kubeconfig

  say "Cluster"
  kc version -o json 2>/dev/null | sed -n 's/.*"gitVersion": "\(v[^"]*\)".*/   server \1/p' | tail -1
  note "namespace $NS: $(k get ns "$NS" -o name 2>/dev/null || echo 'MISSING')"

  say "Pod Security admission on $NS"
  k get ns "$NS" -o jsonpath='{.metadata.labels}' | tr ',' '\n' | grep -i 'pod-security' ||
    note "none — no restrictions to satisfy"

  say "Sidecar injection on $NS"
  k get ns "$NS" -o jsonpath='{.metadata.labels}' | tr ',' '\n' | grep -iE 'istio|revision' ||
    note "not labelled for injection"
  note "our pods opt out either way (sidecar.istio.io/inject=false)"

  say "mTLS policy that could reach our services"
  kc get peerauthentication -A 2>/dev/null || note "no PeerAuthentication objects"
  kc get destinationrule -A -o json 2>/dev/null | python3 "$HERE/istio.py" mtls
  note "20-istio.yaml sets tls DISABLE for our three services, which is why a"
  note "wildcard ISTIO_MUTUAL rule above would still be survivable"

  say "The VirtualService serving $HOST"
  local vs; vs=$(find_vs)
  [ -n "$vs" ] || die "no VirtualService claims $HOST. Nothing to splice routes into —
     the routing for this hostname is somewhere else, and 20-routes.yaml will not apply."
  printf '%s\n' "$vs" | while read -r vns vname; do
    note "$vns/$vname"
    kc -n "$vns" get virtualservice "$vname" -o json | python3 "$HERE/istio.py" show
  done

  say "Load balancer controller (needed for the media NLB)"
  kc get deploy -A -o name 2>/dev/null | grep -i 'load-balancer-controller' ||
    warn "AWS Load Balancer Controller not found.
     Without it, type=LoadBalancer gives an in-tree CLB, which cannot do UDP —
     media would be TCP-only. Workable but worse."

  say "Public subnets the media NLB can land in"
  # The controller picks subnets tagged for internet-facing load balancers. Untagged
  # is the usual reason a Service stays <pending> forever with no useful event.
  local vpc subnets
  vpc=$(aws eks describe-cluster --name "$CLUSTER" --region "$REGION" \
    --query 'cluster.resourcesVpcConfig.vpcId' --output text 2>/dev/null || true)
  if [ -n "$vpc" ] && [ "$vpc" != None ]; then
    note "vpc $vpc"
    subnets=$(aws ec2 describe-subnets --region "$REGION" \
      --filters "Name=vpc-id,Values=$vpc" "Name=tag:kubernetes.io/role/elb,Values=1" \
      --query 'Subnets[].[SubnetId,AvailabilityZone]' --output text 2>/dev/null || true)
    if [ -n "$subnets" ]; then
      printf '%s\n' "$subnets" | sed 's/^/   /'
    else
      warn "no subnet tagged kubernetes.io/role/elb=1.
     The media NLB will not provision, and WebRTC has no path in. Either tag the
     public subnets or set the subnets explicitly on webcast-livekit-media with
     service.beta.kubernetes.io/aws-load-balancer-subnets."
    fi
  else
    warn "could not read the cluster VPC — skipping the subnet check"
  fi

  say "Name collisions in $NS"
  if k get all,secret,configmap,destinationrule -o name 2>/dev/null | grep -E '(^|/)webcast'; then
    warn "existing webcast-* objects, listed above — 'up' will adopt or replace them"
  else
    note "none"
  fi

  say "Preflight done. Nothing was changed."
}

# ------------------------------------------------------------------ secrets

# Generated once and kept locally so a re-run does not invalidate every session
# cookie and orphan the database password.
load_secrets() {
  if [ ! -f "$SECRETS" ]; then
    say "Generating secrets -> ${SECRETS/#$ROOT\//}"
    umask 077
    {
      echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)"
      echo "SESSION_SECRET=$(openssl rand -hex 32)"
      echo "LIVEKIT_API_SECRET=$(openssl rand -hex 32)"
    } > "$SECRETS"
    note "gitignored. Delete it to rotate everything on the next up."
  fi
  # shellcheck disable=SC1090
  set -a; . "$SECRETS"; set +a
}

apply_secret() {
  k create secret generic webcast \
    --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    --from-literal=SESSION_SECRET="$SESSION_SECRET" \
    --from-literal=LIVEKIT_API_SECRET="$LIVEKIT_API_SECRET" \
    --from-literal=DATABASE_URL="postgres://webcast:$POSTGRES_PASSWORD@webcast-postgres:5432/webcast?sslmode=disable" \
    --from-literal=LIVEKIT_KEYS="webcast: $LIVEKIT_API_SECRET" \
    --dry-run=client -o yaml |
    k apply -f - >/dev/null
  # Labelled in a second call rather than with `kubectl label --local`, which is
  # deprecated and would take the teardown selector with it when it goes.
  k label secret webcast "$SELECTOR" --overwrite >/dev/null
  note "secret/webcast"
}

# ------------------------------------------------------------------ images

build_and_push() {
  local tag=$1
  say "Building linux/amd64 images"
  # The frontend needs both values at build time: basePath rewrites every asset
  # URL, and NEXT_PUBLIC_API_BASE is inlined into the browser bundle. Same value —
  # the API lives under the app's own mount.
  docker build --platform linux/amd64 \
    --build-arg BASE_REGISTRY="$BASE_REGISTRY" \
    --build-arg BASE_PATH="$BASE_PATH" \
    --build-arg NEXT_PUBLIC_API_BASE="$BASE_PATH" \
    -t "$REGISTRY/$ECR_REPO:web-$tag" "$ROOT/web"
  docker build --platform linux/amd64 \
    --build-arg BASE_REGISTRY="$BASE_REGISTRY" \
    -t "$REGISTRY/$ECR_REPO:api-$tag" "$ROOT/api"

  say "Pushing to ECR"
  aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" >/dev/null 2>&1 ||
    aws ecr create-repository --repository-name "$ECR_REPO" --region "$REGION" \
      --image-tag-mutability MUTABLE >/dev/null
  aws ecr get-login-password --region "$REGION" |
    docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
  docker push "$REGISTRY/$ECR_REPO:web-$tag"
  docker push "$REGISTRY/$ECR_REPO:api-$tag"
}

# ------------------------------------------------------------------ media address

# The SFU must advertise an address browsers can reach. Create the Service first,
# with no pods behind it, and wait for AWS to assign one.
media_ip() {
  [ -n "$MEDIA_SUBNET" ] || die "MEDIA_SUBNET is not set. Pick one public subnet:
     aws ec2 describe-subnets --region $REGION \\
       --filters Name=tag:kubernetes.io/role/elb,Values=1 \\
       --query 'Subnets[].[SubnetId,AvailabilityZone]' --output text"
  mkdir -p "$RENDER"
  sed -e "s|__MEDIA_SUBNET__|$MEDIA_SUBNET|g" \
      "$HERE/00-media-lb.yaml" > "$RENDER/00-media-lb.yaml"
  k apply -f "$RENDER/00-media-lb.yaml" >/dev/null

  local addr="" i
  for i in $(seq 1 60); do
    addr=$(k get svc webcast-livekit-media \
      -o jsonpath='{.status.loadBalancer.ingress[0].hostname}{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
    [ -n "$addr" ] && break
    sleep 5
  done
  [ -n "$addr" ] || die "the media load balancer never got an address.
     'kubectl describe svc webcast-livekit-media -n $NS' will say why — usually a
     missing AWS Load Balancer Controller or unlabelled public subnets."

  # An IP already? Use it. A DNS name (NLB) resolves to one address per zone, and
  # cross-zone load balancing is on, so any single one of them reaches the pod.
  if [[ $addr =~ ^[0-9.]+$ ]]; then
    echo "$addr"; return
  fi
  local ip
  for i in $(seq 1 60); do
    ip=$(dig +short "$addr" A | grep -E '^[0-9.]+$' | head -1 || true)
    [ -n "$ip" ] && { echo "$ip"; return; }
    sleep 5
  done
  die "$addr never resolved"
}

# ------------------------------------------------------------------ render

render() {
  local tag=$1 ip=$2
  mkdir -p "$RENDER"
  local hash
  hash=$(printf '%s' "$ip" | shasum | cut -c1-12)

  sed -e "s|__MEDIA_IP__|$ip|g" \
      -e "s|__LIVEKIT_CONFIG_HASH__|$hash|g" \
      -e "s|__IMAGE_API__|$REGISTRY/$ECR_REPO:api-$tag|g" \
      -e "s|__IMAGE_WEB__|$REGISTRY/$ECR_REPO:web-$tag|g" \
      -e "s|__HOST__|$HOST|g" \
      -e "s|__BASE_PATH__|$BASE_PATH|g" \
      -e "s|namespace: platform|namespace: $NS|g" \
      "$HERE/10-webcast.yaml" > "$RENDER/10-webcast.yaml"

  for f in 20-istio 20-routes; do
    sed -e "s|__NS__|$NS|g" -e "s|__BASE_PATH__|$BASE_PATH|g" \
        "$HERE/$f.yaml" > "$RENDER/$f.yaml"
  done
}

# ------------------------------------------------------------------ routes

# The one edit to an object we do not own. Backed up first; `down` reverses it.
# The merge itself is istio.py, which has tests.
splice_routes() {
  local op=$1 vns vname
  read -r vns vname <<<"$(find_vs | head -1)"
  [ -n "${vname:-}" ] || die "no VirtualService claims $HOST — run preflight"

  if [ "$op" = add ]; then
    mkdir -p "$BACKUP"
    local at; at=$(date +%Y%m%d%H%M%S)
    kc -n "$vns" get virtualservice "$vname" -o yaml > "$BACKUP/$vns-$vname-$at.yaml"
    note "backed up $vns/$vname -> ${BACKUP/#$ROOT\//}/$vns-$vname-$at.yaml"
  fi

  local args=("$op")
  if [ "$op" = add ]; then
    # Rendered on demand, so `deploy.sh routes add` works on its own after a
    # GitOps sync has reverted us, without rebuilding an image to get there.
    mkdir -p "$RENDER"
    sed -e "s|__NS__|$NS|g" -e "s|__BASE_PATH__|$BASE_PATH|g" \
        "$HERE/20-routes.yaml" > "$RENDER/20-routes.yaml"
    args+=("$RENDER/20-routes.yaml")
  fi

  kc -n "$vns" get virtualservice "$vname" -o json |
    python3 "$HERE/istio.py" "${args[@]}" |
    kc -n "$vns" replace -f - >/dev/null
  note "$vns/$vname updated"
}

# ------------------------------------------------------------------ up

up() {
  need_tools; need_aws; need_kubeconfig

  # Fail before building anything if the object we have to edit is not there.
  local vs; vs=$(find_vs | head -1)
  [ -n "$vs" ] || die "no VirtualService claims $HOST. Run 'preflight' and read what is there."
  note "will add routes to VirtualService $vs"

  local tag; tag=$(date +%Y%m%d%H%M%S)
  load_secrets
  build_and_push "$tag"

  say "Reserving the media address"
  local ip; ip=$(media_ip)
  note "SFU will advertise $ip"

  say "Deploying"
  apply_secret
  render "$tag" "$ip"
  k apply -f "$RENDER/10-webcast.yaml"
  k apply -f "$RENDER/20-istio.yaml"

  say "Waiting for rollout"
  local d
  for d in webcast-postgres webcast-livekit webcast-api webcast-web; do
    k rollout status "deploy/$d" --timeout=5m
  done

  # Routes last, so the hostname never points at pods that are not ready yet.
  say "Adding routes to the existing VirtualService"
  splice_routes add

  say "Up"
  note "open   https://$HOST$BASE_PATH"
  note "host   https://$HOST$BASE_PATH/signup?host=1"
  note "media  $ip  (7881/tcp, 7882/udp)"
  note "down   ./k8s/deploy.sh down"
}

# ------------------------------------------------------------------ the rest

status() {
  need_kubeconfig
  k get deploy,pod,svc -l "$SELECTOR"
  say "Routes on the shared VirtualService"
  local vns vname
  read -r vns vname <<<"$(find_vs | head -1)"
  kc -n "$vns" get virtualservice "$vname" \
    -o jsonpath='{range .spec.http[*]}{.name}{"\t"}{.match[0].uri.prefix}{"\t"}{.route[0].destination.host}{"\n"}{end}' |
    sed 's/^/   /'
  say "Media address the SFU is advertising"
  k get cm webcast-livekit -o jsonpath='{.data.livekit\.yaml}' | grep node_ip || true
}

logs() { need_kubeconfig; k logs -f "-l app.kubernetes.io/name=${1:-api},$SELECTOR" --tail=100; }

down() {
  need_kubeconfig
  # Routes first: stop sending traffic before deleting what serves it.
  say "Removing our routes from the shared VirtualService"
  splice_routes remove || warn "could not remove the routes — check ${BACKUP/#$ROOT\//} and do it by hand"

  say "Deleting every webcast-temp object in $NS"
  k delete svc,deploy,cm,secret,destinationrule -l "$SELECTOR" --ignore-not-found

  if aws sts get-caller-identity >/dev/null 2>&1 &&
     aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" >/dev/null 2>&1; then
    say "Deleting ECR repository $ECR_REPO"
    aws ecr delete-repository --repository-name "$ECR_REPO" --region "$REGION" --force >/dev/null
  fi
  rm -rf "$RENDER"

  # Put the kubeconfig back the way it was found. Deleting the active context leaves
  # kubectl with none selected, which breaks the next unrelated command somebody runs.
  if kubectl config get-contexts "$CTX" >/dev/null 2>&1; then
    kubectl config delete-context "$CTX" >/dev/null 2>&1 || true
    if [ -s "$HERE/.prev-context" ]; then
      kubectl config use-context "$(cat "$HERE/.prev-context")" >/dev/null 2>&1 || true
      note "restored kubectl context $(cat "$HERE/.prev-context")"
    fi
    rm -f "$HERE/.prev-context"
  fi

  say "Gone. Kept: $SECRETS, and the VirtualService backups in ${BACKUP/#$ROOT\//}."
}

case "${1:-}" in
  preflight) preflight ;;
  up)        up ;;
  status)    status ;;
  logs)      logs "${2:-api}" ;;
  routes)    need_kubeconfig; splice_routes "${2:?add or remove}" ;;
  down)      down ;;
  *) die "usage: $0 {preflight|up|status|logs [api|web|livekit|postgres]|routes {add|remove}|down}" ;;
esac
