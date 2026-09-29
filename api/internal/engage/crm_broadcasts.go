package engage

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Broadcasts: one message, written once, sent to a list.
 *
 * The difference from everything else in this package is who is talking. A reminder
 * is this application telling somebody about a webinar they signed up for; a
 * broadcast is the host's own message to their own list, and the only judgement this
 * code makes about it is who may receive it.
 *
 * Which is where all the work is. Three rules, and none of them are Meta's:
 *
 *   - opt-in is required, whatever the template's category says. A broadcast is not
 *     a receipt for anything anybody asked for, so "utility" does not buy a way past
 *     the tick box. This is stricter than the one-to-one send path in crm.go on
 *     purpose: there, a host has read the conversation and is answering a person.
 *   - the audience is frozen when the broadcast is created. The count in the response
 *     is the number of messages that will be sent, not an estimate that grows while
 *     nobody is looking — a host approving 40 messages has not approved 900.
 *   - consent is checked AGAIN for every recipient at send time, by the same outbox
 *     sweep that sends reminders. Between scheduling on Monday and sending on Friday
 *     somebody can reply STOP, and the row queued for them has to notice.
 *
 * Nothing is sent from inside the request that creates it. A 900-person broadcast
 * would be 900 Graph calls with a browser waiting on them; the sweeper takes it
 * within 30 seconds and the stats endpoint is how the host watches it go.
 */

/* maxBroadcastRecipients is the largest list this will queue in one broadcast.
 *
 * A limit rather than paging: past a few thousand messages the questions are about
 * Meta's per-number throughput tier and the host's bill, and answering them by
 * quietly sending to the first 5000 of a longer list would be the worst of the
 * options. Refused with the number, so a host knows what they are up against.
 */
const maxBroadcastRecipients = 5000

// maxPickedContacts bounds a hand-picked list: a list longer than a page of ticks
// is a segment and should be sent as one.
const maxPickedContacts = 2000

/* audienceFromRequest reads an audience from a broadcast request, trimmed. */
func audienceFromRequest(body types.CRMBroadcastRequest) crmstore.Audience {
	ids := make([]string, 0, len(body.ContactIDs))
	seen := map[string]bool{}
	for _, id := range body.ContactIDs {
		id = strings.TrimSpace(id)
		if id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	return crmstore.Audience{
		Kind:        strings.TrimSpace(body.Audience),
		WebinarSlug: strings.TrimSpace(body.WebinarID),
		TagID:       strings.TrimSpace(body.TagID),
		Segment:     body.Segment,
		ContactIDs:  ids,
	}
}

// handleCRMAudience answers "how many people would this reach", before anybody
// commits to reaching them. GET for the simple audiences; POST with a broadcast body
// for segments and hand-picked lists, which do not fit a query string.
func (s *Module) handleCRMAudience(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())

	var body types.CRMBroadcastRequest
	if r.Method == http.MethodPost {
		if err := httpx.DecodeJSON(w, r, &body); err != nil {
			httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
			return
		}
	} else {
		q := r.URL.Query()
		body.Audience = q.Get("audience")
		body.WebinarID = q.Get("webinarId")
		// tagId, spelled the way webinarId beside it is and the way the request body spells
		// it — one name for one thing, since the picker posts whichever it previewed.
		body.TagID = q.Get("tagId")
	}
	a := audienceFromRequest(body)
	if !s.audienceAllowed(w, r, user, a) {
		return
	}
	counts, err := s.store.AudienceCounts(r.Context(), user.ID, a)
	if err != nil {
		s.fail(w, r, "crm audience", err)
		return
	}
	if len(body.Params) > 0 && counts.Recipients > 0 {
		samples, err := s.audienceSamples(r, user, a, body.Params)
		if err != nil {
			s.fail(w, r, "crm audience: samples", err)
			return
		}
		counts.Samples = samples
	}
	httpx.JSON(w, http.StatusOK, counts)
}

// previewSamples is how many recipients the send preview can step through.
const previewSamples = 5

/* audienceSamples fills in the params for the first few recipients, with the same
 * resolution the broadcast uses — so the preview shows what that person will actually
 * read, not a made-up example.
 */
