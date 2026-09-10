# The frontend, as a self-contained Node server.
#
# Three stages so the runtime image carries neither the build toolchain nor a
# node_modules tree: `output: "standalone"` in next.config.ts makes Next trace the
# modules actually reached and emit a server that needs nothing else.

# See api/Dockerfile: Docker Hub is not always reachable from every network, and
# ECR Public mirrors the same official images.
ARG BASE_REGISTRY=docker.io/library

FROM ${BASE_REGISTRY}/node:22-alpine AS deps
WORKDIR /app
# Only the manifests, so this layer is cached until a dependency actually changes.
COPY package.json package-lock.json ./
RUN npm ci

FROM ${BASE_REGISTRY}/node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_ values are inlined into the browser bundle at build time, so this
# is a build argument and not a runtime one.
#
# Empty by default, and that is the point: the browser then requests /api/... from
# whatever origin served the page, so this image works for any hostname. Set it
# only if the API lives somewhere the page did not come from.
ARG NEXT_PUBLIC_API_BASE=""
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE

# Mount point, when the app is not served from the root of its hostname. Next
# rewrites every asset and route path against this, so it is build-time too — and
# it has to match NEXT_PUBLIC_API_BASE above. See web/next.config.ts.
ARG BASE_PATH=""
ENV BASE_PATH=$BASE_PATH

ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

FROM ${BASE_REGISTRY}/node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Runs as the node user (uid 1000) rather than root. Nothing here needs to write.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

USER node
EXPOSE 3000

# server.js is what standalone output emits; `next start` is not used here and
# node_modules is not present for it to run from.
CMD ["node", "server.js"]
