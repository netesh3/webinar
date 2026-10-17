package engage

import (
	"context"
	"errors"
	"fmt"
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
		ListID:      strings.TrimSpace(body.ListID),
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
		body.ListID = q.Get("listId")
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
	linksFor, err := s.broadcastLinks(ctx, user.ID, a.WebinarSlug, params)
	if err != nil {
		return nil, err
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
			Params:    resolveBroadcastParams(params, c, wb, user.Name, watched[c.ID], linksFor(c.ID)),
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
	case types.AudienceList:
		if !s.featureAllowed(w, user, types.FeatureWhatsAppCRM) {
			return false
		}
		if a.ListID == "" {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_list",
				"Pick the saved list that should get this.")
			return false
		}
		if _, err := s.store.List(r.Context(), user.ID, a.ListID); errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_list", "That list is not one of yours.")
			return false
		} else if err != nil {
			s.fail(w, r, "crm audience: list", err)
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
			"Send to everyone who opted in, to one webinar's people, to one tag, to a saved list, or to people you picked.")
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
	s.withHeader(r.Context(), &b)
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
	in, to, ok := s.prepareBroadcast(w, r, user, body)
	if !ok {
		return
	}
	id, err := s.store.CreateBroadcast(r.Context(), user.ID, in, to)
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
		"template", in.TemplateName, "audience", in.Audience, "recipients", len(to),
		"due", in.ScheduledAt.Format(time.RFC3339))
	s.withHeader(r.Context(), &created)
	httpx.JSON(w, http.StatusCreated, created)
}

/* prepareBroadcast checks a create or edit body and resolves who it would reach.
 *
 * The refusal is written here. ok is false when the response is already done.
 * Creating and editing share it so a scheduled broadcast can be rewritten with
 * the same rules as a new one — the audience is frozen again, not guessed.
 */
