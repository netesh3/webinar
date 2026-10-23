package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Recording retention, "Keep longer", the recording storage quota and the expiry reminders.
 *
 * The rules (types.RecordingKeepMonths and the comment above it, migrations/0148):
 *
 *   expiry      the host's retention days (Admin -> Accounts, else RECORDINGS_RETENTION_DAYS)
 *               after the session's last take stopped, or keep_until when later.
 *   Keep longer expiry in effect + 3 months, repeatable — refused (409 quota_exceeded)
 *               while the host's ready recordings total more than their quota, and always
 *               for a recording started while they were over it.
 *   new cloud   never refused for storage: a live session is not the place. Over 90% of
 *   recordings  the quota the start response carries a warning; over 100% the recording is
 *               flagged over_quota and gets the default retention only.
 *   reminders   7 days and 1 day before expiry, one email + one bell per host per sweep,
 *               once per recording per expiry per stage. "Let it expire" stops them.
 */

func recordingExpiresAt(createdAt string, days int) string {
	if days <= 0 || createdAt == "" {
		return ""
	}
	t, err := time.Parse(time.RFC3339, createdAt)
	if err != nil {
		t, err = time.Parse(time.RFC3339Nano, createdAt)
		if err != nil {
			return ""
		}
	}
	return t.Add(time.Duration(days) * 24 * time.Hour).UTC().Format(time.RFC3339)
}

// stampRecording is the default window, for a recording that has only just started.
func (s *Server) stampRecording(rec *types.Recording) {
	days := s.cfg.RecordingsRetentionDays
	rec.RetentionDays = days
	rec.ExpiresAt = recordingExpiresAt(rec.CreatedAt, days)
}

// stampPublicRecording fills a replay page's expiry from the session's own.
func (s *Server) stampPublicRecording(ctx context.Context, slug string, rec *types.PublicRecording) {
	rec.RetentionDays = s.cfg.RecordingsRetentionDays
	rec.ExpiresAt = recordingExpiresAt(rec.CreatedAt, rec.RetentionDays)
	if rec.RetentionDays <= 0 {
		return
	}
	if hostID, err := s.store.HostIDFor(ctx, slug); err == nil {
		if st, err := s.store.RecordingStorageFor(ctx, hostID, s.cfg.RecordingsRetentionDays); err == nil {
			rec.RetentionDays = st.RetentionDays
		}
	}
	if got, err := s.store.RecordingRetentions(ctx, []string{rec.ID}, s.cfg.RecordingsRetentionDays); err == nil {
		if rr, ok := got[rec.ID]; ok && rr.ExpiresAt != nil {
			rec.ExpiresAt = rr.ExpiresAt.UTC().Format(time.RFC3339)
		}
	}
}

/* stampRecordings fills each session's expiry, whether it was kept longer, and whether
 * "Keep longer" would be accepted now. One read for the host's meter, one for the list. */
func (s *Server) stampRecordings(ctx context.Context, slug string, list []types.Recording) {
	for i := range list {
		s.stampRecording(&list[i])
	}
	if len(list) == 0 || s.cfg.RecordingsRetentionDays <= 0 {
		return
	}
	overQuota := false
	if hostID, err := s.store.HostIDFor(ctx, slug); err == nil {
		if st, err := s.store.RecordingStorageFor(ctx, hostID, s.cfg.RecordingsRetentionDays); err == nil {
			overQuota = st.OverQuota
			for i := range list {
				list[i].RetentionDays = st.RetentionDays
			}
		}
	}
	ids := make([]string, len(list))
	for i, r := range list {
		ids[i] = r.ID
	}
	got, err := s.store.RecordingRetentions(ctx, ids, s.cfg.RecordingsRetentionDays)
	if err != nil {
		s.log.Warn("recording retention: could not read expiries", "slug", slug, "error", err)
		return
	}
	for i := range list {
		rr, ok := got[list[i].ID]
		if !ok {
			continue
		}
		if rr.ExpiresAt != nil {
			list[i].ExpiresAt = rr.ExpiresAt.UTC().Format(time.RFC3339)
		}
		list[i].Extended = rr.Extended
		list[i].OverQuota = rr.OverQuota
		list[i].RemindersOff = rr.RemindersOff
		list[i].CanExtend = list[i].Status == types.RecordingReady && !rr.OverQuota && !overQuota && rr.ExpiresAt != nil
	}
}

