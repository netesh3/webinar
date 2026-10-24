package api

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Administration.
 *
 * The privilege this package exists to grant is hosting. Hosting used to be
 * self-service — a checkbox at signup and a toggle on the profile form — so any
 * visitor could create webinars and start taking strangers' names, emails and
 * phone numbers. That is now a grant, and the writes below are where it is made.
 *
 * There is no endpoint here that creates another admin. That is not an omission
 * to be filled in later: a privilege which can be granted through the API can be
 * granted by whoever takes over one admin account, and the property worth having
 * is that the chain starts outside the application. Admins come from ADMIN_EMAILS,
 * reconciled at boot.
 *
 * The reads (accounts, webinars, stats) are what an operator looks at before
 * granting or revoking anything. Stats is its own read because the two lists
 * are the wrong shape for a dashboard — see handleAdminStats.
 */

// handleAdminUsers is GET /api/admin/users?q=…
func (s *Server) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	// ?kind=customer (the default) or audience picks one list; all lists both.
	kind := types.AccountCustomer
	switch q := r.URL.Query().Get("kind"); q {
	case "", string(types.AccountCustomer):
	case string(types.AccountAudience):
		kind = types.AccountAudience
	case "all":
		kind = ""
	default:
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_kind",
			"kind is customer, audience or all.")
		return
	}
	users, err := s.store.AdminUsers(r.Context(), r.URL.Query().Get("q"), kind, 200)
	if err != nil {
		s.fail(w, r, "admin users", err)
		return
	}
	for i := range users {
		users[i].DefaultRecordingRetentionDays = s.cfg.RecordingsRetentionDays
		users[i].MediaLimitBytes = s.cfg.MediaQuotaDefaultBytes()
		if q := users[i].MediaQuotaBytes; q != nil {
			users[i].MediaLimitBytes = *q
		}
	}
	httpx.JSON(w, http.StatusOK, users)
}

// handleAdminAccountCounts is GET /api/admin/users/counts: the size of each list.
func (s *Server) handleAdminAccountCounts(w http.ResponseWriter, r *http.Request) {
	counts, err := s.store.AdminAccountCounts(r.Context())
	if err != nil {
		s.fail(w, r, "admin account counts", err)
		return
	}
	httpx.JSON(w, http.StatusOK, counts)
}

/* handleSetAccountKind is PATCH /api/admin/users/{id}/kind: moving an account
 * between the customer list and the webinar-audience list. It does not grant or
 * take away hosting; that is the host switch. */
func (s *Server) handleSetAccountKind(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	targetID := chi.URLParam(r, "id")

	var body types.SetAccountKindRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if body.Kind != types.AccountCustomer && body.Kind != types.AccountAudience {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_kind",
			"kind is customer or audience.")
		return
	}
	updated, err := s.store.SetAccountKind(r.Context(), targetID, body.Kind, admin.ID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
		return
	}
	if err != nil {
		s.fail(w, r, "set account kind", err)
		return
	}
	s.log.Info("account kind changed", "admin", admin.ID, "target", updated.ID, "kind", body.Kind)
	httpx.JSON(w, http.StatusOK, updated.Public())
}

/* handleSetHostCapability is PATCH /api/admin/users/{id}/host.
 *
 * A PATCH with an explicit boolean rather than POST /grant and POST /revoke. The action is
 * idempotent and the UI is a switch, so a request that says what the state should BE cannot
 * double-apply if it is retried — which two verbs invite.
 */