func (s *Module) prepareBroadcast(w http.ResponseWriter, r *http.Request, user store.User, body types.CRMBroadcastRequest) (crmstore.BroadcastInput, []crmstore.BroadcastRecipient, bool) {
	if s.whatsapp == nil || !s.whatsapp.Enabled() {
		httpx.Error(w, http.StatusServiceUnavailable, "whatsapp_unset",
			"WhatsApp is not set up on this instance.")
		return crmstore.BroadcastInput{}, nil, false
	}
	if user.WhatsAppToken == "" || user.WhatsAppPhoneNumberID == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "whatsapp_not_connected",
			"Connect your WhatsApp Business account in Account settings before sending.")
		return crmstore.BroadcastInput{}, nil, false
	}

	a := audienceFromRequest(body)
	slug := a.WebinarSlug
	if !s.audienceAllowed(w, r, user, a) {
		return crmstore.BroadcastInput{}, nil, false
	}

	// The webinar, when there is one, is loaded once here and used for every
	// recipient's topic and when — rather than re-read per contact, which for a
	// four-thousand-person list would be four thousand identical queries.
	var wb types.Webinar
	if slug != "" {
		loaded, err := s.store.WebinarBySlug(r.Context(), slug)
		if err != nil {
			s.fail(w, r, "crm broadcast: webinar", err)
			return crmstore.BroadcastInput{}, nil, false
		}
		wb = loaded
	}

	tmpl, err := s.templateForSend(r.Context(), user, strings.TrimSpace(body.Template), body.Language)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_template", noTemplateMessage(body.Template))
		return crmstore.BroadcastInput{}, nil, false
	}
	if err != nil {
		s.fail(w, r, "crm broadcast: template", err)
		return crmstore.BroadcastInput{}, nil, false
	}
	// A broadcast that brings its own header file can use a video or document template
	// that has no default file yet; that is the only way round Sendable here.
	ownFile := strings.TrimSpace(body.HeaderFileID) != ""
	ownCards := len(body.CardFileIDs) > 0
	fixable := tmpl.Status == "APPROVED" && tmpl.Unsupported == "" &&
		(!tmpl.NeedsHeaderFile || ownFile) && (!tmpl.NeedsCardFiles || ownCards)
	if !tmpl.Sendable && !fixable {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_template_unusable", unusableMessage(tmpl))
		return crmstore.BroadcastInput{}, nil, false
	}
	if len(body.Params) != tmpl.Variables {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_template_params",
			"That template needs exactly "+strconv.Itoa(tmpl.Variables)+" value(s) filling in.")
		return crmstore.BroadcastInput{}, nil, false
	}
	if !s.paramsAllowed(w, body.Params, slug) {
		return crmstore.BroadcastInput{}, nil, false
	}
	extras, ok := s.broadcastExtras(w, r, user, tmpl, body)
	if !ok {
		return crmstore.BroadcastInput{}, nil, false
	}
	headerFileID, useCover, ok := s.broadcastHeaderChoice(w, r, user, tmpl, body)
	if !ok {
		return crmstore.BroadcastInput{}, nil, false
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
			return crmstore.BroadcastInput{}, nil, false
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
		return crmstore.BroadcastInput{}, nil, false
	}
	if err != nil {
		s.fail(w, r, "crm broadcast: audience", err)
		return crmstore.BroadcastInput{}, nil, false
	}
	if len(contacts) == 0 {
		/* Refused rather than created empty, because the two readings of an empty
		 * broadcast are "it worked" and "nobody got it", and only one of them is true.
		 * The audience endpoint says which of the three reasons applies. */
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_audience_empty",
			"Nobody in that audience has opted in to WhatsApp with a number yet.")
		return crmstore.BroadcastInput{}, nil, false
	}

	// Minutes watched, for the `watched` merge field: only read when a value uses it.
	var watched map[string]int
	if slug != "" && usesField(body.Params, "watched") {
		watched, err = s.store.ContactWatchMinutes(r.Context(), user.ID, slug)
		if err != nil {
			s.fail(w, r, "crm broadcast: watch time", err)
			return crmstore.BroadcastInput{}, nil, false
		}
	}
	linksFor, err := s.broadcastLinks(r.Context(), user.ID, slug, body.Params)
	if err != nil {
		s.fail(w, r, "crm broadcast: join links", err)
		return crmstore.BroadcastInput{}, nil, false
	}
	to := make([]crmstore.BroadcastRecipient, 0, len(contacts))
	for _, c := range contacts {
		to = append(to, crmstore.BroadcastRecipient{
			ContactID: c.ID,
			Params:    resolveBroadcastParams(body.Params, c, wb, user.Name, watched[c.ID], linksFor(c.ID)),
		})
	}

	name := strings.Join(strings.Fields(body.Name), " ")
	if name == "" {
		// The template name is a better label than a refusal is: a host who did not
		// type one still wants the broadcast in the list.
		name = tmpl.Name
	}
	return crmstore.BroadcastInput{
		Name:             name,
		TemplateName:     tmpl.Name,
		TemplateLanguage: tmpl.Language,
		Params:           body.Params,
		Audience:         a.Kind,
		WebinarSlug:      slug,
		TagID:            a.TagID,
		ListID:           a.ListID,
		Segment:          segmentToStore(a),
		ScheduledAt:      scheduled,
		HeaderFileID:     headerFileID,
		HeaderUseCover:   useCover,
		Coupon:           extras.Coupon,
		OfferExpiresAt:   extras.OfferExpiresAt,
		CardFileIDs:      extras.CardFileIDs,
	}, to, true
}

/* broadcastExtras checks what a broadcast brings for its template beyond the header:
 * a coupon for a copy-code button, the end of a limited-time offer (required when the
 * offer has one — Meta counts down to it), and a picture per carousel card. */