// stampRecordingSummaryExpiry adds the soonest expiry to the Completed list's badges.
func (s *Server) stampRecordingSummaryExpiry(ctx context.Context, recs map[string]types.HostRecordingSummary) {
	if len(recs) == 0 || s.cfg.RecordingsRetentionDays <= 0 {
		return
	}
	slugs := make([]string, 0, len(recs))
	for slug := range recs {
		slugs = append(slugs, slug)
	}
	got, err := s.store.RecordingSoonestExpiries(ctx, slugs, s.cfg.RecordingsRetentionDays)
	if err != nil {
		s.log.Warn("recording retention: could not read list expiries", "error", err)
		return
	}
	for slug, at := range got {
		if sum, ok := recs[slug]; ok {
			sum.ExpiresAt = at.UTC().Format(time.RFC3339)
			recs[slug] = sum
		}
	}
}

// gbText is a byte count the way the meter says it: "6.2 GB".
func gbText(n int64) string {
	gb := float64(n) / (1 << 30)
	if gb >= 10 || gb == float64(int64(gb)) {
		return strconv.FormatFloat(gb, 'f', 0, 64) + " GB"
	}
	return strconv.FormatFloat(gb, 'f', 1, 64) + " GB"
}

func quotaExceededMessage(st types.RecordingStorage) string {
	return fmt.Sprintf("You're using %s of your %s recording storage, so recordings can't be kept longer right now. "+
		"Delete recordings you no longer need, let others expire, or upgrade your plan for more space.",
		gbText(st.UsedBytes), gbText(st.QuotaBytes))
}

/* recordingStartStorage is the storage check when a cloud recording starts: never a refusal.
 * Over quota, the new session is flagged (default retention, no "Keep longer"); at or past
 * RecordingQuotaWarnPercent, the returned line is shown in the room. */
func (s *Server) recordingStartStorage(ctx context.Context, hostID, recordingID string) string {
	st, err := s.store.RecordingStorageFor(ctx, hostID, s.cfg.RecordingsRetentionDays)
	if err != nil || st.QuotaBytes <= 0 {
		return ""
	}
	if st.UsedBytes > st.QuotaBytes {
		if err := s.store.MarkRecordingOverQuota(ctx, recordingID); err != nil {
			s.log.Warn("recording quota: could not flag", "recording", recordingID, "error", err)
		}
		return fmt.Sprintf("Recording storage is full (%s of %s). This recording is kept for %d days and can't be kept longer — "+
			"delete old recordings or upgrade for more space.", gbText(st.UsedBytes), gbText(st.QuotaBytes), st.RetentionDays)
	}
	if st.UsedBytes*100 >= st.QuotaBytes*types.RecordingQuotaWarnPercent {
		return fmt.Sprintf("Recording storage is almost full: %s of %s used.", gbText(st.UsedBytes), gbText(st.QuotaBytes))
	}
	return ""
}

// handleRecordingStorage is GET /api/host/recording-storage: the caller's meter.
func (s *Server) handleRecordingStorage(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	st, err := s.store.RecordingStorageFor(r.Context(), user.ID, s.cfg.RecordingsRetentionDays)
	if err != nil {
		s.fail(w, r, "recording storage", err)
		return
	}
	httpx.JSON(w, http.StatusOK, st)
}

/* keepRecording is "Keep longer" for the session holding id, on behalf of hostID. onlyIf is
 * the expiry an email link was about (nil from the card). Writes the refusal itself and
 * reports ok=false; moved=false means the expiry was not onlyIf any more (a reused link). */
