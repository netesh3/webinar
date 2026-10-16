package api_test

import (
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
)

// Tokens are deleted a grace period after they expire, used or not. A token
// still live, or expired only recently, stays so its link explains itself.
func TestExpiredTokensArePruned(t *testing.T) {
	h := newHarness(t)
	acct := h.signup("Token Owner", "token-owner@example.com", false)
	ctx := t.Context()
	db := h.store.Pool()

	for _, table := range []string{"password_reset_tokens", "email_verification_tokens"} {
		if _, err := db.Exec(ctx, `DELETE FROM `+table+` WHERE user_id = $1::uuid`, acct.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(ctx, `
			INSERT INTO `+table+` (user_id, token_hash, expires_at, used_at) VALUES
			  ($1::uuid, $2||'-old',    now() - interval '10 days', NULL),
			  ($1::uuid, $2||'-oldused', now() - interval '10 days', now() - interval '11 days'),
			  ($1::uuid, $2||'-recent', now() - interval '1 day',   NULL),
			  ($1::uuid, $2||'-live',   now() + interval '1 hour',  NULL)`, acct.ID, table); err != nil {
			t.Fatalf("seed %s: %v", table, err)
		}
	}

	n, err := h.store.PruneExpiredTokens(ctx, time.Now().Add(-store.TokenGrace), 1)
	if err != nil {
		t.Fatal(err)
	}
	if n != 4 {
		t.Fatalf("deleted = %d, want 4", n)
	}
	for _, table := range []string{"password_reset_tokens", "email_verification_tokens"} {
		var left []string
		rows, err := db.Query(ctx, `SELECT token_hash FROM `+table+` WHERE user_id = $1::uuid ORDER BY token_hash`, acct.ID)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var h string
			if err := rows.Scan(&h); err != nil {
				t.Fatal(err)
			}
			left = append(left, h)
		}
		rows.Close()
		if len(left) != 2 || left[0] != table+"-live" || left[1] != table+"-recent" {
			t.Fatalf("%s left = %v, want live and recent", table, left)
		}
	}
}
