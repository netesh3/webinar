SHELL := /bin/bash
.DEFAULT_GOAL := help

# Homebrew paths so `make` works from a GUI terminal with a thin PATH.
export PATH := /opt/homebrew/bin:/opt/homebrew/opt/postgresql@18/bin:$(PATH)

DB_URL      ?= postgres://webcast:webcast@localhost:5432/webcast?sslmode=disable
TEST_DB_URL ?= postgres://webcast:webcast@localhost:5432/webcast_test?sslmode=disable
LIVEKIT_BIN := infra/bin/livekit-server
LIVEKIT_VER := v1.13.6

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------- setup

.PHONY: setup
setup: db livekit-bin ## One-time local setup (databases + LiveKit binary)
	cd web && npm install

.PHONY: db
db: ## Start Postgres and create the databases
	brew services start postgresql@18
	@until pg_isready -h localhost -q; do sleep 1; done
	@psql -h localhost -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='webcast'" | grep -q 1 \
	  || psql -h localhost -d postgres -c "CREATE ROLE webcast LOGIN PASSWORD 'webcast' CREATEDB;"
	@psql -h localhost -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='webcast'" | grep -q 1 \
	  || psql -h localhost -d postgres -c "CREATE DATABASE webcast OWNER webcast;"
	@psql -h localhost -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='webcast_test'" | grep -q 1 \
	  || psql -h localhost -d postgres -c "CREATE DATABASE webcast_test OWNER webcast;"
	@echo "postgres ready"

$(LIVEKIT_BIN): ## Build LiveKit from source (no darwin release tarball exists)
	@mkdir -p infra/bin
	rm -rf /tmp/livekit-src
	git clone --depth 1 --branch $(LIVEKIT_VER) https://github.com/livekit/livekit.git /tmp/livekit-src
	cd /tmp/livekit-src && go build -o $(CURDIR)/$(LIVEKIT_BIN) ./cmd/server
	@$(LIVEKIT_BIN) --version

.PHONY: livekit-bin
livekit-bin: $(LIVEKIT_BIN) ## Ensure the LiveKit binary exists

# ---------------------------------------------------------------- run
# Four terminals. Nothing here daemonises, so Ctrl-C stops what you started.

.PHONY: livekit
livekit: $(LIVEKIT_BIN) ## Run the LiveKit SFU (terminal 1)
	$(LIVEKIT_BIN) --config infra/livekit.local.yaml --node-ip 127.0.0.1

.PHONY: api
api: ## Run the Go API (terminal 2)
	cd api && APP_ENV=development DATABASE_URL="$(DB_URL)" go run ./cmd/server

.PHONY: migrate
migrate: ## Apply embedded SQL migrations (override: make migrate DB_URL='postgres://…?sslmode=require')
	cd api && DATABASE_URL="$(DB_URL)" go run ./cmd/migrate

.PHONY: web
web: ## Run the Next.js frontend (terminal 3)
	cd web && npm run dev

.PHONY: tunnel
tunnel: ## Public HTTPS URL, needed to test camera/mic from a phone
	cloudflared tunnel --url http://localhost:3000

# ---------------------------------------------------------------- types

.PHONY: types
types: ## Regenerate web/lib/api-types.ts from the Go structs
	cd api && go run github.com/gzuidhof/tygo@latest generate
	@echo "regenerated web/lib/api-types.ts"

.PHONY: types-check
types-check: ## Fail if the generated types are stale (for CI)
	@cp web/lib/api-types.ts /tmp/api-types.before
	@$(MAKE) -s types
	@diff -q /tmp/api-types.before web/lib/api-types.ts \
	  || { echo "ERROR: api-types.ts is stale. Run 'make types' and commit."; exit 1; }
	@echo "generated types are up to date"

# ---------------------------------------------------------------- test

.PHONY: test
test: test-api test-web ## Run every test

.PHONY: test-api
test-api: ## Go unit + integration tests
	cd api && TEST_DATABASE_URL="$(TEST_DB_URL)" go test ./... -count=1