func (s *Server) keepRecording(w http.ResponseWriter, r *http.Request, own store.RecordingOwner, onlyIf *time.Time) (time.Time, bool, bool) {
	if s.cfg.RecordingsRetentionDays <= 0 || own.ExpiresAt == nil {
		httpx.Error(w, http.StatusConflict, "no_expiry", "Recordings on this server are kept until you delete them.")
		return time.Time{}, false, false
	}
	if !own.Ready {
		httpx.Error(w, http.StatusConflict, "not_ready", "This recording isn't ready yet, so there's nothing to keep.")
		return time.Time{}, false, false
	}
	st, err := s.store.RecordingStorageFor(r.Context(), own.HostID, s.cfg.RecordingsRetentionDays)
	if err != nil {
		s.fail(w, r, "keep recording: storage", err)
		return time.Time{}, false, false
	}
	if own.OverQuota || st.OverQuota {
		msg := quotaExceededMessage(st)
		if own.OverQuota && !st.OverQuota {
			msg = "This recording was made while your recording storage was full, so it's kept for the standard " +
				strconv.Itoa(st.RetentionDays) + " days only. Download a copy to keep it."
		}
		httpx.JSON(w, http.StatusConflict, types.RecordingQuotaError{
			Error: "quota_exceeded", Message: msg, UsedBytes: st.UsedBytes, QuotaBytes: st.QuotaBytes,
		})
		return time.Time{}, false, false
	}
	at, moved, err := s.store.ExtendRecording(r.Context(), own.SessionID, s.cfg.RecordingsRetentionDays, onlyIf)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That recording has already been deleted.")
		return time.Time{}, false, false
	}
	if err != nil {
		s.fail(w, r, "keep recording", err)
		return time.Time{}, false, false
	}
	if moved {
		s.log.Info("recording kept longer", "slug", own.Webinar, "recording", own.SessionID, "expiresAt", at)
	}
	return at, moved, true
}

// recordingOwnedHere loads id's session for the webinar's owner, writing a refusal otherwise.
func (s *Server) recordingOwnedHere(w http.ResponseWriter, r *http.Request) (store.RecordingOwner, bool) {
	slug := slugFromContext(r.Context())
	id := chi.URLParam(r, "id")
	if stageRoleFromContext(r.Context()) != types.RoleHost {
		httpx.Error(w, http.StatusForbidden, "host_only", "Only the host can change how long a recording is kept.")
		return store.RecordingOwner{}, false
	}
	if _, err := s.store.RecordingFor(r.Context(), slug, id); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such recording.")
		return store.RecordingOwner{}, false
	} else if err != nil {
		s.fail(w, r, "recording retention: lookup", err)
		return store.RecordingOwner{}, false
	}
	own, err := s.store.RecordingOwnerOf(r.Context(), id, s.cfg.RecordingsRetentionDays)
	if err != nil {
		s.fail(w, r, "recording retention: owner", err)
		return store.RecordingOwner{}, false
	}
	return own, true
}

// respondRecording writes the session holding id as the list shows it.
func (s *Server) respondRecording(w http.ResponseWriter, r *http.Request, slug, id string) {
	list, err := s.store.Recordings(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "recording retention: reload", err)
		return
	}
	s.stampRecordings(r.Context(), slug, list)
	s.stampRecordingCaptions(r.Context(), slug, list)
	for _, rec := range list {
		if rec.ID == id {
			httpx.JSON(w, http.StatusOK, rec)
			return
		}
	}
	httpx.Error(w, http.StatusNotFound, "not_found", "No such recording.")
}

// handleKeepRecording is POST /api/host/webinars/{slug}/recordings/{id}/keep: "Keep longer".
func (s *Server) handleKeepRecording(w http.ResponseWriter, r *http.Request) {
	own, ok := s.recordingOwnedHere(w, r)
	if !ok {
		return
	}
	if _, _, ok := s.keepRecording(w, r, own, nil); !ok {
		return
	}
	s.respondRecording(w, r, own.Webinar, own.SessionID)
}