func (s *Module) audienceSamples(r *http.Request, user store.User, a crmstore.Audience, params []types.CRMParam) ([]types.CRMAudienceSample, error) {
	ctx := r.Context()
	contacts, err := s.store.AudienceContacts(ctx, user.ID, a, previewSamples)
	if err != nil && !errors.Is(err, store.ErrConflict) {
		return nil, err
	}
	if len(contacts) > previewSamples {
		contacts = contacts[:previewSamples]
	}
	var wb types.Webinar
	var watched map[string]int
	if a.WebinarSlug != "" {
		if wb, err = s.store.WebinarBySlug(ctx, a.WebinarSlug); err != nil {
			return nil, err
		}
		if usesField(params, "watched") {
			if watched, err = s.store.ContactWatchMinutes(ctx, user.ID, a.WebinarSlug); err != nil {
				return nil, err
			}
		}
	}
	out := make([]types.CRMAudienceSample, 0, len(contacts))
	for _, c := range contacts {
		name := c.Name
		if name == "" {
			name = c.Phone
		}
		out = append(out, types.CRMAudienceSample{
			ContactID: c.ID,
			Name:      name,
			Params:    resolveBroadcastParams(params, c, wb, user.Name, watched[c.ID]),
		})
	}
	return out, nil
}

/* audienceAllowed checks the audience and the webinar it names, writing the refusal
 * itself when there is one.
 *
 * The webinar is checked for ownership even when it is only supplying merge values,
 * because "which webinar" is the one part of a broadcast that names somebody else's
 * row — and a topic and start time are exactly what a slug guesser would be after.
 */
func (s *Module) audienceAllowed(w http.ResponseWriter, r *http.Request, user store.User, a crmstore.Audience) bool {
	switch a.Kind {
	case types.AudienceOptedIn, types.AudienceWebinar:
	case types.AudienceTag:
		// The audience the tags feature exists for. Gated, because a host without it has
		// no way to put a label on anybody and a stored tag audience would then be a
		// broadcast nobody can explain.
		if !s.featureAllowed(w, user, types.FeatureWhatsAppCRM) {
			return false
		}
		if a.TagID == "" {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_tag",
				"Pick the tag whose contacts should get this.")
			return false
		}
		// Checked here rather than left to the audience query, which would simply find
		// nobody: "that tag is not one of yours" and "nobody has that tag" are different
		// answers and the host can only act on one of them.
		if !s.crmTagAllowed(w, r, user.ID, a.TagID) {
			return false
		}
	case types.AudienceSegment:
		if a.Segment == nil {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_segment",
				"Say which of this webinar's people should get this.")
			return false
		}
		g := *a.Segment
		switch g.Attendance {
		case "", types.SegmentJoined, types.SegmentNoShow:
		default:
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_segment",
				"Attendance is joined, no_show, or left out.")
			return false
		}
		if g.MinWatchMin < 0 || g.MaxWatchMin < 0 || (g.MaxWatchMin > 0 && g.MaxWatchMin <= g.MinWatchMin) {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_segment",
				"The watch-time range is empty — the upper bound has to be above the lower one.")
			return false
		}
		if g.Attendance == types.SegmentNoShow && (g.MinWatchMin > 0 || g.MaxWatchMin > 0) {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_segment",
				"Somebody who didn't join has no watch time to filter on.")
			return false
		}
		for _, t := range g.Tiers {
			switch t {
			case types.TierHigh, types.TierEngaged, types.TierPassive, types.TierRisk:
			default:
				httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_segment",
					"Engagement tiers are high, engaged, passive or risk. No-shows are chosen with attendance.")
				return false
			}
		}
		if g.Attendance == types.SegmentNoShow && len(g.Tiers) > 0 {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_segment",
				"Somebody who didn't join has no engagement score to filter on.")
			return false
		}
		if a.WebinarSlug == "" {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_webinar",
				"Pick the webinar whose people should get this.")
			return false
		}
	case types.AudienceContacts:
		if len(a.ContactIDs) == 0 {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_contacts",
				"Tick the people who should get this.")
			return false
		}
		if len(a.ContactIDs) > maxPickedContacts {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_too_many_contacts",
				"That is over "+strconv.Itoa(maxPickedContacts)+" people. Send to a filter instead.")
			return false
		}
		for _, id := range a.ContactIDs {
			if !looksLikeUUID(id) {
				httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_contacts",
					"One of those people could not be found.")
				return false
			}
		}
	default:
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_audience",
			"Send to everyone who opted in, to one webinar's people, to one tag, or to people you picked.")
		return false
	}
	if a.Kind == types.AudienceWebinar && a.WebinarSlug == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_webinar",
			"Pick the webinar whose registrants should get this.")
		return false
	}
	if a.WebinarSlug == "" {
		return true
	}
	return s.crmWebinarAllowed(w, r, user.ID, a.WebinarSlug)
}

