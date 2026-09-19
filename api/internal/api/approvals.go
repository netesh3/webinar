package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The host approval workflow: reviewing who gets in, and telling them.
 *
 * The decision itself already existed — one registration at a time, plus an all-or-nothing
 * "approve everyone waiting". What is here is the two things that were missing:
 *
 *   a SELECTIVE batch, because a host reviewing forty strangers approves some and declines
 *   others, and doing that one request at a time is both slow and non-atomic: a failure
 *   halfway leaves half the room approved with nothing to say which half.
 *
 *   NOTIFICATION, because approving somebody who is never told is not letting them in. The
 *   old flow required the registrant to guess when to come back and look.
 */

// dispatch is how many notifications a decision produced, for the response.
type dispatch struct{ notified int }

/* handleApprovals is PATCH /api/host/webinars/{slug}/approvals.
 *
 * Under requireOwnership, so the caller provably hosts the webinar in the URL. That is NOT
 * enough on its own: the ids arrive in the body, so the store scopes the UPDATE to this
 * webinar as well. Otherwise a host could paste another host's registration ids and approve
 * strangers into somebody else's session — see store.SetRegistrationStates.
 */
func (s *Server) handleApprovals(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())

	var body types.ApprovalsRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if !body.State.Decidable() {
		httpx.Error(w, http.StatusUnprocessableEntity, "bad_state",
			"State must be approved, declined or pending.")
		return
	}
	/* An empty list is accepted and changes nothing, rather than being a 422.
	 *
	 * It is what a host who pressed the button with no rows ticked meant, and answering
	 * "changed: 0" is more useful than an error the UI then has to translate back into
	 * "nothing was selected". */
	if len(body.IDs) == 0 {
		httpx.JSON(w, http.StatusOK, types.ApprovalsResponse{Rows: []types.RegistrantRow{}})
		return
	}

	rows, err := s.store.SetRegistrationStates(r.Context(), slug, body.IDs, body.State)
	if err != nil {
		s.fail(w, r, "batch approvals", err)
		return
	}

	d := s.notifyDecisions(r.Context(), slug, rows, body.State)

	s.log.Info("batch approvals",
		"slug", slug, "state", body.State,
		"asked", len(body.IDs), "changed", len(rows), "notified", d.notified)

	httpx.JSON(w, http.StatusOK, types.ApprovalsResponse{
		Changed: len(rows), Notified: d.notified, Rows: rows,
	})
}

// handlePendingApprovals is GET /api/host/webinars/{slug}/approvals: just the queue.
//
// A separate endpoint from /registrants, which returns everybody in every state. The approval
// panel wants only the rows that need a decision, and asking it to fetch every registrant of a
// 500-person webinar to find the four pending ones is the kind of thing that is fine until it
// is not.
func (s *Server) handlePendingApprovals(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())

	all, err := s.store.Registrants(r.Context(), slug, 0)
	if err != nil {
		s.fail(w, r, "pending approvals", err)
		return
	}
	pending := make([]types.RegistrantRow, 0, len(all))
	for _, row := range all {
		if row.State == types.RegPending {
			pending = append(pending, row)
		}
	}
	httpx.JSON(w, http.StatusOK, pending)
}

/* notifyDecisions writes one notification per person whose state actually changed.
 *
 * Failures here are logged and NOT returned. The decision is already committed, and turning a
 * successful approval into a 500 because a mail server was slow would leave the host pressing
 * the button again on rows that are already approved. The outbox row is what guarantees the
 * message is not lost; this call is only the fast path.
 */
func (s *Server) notifyDecisions(
	ctx context.Context, slug string, rows []types.RegistrantRow, state types.RegistrationState,
) dispatch {
	// Nothing to say when a host moves somebody back to pending: that is a correction to
	// their own queue, and "your registration is now awaiting approval again" would be a
	// confusing message about a decision that was never communicated in the first place.
	if state == types.RegPending || len(rows) == 0 {
		return dispatch{}
	}

	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil {
		s.log.Error("notify: could not load webinar", "slug", slug, "err", err)
		return dispatch{}
	}

	var out dispatch
	for _, row := range rows {
		in := notify.Invite{
			Name:     row.Name,
			Topic:    wb.Topic,
			WhenText: whenText(wb.StartsAt, wb.TimeZone),
			HostName: wb.Host.Name,
		}

		var kind types.NotificationKind
		var subject, bodyText string
		switch state {
		case types.RegApproved:
			in.JoinURL = s.joinURLFor(ctx, slug, row.ID)
			kind = types.NotifyRegistrationApproved
			subject, bodyText = notify.RegistrationApproved(in)
			s.enqueueApprovedInvite(ctx, wb, row.Email, row.Name, row.ID, in.JoinURL, types.NotifyRegistrationApproved)
			out.notified++
			continue
		case types.RegDeclined:
			kind = types.NotifyRegistrationDeclined
			subject, bodyText = notify.RegistrationDeclined(in)
			_ = s.store.SkipPendingRemindersForRegistration(ctx, row.ID)
		default:
			continue
		}

		n := store.Notification{
			Email:       row.Email,
			Kind:        kind,
			WebinarSlug: slug,
			Subject:     subject,
			Body:        bodyText,
		}
		if err := s.store.Notify(ctx, s.store.DB(), n); err != nil {
			s.log.Error("notify: could not queue", "email", row.Email, "err", err)
			continue
		}
		out.notified++
	}

	// Delivery is attempted immediately for responsiveness, and the outbox is what makes it
	// safe for this to fail. See s.flushOutbox.
	s.flushOutbox(ctx)
	return out
}