func (s *Server) handleSetHostCapability(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	targetID := chi.URLParam(r, "id")

	var body types.HostGrant
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	/* An admin cannot revoke their own hosting.
	 *
	 * Not paranoia about self-harm — it is the only lockout in here that cannot be undone from
	 * inside the app. An admin who turns their own hosting off has no toggle to turn it back
	 * on, because the toggle they would use is the one they just removed access to, and
	 * recovery means an operator editing the database. Refusing is cheap; the alternative is a
	 * support call.
	 */
	if targetID == admin.ID && !body.CanHost {
		httpx.Error(w, http.StatusUnprocessableEntity, "cannot_self_revoke",
			"You can't remove your own hosting access.")
		return
	}

	updated, err := s.store.SetHostCapability(r.Context(), targetID, body.CanHost)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
		return
	}
	if err != nil {
		s.fail(w, r, "set host capability", err)
		return
	}

	// Logged with both parties, because this is the audit trail for a privilege change and
	// "who granted this" is the first question anybody asks about one.
	s.log.Info("host capability changed",
		"admin", admin.ID, "target", updated.ID, "can_host", updated.CanHost)

	httpx.JSON(w, http.StatusOK, updated.Public())
}

/* handleSetUserMediaQuota is PATCH /api/admin/users/{id}/media-quota: how much this
 * account may keep in its WhatsApp media library, in bytes. Null is the default. */
func (s *Server) handleSetUserMediaQuota(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	targetID := chi.URLParam(r, "id")
	var body types.SetUserMediaQuotaRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if q := body.MediaQuotaBytes; q != nil && (*q <= 0 || *q > int64(types.MaxMediaQuotaMB)<<20) {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_quota",
			fmt.Sprintf("The media limit is above 0 and at most %d GB, or blank for the default.", types.MaxMediaQuotaMB/1024))
		return
	}
	if err := s.store.SetUserMediaQuota(r.Context(), targetID, body.MediaQuotaBytes); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
		return
	} else if err != nil {
		s.fail(w, r, "set user media quota", err)
		return
	}
	s.log.Info("user media quota changed", "admin", admin.ID, "target", targetID, "media_quota_bytes", body.MediaQuotaBytes)
	httpx.JSON(w, http.StatusOK, body)
}

/* handleSetUserMaxDuration is PATCH /api/admin/users/{id}/max-duration.
 *
 * Configures an account's maximum meeting length in minutes.
 * Passing null resets the account to use the system default limit.
 */
func (s *Server) handleSetUserMaxDuration(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	targetID := chi.URLParam(r, "id")

	var body types.SetUserMaxDurationRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	if body.MaxDurationMin != nil && *body.MaxDurationMin <= 0 {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_duration",
			"Max meeting duration must be at least 1 minute or null to use the system default.")
		return
	}

	updated, err := s.store.SetUserMaxDuration(r.Context(), targetID, body.MaxDurationMin)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
		return
	}
	if err != nil {
		s.fail(w, r, "set user max duration", err)
		return
	}

	s.log.Info("user max duration changed",
		"admin", admin.ID, "target", updated.ID, "max_duration_min", updated.MaxDurationMin)

	httpx.JSON(w, http.StatusOK, updated.Public())
}

/* handleSetUserStageCap is PATCH /api/admin/users/{id}/stage-cap: a custom number of people
 * on stage for one account, over its plan's (types.PlanStageCap). Null goes back to the plan.
 * Takes effect on the next person brought on stage; nobody already there is moved off. */
func (s *Server) handleSetUserStageCap(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	targetID := chi.URLParam(r, "id")

	var body types.SetUserStageCapRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if body.StageCap != nil && (*body.StageCap < 1 || *body.StageCap > types.MaxStageCapOverride) {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_stage_cap",
			fmt.Sprintf("A stage holds 1 to %d people, or null to use the plan.", types.MaxStageCapOverride))
		return
	}
	if err := s.store.SetUserStageCap(r.Context(), targetID, body.StageCap); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
		return
	} else if err != nil {
		s.fail(w, r, "set user stage cap", err)
		return
	}
	s.log.Info("user stage cap changed", "admin", admin.ID, "target", targetID, "stage_cap", body.StageCap)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
}

/* handleSetUserMeetingCap is PATCH /api/admin/users/{id}/meeting-cap: how many people one of
 * this account's meetings holds, over its plan's (types.PlanMeetingCap). Null goes back to the
 * plan. Webinar stages are not affected (stage-cap). Takes effect on the next person admitted. */