// looksLikeUUID keeps a malformed id from reaching a ::uuid cast, which would be a 500.
func looksLikeUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
				return false
			}
		}
	}
	return true
}

// handleCRMBroadcasts lists the host's broadcasts, newest first, with their stats.
func (s *Module) handleCRMBroadcasts(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())

	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	list, err := s.store.Broadcasts(r.Context(), user.ID, limit)
	if err != nil {
		s.fail(w, r, "crm broadcasts", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.CRMBroadcastsResponse{
		Broadcasts: list,
		// The same merge fields the reminders offer, from the same place, so the
		// composer cannot offer a token the server would refuse.
		Fields:            s.fieldsFor(r.Context(), user.ID),
		WhatsAppConnected: user.WhatsAppToken != "",
	})
}

// handleCRMBroadcast reads one, which is how the UI watches a send progress.
func (s *Module) handleCRMBroadcast(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())

	b, err := s.store.Broadcast(r.Context(), user.ID, chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such broadcast.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm broadcast", err)
		return
	}
	httpx.JSON(w, http.StatusOK, b)
}

/* handleCreateCRMBroadcast writes the broadcast and queues a message per recipient.
 *
 * Creating one IS scheduling one: there is no draft, and no separate send. A draft
 * is a message nobody has decided to send, and keeping half-written ones would add a
 * state whose only behaviour is "does nothing".
 */
