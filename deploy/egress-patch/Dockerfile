# LiveKit Egress with a zero-latency x264 switch for the live mix (docs/edge-delivery.md).
#
# Stock Egress v1.15.0 never sets x264enc's `tune`, so the live mix encodes with x264's preset
# defaults: 3 B-frames, a 10-frame lookahead with mb-tree, sync-lookahead and frame threads,
# ~15–20 frames (~0.75–1 s at 20 fps) held inside the encoder. x264-zerolatency.patch adds
# `tune=zerolatency` (no B-frames, no lookahead, sliced threads) for stream-only egresses when
# EGRESS_X264_ZEROLATENCY=true, so the image can be rolled back without a rebuild.
#
# Not built directly: build.sh clones the tag, applies the patch and builds with Egress's own
# build/egress/Dockerfile (GStreamer from .gst-version, 1.24.13 for v1.15.0). This file only
# checks that the patch applies (`docker build --target source .`).
#
# Built by .github/workflows/egress-image.yml; the box uses it when the repo variable
# EGRESS_IMAGE names it (deploy/livekit-box/docker-compose.egress.yml).
ARG EGRESS_VERSION=v1.15.0
ARG GSTVERSION=1.24.13

FROM alpine/git:latest AS source
ARG EGRESS_VERSION
WORKDIR /src
RUN git clone --depth 1 --branch "${EGRESS_VERSION}" https://github.com/livekit/egress.git .
COPY x264-zerolatency.patch /tmp/
RUN git apply --check /tmp/x264-zerolatency.patch && git apply /tmp/x264-zerolatency.patch

# The rest is Egress's own build (build/egress/Dockerfile), unchanged, on the patched tree.
FROM source AS patched
