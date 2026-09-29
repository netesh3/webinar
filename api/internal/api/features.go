package api

import (
	"context"
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

/* requireCloudRecording allows the request only when this webinar's host has the switch.
 *
 * The host, not whoever pressed the button. A panelist records the host's session, so a
 * host with the switch off cannot be routed around by inviting someone who has it, and a
 * panelist on a host who has it can still press Record. Absent means off — see
 * migrations/0072. Local recording never reaches this: it stays on the presenter's computer.
 *
 * Returns false after writing the response. Callers return immediately.
 */
func (s *Server) requireCloudRecording(w http.ResponseWriter, r *http.Request, hostID string) bool {
	if hostID == "" {
		httpx.Error(w, http.StatusForbidden, "feature_off",
			featureLabel(types.FeatureCloudRecording)+" isn't switched on for this account.")
		return false
	}
	caller := userFromContext(r.Context())
	subject := caller
	if hostID != caller.ID {
		host, err := s.store.UserByID(r.Context(), hostID)
		if err != nil {
			s.fail(w, r, "cloud recording: load host", err)
			return false
		}
		subject = host
	}
	return s.featureAllowed(w, subject, types.FeatureCloudRecording)
}

// hostCloudRecording is the same switch, for a response that has to say yes or no
// rather than refuse. A lookup failure is off: offering Cloud and then 403ing is worse.
func (s *Server) hostCloudRecording(ctx context.Context, hostID string) bool {
	if hostID == "" {
		return false
	}
	host, err := s.store.UserByID(ctx, hostID)
	if err != nil {
		s.log.Warn("cloud recording: load host", "host", hostID, "error", err)
		return false
	}
	return host.HasFeature(types.FeatureCloudRecording)
}

/* requireHostFeature allows the request only when this host has the switch.
 *
 * The host, not whoever pressed the button, same as requireCloudRecording. Returns
 * false after writing 403 feature_off. Callers return immediately.
 */
func (s *Server) requireHostFeature(w http.ResponseWriter, r *http.Request, hostID, key string) bool {
	if hostID == "" {
		httpx.Error(w, http.StatusForbidden, "feature_off",
			featureLabel(key)+" isn't switched on for this account.")
		return false
	}
	caller := userFromContext(r.Context())
	subject := caller
	if hostID != caller.ID {
		host, err := s.store.UserByID(r.Context(), hostID)
		if err != nil {
			s.fail(w, r, "feature: load host", err)
			return false
		}
		subject = host
	}
	return s.featureAllowed(w, subject, key)
}
