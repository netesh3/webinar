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

// handleCRMAudience answers "how many people would this reach", before anybody
// commits to reaching them.
func (s *Module) handleCRMAudience(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())

	audience := strings.TrimSpace(r.URL.Query().Get("audience"))
	slug := strings.TrimSpace(r.URL.Query().Get("webinarId"))
	// tagId, spelled the way webinarId beside it is and the way the request body spells
	// it — one name for one thing, since the picker posts whichever it previewed.
	tagID := strings.TrimSpace(r.URL.Query().Get("tagId"))
	if !s.audienceAllowed(w, r, user, audience, slug, tagID) {
		return
	}
	counts, err := s.store.AudienceCounts(r.Context(), user.ID, audience, slug, tagID)
	if err != nil {
		s.fail(w, r, "crm audience", err)
		return
	}
	httpx.JSON(w, http.StatusOK, counts)
}

/* audienceAllowed checks the audience and the webinar it names, writing the refusal
 * itself when there is one.
 *
 * The webinar is checked for ownership even when it is only supplying merge values,
 * because "which webinar" is the one part of a broadcast that names somebody else's
 * row — and a topic and start time are exactly what a slug guesser would be after.
 */
func (s *Module) audienceAllowed(w http.ResponseWriter, r *http.Request, user store.User, audience, slug, tagID string) bool {
	switch audience {
	case types.AudienceOptedIn, types.AudienceWebinar:
	case types.AudienceTag:
		// The audience the tags feature exists for. Gated, because a host without it has
		// no way to put a label on anybody and a stored tag audience would then be a
		// broadcast nobody can explain.
		if !s.featureAllowed(w, user, types.FeatureCRMTags) {
			return false
		}
		if tagID == "" {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_tag",
				"Pick the tag whose contacts should get this.")
			return false
		}
		// Checked here rather than left to the audience query, which would simply find
		// nobody: "that tag is not one of yours" and "nobody has that tag" are different
		// answers and the host can only act on one of them.
		if !s.crmTagAllowed(w, r, user.ID, tagID) {
			return false
		}
	default:
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_audience",
			"Send to everyone who opted in, to one webinar's registrants, or to one tag.")
		return false
	}
	if audience == types.AudienceWebinar && slug == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_webinar",
			"Pick the webinar whose registrants should get this.")
		return false
	}
	if slug == "" {
		return true
	}
	return s.crmWebinarAllowed(w, r, user.ID, slug)
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
		Fields:            mergeFields,
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

	audience := strings.TrimSpace(body.Audience)
	slug := strings.TrimSpace(body.WebinarID)
	tagID := strings.TrimSpace(body.TagID)
	if !s.audienceAllowed(w, r, user, audience, slug, tagID) {
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

	contacts, err := s.store.AudienceContacts(r.Context(), user.ID, audience, slug, tagID, maxBroadcastRecipients)
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

	to := make([]crmstore.BroadcastRecipient, 0, len(contacts))
	for _, c := range contacts {
		to = append(to, crmstore.BroadcastRecipient{
			ContactID: c.ID,
			Params:    resolveBroadcastParams(body.Params, c, wb, user.Name),
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
		Audience:         audience,
		WebinarSlug:      slug,
		TagID:            tagID,
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
		"template", tmpl.Name, "audience", audience, "recipients", len(to),
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
		case types.NotifyWhatsAppReplay:
			return "crm_bad_merge_field",
				"Value {{" + at + "}} is " + token + ", which only has a value on the replay " +
					"message — a " + what + " has no recording to link to."
		default:
			return "crm_bad_merge_field",
				"Value {{" + at + "}} is " + token + ", which only has a value on a timed " +
					"reminder — a " + what + " is not sent a set time before a webinar."
		}
		if (token == "topic" || token == "when") && !hasWebinar {
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
func resolveBroadcastParams(params []types.CRMParam, contact types.CRMContact, wb types.Webinar, hostName string) []string {
	out := make([]string, 0, len(params))
	for _, p := range params {
		if token := strings.TrimSpace(p.Field); token != "" {
			out = append(out, mergeValue(token, contact, wb, hostName, "", 0))
			continue
		}
		// Single-spaced for Meta's sake, exactly like a merge value: a parameter with a
		// newline in it fails the send rather than the line break.
		out = append(out, strings.Join(strings.Fields(p.Text), " "))
	}
	return out
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
