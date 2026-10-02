SHELL := /bin/bash
.DEFAULT_GOAL := help

# Homebrew paths so `make` works from a GUI terminal with a thin PATH.
export PATH := /opt/homebrew/bin:/opt/homebrew/opt/postgresql@18/bin:$(PATH)

DB_URL      ?= postgres://webcast:webcast@localhost:5432/webcast?sslmode=disable
TEST_DB_URL ?= postgres://webcast:webcast@localhost:5432/webcast_test?sslmode=disable
LIVEKIT_BIN := infra/bin/livekit-server
LIVEKIT_VER := v1.13.7

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
	@cd api && DATABASE_URL="$(DB_URL)" go run ./cmd/migrate

.PHONY: web
web: ## Run the Next.js frontend (terminal 3)
	cd web && npm run dev

.PHONY: tunnel
tunnel: ## Public HTTPS URL, needed to test camera/mic from a phone
	cloudflared tunnel --url http://localhost:3000

.PHONY: tours
tours: ## Record the narrated guided-tour videos (stack up + demo seed); make tours ONLY="02 05"
	node scripts/tours/run.mjs $(ONLY)
	@echo "open docs/tours/index.html"

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
	# And what that ladder puts back once it reconnects, for the same reason plus a worse
	# one: getting it wrong in the generous direction republishes somebody's screen.
	cd web && node --experimental-strip-types --no-warnings lib/republish.test.mts
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
	# And the registration-question builder: a "Choose one" must open option rows to fill
	# in, and an option containing a comma is still one option.
	cd web && node --experimental-strip-types --no-warnings lib/registration-questions.test.mts
	# And the create-webinar form's two steps: old ?step= links must still open the right
	# one, and only a real problem on The webinar may hold back Next or Schedule.
	cd web && node --experimental-strip-types --no-warnings lib/schedule-wizard.test.mts
	# And the chat preview card: a burst of arrivals, a reconnect merging history, and
	# your own echo coming back off the wire cannot be produced by hand in a live room.
	cd web && node --experimental-strip-types --no-warnings lib/chat-notify.test.mts
	# And chat avatars and grouping: the initials and colour must match the server's
	# InitialsOf/HueFor, and a panelists-only aside must never join a public run.
	cd web && node --experimental-strip-types --no-warnings lib/chat-groups.test.mts
	# And @mentions: who the picker may offer (hidden attendees must never appear), how a
	# tag survives edits in a plain textarea, and how a delivered message is highlighted.
	cd web && node --experimental-strip-types --no-warnings lib/mentions.test.mts
	# And the host's attendee-chat control: turning chat off must leave the destination
	# alone, or switching it back on silently widens "Panelists only" to everyone.
	cd web && node --experimental-strip-types --no-warnings lib/chat-permission.test.mts
	# And the Q&A card's asker line: an anonymous question must never surface its
	# sender's name, initials or identity, and "answered live" is not a text answer.
	cd web && node --experimental-strip-types --no-warnings lib/qa-view.test.mts
	# And the polls panel and pop-up: percentages that must add to 100, a quiz answer
	# marked after a blank option, and a launch announced mid-read that must not be lost.
	cd web && node --experimental-strip-types --no-warnings lib/poll-view.test.mts
	# And what a rejoin reads back: a long session's backlog paged to the present, a
	# double upvote from a reloaded tab counted once, and history raising no badge.
	cd web && node --experimental-strip-types --no-warnings lib/room-history.test.mts
	# And the host roster sections: oldest-first hands and a search box that stays
	# away until the list is too long to scan are not things a three-person room shows.
	cd web && node --experimental-strip-types --no-warnings lib/roster.test.mts
	# And the media shortcuts: M/V/Space are also typing keys, so the guard that they
	# do not fire in a chat box is the whole reason this file exists.
	cd web && node --experimental-strip-types --no-warnings lib/media-hotkeys.test.mts
	# And which tools sit in Zoom's standing centre cluster vs More on a phone.
	cd web && node --experimental-strip-types --no-warnings lib/tools-bar.test.mts
	# And customising it: adding from More never pins a tool out of sight on a full
	# bar, a recently used slot can be moved back, and undo puts exactly it back.
	cd web && node --experimental-strip-types --no-warnings lib/tools-edit.test.mts
	# And when More gets out of the way of the rest of the bar: another button
	# closes it in the same click, a drag toward it or Customize does not.
	cd web && node --experimental-strip-types --no-warnings lib/bar-popover.test.mts
	# And the virtual-background catalogue: an old stored image id must not reach
	# the compositor as a missing texture.
	cd web && node --experimental-strip-types --no-warnings lib/backgrounds.test.mts
	# And the low-light amount, which the shader divides by as a gamma exponent — a
	# negative one out of storage inverts the presenter's camera. The curve itself is
	# GLSL and is checked on a real GPU by `make test-low-light`.
	cd web && node --experimental-strip-types --no-warnings lib/low-light.test.mts
	# And remembering a closed pop-out during screen share: without it MediaSession
	# re-opens the window on every switch-away after the user hit X.
	cd web && node --experimental-strip-types --no-warnings lib/pip.test.mts
	# And reaction bursts appearing one at a time, 500–1000 ms apart, with a bounded
	# backlog — so one click never reads as several and a flood never queues a minute.
	cd web && node --experimental-strip-types --no-warnings lib/reaction-queue.test.mts
	# And the host's join toasts: "joining…" must only turn into "joined" once the roster
	# shows the person, and a reconnect or the host's own first roster must not burst.
	cd web && node --experimental-strip-types --no-warnings lib/join-toasts.test.mts
	# And the raised-hand toasts: one per new hand, gone when anyone handles it, a burst
	# folded into one summary, and the hands already up when a host arrives left alone.
	cd web && node --experimental-strip-types --no-warnings lib/hand-toasts.test.mts
	# And where a recording goes: Cloud must read as "checking", not unavailable, while
	# the config loads, and the compact menu's sublines must stay one short line.
	cd web && node --experimental-strip-types --no-warnings lib/record-target.test.mts
	# And the connection toast: a blip under six seconds must stay silent, a shown drop must
	# turn into "back online" in place, and a long one must escalate to "Connection lost".
	cd web && node --experimental-strip-types --no-warnings lib/connection-toast.test.mts
	# And the clock that toast uses: signal-only resumes are not drops, a blip under 6s never
	# shows, and a recovery cancels the wait so flaps cannot add up.
	cd web && node --experimental-strip-types --no-warnings lib/reconnect-indicator.test.mts
	# And the requester's own hand and stage toast: raised → lowered by the host must
	# replace in place, an open invite must not be talked over or time out.
	cd web && node --experimental-strip-types --no-warnings lib/self-hand-toasts.test.mts
	# And the engagement score, against the same table the Go formula is tested with
	# (api/internal/engagement/testdata/score_cases.json), so the fixture page and the
	# server can never disagree about a number — plus the attendee paging and heatmap maths.
	cd web && node --experimental-strip-types --no-warnings lib/engagement/score.test.mts
	cd web && node --experimental-strip-types --no-warnings lib/survey.test.mts
	# And the Engagement tab that replaced Report: old ?tab=report links must still land on
	# it, and the Export menu must keep offering the old attendance CSV people built on.
	cd web && node --experimental-strip-types --no-warnings lib/host-tabs.test.mts
	cd web && node --experimental-strip-types --no-warnings lib/engagement/tab.test.mts
	cd web && node --experimental-strip-types --no-warnings lib/engagement/folds.test.mts
	# And table header sorting: numbers and dates must not sort as text, empty
	# cells stay last, and a third click returns to the list's own order.
	cd web && node --experimental-strip-types --no-warnings lib/table-sort.test.mts
	# And WhatsApp inbox labels: Meta's type "unsupported" must not read as
	# "Sent a unsupported", and a photo stored before media ids existed still
	# reads as a photo.
	cd web && node --experimental-strip-types --no-warnings engage/message-kind.test.mts
	# And the unread badges: opening a thread or a notification takes it off the
	# count once, including a thread that was past the bell's short preview.
	cd web && node --experimental-strip-types --no-warnings engage/unread.test.mts
	# And the host-home follow-up column: a week after the end, and no wider,
	# so a session from last month does not sit beside Upcoming.
	cd web && node --experimental-strip-types --no-warnings lib/follow-up-nudge.test.mts