.PHONY: test-web
test-web: ## Typecheck, lint and unit-test the frontend
	cd web && npx tsc --noEmit && npx eslint .
	# Node runs the TypeScript directly, so there is no test runner and no build
	# step to keep in sync. The suite covers the stage layout's pure functions —
	# paging, sorting, filtering and the subscription budget — which is where the
	# 300-participant behaviour lives and the one place a browser cannot check it.
	cd web && node --experimental-strip-types --no-warnings lib/layout.test.mts
	# And the playout-delay readout, which reports a number to somebody who is
	# troubleshooting — where a plausible wrong number is worse than none.
	cd web && node --experimental-strip-types --no-warnings lib/network.test.mts
	# And the reconnection ladder, which cannot be tested in a browser at all: a real
	# media-path failure is not injectable, so this is the only check it gets.
	cd web && node --experimental-strip-types --no-warnings lib/recovery.test.mts
	# And route-level access control, where both failure directions are silent: a
	# participant reading a registrant list, or a panelist locked out of their own stage.
	cd web && node --experimental-strip-types --no-warnings lib/access.test.mts
	# And the zone helpers. A time rendered in the wrong zone is not a visible bug — it is a
	# plausible-looking hour that makes somebody miss the webinar — and the DST round trips
	# are unreachable by hand.
	cd web && node --experimental-strip-types --no-warnings lib/format.test.mts
	# And the active-speaker debounce, which is entirely about what happens BETWEEN readings —
	# a live call cannot demonstrate a 450 ms hold or a cough at the moment of a handover.
	cd web && node --experimental-strip-types --no-warnings lib/speaker.test.mts
	# And the delete warning, because the delete is irreversible and the previous copy told a
	# host deleting a finished webinar that they were tidying up a page.
	cd web && node --experimental-strip-types --no-warnings lib/webinar-delete.test.mts

.PHONY: test-mask
test-mask: ## Virtual-background mask check: make test-mask PHOTO=~/some-photo-of-a-person.jpg
	# Needs a photograph because Chrome's fake camera has no person in it, so the mask is
	# ~0 everywhere and every geometry bug looks like "nothing to segment". No server
	# required — the page is assembled from the vendored MediaPipe assets.
	@test -n "$(PHOTO)" || (echo "set PHOTO=<a photo with a person in it>"; exit 2)
	node e2e/probe-mask.mjs "$(PHOTO)"

.PHONY: test-e2e
test-e2e: ## Three-browser WebRTC test (needs livekit + api + web running)
	./scripts/e2e-browsers.sh
	node scripts/e2e.mjs

.PHONY: lint
lint: ## Vet and format-check the Go code
	cd api && go vet ./... && test -z "$$(gofmt -l .)"

# ---------------------------------------------------------------- ops

.PHONY: room
room: ## Show who is in a room: make room SLUG=scaling-webrtc-10k
	cd api && go run ./cmd/lkstat webinar_$(SLUG)

.PHONY: build
build: ## Compile the API for linux/amd64
	cd api && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
	  go build -trimpath -ldflags='-s -w' -o ../infra/bin/webcast-api ./cmd/server
	@ls -lh infra/bin/webcast-api

.PHONY: docker
docker: ## Build the API container image
	docker build -t webcast-api:latest ./api

# ---------------------------------------------------------------- deploy
# The production stack. See DEPLOY.md. COMPOSE is spelled out in each target
# rather than exported, so copying one line into a terminal still works.
COMPOSE = docker compose -f docker-compose.prod.yml --env-file .env.prod

.PHONY: deploy
deploy: ## Build and start the production stack (needs .env.prod)
	@test -f .env.prod || { echo "no .env.prod — cp .env.prod.example .env.prod and fill it in"; exit 1; }
	$(COMPOSE) up -d --build
	@echo "up. logs: make deploy-logs"

.PHONY: deploy-logs
deploy-logs: ## Follow the production logs
	$(COMPOSE) logs -f --tail=50

.PHONY: deploy-ps
deploy-ps: ## What is running in production
	$(COMPOSE) ps

.PHONY: deploy-down
deploy-down: ## Stop the production stack (volumes survive)
	$(COMPOSE) down

.PHONY: deploy-backup
deploy-backup: ## Dump the database and the recordings to ./backups
	@mkdir -p backups
	$(COMPOSE) exec -T postgres pg_dump -U webcast webcast | gzip > backups/db-$$(date +%F-%H%M).sql.gz
	docker run --rm -v webcast_recordings:/data -v "$(CURDIR)/backups:/out" alpine \
	  tar czf /out/recordings-$$(date +%F-%H%M).tar.gz -C /data .
	@ls -lh backups | tail -3

.PHONY: clean
clean:
	rm -rf infra/bin/webcast-api web/.next