/* joinURLFor builds the personal join link for one registration.
 *
 * The token is read back from the store rather than passed around, because the batch UPDATE
 * returns the registrant's details and not their join key — and putting a bearer credential in
 * a RETURNING clause that feeds an API response would be how it ends up in a log.
 */
func (s *Server) joinURLFor(ctx context.Context, slug, registrationID string) string {
	base := strings.TrimRight(s.cfg.WebBaseURL, "/")
	key, err := s.store.JoinKeyForRegistration(ctx, registrationID)
	if err != nil || key == "" {
		// Still a usable link: the room resolves a signed-in registrant from their session,
		// so an account holder is unaffected. A guest lands on the page and can recover
		// their key by re-submitting the form, which returns the original registration.
		if err != nil {
			s.log.Warn("notify: no join key for registration", "id", registrationID, "err", err)
		}
		return base + "/webinars/" + slug
	}
	return base + "/webinars/" + slug + "/room?k=" + key
}

/* flushOutbox tries to deliver everything owed, once, synchronously.
 *
 * Synchronous and bounded rather than a background worker, deliberately. A background sender
 * needs a lifecycle, a shutdown path and a way to not run twice on two processes; this
 * deployment is one process and one box, and an approval already blocks on a database write.
 * The outbox means a message survives this call failing, so the only cost of doing it here is
 * latency on the host's click — bounded by the transport's own context.
 *
 * Errors are recorded per row and never returned: a decision that has been committed must not
 * be reported as failed.
 */
func (s *Server) flushOutbox(ctx context.Context) {
	owed, err := s.store.PendingDeliveries(ctx, 100)
	if err != nil {
		s.log.Error("outbox: could not read", "err", err)
		return
	}
	for _, m := range owed {
		if !s.mail.Configured() {
			// 'skipped', not 'failed': no transport is an operator's decision, and marking
			// it as a failure would bury real delivery errors in routine noise.
			_ = s.store.MarkDelivered(ctx, m.ID, "skipped", "no mail transport configured")
			continue
		}
		err := s.mail.Send(ctx, notify.Message{
			To: m.Email, Subject: m.Subject, Body: m.Body, ICS: m.ICS, ICSName: "webinar.ics",
		})
		if err != nil {
			s.log.Error("outbox: send failed", "to", m.Email, "err", err)
			_ = s.store.MarkDelivered(ctx, m.ID, "failed", err.Error())
			continue
		}
		_ = s.store.MarkDelivered(ctx, m.ID, "sent", "")
	}
}

// ------------------------------------------------------------- host alerts

// handleHostAlerts is GET /api/host/alerts: the bell, and the panel behind it.
func (s *Server) handleHostAlerts(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	unreadOnly := r.URL.Query().Get("unread") == "1"

	alerts, err := s.store.HostAlerts(r.Context(), user.ID, unreadOnly, 50)
	if err != nil {
		s.fail(w, r, "host alerts", err)
		return
	}
	count, err := s.store.UnreadAlertCount(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "unread alert count", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.AlertsResponse{Alerts: alerts, Unread: count})
}

// handleReadHostAlerts is POST /api/host/alerts/read. An empty id list means "all",
// which is what the "Mark all read" affordance sends.
func (s *Server) handleReadHostAlerts(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())

	var body struct {
		IDs []string `json:"ids"`
	}
	// A missing body means all of them, so a decode failure on an empty request is not an
	// error worth surfacing.
	if r.ContentLength > 0 {
		if err := httpx.DecodeJSON(w, r, &body); err != nil {
			httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
			return
		}
	}

	n, err := s.store.MarkAlertsRead(r.Context(), user.ID, body.IDs)
	if err != nil {
		s.fail(w, r, "mark alerts read", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.MuteAllResponse{Muted: n})
}

/* whenText formats a webinar's start for a human, in the webinar's own zone.
 *
 * The store hands StartsAt over as an RFC3339 string, so it is parsed back here rather than
 * localTime being changed to take a string — every other caller of localTime already holds a
 * time.Time, and loosening its signature to suit one caller would push the parsing (and the
 * decision about what to do when it fails) into a helper that should not have an opinion.
 *
 * An unparseable timestamp yields "", and the templates omit the line entirely rather than
 * emailing somebody the word "Invalid". Nothing writes StartsAt except the store, so this is
 * defence rather than an expected path.
 */
func whenText(startsAt, zone string) string {
	at, err := time.Parse(time.RFC3339, startsAt)
	if err != nil {
		return ""
	}
	return localTime(at, zone)
}