func (s *Module) handleCreateCRMBroadcast(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())

	var body types.CRMBroadcastRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if s.whatsapp == nil || !s.whatsapp.Enabled() {
		httpx.Error(w, http.StatusServiceUnavailable, "whatsapp_unset",
			"WhatsApp is not set up on this instance.")
		return
	}
	if user.WhatsAppToken == "" || user.WhatsAppPhoneNumberID == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "whatsapp_not_connected",
			"Connect your WhatsApp Business account in Account settings before sending.")
		return
	}

	a := audienceFromRequest(body)
	slug := a.WebinarSlug
	if !s.audienceAllowed(w, r, user, a) {
		return
	}

	// The webinar, when there is one, is loaded once here and used for every
	// recipient's topic and when — rather than re-read per contact, which for a
	// four-thousand-person list would be four thousand identical queries.
	var wb types.Webinar
	if slug != "" {
		loaded, err := s.store.WebinarBySlug(r.Context(), slug)
		if err != nil {
			s.fail(w, r, "crm broadcast: webinar", err)
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
		s.fail(w, r, "crm broadcast: template", err)
		return
	}
	if !tmpl.Sendable {
		msg := tmpl.Unsupported
		if msg == "" {
			msg = "Meta has not approved that template yet — it is " + strings.ToLower(tmpl.Status) + "."
		}
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_template_unusable", msg)
		return
	}
	if len(body.Params) != tmpl.Variables {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_template_params",
			"That template needs exactly "+strconv.Itoa(tmpl.Variables)+" value(s) filling in.")
		return
	}
	if !s.paramsAllowed(w, body.Params, slug) {
		return
	}

	/* A schedule in the past is now, not an error.
	 *
	 * "Send now" posts no time at all, and a time that has just slipped past while
	 * somebody was reading their own message back is the same intention. The outbox
	 * treats any due time at or before now the same way, so this only has to parse.
	 */
	scheduled := time.Now()
	if raw := strings.TrimSpace(body.ScheduledAt); raw != "" {
		at, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_schedule",
				"That send time could not be read.")
			return
		}
		if at.After(scheduled) {
			scheduled = at
		}
	}

	contacts, err := s.store.AudienceContacts(r.Context(), user.ID, a, maxBroadcastRecipients)
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_audience_too_large",
			"That audience is over "+strconv.Itoa(maxBroadcastRecipients)+
				" people. Narrow it down — one webinar's registrants, for instance.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm broadcast: audience", err)
		return
	}
	if len(contacts) == 0 {
		/* Refused rather than created empty, because the two readings of an empty
		 * broadcast are "it worked" and "nobody got it", and only one of them is true.
		 * The audience endpoint says which of the three reasons applies. */
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_audience_empty",
			"Nobody in that audience has opted in to WhatsApp with a number yet.")
		return
	}

	// Minutes watched, for the `watched` merge field: only read when a value uses it.
	var watched map[string]int
	if slug != "" && usesField(body.Params, "watched") {
		watched, err = s.store.ContactWatchMinutes(r.Context(), user.ID, slug)
		if err != nil {
			s.fail(w, r, "crm broadcast: watch time", err)
			return
		}
	}
	to := make([]crmstore.BroadcastRecipient, 0, len(contacts))
	for _, c := range contacts {
		to = append(to, crmstore.BroadcastRecipient{
			ContactID: c.ID,
			Params:    resolveBroadcastParams(body.Params, c, wb, user.Name, watched[c.ID]),
		})
	}

	name := strings.Join(strings.Fields(body.Name), " ")
	if name == "" {
		// The template name is a better label than a refusal is: a host who did not
		// type one still wants the broadcast in the list.
		name = tmpl.Name
	}
	id, err := s.store.CreateBroadcast(r.Context(), user.ID, crmstore.BroadcastInput{
		Name:             name,
		TemplateName:     tmpl.Name,
		TemplateLanguage: tmpl.Language,
		Params:           body.Params,
		Audience:         a.Kind,
		WebinarSlug:      slug,
		TagID:            a.TagID,
		Segment:          segmentToStore(a),
		ScheduledAt:      scheduled,
	}, to)
	if err != nil {
		s.fail(w, r, "crm broadcast: create", err)
		return
	}

	created, err := s.store.Broadcast(r.Context(), user.ID, id)
	if err != nil {
		s.fail(w, r, "crm broadcast: reload", err)
		return
	}
	s.log.Info("whatsapp broadcast queued", "host", user.ID, "broadcast", id,
		"template", tmpl.Name, "audience", a.Kind, "recipients", len(to),
		"due", scheduled.Format(time.RFC3339))
	httpx.JSON(w, http.StatusCreated, created)
}

/* paramsProblem checks what each {{n}} is filled with, and returns the refusal rather
 * than writing it — a drip step's message has to be able to say which step it is.
 *
 * A merge token has to be one this server can resolve, and topic and when have
 * nothing to resolve against unless the message names a webinar — a template that
 * said "starts on —" to four thousand people would be a worse outcome than a refusal
 * while somebody is still looking at the form.
 *
 * A literal is checked for being blank once whitespace is collapsed, because Meta
 * rejects an empty parameter and rejects the whole message with it.
 */
func paramsProblem(params []types.CRMParam, hasWebinar bool, what string) (code, msg string) {
	for i, p := range params {
		at := strconv.Itoa(i + 1)
		token := strings.TrimSpace(p.Field)
		if token == "" {
			if strings.Join(strings.Fields(p.Text), " ") == "" {
				return "crm_bad_param",
					"Value {{" + at + "}} is empty — type something or pick a field for it."
			}
			continue
		}
		if !knownMergeField(token) {
			return "crm_bad_merge_field",
				"There is nothing called " + token + " to fill a template with."
		}
		switch mergeFieldOnlyKind(token) {
		case "":
		case types.NotifyWhatsAppBroadcast:
			// `watched`: a broadcast's own field. A drip step is a broadcast too as far
			// as values go, but has no single webinar session to measure.
			if what != "broadcast" {
				return "crm_bad_merge_field",
					"Value {{" + at + "}} is " + token + ", which only has a value on a message sent after a webinar."
			}
		case types.NotifyWhatsAppReplay:
			return "crm_bad_merge_field",
				"Value {{" + at + "}} is " + token + ", which only has a value on the replay " +
					"message — a " + what + " has no recording to link to."
		default:
			return "crm_bad_merge_field",
				"Value {{" + at + "}} is " + token + ", which only has a value on a timed " +
					"reminder — a " + what + " is not sent a set time before a webinar."
		}
		if (token == "topic" || token == "when" || token == "watched") && !hasWebinar {
			return "crm_no_webinar",
				"Value {{" + at + "}} is " + token + ", so this " + what +
					" has to say which webinar it is about."
		}
	}
	return "", ""
}

