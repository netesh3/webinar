package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
)

/* Load tests (docs/LOAD-TESTING.md, e2e/load/). Everything here is admin-only and off by
 * default: nothing changes for a webinar until an admin marks it.
 *
 * The load-test kit needs three things the public API (rightly) does not give a script:
 *
 *  1. a host account it can sign in as. Signup leaves an address unverified until its link is
 *     opened, and the kit's host is a test address that cannot receive mail;
 *  2. viewer seats with join keys. A real registrant gets theirs after verifying their email,
 *     and REGISTER_RATE_PER_MIN (30/min per IP) would take half an hour to seat a thousand;
 *  3. room for more viewers than any plan admits (the attendee ceiling, 500 at most).
 *
 * The guard on all three is the test-account rule: the account (or the webinar's host) must
 * have an email ending in ".invalid", the reserved top-level domain that cannot receive mail.
 * No customer can host from such an address (their login needs the verification mail), so a
 * load test can never be switched on for, or seat strangers in, a customer's webinar.
 *
 * The seats are name-only guest registrations ("Load viewer N"): no email, no account, so no
 * mail, no CRM contact, no users row. Deleting the webinar removes them, its visits and the
 * load-test mark. */

// isTestAddress is an address that can never be a customer's inbox (RFC 2606 .invalid).
func isTestAddress(email string) bool {
	return strings.HasSuffix(strings.ToLower(strings.TrimSpace(email)), ".invalid")
}

/* handleAdminVerifyTestEmail is POST /api/admin/users/{id}/verify-email: mark a test
 * account's address verified so it can sign in. Only for .invalid addresses: a real address
 * verifies itself through its link, and an admin should not be able to vouch for one. */
func (s *Server) handleAdminVerifyTestEmail(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	targetID := chi.URLParam(r, "id")
	u, err := s.store.UserByID(r.Context(), targetID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
		return
	}
	if err != nil {
		s.fail(w, r, "verify test email: load user", err)
		return
	}
	if !isTestAddress(u.Email) {
		httpx.Error(w, http.StatusUnprocessableEntity, "not_a_test_account",
			"Only a test account (an address ending in .invalid) can be verified by an admin.")
		return
	}
	if err := s.store.MarkEmailVerified(r.Context(), u.ID); err != nil {
		s.fail(w, r, "verify test email", err)
		return
	}
	s.log.Info("test account verified by admin", "admin", admin.ID, "target", u.ID)
	w.WriteHeader(http.StatusNoContent)
}

type loadTestRequest struct {
	Viewers int `json:"viewers"`
}

type loadTestResponse struct {
	Slug    string `json:"slug"`
	Viewers int    `json:"viewers"`
}

type loadTestSeatsRequest struct {
	Count int `json:"count"`
}

type loadTestSeatsResponse struct {
	JoinKeys []string `json:"joinKeys"`
}

// maxSeatsPerCall bounds one mint (and one response body).
const maxSeatsPerCall = 1000

/* loadTestWebinarHost answers whether the webinar exists and its host is a test account,
 * writing the error response when not. */
func (s *Server) loadTestWebinarHost(w http.ResponseWriter, r *http.Request, slug string) bool {
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return false
	}
	if err != nil {
		s.fail(w, r, "load test: load webinar", err)
		return false
	}
	host, err := s.store.UserByID(r.Context(), wb.Host.ID)
	if err != nil {
		s.fail(w, r, "load test: load host", err)
		return false
	}
	if !isTestAddress(host.Email) {
		httpx.Error(w, http.StatusUnprocessableEntity, "not_a_test_webinar",
			"Only a webinar hosted by a test account (an address ending in .invalid) can be a load test.")
		return false
	}
	return true
}

/* handleAdminSetLoadTest is PUT /api/admin/webinars/{slug}/load-test {viewers}: mark the
 * webinar as a load test admitting that many viewers at once (1..5000). */
func (s *Server) handleAdminSetLoadTest(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	slug := chi.URLParam(r, "slug")
	var body loadTestRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if body.Viewers < 1 || body.Viewers > store.MaxLoadTestViewers {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_viewers", "Viewers is 1 to 5000.")
		return
	}
	if !s.loadTestWebinarHost(w, r, slug) {
		return
	}
	if err := s.store.SetLoadTest(r.Context(), slug, body.Viewers, admin.ID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
			return
		}
		s.fail(w, r, "set load test", err)
		return
	}
	s.logAdminAction(admin.ID, "load-test on", slug, "viewers", body.Viewers)
	httpx.JSON(w, http.StatusOK, loadTestResponse{Slug: slug, Viewers: body.Viewers})
}

// handleAdminClearLoadTest is DELETE /api/admin/webinars/{slug}/load-test.
func (s *Server) handleAdminClearLoadTest(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	slug := chi.URLParam(r, "slug")
	if err := s.store.ClearLoadTest(r.Context(), slug); err != nil {
		s.fail(w, r, "clear load test", err)
		return
	}
	s.logAdminAction(admin.ID, "load-test off", slug)
	w.WriteHeader(http.StatusNoContent)
}

/* handleAdminLoadTestSeats is POST /api/admin/webinars/{slug}/load-test/seats {count}: mint
 * that many name-only viewer seats and return their join keys (at most 1000 a call, and never
 * more in total than the load test's viewers). */
func (s *Server) handleAdminLoadTestSeats(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	slug := chi.URLParam(r, "slug")
	var body loadTestSeatsRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if body.Count < 1 || body.Count > maxSeatsPerCall {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_count", "Count is 1 to 1000 a call.")
		return
	}
	if !s.loadTestWebinarHost(w, r, slug) {
		return
	}
	keys, err := s.store.AddLoadTestViewers(r.Context(), slug, body.Count)
	switch {
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist, is a draft or has ended.")
		return
	case errors.Is(err, store.ErrNotLoadTest):
		httpx.Error(w, http.StatusConflict, "not_a_load_test", "Mark the webinar as a load test first.")
		return
	case errors.Is(err, store.ErrLoadTestFull):
		httpx.Error(w, http.StatusConflict, "load_test_full", "That is more seats than the load test admits.")
		return
	case err != nil:
		s.fail(w, r, "load test seats", err)
		return
	}
	s.logAdminAction(admin.ID, "load-test seats", slug, "count", len(keys))
	httpx.JSON(w, http.StatusCreated, loadTestSeatsResponse{JoinKeys: keys})
}