func (s *Server) handleSetUserMeetingCap(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	targetID := chi.URLParam(r, "id")

	var body types.SetUserMeetingCapRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if body.MeetingCap != nil && (*body.MeetingCap < 1 || *body.MeetingCap > types.MaxMeetingCapOverride) {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_meeting_cap",
			fmt.Sprintf("A meeting holds 1 to %d people, or null to use the plan.", types.MaxMeetingCapOverride))
		return
	}
	if err := s.store.SetUserMeetingCap(r.Context(), targetID, body.MeetingCap); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
		return
	} else if err != nil {
		s.fail(w, r, "set user meeting cap", err)
		return
	}
	s.log.Info("user meeting cap changed", "admin", admin.ID, "target", targetID, "meeting_cap", body.MeetingCap)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
}

/* handleSetFeature is PATCH /api/admin/users/{id}/features.
 *
 * One feature per request, carrying the end state rather than a verb, for the same reason
 * handleSetHostCapability does: the UI is a row of switches, and a retried request that says
 * what should BE cannot double-apply.
 *
 * The unknown-key refusal is the only validation these switches get. features is a text[]
 * with no CHECK behind it (see migrations/0048), so a typo in a client would otherwise be
 * stored happily and read as off for ever — an admin would flip a switch, see it stick, and
 * the customer still could not use the thing. Refusing here is what makes types.Features the
 * list that decides.
 */
func (s *Server) handleSetFeature(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	targetID := chi.URLParam(r, "id")

	var body types.FeatureGrant
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if !types.KnownFeature(body.Feature) {
		httpx.Error(w, http.StatusUnprocessableEntity, "unknown_feature",
			"That isn't a feature this server knows about.")
		return
	}

	var state *bool
	if !body.Inherit {
		state = &body.Enabled
	}
	updated, err := s.store.SetFeatureOverride(r.Context(), targetID, body.Feature, state)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
		return
	}
	if err != nil {
		s.fail(w, r, "set feature", err)
		return
	}

	s.log.Info("account feature changed",
		"admin", admin.ID, "target", updated.ID, "feature", body.Feature,
		"enabled", body.Enabled, "inherit", body.Inherit)

	httpx.JSON(w, http.StatusOK, updated.Public())
}

/* handleSetFeatures is PUT /api/admin/users/{id}/features: handleSetFeature for several
 * switches at once (types.FeatureGrants). All keys are checked first, so a typo writes
 * nothing; the writes share one transaction, so the account is never left half-changed. */
func (s *Server) handleSetFeatures(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	targetID := chi.URLParam(r, "id")

	var body types.FeatureGrants
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if len(body.Grants) == 0 {
		httpx.Error(w, http.StatusUnprocessableEntity, "no_grants", "Name at least one feature.")
		return
	}
	changes := make([]store.FeatureChange, 0, len(body.Grants))
	for _, g := range body.Grants {
		if !types.KnownFeature(g.Feature) {
			httpx.Error(w, http.StatusUnprocessableEntity, "unknown_feature",
				"That isn't a feature this server knows about.")
			return
		}
		c := store.FeatureChange{Feature: g.Feature}
		if !g.Inherit {
			on := g.Enabled
			c.State = &on
		}
		changes = append(changes, c)
	}
	updated, err := s.store.SetFeatureOverrides(r.Context(), targetID, changes)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
		return
	}
	if err != nil {
		s.fail(w, r, "set features", err)
		return
	}
	s.log.Info("account features changed", "admin", admin.ID, "target", updated.ID, "count", len(changes))
	httpx.JSON(w, http.StatusOK, updated.Public())
}

/* handlePlanFeatures is GET /api/admin/plan-features: which features each plan
 * includes, for the admin screen's matrix. */