// paramsAllowed is paramsProblem for a broadcast, which has one set of values and can
// refuse on the spot.
func (s *Module) paramsAllowed(w http.ResponseWriter, params []types.CRMParam, slug string) bool {
	if code, msg := paramsProblem(params, slug != "", "broadcast"); code != "" {
		httpx.Error(w, http.StatusUnprocessableEntity, code, msg)
		return false
	}
	return true
}

/* resolveBroadcastParams turns the configured entries into one recipient's values.
 *
 * At queue time, like the reminders and for the same reason: the row is the record
 * of what was promised to this person. A host who renames a webinar the day after
 * scheduling a broadcast about it has changed the webinar, not the thing four
 * thousand people are about to read.
 */
func resolveBroadcastParams(params []types.CRMParam, contact types.CRMContact, wb types.Webinar, hostName string, watchedMin int) []string {
	out := make([]string, 0, len(params))
	for _, p := range params {
		if token := strings.TrimSpace(p.Field); token != "" {
			if token == "watched" {
				out = append(out, watchedText(watchedMin))
				continue
			}
			out = append(out, mergeValue(token, contact, wb, hostName, "", 0))
			continue
		}
		// Single-spaced for Meta's sake, exactly like a merge value: a parameter with a
		// newline in it fails the send rather than the line break.
		out = append(out, strings.Join(strings.Fields(p.Text), " "))
	}
	return out
}

// segmentToStore is the rule to keep on the broadcast: only a segment audience has one.
func segmentToStore(a crmstore.Audience) *types.CRMSegment {
	if a.Kind != types.AudienceSegment {
		return nil
	}
	return a.Segment
}

// usesField reports whether any {{n}} is filled with the merge field token.
func usesField(params []types.CRMParam, token string) bool {
	for _, p := range params {
		if strings.TrimSpace(p.Field) == token {
			return true
		}
	}
	return false
}

// watchedText is the `watched` merge value: "58 minutes", "1 minute", "0 minutes".
func watchedText(min int) string {
	if min == 1 {
		return "1 minute"
	}
	return strconv.Itoa(min) + " minutes"
}

/* handleCancelCRMBroadcast stops whatever has not gone out.
 *
 * There is no unsend on WhatsApp, so this is honest about what it can do: the queued
 * messages are retired and the already-sent ones stay in the stats. A broadcast that
 * had already finished is a 422 rather than a success — a host pressing Cancel is
 * trying to stop something, and telling them they managed it would be the one lie
 * they cannot check.
 */
func (s *Module) handleCancelCRMBroadcast(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	id := chi.URLParam(r, "id")

	err := s.store.CancelBroadcast(r.Context(), user.ID, id)
	switch {
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "No such broadcast.")
		return
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_broadcast_done",
			"Nothing is left to cancel — every message has already gone out.")
		return
	case err != nil:
		s.fail(w, r, "crm broadcast: cancel", err)
		return
	}

	b, err := s.store.Broadcast(r.Context(), user.ID, id)
	if err != nil {
		s.fail(w, r, "crm broadcast: reload", err)
		return
	}
	s.log.Info("whatsapp broadcast cancelled", "host", user.ID, "broadcast", id,
		"sent", b.Stats.Sent, "skipped", b.Stats.Skipped)
	httpx.JSON(w, http.StatusOK, b)
}
