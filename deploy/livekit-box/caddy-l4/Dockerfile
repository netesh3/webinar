# Caddy with the layer4 app (github.com/mholt/caddy-l4), for TURN over TLS on :443
# (TURN_TLS_443=true in .env; see docker-compose.turn443.yml and Caddyfile.turn443).
# Built on the box by redeploy.sh; the stock caddy:2-alpine image is used otherwise.
ARG CADDY_VERSION=2.11
FROM caddy:${CADDY_VERSION}-builder-alpine AS builder
ARG CADDY_L4_VERSION=v0.1.2
RUN xcaddy build --with github.com/mholt/caddy-l4@${CADDY_L4_VERSION}

FROM caddy:${CADDY_VERSION}-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