func (s *Server) handlePlanFeatures(w http.ResponseWriter, r *http.Request) {
	tiers, err := s.store.PlanFeatures(r.Context())
	if err != nil {
		s.fail(w, r, "plan features", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.PlanFeaturesBody{Tiers: tiers})
}

/* handleSetPlanFeatures is PUT /api/admin/plan-features: the whole matrix, replaced.
 *
 * Whole rather than one cell, because the admin edits a grid and saves it; a partial
 * write is the one state they never looked at. Every plan and feature key is checked,
 * the same refusal handleSetFeature gives, so a typo cannot quietly switch a tier off.
 * A PerHost switch (every AI one) is refused in any tier. A plan left out of the body
 * includes nothing. */
func (s *Server) handleSetPlanFeatures(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	var body types.PlanFeaturesBody
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	for _, t := range body.Tiers {
		if t.Plan != "" && !t.Plan.Valid() {
			httpx.Error(w, http.StatusUnprocessableEntity, "invalid_plan",
				"Plan is professional, business, enterprise, or empty for none.")
			return
		}
		for _, f := range t.Features {
			if !types.KnownFeature(f) {
				httpx.Error(w, http.StatusUnprocessableEntity, "unknown_feature",
					"That isn't a feature this server knows about.")
				return
			}
			// AI is off by default on every plan: an admin turns it on per host.
			if types.PerHostFeature(f) {
				httpx.Error(w, http.StatusUnprocessableEntity, "per_host_feature",
					featureLabel(f)+" is off on every plan. Turn it on for a host under Accounts → Features.")
				return
			}
		}
	}
	if err := s.store.SetPlanFeatures(r.Context(), body.Tiers); err != nil {
		s.fail(w, r, "set plan features", err)
		return
	}
	tiers, err := s.store.PlanFeatures(r.Context())
	if err != nil {
		s.fail(w, r, "plan features", err)
		return
	}
	s.log.Info("plan features changed", "admin", admin.ID)
	httpx.JSON(w, http.StatusOK, types.PlanFeaturesBody{Tiers: tiers})
}

/* handleAdminWebinars is GET /api/admin/webinars?status=&kind=&from=&to=&q=.
 *
 * The only place in the app that lists webinars across every host: every
 * other listing (VisibleTo, ByHost) is deliberately scoped to one account,
 * and an admin reviewing what has run — or what is coming up — on the whole
 * instance needs the one view that isn't.
 *
 * status is one of "scheduled", "live", "ended", or omitted for all three.
 * from/to are plain dates (2006-01-02), because a date picker is what an
 * admin filtering "webinars in March" actually has, not a timestamp — to is
 * read as the end of that day so the day itself is included.
 */
func (s *Server) handleAdminWebinars(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	filter := store.AdminWebinarFilter{
		Search: q.Get("q"),
	}

	switch status := types.WebinarStatus(q.Get("status")); status {
	case "", types.StatusDraft, types.StatusScheduled, types.StatusLive, types.StatusEnded:
		filter.Status = status
	default:
		httpx.Error(w, http.StatusUnprocessableEntity, "bad_status",
			"status must be draft, scheduled, live, or ended.")
		return
	}

	switch kind := q.Get("kind"); kind {
	case "", store.AdminKindWebinar, store.AdminKindMeeting, store.AdminKindSimulive:
		filter.Kind = kind
	default:
		httpx.Error(w, http.StatusUnprocessableEntity, "bad_kind",
			"kind must be webinar, meeting, or simulive.")
		return
	}

	if v := q.Get("from"); v != "" {
		t, err := time.Parse("2006-01-02", v)
		if err != nil {
			httpx.Error(w, http.StatusUnprocessableEntity, "bad_from", "from must be YYYY-MM-DD.")
			return
		}
		filter.From = t
	}
	if v := q.Get("to"); v != "" {
		t, err := time.Parse("2006-01-02", v)
		if err != nil {
			httpx.Error(w, http.StatusUnprocessableEntity, "bad_to", "to must be YYYY-MM-DD.")
			return
		}
		// End of that day, inclusive — a bare date otherwise means midnight,
		// which would exclude every webinar on the day the admin actually asked for.
		filter.To = t.Add(24*time.Hour - time.Nanosecond)
	}

	list, err := s.store.AdminWebinars(r.Context(), filter)
	if err != nil {
		s.fail(w, r, "admin webinars", err)
		return
	}
	httpx.JSON(w, http.StatusOK, list)
}

/* handleAdminStats is GET /api/admin/stats.
 *
 * A dashboard that added up GET /admin/users and GET /admin/webinars would be
 * wrong twice: users are capped at 200, so the total stops meaning "every
 * account" the moment the instance passes that, and webinars come back as the
 * full record the management list renders. Neither is a cheap way to learn
 * that one session is live. This returns the aggregates, a 28-day series with
 * the quiet days filled in, and the handful of rows the glance lists draw.
 */
func (s *Server) handleAdminStats(w http.ResponseWriter, r *http.Request) {
	stats, err := s.store.AdminStats(r.Context())
	if err != nil {
		s.fail(w, r, "admin stats", err)
		return
	}
	httpx.JSON(w, http.StatusOK, stats)
}

/* handleAdminWhatsAppUsage is GET /api/admin/stats/whatsapp?days=7|30|90.
 *
 * Which parts of the WhatsApp CRM hosts used, which is the data for deciding
 * whether reminders alone are worth selling as an add-on. Any other days is 30. */
func (s *Server) handleAdminWhatsAppUsage(w http.ResponseWriter, r *http.Request) {
	days := 30
	switch r.URL.Query().Get("days") {
	case "7":
		days = 7
	case "90":
		days = 90
	}
	usage, err := s.engage.WhatsAppUsage(r.Context(), days)
	if err != nil {
		s.fail(w, r, "admin whatsapp usage", err)
		return
	}
	httpx.JSON(w, http.StatusOK, usage)
}

// handleAdminDeleteWebinar is DELETE /api/admin/webinars/{slug} — the same
// teardown a host's own delete performs (see deleteWebinarBySlug), reachable
// here without owning the webinar. The one privilege this endpoint adds over
// the host one is exactly that: whose webinar it is stops mattering.
func (s *Server) handleAdminDeleteWebinar(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	slug := chi.URLParam(r, "slug")

	deleted, err := s.deleteWebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "admin delete webinar", err)
		return
	}

	s.logAdminAction(admin.ID, "delete", slug, "was", deleted.Status)
	s.logWebinarDeleted(slug, deleted)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "deleted"})
}