// handleLetRecordingExpire is POST /api/host/webinars/{slug}/recordings/{id}/let-expire.
func (s *Server) handleLetRecordingExpire(w http.ResponseWriter, r *http.Request) {
	own, ok := s.recordingOwnedHere(w, r)
	if !ok {
		return
	}
	if s.cfg.RecordingsRetentionDays <= 0 || own.ExpiresAt == nil {
		httpx.Error(w, http.StatusConflict, "no_expiry", "Recordings on this server are kept until you delete them.")
		return
	}
	at, err := s.store.LetRecordingExpire(r.Context(), own.SessionID, s.cfg.RecordingsRetentionDays)
	if err != nil {
		s.fail(w, r, "let recording expire", err)
		return
	}
	s.log.Info("recording set to expire", "slug", own.Webinar, "recording", own.SessionID, "expiresAt", at)
	s.respondRecording(w, r, own.Webinar, own.SessionID)
}

// keepLinkSig signs one email link: this recording, this host, this expiry.
func (s *Server) keepLinkSig(recordingID, hostID string, expires int64) string {
	m := hmac.New(sha256.New, []byte(s.cfg.SessionSecret))
	m.Write([]byte("recording-keep\x00" + recordingID + "\x00" + hostID + "\x00" + strconv.FormatInt(expires, 10)))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// keepLinkURL is the "Keep 3 more months" link in an expiry email.
func (s *Server) keepLinkURL(recordingID, hostID string, expiresAt time.Time) string {
	e := expiresAt.Unix()
	q := url.Values{}
	q.Set("r", recordingID)
	q.Set("e", strconv.FormatInt(e, 10))
	q.Set("s", s.keepLinkSig(recordingID, hostID, e))
	return strings.TrimRight(s.cfg.WebBaseURL, "/") + "/recordings/keep?" + q.Encode()
}

/* handleKeepRecordingLink is POST /api/host/recordings/keep-link: what the email link's page
 * sends once the host is signed in. The signature is for the signed-in account, so a link
 * forwarded to somebody else does nothing for them; and it names the expiry the email was
 * about, so pressing it twice keeps the recording 3 months, not 6. */
func (s *Server) handleKeepRecordingLink(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	var body types.KeepRecordingLinkRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	want := s.keepLinkSig(body.Recording, user.ID, body.Expires)
	if body.Recording == "" || body.Expires <= 0 || !hmac.Equal([]byte(want), []byte(body.Sig)) {
		httpx.Error(w, http.StatusForbidden, "bad_link",
			"This link isn't valid for the account you're signed in with. Sign in as the host who got the email.")
		return
	}
	own, err := s.store.RecordingOwnerOf(r.Context(), body.Recording, s.cfg.RecordingsRetentionDays)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That recording has already been deleted.")
		return
	}
	if err != nil {
		s.fail(w, r, "keep link: owner", err)
		return
	}
	if own.HostID != user.ID {
		httpx.Error(w, http.StatusForbidden, "bad_link", "That recording isn't yours.")
		return
	}
	expires := time.Unix(body.Expires, 0)
	at, moved, ok := s.keepRecording(w, r, own, &expires)
	if !ok {
		return
	}
	status := "kept"
	if !moved {
		status = "already_kept"
	}
	httpx.JSON(w, http.StatusOK, types.KeepRecordingLinkResponse{
		Status: status, Webinar: own.Webinar, Topic: own.Topic, ExpiresAt: at.UTC().Format(time.RFC3339),
	})
}

/* handleSetUserRecordingStorage is PATCH /api/admin/users/{id}/recording-storage: one
 * account's recording storage (over its plan's) and default retention days (over the
 * deployment's). Null puts either back. Lowering the quota deletes nothing; it stops
 * "Keep longer" until the account is back under it. */
