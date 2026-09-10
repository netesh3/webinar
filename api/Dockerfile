# Static binary in a distroless image: ~20 MB, no shell, no package manager,
# nothing to patch. This is the deployment-cost argument for Go, made concrete.

# Base images come from a configurable registry. Docker Hub has refused manifests
# from this network more than once (see docker-compose.yml), and ECR Public mirrors
# the same official images:
#
#   docker build --build-arg BASE_REGISTRY=public.ecr.aws/docker/library ./api
ARG BASE_REGISTRY=docker.io/library

FROM ${BASE_REGISTRY}/golang:1.27-alpine AS build
WORKDIR /src

# Cache the module download layer separately from the source.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# CGO off so the result is fully static; -trimpath and -s -w for a smaller,
# reproducible binary.
RUN CGO_ENABLED=0 GOOS=linux go build \
      -trimpath -ldflags='-s -w' \
      -o /out/webcast-api ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /
COPY --from=build /out/webcast-api /webcast-api

# Runs as uid 65532; nothing in the image is writable.
USER nonroot:nonroot
EXPOSE 8080

# Recordings are the one thing this service writes to disk, so they need a volume
# the container user can write to. The API checks this at startup and refuses to
# boot if it cannot — better than discovering it when somebody presses record.
# Mount it as uid 65532, or set RECORDINGS_ENABLED=false.
ENV RECORDINGS_DIR=/data/recordings
VOLUME ["/data/recordings"]

# Migrations are embedded in the binary, so the container cannot start against a
# schema it wasn't built for.
ENTRYPOINT ["/webcast-api"]
