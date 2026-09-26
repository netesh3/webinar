/*
Package crmstore is the WhatsApp CRM's SQL: contacts, messages, templates, reminders,
broadcasts, drips, bots, tags and notes.

Store embeds the core *store.Store, so a CRM handler reads a webinar or a user through the
same s.store it reads a contact through. What the embedding does NOT grant is the right to
write webinar tables: this package writes only crm_* tables, its own rows in the shared
notifications outbox (channel 'whatsapp'), and the users.whatsapp_* columns. That rule is
checked by the boundary test in package engage.

The schema lives with every other migration in store/migrations, because the tables share
one database and one ordered history; which module owns a table is in docs/engage/MODULES.md.
*/
package crmstore

import (
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/netkumar/webcast/api/internal/store"
)

type Store struct {
	*store.Store
	pool *pgxpool.Pool
}

func New(core *store.Store) *Store { return &Store{Store: core, pool: core.Pool()} }

type scanner interface {
	Scan(dest ...any) error
}

func noRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func isForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}

// normalisePhone is the registration form's normalisation, so a contact and a registrant match.
func normalisePhone(raw string) string { return store.NormalisePhone(raw) }