func (s *Server) handleSetUserRecordingStorage(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	targetID := chi.URLParam(r, "id")
	var body types.SetUserRecordingStorageRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if q := body.RecordingQuotaBytes; q != nil && (*q <= 0 || *q > int64(types.MaxRecordingQuotaGB)<<30) {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_recording_quota",
			fmt.Sprintf("Recording storage is above 0 and at most %d GB, or blank for the plan's.", types.MaxRecordingQuotaGB))
		return
	}
	if d := body.RecordingRetentionDays; d != nil && (*d < 1 || *d > types.MaxRecordingRetentionDays) {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_retention_days",
			fmt.Sprintf("Retention is 1 to %d days, or blank for the default.", types.MaxRecordingRetentionDays))
		return
	}
	err := s.store.SetUserRecordingStorage(r.Context(), targetID, body.RecordingQuotaBytes, body.RecordingRetentionDays)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
		return
	}
	if err != nil {
		s.fail(w, r, "set recording storage", err)
		return
	}
	s.log.Info("user recording storage changed", "admin", admin.ID, "target", targetID,
		"recording_quota_bytes", body.RecordingQuotaBytes, "recording_retention_days", body.RecordingRetentionDays)
	st, err := s.store.RecordingStorageFor(r.Context(), targetID, s.cfg.RecordingsRetentionDays)
	if err != nil {
		s.fail(w, r, "set recording storage: read back", err)
		return
	}
	httpx.JSON(w, http.StatusOK, st)
}

/* sweepRecordingExpiryReminders sends the 7-day and 1-day reminders: one email and one bell
 * per host for everything that reached a stage since the last pass. */
func (s *Server) sweepRecordingExpiryReminders(ctx context.Context) {
	due, err := s.store.DueExpiryReminders(ctx, s.cfg.RecordingsRetentionDays, 500)
	if err != nil {
		s.log.Error("recording reminders: query failed", "error", err)
		return
	}
	queued := false
	for start := 0; start < len(due); {
		end := start
		for end < len(due) && due[end].HostID == due[start].HostID {
			end++
		}
		batch := due[start:end]
		start = end
		if ctx.Err() != nil {
			break
		}
		ok, err := s.store.QueueExpiryReminder(ctx, batch, s.expiryReminderMessages)
		if err != nil {
			s.log.Error("recording reminders: queue failed", "host", batch[0].HostID, "error", err)
			continue
		}
		if ok {
			queued = true
			s.log.Info("recording reminders: queued", "host", batch[0].HostID, "recordings", len(batch))
		}
	}
	if queued {
		s.flushMailSoon()
	}
}

// expiryReminderMessages is one host's bell and email for the recordings in batch.
func (s *Server) expiryReminderMessages(batch []store.ExpiringRecording) []store.Notification {
	host := batch[0]
	base := strings.TrimRight(s.cfg.WebBaseURL, "/")
	n := notify.RecordingExpiryNotice{
		Product: s.cfg.AppName, HostName: host.HostName, KeepMonths: types.RecordingKeepMonths, Now: time.Now(),
	}
	oneWebinar := host.Webinar
	for _, e := range batch {
		if e.Webinar != oneWebinar {
			oneWebinar = ""
		}
		n.Items = append(n.Items, notify.ExpiringItem{
			Topic: e.Topic, CreatedAt: e.CreatedAt, ExpiresAt: e.ExpiresAt, SizeBytes: e.SizeBytes,
			KeepURL: s.keepLinkURL(e.ID, e.HostID, e.ExpiresAt),
			OpenURL: base + "/host/" + url.PathEscape(e.Webinar) + "?tab=recording",
		})
	}
	subject, text, alert := notify.RecordingExpiryEmail(n)
	msgs := []store.Notification{{
		UserID: host.HostID, Kind: types.NotifyRecordingExpiring, WebinarSlug: oneWebinar,
		Subject: subject, Body: alert,
	}}
	email := strings.ToLower(strings.TrimSpace(host.HostEmail))
	if email != "" && !strings.HasSuffix(email, ".invalid") {
		msgs = append(msgs, store.Notification{
			Email: email, Kind: types.NotifyRecordingExpiring, Subject: subject, Body: text,
		})
	}
	return msgs
}
