package api

import (
	"net/http"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Per-account feature switches, enforced.
 *
 * The admin screen decides; this decides again. The browser is told which switches are on
 * (Account.Features) and hides what it should, and that is a courtesy to the host, not a
 * control: a hidden button is not a permission, and every one of these features either
 * spends the host's own money at Meta or writes to somebody else's phone.
 *
 * Not middleware, deliberately. Two of the gated paths are not requests at all — a bot
 * step applying a tag, and the sweep that sends a queued replay — and the ones that are
 * requests already have the account in hand from the context. A middleware would have
 * covered the routes and left the runtime uncovered, which is where the sending happens.
 */

// featureAllowed answers 403 and reports false when this account does not have the switch.
func (s *Server) featureAllowed(w http.ResponseWriter, user store.User, key string) bool {
	if user.HasFeature(key) {
		return true
	}
	/* 403 rather than 404, and named in the error code.
	 *
	 * The route exists and the caller is who they say they are — the answer is "not for
	 * this account", and a host who is told that can ask for it. A 404 would send them
	 * looking for a bug in their own client instead.
	 */
	httpx.Error(w, http.StatusForbidden, "feature_off",
		featureLabel(key)+" isn't switched on for this account.")
	return false
}

// featureLabel is the admin-facing name of a switch, for the refusal above. Falls back to
// the key so an unknown one still produces a sentence rather than a blank.
func featureLabel(key string) string {
	for _, f := range types.Features {
		if f.Key == key {
			return f.Label
		}
	}
	return key
}
