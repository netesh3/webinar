// Command server runs the Webinar Liv API.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/auth"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/media"
	"github.com/netkumar/webcast/api/internal/store"
)

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	log := newLogger(cfg)
	log.Info("starting webcast api", "config", cfg.String())

	// Root context cancelled on SIGINT/SIGTERM so shutdown is orderly.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.Open(ctx, cfg.DatabaseURL, log)
	if err != nil {
		return err
	}
	defer st.Close()

	if err := st.Migrate(ctx); err != nil {
		return err
	}

	/* Create any admin account that is missing, BEFORE reconciling.
	 *
	 * Order matters: PromoteAdmins can only promote an account that exists, so creating first is
	 * what makes a fresh database — or a cleared one — self-sufficient. Both steps run on every
	 * boot and both are idempotent, which is why this is here rather than in a migration: a
	 * migration runs once and is recorded, so an admin deleted afterwards would never come back.
	 *
	 * Never fatal. A deployment whose admin cannot be created still serves every existing
	 * webinar, and refusing to start would turn a missing environment variable into an outage.
	 */
	for _, email := range cfg.AdminEmails {
		if cfg.AdminPassword == "" {
			log.Warn("ADMIN_PASSWORD is not set, so a missing admin account cannot be created",
				"email", email)
			break
		}
		if len(cfg.AdminPassword) < cfg.MinPasswordLength {
			log.Error("ADMIN_PASSWORD is shorter than MIN_PASSWORD_LENGTH and was ignored",
				"min", cfg.MinPasswordLength)
			break
		}
		hash, err := auth.HashPassword(cfg.AdminPassword)
		if err != nil {
			log.Error("could not hash ADMIN_PASSWORD", "err", err)
			break
		}
		created, err := st.EnsureAdminAccount(ctx, email, store.NameFromEmail(email), hash)
		if err != nil {
			log.Error("could not ensure admin account", "email", email, "err", err)
			continue
		}
		if created {
			// A privilege-creating event, so it is logged rather than left to be inferred.
			log.Warn("created a missing admin account from ADMIN_EMAILS/ADMIN_PASSWORD",
				"email", email)
		}
	}

	/* Reconcile the admin set from ADMIN_EMAILS.
	 *
	 * At boot, because this is the one privilege that cannot be granted through the API. The
	 * hosting capability used to be self-service — a checkbox on the signup form — and moving
	 * it behind an admin only helps if the admin role itself is out of reach of anyone who
	 * takes over an account. So the chain starts in the environment, where changing it needs
	 * access to the machine.
	 *
	 * Not fatal when it fails, and not fatal when the list is empty. An empty list on a
	 * deployment that already has admins in the database is the normal state after this
	 * feature ships — the operator has not set the variable yet — and refusing to start would
	 * turn a missing config value into an outage of a running webinar platform. It is logged
	 * loudly instead, including the case where nobody can grant anything.
	 */
	if promoted, demoted, err := st.PromoteAdmins(ctx, cfg.AdminEmails); err != nil {
		log.Error("could not reconcile admins from ADMIN_EMAILS", "err", err)
	} else if len(cfg.AdminEmails) == 0 {
		log.Warn("ADMIN_EMAILS is empty: nobody can grant hosting access. " +
			"Set it to a comma-separated list of account emails and restart.")
	} else {
		log.Info("admins reconciled",
			"configured", len(cfg.AdminEmails), "promoted", promoted, "demoted", demoted)
	}

	// Seeding only ever happens in development — production data comes from
	// real usage, and a known password in a real database is a breach. SEED_DEV=false
	// turns it off for a development instance that is nobody's demo any more.
	if cfg.IsDev() && cfg.SeedDev {
		hash, err := auth.HashPassword("webcast-dev")
		if err != nil {
			return err
		}
		if err := st.SeedDev(ctx, hash); err != nil {
			return err
		}
	}

	/* One client per configured LiveKit project.
	 *
	 * A pool rather than a client because a LiveKit Cloud project has a monthly allowance,
	 * and running out of it must be an operator editing LIVEKIT_PROJECTS rather than a
	 * redeploy. Which project a given webinar's room lives on is recorded against the
	 * webinar; see internal/api/sfu.go.
	 */
	pool := lk.NewPool(cfg.LiveKitProjects, cfg.TokenTTL)

	// Recording storage. Opened at startup — including a write probe — so a
	// misconfigured directory is a boot failure rather than a recording that
	// silently captures nothing for forty minutes. nil means recording is off,
	// and the handlers answer 503 instead of pretending.
	var recordings media.Store
	if cfg.RecordingsEnabled {
		switch cfg.RecordingsBackend {
		case "s3":
			bucket, err := media.NewS3(
				cfg.RecordingsDir, cfg.RecordingsS3Endpoint, cfg.RecordingsS3Region,
				cfg.RecordingsS3Bucket, cfg.RecordingsS3AccessKey, cfg.RecordingsS3SecretKey,
			)
			if err != nil {
				return err
			}
			recordings = bucket
			log.Info("recording storage ready", "backend", bucket.Describe())
		default:
			// config.validate already refused anything but "disk" or "s3" —
			// this is unreachable except by a future backend name added there
			// and not here, which is exactly the case worth a clear failure
			// instead of a silent fall-through to disk.
			disk, err := media.NewDisk(cfg.RecordingsDir)
			if err != nil {
				return err
			}
			recordings = disk
			log.Info("recording storage ready", "backend", disk.Describe())
		}
	} else {
		log.Info("recording is disabled")
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.NewServer(cfg, st, api.NewSFUPool(pool), recordings, log).Routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- err
		}
	}()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
		log.Info("shutdown signal received", "grace", cfg.ShutdownGrace)
	}

	// Drain in-flight requests before exiting so a deploy doesn't drop the
	// join burst at the top of the hour.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownGrace)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	log.Info("stopped cleanly")
	return nil
}

func newLogger(cfg config.Config) *slog.Logger {
	level := slog.LevelInfo
	if cfg.IsDev() {
		level = slog.LevelDebug
	}
	var h slog.Handler
	if cfg.IsDev() {
		h = slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level})
	} else {
		// JSON in production so Loki/CloudWatch can index the fields.
		h = slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})
	}
	return slog.New(h)
}