/* handleAdminDeleteUser is DELETE /api/admin/users/{id}.
 *
 * Refuses to delete the caller's own account, the same lockout
 * handleSetHostCapability applies to self-revoke and for the identical
 * reason: it is the one action with no way back from inside the app, since
 * the account that would undo it is the one just removed.
 *
 * Refuses an account that still hosts webinars with a specific, actionable
 * error rather than a raw constraint violation — see store.ErrHasWebinars.
 * Deleting those first is the admin's own explicit action (handleAdminDeleteWebinar,
 * above), not something this endpoint does on their behalf.
 */
func (s *Server) handleAdminDeleteUser(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	targetID := chi.URLParam(r, "id")

	if targetID == admin.ID {
		httpx.Error(w, http.StatusUnprocessableEntity, "cannot_self_delete",
			"You can't delete your own account.")
		return
	}

	avatarKey, err := s.store.DeleteUser(r.Context(), targetID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
		return
	case errors.Is(err, store.ErrHasWebinars):
		httpx.Error(w, http.StatusConflict, "has_webinars",
			"This account still hosts webinars. Delete those first, then delete the account.")
		return
	case err != nil:
		s.fail(w, r, "admin delete user", err)
		return
	}

	s.removeAccountFiles(r.Context(), targetID, avatarKey)
	s.log.Info("account deleted by admin", "admin", admin.ID, "target", targetID)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "deleted"})
}
