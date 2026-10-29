package store

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* Reserved inbox names (29 Oct 2026): a host cannot choose one, the default never
 * picks one, and a row that already holds one is reported at boot, not changed. */

func TestInboxCandidatesSkipReserved(t *testing.T) {
	id := "1a2b3c4d-0000-0000-0000-000000000000"
	for _, name := range []string{"Support", "SECURITY", "  billing ", "No Reply", "Zoom Review", "Admin"} {
		got := inboxCandidates(name, id)
		if len(got) == 0 {
			t.Fatalf("%q: no candidates", name)
		}
		for _, c := range got {
			if types.InboxLocalReserved(c) {
				t.Fatalf("%q: candidate %q is reserved (%v)", name, c, got)
			}
		}
	}
	if got := inboxCandidates("Support", id); got[0] != "support-1a2b" {
		t.Fatalf("Support first candidate = %q, want support-1a2b", got[0])
	}
	if got := inboxCandidates("Gsp", id); got[0] != "gsp" {
		t.Fatalf("an ordinary name must still be offered as is, got %v", got)
	}
}

func TestReservedListIsCaseInsensitive(t *testing.T) {
	for _, s := range []string{"security", "Security", "SECURITY", " security ", "Zoom-Review", "NO-REPLY"} {
		if !types.InboxLocalReserved(s) {
			t.Fatalf("%q should be reserved", s)
		}
	}
	for _, s := range []string{"gsp", "securityteam", "support-1a2b"} {
		if types.InboxLocalReserved(s) {
			t.Fatalf("%q should not be reserved", s)
		}
	}
	for _, s := range types.ReservedInboxLocalList() {
		if !inboxLocalOK(s) || s != strings.ToLower(s) {
			t.Fatalf("reserved entry %q is not a valid stored local part", s)
		}
	}
}

func reservedInboxStore(t *testing.T) (*Store, string) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	s, err := Open(ctx, dsn, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	if err := s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	tag := time.Now().Format("150405.000000")
	var host string
	if err := s.pool.QueryRow(ctx, `
		INSERT INTO users (email, name) VALUES ('reserved-' || $1 || '@test.dev', 'Support') RETURNING id::text`, tag).Scan(&host); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1::uuid`, host)
	})
	return s, host
}

func TestRenameInboxRejectsReservedInAnyCase(t *testing.T) {
	s, host := reservedInboxStore(t)
	ctx := context.Background()

	in, err := s.EnsureInbox(ctx, host, "Support")
	if err != nil {
		t.Fatal(err)
	}
	if types.InboxLocalReserved(in.Local) || !strings.HasPrefix(in.Local, "support-") {
		t.Fatalf("default for a host named Support = %q", in.Local)
	}
	for _, name := range []string{"security", "Security", "SECURITY", " Billing ", "zoom-review", "No-Reply"} {
		if _, err := s.RenameInbox(ctx, host, "Support", name); err != ErrInboxReserved {
			t.Fatalf("rename to %q: err = %v, want ErrInboxReserved", name, err)
		}
	}
	after, err := s.readInbox(ctx, host)
	if err != nil {
		t.Fatal(err)
	}
	if after.Local != in.Local {
		t.Fatalf("a refused rename changed the address: %q -> %q", in.Local, after.Local)
	}
	if _, err := s.RenameInbox(ctx, host, "Support", "support-desk-"+in.Local[len(in.Local)-4:]); err != nil {
		t.Fatalf("an ordinary name must still be accepted: %v", err)
	}
}

func TestReservedInboxHoldersFindsExistingRows(t *testing.T) {
	s, host := reservedInboxStore(t)
	ctx := context.Background()

	// A row from before the list: written directly, the way old data looks.
	if _, err := s.pool.Exec(ctx, `UPDATE users SET inbox_local = 'postmaster' WHERE id = $1::uuid`, host); err != nil {
		t.Fatal(err)
	}
	holders, err := s.ReservedInboxHolders(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, h := range holders {
		if !types.InboxLocalReserved(h.Local) {
			t.Fatalf("holder %+v is not reserved", h)
		}
		if h.UserID == host {
			found = h.Local == "postmaster"
		}
	}
	if !found {
		t.Fatalf("host with postmaster not reported: %+v", holders)
	}
	// Reporting must not change the row.
	in, err := s.readInbox(ctx, host)
	if err != nil {
		t.Fatal(err)
	}
	if in.Local != "postmaster" {
		t.Fatalf("boot check changed inbox_local to %q", in.Local)
	}

	if _, err := s.pool.Exec(ctx, `UPDATE users SET inbox_local = 'gsp-reserved-test' WHERE id = $1::uuid`, host); err != nil {
		t.Fatal(err)
	}
	holders, err = s.ReservedInboxHolders(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, h := range holders {
		if h.UserID == host {
			t.Fatalf("host with an ordinary name reported: %+v", h)
		}
	}
}