func (s *Module) broadcastExtras(w http.ResponseWriter, r *http.Request, user store.User,
	tmpl types.CRMTemplate, body types.CRMBroadcastRequest) (crmstore.BroadcastHeaderInput, bool) {
	var out crmstore.BroadcastHeaderInput
	hasCoupon := false
	for _, b := range tmpl.Buttons {
		hasCoupon = hasCoupon || b.Type == "COPY_CODE"
	}
	if code := strings.TrimSpace(body.CouponCode); code != "" {
		if !hasCoupon {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_coupon", "That template has no coupon button.")
			return out, false
		}
		if len(code) > maxCouponCode || !couponChars.MatchString(code) {
			httpx.Error(w, http.StatusUnprocessableEntity, "invalid_coupon",
				"The coupon is up to 15 letters and numbers, like SAVE20.")
			return out, false
		}
		out.Coupon = code
	}
	if tmpl.Offer != nil && tmpl.Offer.HasExpiration {
		raw := strings.TrimSpace(body.OfferExpiresAt)
		at, err := time.Parse(time.RFC3339, raw)
		if raw == "" || err != nil {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_offer_expiry",
				"Choose when the offer ends — WhatsApp counts down to it.")
			return out, false
		}
		if !at.After(time.Now()) {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_offer_expiry", "The offer's end has to be in the future.")
			return out, false
		}
		out.OfferExpiresAt = &at
	} else if strings.TrimSpace(body.OfferExpiresAt) != "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_offer_expiry", "That template has no offer end to set.")
		return out, false
	}
	if len(body.CardFileIDs) > 0 {
		if len(body.CardFileIDs) != len(tmpl.Cards) {
			httpx.Error(w, http.StatusUnprocessableEntity, "invalid_cards",
				fmt.Sprintf("That carousel has %d cards; give a picture for each.", len(tmpl.Cards)))
			return out, false
		}
		for i, id := range body.CardFileIDs {
			f, err := s.store.MediaFileForHost(r.Context(), user.ID, strings.TrimSpace(id))
			if errors.Is(err, store.ErrNotFound) {
				httpx.Error(w, http.StatusUnprocessableEntity, "media_not_found",
					fmt.Sprintf("Upload card %d's picture again.", i+1))
				return out, false
			}
			if err != nil {
				s.fail(w, r, "crm broadcast: card file", err)
				return out, false
			}
			if headerMediaTypes[f.Mime].kind != strings.ToLower(tmpl.Cards[i].HeaderFormat) {
				httpx.Error(w, http.StatusUnprocessableEntity, "media_wrong_kind",
					fmt.Sprintf("Card %d needs a %s.", i+1, strings.ToLower(tmpl.Cards[i].HeaderFormat)))
				return out, false
			}
			out.CardFileIDs = append(out.CardFileIDs, f.ID)
		}
	}
	return out, true
}

/* broadcastHeaderChoice checks a broadcast's header override against its template: a
 * file of the header's kind, owned by this host, or the cover for an image header. */
func (s *Module) broadcastHeaderChoice(w http.ResponseWriter, r *http.Request, user store.User,
	tmpl types.CRMTemplate, body types.CRMBroadcastRequest) (string, bool, bool) {
	fileID := strings.TrimSpace(body.HeaderFileID)
	format := tmpl.HeaderFormat
	media := format == "IMAGE" || format == "VIDEO" || format == "DOCUMENT"
	if !media {
		if fileID != "" || body.HeaderUseCover {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_media_header",
				"That template has no image, video or document header.")
			return "", false, false
		}
		return "", false, true
	}
	if body.HeaderUseCover {
		if format != "IMAGE" {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_header_cover",
				"Only an image header can use the webinar cover.")
			return "", false, false
		}
		return "", true, true
	}
	if fileID == "" {
		return "", false, true
	}
	file, err := s.store.MediaFileForHost(r.Context(), user.ID, fileID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusUnprocessableEntity, "media_not_found", "Upload the file again.")
		return "", false, false
	}
	if err != nil {
		s.fail(w, r, "crm broadcast: header file", err)
		return "", false, false
	}
	if headerMediaTypes[file.Mime].kind != strings.ToLower(format) {
		httpx.Error(w, http.StatusUnprocessableEntity, "media_wrong_kind",
			"This template's header is "+strings.ToLower(format)+"; that file is "+headerMediaTypes[file.Mime].kind+".")
		return "", false, false
	}
	return file.ID, false, true
}

// unusableMessage is why a template cannot be sent, in words a host can act on.
func unusableMessage(tmpl types.CRMTemplate) string {
	switch {
	case tmpl.Unsupported != "":
		return tmpl.Unsupported
	case tmpl.NeedsHeaderFile:
		return "That template's header is a " + strings.ToLower(tmpl.HeaderFormat) +
			" — add the file on the WhatsApp templates page first."
	default:
		return "Meta has not approved that template yet — it is " + strings.ToLower(tmpl.Status) + "."
	}
}