.PHONY: test-background
test-background: ## Virtual backgrounds, frame by frame: make test-background PHOTO=~/person.jpg [HAIR=~/long-hair.jpg]
	# Needs a photograph because Chrome's fake camera has no person in it, so the mask is
	# ~0 everywhere, every geometry bug looks like "nothing to segment", and "the room is
	# never shown" passes on a picture with no room to hide. HAIR, a photo of loose hair
	# against a plain wall, adds the still-edge flicker check. The app's own lib/ code runs,
	# bundled out of web/node_modules, so install those first. No server and no LiveKit —
	# the page is served from the vendored MediaPipe assets, and nothing is downloaded.
	@test -n "$(PHOTO)" || (echo "set PHOTO=<a photo with a person in it>"; exit 2)
	@test -d web/node_modules || (echo "run: cd web && npm ci"; exit 2)
	node e2e/probe-background.mjs "$(PHOTO)" $(if $(HAIR),"$(HAIR)")

.PHONY: test-low-light
test-low-light: ## Low-light curve on a real GPU. Optional: make test-low-light PHOTO=~/photo.jpg
	# The curve is GLSL, so the only honest check compiles the shipped string and reads
	# pixels back — a JavaScript copy of the formula would assert every property and prove
	# none of them. No server and no model needed; the curve knows nothing about the person.
	# PHOTO additionally writes a side-by-side strip, for judging how much lift is right.
	node --experimental-strip-types --no-warnings e2e/probe-low-light.mjs $(PHOTO)

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

# The single-VM docker-compose.prod.yml stack (DEPLOY.md / DEPLOY-ANYWHERE.md)
# and its `make deploy*` targets were removed here: production runs the
# managed topology instead (Cloudflare Workers + Cloud Run + Supabase +
# Hetzner LiveKit — see docs/DEPLOYMENT-TOPOLOGY.md, and deploy/cloudrun-deploy.sh
# / deploy/livekit-hetzner/ below). That stack was only ever used for AWS.

.PHONY: clean
clean:
	rm -rf infra/bin/webcast-api web/.next
