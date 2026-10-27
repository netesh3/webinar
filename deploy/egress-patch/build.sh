#!/usr/bin/env bash
# Build the patched Egress image from the upstream tag, using Egress's own Dockerfile.
#   build.sh <egress-version> <image-tag> [--push]
# Needs Docker with buildx. Run by .github/workflows/egress-image.yml.
set -euo pipefail
version="${1:?egress version, e.g. v1.15.0}"
tag="${2:?image tag, e.g. ghcr.io/netesh3/webinar-egress:v1.15.0-zl1}"
push="${3:-}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git clone -q --depth 1 --branch "$version" https://github.com/livekit/egress.git "$work/egress"
cd "$work/egress"
git apply --check "$here/x264-zerolatency.patch"
git apply "$here/x264-zerolatency.patch"
gst="$(cat .gst-version)"
args=(buildx build --platform linux/amd64 --build-arg "GSTVERSION=${gst}" -f build/egress/Dockerfile -t "$tag" --provenance=true .)
if [[ "$push" == "--push" ]]; then args+=(--push); else args+=(--load); fi
docker "${args[@]}"
echo "built $tag (egress $version, gstreamer $gst, x264 zero-latency patch)"