// withHeader adds a broadcast's own header choice to it, for the wire.
func (s *Module) withHeader(ctx context.Context, b *types.CRMBroadcast) {
	h, err := s.store.BroadcastHeaderFor(ctx, b.ID)
	if err != nil {
		s.log.Warn("crm broadcast: header choice", "broadcast", b.ID, "error", err)
		return
	}
	b.HeaderFile = s.fileJSON(h.File)
	b.HeaderUseCover = h.UseCover
	b.CouponCode = h.Coupon
	if h.OfferExpiresAt != nil {
		b.OfferExpiresAt = h.OfferExpiresAt.UTC().Format(time.RFC3339)
	}
	for i := range h.CardFiles {
		b.CardFiles = append(b.CardFiles, *s.fileJSON(&h.CardFiles[i]))
	}
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
		if (needsWebinar(token) || token == "watched") && !hasWebinar {
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
func resolveBroadcastParams(params []types.CRMParam, contact types.CRMContact, wb types.Webinar, hostName string, watchedMin int, links mergeLinks) []string {
	out := make([]string, 0, len(params))
	for _, p := range params {
		if token := strings.TrimSpace(p.Field); token != "" {
			if token == "watched" {
				out = append(out, watchedText(watchedMin))
				continue
			}
			out = append(out, mergeValue(token, contact, wb, hostName, "", 0, links))
			continue
		}
		// Single-spaced for Meta's sake, exactly like a merge value: a parameter with a
		// newline in it fails the send rather than the line break.
		out = append(out, strings.Join(strings.Fields(p.Text), " "))
	}
	return out
}

/* broadcastLinks gives each recipient's link fields for a broadcast about slug. Join
 * links are read for the whole webinar in one query, and only when a value uses them;
 * a contact with no registration for it gets the webinar's page. */
func (s *Module) broadcastLinks(ctx context.Context, hostID, slug string, params []types.CRMParam) (func(contactID string) mergeLinks, error) {
	page := s.webinarPage(slug)
	if slug == "" || !usesField(params, "join_link") {
		return func(string) mergeLinks { return mergeLinks{Webinar: page} }, nil
	}
	keys, err := s.store.ContactJoinKeys(ctx, hostID, slug)
	if err != nil {
		return nil, err
	}
	return func(contactID string) mergeLinks {
		k, ok := keys[contactID]
		switch {
		case !ok || k.JoinKey == "" && k.ZoomURL == "":
			return mergeLinks{Webinar: page}
		case k.ZoomURL != "":
			return mergeLinks{Webinar: page, Join: k.ZoomURL}
		default:
			return mergeLinks{Webinar: page, Join: page + "/room?k=" + k.JoinKey}
		}
	}, nil
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
	s.withHeader(r.Context(), &b)
	httpx.JSON(w, http.StatusOK, b)
}

/* handleUpdateCRMBroadcast rewrites one that has not started sending.
 *
 * Same body as create. The audience is resolved again and the queued rows are
 * replaced, so the count in the response is the new list. Once anything has gone
 * out — or the broadcast was cancelled — it is refused: those messages are already
 * somebody's chat, and editing must not pretend otherwise.
 */
func (s *Module) handleUpdateCRMBroadcast(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	id := chi.URLParam(r, "id")

	// Before the body, so another host's id is a 404 even with an empty request.
	existing, err := s.store.Broadcast(r.Context(), user.ID, id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such broadcast.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm broadcast: update", err)
		return
	}
	if existing.Status != "scheduled" {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_broadcast_started",
			"This broadcast can no longer be edited.")
		return
	}

	var body types.CRMBroadcastRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	in, to, ok := s.prepareBroadcast(w, r, user, body)
	if !ok {
		return
	}
	err = s.store.ReplaceScheduledBroadcast(r.Context(), user.ID, id, in, to)
	switch {
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "No such broadcast.")
		return
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_broadcast_started",
			"This broadcast can no longer be edited.")
		return
	case err != nil:
		s.fail(w, r, "crm broadcast: update", err)
		return
	}

	updated, err := s.store.Broadcast(r.Context(), user.ID, id)
	if err != nil {
		s.fail(w, r, "crm broadcast: reload", err)
		return
	}
	s.log.Info("whatsapp broadcast updated", "host", user.ID, "broadcast", id,
		"template", in.TemplateName, "audience", in.Audience, "recipients", len(to))
	s.withHeader(r.Context(), &updated)
	httpx.JSON(w, http.StatusOK, updated)
}

/* handleDeleteCRMBroadcast hides one from the list.
 *
 * Scheduled and still-sending broadcasts also stop: pending rows are retired and
 * nothing further goes out. Sent messages stay in the conversation, and the row
 * stays in the database so metrics that count those messages keep counting them.
 */
func (s *Module) handleDeleteCRMBroadcast(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	id := chi.URLParam(r, "id")

	err := s.store.DeleteBroadcast(r.Context(), user.ID, id)
	switch {
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "No such broadcast.")
		return
	case err != nil:
		s.fail(w, r, "crm broadcast: delete", err)
		return
	}
	s.log.Info("whatsapp broadcast deleted", "host", user.ID, "broadcast", id)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "deleted"})
}
