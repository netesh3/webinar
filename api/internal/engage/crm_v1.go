package engage

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/wa"
	"github.com/netkumar/webcast/api/types"
)

/* Engage v1's endpoints: the People and Messages tabs on Hosting, a webinar's Messages
 * tab, the bell's reply count, and a test send. See docs/engage/V1.md.
 */

// handleCRMPeople is the People tab.
func (s *Module) handleCRMPeople(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	f, ok := s.peopleFilter(w, r)
	if !ok {
		return
	}
	out, err := s.store.People(r.Context(), user.ID, f)
	if errors.Is(err, store.ErrInvalid) {
		httpx.Error(w, http.StatusBadRequest, "bad_filter", "There is no such filter.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm people", err)
		return
	}
	out.WhatsAppConnected = user.WhatsAppToken != "" && user.WhatsAppPhoneNumberID != ""
	httpx.JSON(w, http.StatusOK, out)
}

// handleCRMPeopleIDs is every messageable contact a People filter matches, so "Message
// these N" can send to a filter bigger than a page.
func (s *Module) handleCRMPeopleIDs(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	f, ok := s.peopleFilter(w, r)
	if !ok {
		return
	}
	ids, err := s.store.PeopleContactIDs(r.Context(), user.ID, f, maxPickedContacts)
	if errors.Is(err, store.ErrInvalid) {
		httpx.Error(w, http.StatusBadRequest, "bad_filter", "There is no such filter.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm people ids", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.CRMContactIDsResponse{ContactIDs: ids})
}

func (s *Module) peopleFilter(w http.ResponseWriter, r *http.Request) (crmstore.PeopleFilter, bool) {
	user := authctx.User(r.Context())
	q := r.URL.Query()
	f := crmstore.PeopleFilter{
		WebinarSlug: strings.TrimSpace(q.Get("webinarId")),
		Filter:      strings.TrimSpace(q.Get("filter")),
		Query:       strings.TrimSpace(q.Get("q")),
	}
	f.Offset, _ = strconv.Atoi(q.Get("offset"))
	f.Limit, _ = strconv.Atoi(q.Get("limit"))
	if f.WebinarSlug != "" && !s.crmWebinarAllowed(w, r, user.ID, f.WebinarSlug) {
		return f, false
	}
	return f, true
}

// handleCRMInbox is the Messages tab's list.
func (s *Module) handleCRMInbox(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	slug := strings.TrimSpace(r.URL.Query().Get("webinarId"))
	if slug != "" && !s.crmWebinarAllowed(w, r, user.ID, slug) {
		return
	}
	out, err := s.store.Inbox(r.Context(), user.ID, strings.TrimSpace(r.URL.Query().Get("view")), slug)
	if errors.Is(err, store.ErrInvalid) {
		httpx.Error(w, http.StatusBadRequest, "bad_view", "There is no such view.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm inbox", err)
		return
	}
	out.WhatsAppConnected = user.WhatsAppToken != "" && user.WhatsAppPhoneNumberID != ""
	if coex, err := s.store.Coexistence(r.Context(), user.ID); err == nil {
		out.Coexistence = coex
	}
	httpx.JSON(w, http.StatusOK, out)
}

// handleCRMInboxDone is Mark done, and its undo.
func (s *Module) handleCRMInboxDone(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	id := chi.URLParam(r, "id")
	var body types.CRMDoneRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if !looksLikeUUID(id) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such contact.")
		return
	}
	err := s.store.SetInboxDone(r.Context(), user.ID, id, body.Done)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such contact.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm inbox done", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleCRMReplies is the bell's count of conversations waiting.
func (s *Module) handleCRMReplies(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	out, err := s.store.Replies(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "crm replies", err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// handleCRMWebinarMessages is one webinar's Messages tab.
func (s *Module) handleCRMWebinarMessages(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	slug := chi.URLParam(r, "slug")
	if !s.crmWebinarAllowed(w, r, user.ID, slug) {
		return
	}
	ctx := r.Context()
	out := types.CRMWebinarMessagesResponse{
		WebinarID:         slug,
		WhatsAppConnected: user.WhatsAppToken != "" && user.WhatsAppPhoneNumberID != "",
	}
	var err error
	if out.Audience, err = s.store.AudienceCounts(ctx, user.ID,
		crmstore.Audience{Kind: types.AudienceWebinar, WebinarSlug: slug}); err != nil {
		s.fail(w, r, "crm webinar messages: audience", err)
		return
	}
	if out.Automatic, err = s.store.WebinarAutomatic(ctx, user.ID, slug); err != nil {
		s.fail(w, r, "crm webinar messages: automatic", err)
		return
	}
	if out.Templates, err = s.store.ReminderTemplates(ctx, user.ID); err != nil {
		s.fail(w, r, "crm webinar messages: templates", err)
		return
	}
	if out.Broadcasts, err = s.store.WebinarBroadcasts(ctx, user.ID, slug); err != nil {
		s.fail(w, r, "crm webinar messages: broadcasts", err)
		return
	}
	if out.Waiting, err = s.store.WebinarWaiting(ctx, user.ID, slug); err != nil {
		s.fail(w, r, "crm webinar messages: waiting", err)
		return
	}
	if out.Results, err = s.store.WebinarResults(ctx, user.ID, slug); err != nil {
		s.fail(w, r, "crm webinar messages: results", err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// handleCRMSummary is the Hosting home's "WhatsApp this week" card.
func (s *Module) handleCRMSummary(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	out, err := s.store.Summary(r.Context(), user.ID, 7)
	if err != nil {
		s.fail(w, r, "crm summary", err)
		return
	}
	out.Connected = user.WhatsAppToken != "" && user.WhatsAppPhoneNumberID != ""
	httpx.JSON(w, http.StatusOK, out)
}

/* handleCRMTestSend sends a template once to a number the host names — their own — so
 * they can see it on a phone before sending it to hundreds. Not recorded as a
 * conversation: the host is not a contact. Merge values are the example ones, filled
 * from the webinar when one is named. */
func (s *Module) handleCRMTestSend(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	var body types.CRMTestSendRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if s.whatsapp == nil || !s.whatsapp.Enabled() {
		httpx.Error(w, http.StatusServiceUnavailable, "whatsapp_unset", "WhatsApp is not set up on this instance.")
		return
	}
	if user.WhatsAppToken == "" || user.WhatsAppPhoneNumberID == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "whatsapp_not_connected",
			"Connect your WhatsApp Business account before sending.")
		return
	}
	phone := store.NormalisePhone(body.Phone)
	if phone == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "bad_phone", "Give the number to send the test to, with its country code.")
		return
	}
	slug := strings.TrimSpace(body.WebinarID)
	var wb types.Webinar
	if slug != "" {
		if !s.crmWebinarAllowed(w, r, user.ID, slug) {
			return
		}
		loaded, err := s.store.WebinarBySlug(r.Context(), slug)
		if err != nil {
			s.fail(w, r, "crm test send: webinar", err)
			return
		}
		wb = loaded
	}
	tmpl, err := s.templateForSend(r.Context(), user, strings.TrimSpace(body.Template), body.Language)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_template",
			"That template is not in your WhatsApp account. Refresh your templates and try again.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm test send: template", err)
		return
	}
	if !tmpl.Sendable {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_template_unusable",
			"Meta has not approved that template yet.")
		return
	}
	if len(body.Params) != tmpl.Variables {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_template_params",
			"That template needs exactly "+strconv.Itoa(tmpl.Variables)+" value(s) filling in.")
		return
	}
	me := types.CRMContact{Name: user.Name, Phone: phone}
	params := resolveBroadcastParams(body.Params, me, wb, user.Name, 58)
	if _, err := s.whatsapp.SendTemplate(r.Context(), user.WhatsAppToken, user.WhatsAppPhoneNumberID,
		wa.OutgoingTemplate{To: phone, Name: tmpl.Name, Language: tmpl.Language, BodyParams: params}); err != nil {
		s.noteWhatsAppError(r.Context(), user.ID, user.WhatsAppToken, err)
		s.reportSendError(w, r, user.ID, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
