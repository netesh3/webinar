package engage

import (
	"context"
	"errors"
	"github.com/netkumar/webcast/api/internal/notify"
	"net/http"
	"slices"
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

/* Drips: a sequence that sends itself, to people who have not registered yet.
 *
 * The third way to send a WhatsApp message in this CRM and the first one where nobody
 * is present when it happens. A reminder is tied to a webinar's clock, a broadcast to
 * a moment the host picked; a drip is a rule that keeps applying, and everything
 * awkward about it follows from that:
 *
 *   - the audience cannot be frozen, because it does not exist yet. What is frozen
 *     instead is entry: one enrollment per person per sequence, for ever, so a second
 *     registration does not restart a five-message sequence somebody already had.
 *   - a step's values are resolved when the step comes due, not when the person was
 *     enrolled. The third message of a sequence is composed two days after the first
 *     and the row still records what was promised to that person at that moment.
 *   - consent is checked three times: at entry, when a step is queued, and again by
 *     the outbox at send. A sequence running for a month is a month of chances for
 *     somebody to change their mind, and the answer to "they said stop" is to close
 *     the enrollment rather than to leave a message pending for ever.
 *
 * The webinar triggers all follow the webinar's own WhatsApp switch. A host who turned
 * WhatsApp off for a webinar did not mean "except for the sequence", and one switch
 * meaning "no WhatsApp about this webinar" is a thing a host can hold in their head.
 *
 * Only templates. The plan allowed a free-form step inside Meta's 24-hour window, and
 * a drip is exactly where that cannot be relied on: a step due two days after somebody
 * entered is outside the window by construction, and a step that silently does not
 * send is worse than one that needed approving.
 */

const (
	// maxDripSteps matches the CHECK in migrations/0046. A bound rather than a
	// judgement about sequences: fifty messages to one person is already a problem
	// this code should not be the thing that allows.
	maxDripSteps = 50
	// maxDripDelayMinutes is 90 days, the same bound the column has. Past that a host
	// is describing a campaign for next quarter, and a sequence is the wrong shape.
	maxDripDelayMinutes = 90 * 24 * 60
	// How many enrollments one sweep will advance. A hundred queued messages every
	// thirty seconds is comfortably inside Cloud API's throughput and is a bound on
	// what one misconfigured drip can do in a minute.
	dripStepsPerSweep = 100
)

// handleCRMDrips lists the host's sequences, newest first, with their steps and stats.
func (s *Module) handleCRMDrips(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())

	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	list, err := s.store.Drips(r.Context(), user.ID, limit)
	if err != nil {
		s.fail(w, r, "crm drips", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.CRMDripsResponse{
		Drips: list,
		// The same merge fields and the same triggers the server enforces, so the
		// builder cannot offer either one this code would refuse.
		Fields:            s.fieldsFor(r.Context(), user.ID),
		Triggers:          types.DripTriggers,
		Tags:              s.hostTags(r.Context(), user),
		WhatsAppConnected: user.WhatsAppToken != "",
	})
}

// handleCRMDrip reads one sequence with the people on it.
func (s *Module) handleCRMDrip(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())

	out, ok := s.dripResponse(w, r, user.ID, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// dripResponse reads a drip and its enrollments, writing the refusal for a drip that
// is not this host's. Shared by every handler here that answers with one.
func (s *Module) dripResponse(w http.ResponseWriter, r *http.Request, hostID, id string) (types.CRMDripResponse, bool) {
	drip, err := s.store.Drip(r.Context(), hostID, id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such sequence.")
		return types.CRMDripResponse{}, false
	}
	if err != nil {
		s.fail(w, r, "crm drip", err)
		return types.CRMDripResponse{}, false
	}
	people, err := s.store.DripEnrollments(r.Context(), id, 0)
	if err != nil {
		s.fail(w, r, "crm drip: enrollments", err)
		return types.CRMDripResponse{}, false
	}
	return types.CRMDripResponse{Drip: drip, Enrollments: people}, true
}

/* handleCreateCRMDrip writes a sequence, steps and all.
 *
 * Nothing is sent by this request and nobody is enrolled by it, which is the whole
 * difference from creating a broadcast. A sequence with the `registered` trigger does
 * nothing at all until the next person registers.
 */
func (s *Module) handleCreateCRMDrip(w http.ResponseWriter, r *http.Request) {
	s.saveDrip(w, r, "")
}

// handleUpdateCRMDrip replaces one. The steps come with it; see store.SaveDrip for
// what that means for the people already part-way through.
func (s *Module) handleUpdateCRMDrip(w http.ResponseWriter, r *http.Request) {
	s.saveDrip(w, r, chi.URLParam(r, "id"))
}

func (s *Module) saveDrip(w http.ResponseWriter, r *http.Request, id string) {
	user := authctx.User(r.Context())

	var body types.CRMDripRequest
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
			"Connect your WhatsApp Business account in Account settings before building a sequence.")
		return
	}

	trigger := strings.TrimSpace(body.Trigger)
	if !knownDripTrigger(trigger) {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_trigger",
			"Pick how somebody joins this sequence.")
		return
	}
	/* The manual trigger names no webinar, and a posted one is dropped rather than
	 * refused: "add people myself" has no webinar to be about, and the webinar a host
	 * had selected before changing their mind is not an error worth a red message. */
	slug := strings.TrimSpace(body.WebinarID)
	if trigger == types.DripManual {
		slug = ""
	}
	if slug != "" && !s.crmWebinarAllowed(w, r, user.ID, slug) {
		return
	}

	/* The tag trigger, and the only one whose scope is not a webinar.
	 *
	 * An empty tag id is the wildcard — "when I tag somebody, start following up" — and
	 * it is allowed on purpose, because that is the rule most hosts want. A tag id on any
	 * other trigger is dropped rather than refused, matching the webinar above: it is
	 * what a host left behind when they changed their mind about the trigger.
	 */
	tagID := strings.TrimSpace(body.TagID)
	if trigger != types.DripTagAdded {
		tagID = ""
	}
	if trigger == types.DripTagAdded {
		if !s.featureAllowed(w, user, types.FeatureCRMTags) {
			return
		}
		if tagID != "" && !s.crmTagAllowed(w, r, user.ID, tagID) {
			return
		}
	}

	tiers, ok := tiersAllowed(w, trigger, body.Tiers)
	if !ok {
		return
	}
	match, ok := matchAllowed(w, trigger, body.Match)
	if !ok {
		return
	}

	steps, ok := s.stepsAllowed(w, r, user, body.Steps, trigger, slug)
	if !ok {
		return
	}

	name := strings.Join(strings.Fields(body.Name), " ")
	if name == "" {
		// Unlike a broadcast, there is no template to borrow a name from: a sequence
		// has several. A host with three unnamed sequences could not tell them apart.
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_name",
			"Give the sequence a name, so you can tell it from the next one.")
		return
	}

	saved, err := s.store.SaveDrip(r.Context(), user.ID, id, crmstore.DripInput{
		Name:        name,
		Trigger:     trigger,
		WebinarSlug: slug,
		TagID:       tagID,
		Active:      body.Active,
		Steps:       steps,
		Tiers:       tiers,
		Match:       match,
	})
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such sequence.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm drip: save", err)
		return
	}

	out, ok := s.dripResponse(w, r, user.ID, saved)
	if !ok {
		return
	}
	s.log.Info("whatsapp drip saved", "host", user.ID, "drip", saved,
		"trigger", trigger, "steps", len(steps), "active", body.Active,
		"created", id == "")
	status := http.StatusOK
	if id == "" {
		status = http.StatusCreated
	}
	httpx.JSON(w, status, out)
}

/* matchAllowed checks what an event trigger matches: a poll's question (and optionally one
 * answer), a button's text, or a word. Dropped on every other trigger. */
func matchAllowed(w http.ResponseWriter, trigger string, in *types.CRMDripMatch) (types.CRMDripMatch, bool) {
	clean := func(v string) string { return strings.Join(strings.Fields(v), " ") }
	var m types.CRMDripMatch
	if in != nil {
		m = types.CRMDripMatch{Question: clean(in.Question), Answer: clean(in.Answer), Text: clean(in.Text), Word: clean(in.Word)}
	}
	fail := func(msg string) (types.CRMDripMatch, bool) {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_match", msg)
		return types.CRMDripMatch{}, false
	}
	switch trigger {
	case types.DripPollAnswer:
		if m.Question == "" {
			return fail("Type the poll's question, as you ask it in the room.")
		}
		return types.CRMDripMatch{Question: m.Question, Answer: m.Answer}, true
	case types.DripButtonTap:
		if m.Text == "" {
			return fail("Type the button's text, e.g. “Tell me more”.")
		}
		return types.CRMDripMatch{Text: m.Text}, true
	case types.DripKeywordIn:
		if m.Word == "" || len([]rune(m.Word)) > 40 {
			return fail("Give one word or short phrase to look for.")
		}
		if isWhatsAppStop(m.Word) {
			return fail("“" + m.Word + "” is how people opt out, so it can't start an automation.")
		}
		return types.CRMDripMatch{Word: m.Word}, true
	}
	return types.CRMDripMatch{}, true
}

/* tiersAllowed checks an `attended` sequence's engagement tiers: the four score tiers,
 * each once. Dropped on any other trigger, as a webinar or tag is. */
func tiersAllowed(w http.ResponseWriter, trigger string, in []types.EngagementTier) ([]types.EngagementTier, bool) {
	if trigger != types.DripAttended {
		return nil, true
	}
	out := []types.EngagementTier{}
	for _, t := range in {
		switch t {
		case types.TierHigh, types.TierEngaged, types.TierPassive, types.TierRisk:
			if !slices.Contains(out, t) {
				out = append(out, t)
			}
		default:
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_tier",
				"Pick engagement groups from Highly engaged, Engaged, Passive and At risk.")
			return nil, false
		}
	}
	return out, true
}

/* stepsAllowed checks every step, and returns them normalised.
 *
 * All of it before anything is written, because a sequence half of whose steps name a
 * template Meta has not approved is a sequence that stops in the middle for one person
 * and not another — and it would stop days later, with nobody watching.
 *
 * `hasWebinar` is the subtle one. A step may use the topic and when merge fields when
 * the drip is scoped to a webinar OR when its trigger is one: an unscoped `registered`
 * sequence has no webinar of its own, but every person on it entered from one, and
 * their enrollment remembers which.
 */
func (s *Module) stepsAllowed(
	w http.ResponseWriter,
	r *http.Request,
	user store.User,
	steps []types.CRMDripStep,
	trigger, slug string,
) ([]types.CRMDripStep, bool) {
	if len(steps) == 0 {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_drip_no_steps",
			"An automation needs at least one step.")
		return nil, false
	}
	if len(steps) > maxDripSteps {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_drip_too_many_steps",
			"A sequence can have at most "+strconv.Itoa(maxDripSteps)+" messages.")
		return nil, false
	}
	/* Two triggers have no webinar of their own and none to inherit: a manually added
	 * person entered from nowhere, and a tag is a fact about somebody rather than about a
	 * session. Both can still have topic and when if the host scoped the sequence to a
	 * webinar, which is what the slug is — see EnrollOnTagAdded, which copies it onto the
	 * enrollment for exactly this. */
	// Event triggers from a message have no webinar; a poll answer does (the room's).
	hasWebinar := slug != "" ||
		(trigger != types.DripManual && trigger != types.DripTagAdded &&
			trigger != types.DripButtonTap && trigger != types.DripKeywordIn)

	out := make([]types.CRMDripStep, 0, len(steps))
	for i, step := range steps {
		at := "Step " + strconv.Itoa(i+1) + ": "
		if step.DelayMinutes < 0 || step.DelayMinutes > maxDripDelayMinutes {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_drip_bad_delay",
				at+"the wait has to be between none at all and 90 days.")
			return nil, false
		}
		switch step.Kind {
		case types.DripStepTag:
			tagID := strings.TrimSpace(step.TagID)
			if tagID == "" {
				httpx.Error(w, http.StatusUnprocessableEntity, "crm_step_no_tag", at+"pick the tag to put on them.")
				return nil, false
			}
			if !s.featureAllowed(w, user, types.FeatureCRMTags) || !s.crmTagAllowed(w, r, user.ID, tagID) {
				return nil, false
			}
			out = append(out, types.CRMDripStep{DelayMinutes: step.DelayMinutes, Kind: types.DripStepTag,
				TagID: tagID, Params: []types.CRMParam{}})
			continue
		case types.DripStepNotify:
			note := strings.TrimSpace(step.Note)
			if len([]rune(note)) > 500 {
				httpx.Error(w, http.StatusUnprocessableEntity, "crm_step_note", at+"keep the note under 500 characters.")
				return nil, false
			}
			out = append(out, types.CRMDripStep{DelayMinutes: step.DelayMinutes, Kind: types.DripStepNotify,
				Note: note, Params: []types.CRMParam{}})
			continue
		case "", types.DripStepMessage:
		default:
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_step_kind", at+"that is not something a step can do.")
			return nil, false
		}
		tmpl, err := s.templateForSend(r.Context(), user, strings.TrimSpace(step.Template), step.Language)
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_template",
				at+"that template is not in your WhatsApp account. Refresh your templates and try again.")
			return nil, false
		}
		if err != nil {
			s.fail(w, r, "crm drip: template", err)
			return nil, false
		}
		if !tmpl.Sendable {
			msg := tmpl.Unsupported
			if msg == "" {
				msg = "Meta has not approved that template yet — it is " + strings.ToLower(tmpl.Status) + "."
			}
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_template_unusable", at+msg)
			return nil, false
		}
		if len(step.Params) != tmpl.Variables {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_template_params",
				at+"that template needs exactly "+strconv.Itoa(tmpl.Variables)+" value(s) filling in.")
			return nil, false
		}
		if code, msg := paramsProblem(step.Params, hasWebinar, "sequence"); code != "" {
			httpx.Error(w, http.StatusUnprocessableEntity, code, at+msg)
			return nil, false
		}
		params := step.Params
		if params == nil {
			params = []types.CRMParam{}
		}
		out = append(out, types.CRMDripStep{
			DelayMinutes: step.DelayMinutes,
			Kind:         types.DripStepMessage,
			// The template's own name and language rather than what was posted, so a
			// casing difference cannot store a name Meta will not recognise later.
			Template: tmpl.Name,
			Language: tmpl.Language,
			Params:   params,
		})
	}
	return out, true
}

/* handleDeleteCRMDrip removes a sequence.
 *
 * Deleting stops it and forgets it, including who was on it — the gentler thing is to
 * pause it, which is a PUT with active false and keeps everybody's place. The messages
 * that already went out stay in each contact's conversation either way; there is no
 * unsend on WhatsApp and nothing here pretends otherwise.
 */
func (s *Module) handleDeleteCRMDrip(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	id := chi.URLParam(r, "id")

	err := s.store.DeleteDrip(r.Context(), user.ID, id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such sequence.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm drip: delete", err)
		return
	}
	s.log.Info("whatsapp drip deleted", "host", user.ID, "drip", id)
	w.WriteHeader(http.StatusNoContent)
}

/* handleEnrollCRMDrip puts one person on a sequence by hand.
 *
 * The manual trigger's whole implementation, and also available for the automatic ones:
 * a host who wants one more person on a sequence should not have to wait for them to
 * register for something. Nothing is sent from here — the first step is queued by the
 * next sweep, within thirty seconds.
 */
func (s *Module) handleEnrollCRMDrip(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	id := chi.URLParam(r, "id")

	var body types.CRMDripEnrollRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	drip, err := s.store.Drip(r.Context(), user.ID, id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such sequence.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm drip: enroll", err)
		return
	}

	/* Which webinar this person's topic and when come from: the one the host named
	 * here, or the one the whole sequence is about.
	 *
	 * Refused when a step needs one and there is neither, because the alternative is a
	 * message that says "— starts —" and there is no registration to infer it from. */
	slug := strings.TrimSpace(body.WebinarID)
	if slug == "" {
		slug = drip.WebinarID
	}
	if slug != "" && !s.crmWebinarAllowed(w, r, user.ID, slug) {
		return
	}
	if slug == "" && dripUsesWebinarFields(drip) {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_webinar",
			"This sequence mentions a webinar, so say which one this person is being added for.")
		return
	}

	err = s.store.EnrollByHand(r.Context(), user.ID, id, strings.TrimSpace(body.ContactID), slug)
	if errors.Is(err, store.ErrConflict) {
		/* One refusal for three causes, and on purpose: already on it, no opt-in, or a
		 * sequence with no steps. Separating them would mean telling a caller with a
		 * guessed contact id whether that person is in somebody else's CRM. */
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_drip_not_enrolled",
			"Could not add them: they are already on this sequence, or they have not opted in to WhatsApp.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm drip: enroll", err)
		return
	}

	out, ok := s.dripResponse(w, r, user.ID, id)
	if !ok {
		return
	}
	s.log.Info("whatsapp drip enrollment added", "host", user.ID, "drip", id,
		"contact", body.ContactID)
	httpx.JSON(w, http.StatusCreated, out)
}

/* handleRemoveCRMDripEnrollment takes somebody off a sequence.
 *
 * "Manual removal" from the plan, and the honest version of it: the enrollment is
 * marked exited with a reason rather than deleted, and the step waiting in the outbox
 * is retired with it. A deleted row would let the same person be enrolled again by the
 * next trigger, which is not what a host removing them meant.
 */
func (s *Module) handleRemoveCRMDripEnrollment(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	id := chi.URLParam(r, "id")

	// The drip is read first, so an enrollment id alone can never reach somebody
	// else's sequence: ExitDripEnrollment is scoped to both.
	if _, err := s.store.Drip(r.Context(), user.ID, id); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such sequence.")
		return
	} else if err != nil {
		s.fail(w, r, "crm drip: remove", err)
		return
	}

	err := s.store.ExitDripEnrollment(r.Context(), id, chi.URLParam(r, "enrollmentId"),
		"removed by the host")
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found",
			"They are not on this sequence any more.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm drip: remove", err)
		return
	}

	out, ok := s.dripResponse(w, r, user.ID, id)
	if !ok {
		return
	}
	s.log.Info("whatsapp drip enrollment removed", "host", user.ID, "drip", id,
		"enrollment", chi.URLParam(r, "enrollmentId"))
	httpx.JSON(w, http.StatusOK, out)
}

// knownDripTrigger is the trigger list from types, asked as a question. In one place
// so a new trigger does not need finding here as well.
func knownDripTrigger(trigger string) bool {
	for _, t := range types.DripTriggers {
		if t == trigger {
			return true
		}
	}
	return false
}

// dripUsesWebinarFields is whether any step needs a webinar to fill itself in.
func dripUsesWebinarFields(drip types.CRMDrip) bool {
	for _, step := range drip.Steps {
		for _, p := range step.Params {
			if p.Field == "topic" || p.Field == "when" {
				return true
			}
		}
	}
	return false
}

/* crmWebinarAllowed checks a slug belongs to this host, writing the refusal when it does not.
 *
 * Somebody else's webinar reads the same as one that does not exist, like everywhere
 * else in the CRM: a topic and a start time are exactly what a slug guesser is after.
 */
func (s *Module) crmWebinarAllowed(w http.ResponseWriter, r *http.Request, hostID, slug string) bool {
	owner, err := s.store.HostIDFor(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) || (err == nil && owner != hostID) {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_webinar",
			"That webinar is not one of yours.")
		return false
	}
	if err != nil {
		s.fail(w, r, "crm: webinar owner", err)
		return false
	}
	return true
}

// ---------------------------------------------------------------- triggers

/* enrollDripsOnRegistration is the `registered` trigger.
 *
 * Called from the registration path, after the contact exists and beside the WhatsApp
 * invitation — which is also where the webinar's WhatsApp switch is honoured, and for
 * the same reason: a host who turned it off for this webinar did not mean "except for
 * the sequence".
 *
 * Failures are logged and dropped. The seat is what the registrant came for.
 */
func (s *Module) enrollDripsOnRegistration(ctx context.Context, wb types.Webinar, contact types.CRMContact) {
	if !wb.Options.WhatsAppReminders || !contact.WhatsAppOptIn || contact.Phone == "" {
		return
	}
	hostID, err := s.store.HostIDFor(ctx, wb.ID)
	if err != nil {
		s.log.Error("drip trigger: could not resolve host", "webinar", wb.ID, "error", err)
		return
	}
	n, err := s.store.EnrollOnRegistration(ctx, hostID, wb.ID, contact.ID)
	if err != nil {
		s.log.Error("drip trigger: registered", "webinar", wb.ID,
			"contact", contact.ID, "error", err)
		return
	}
	if n > 0 {
		s.log.Info("drip enrolled on registration", "webinar", wb.ID,
			"contact", contact.ID, "sequences", n)
	}
}

/* enrollDripsOnWebinarEnd is the `attended`, `no_show` and `ended` triggers.
 *
 * Fired from endWebinarSession, which is also what the attendance rows have stopped
 * being written by — so "did they turn up" has its final answer by the time this runs.
 * A webinar that ends twice enrolls nobody twice; entry is one per person per sequence.
 */
func (s *Module) enrollDripsOnWebinarEnd(ctx context.Context, wb types.Webinar) {
	if !wb.Options.WhatsAppReminders {
		return
	}
	hostID, err := s.store.HostIDFor(ctx, wb.ID)
	if err != nil {
		s.log.Error("drip trigger: could not resolve host", "webinar", wb.ID, "error", err)
		return
	}
	since := time.Now().Add(-30 * time.Second)
	for _, trigger := range []string{types.DripAttended, types.DripNoShow, types.DripEnded} {
		n, err := s.store.EnrollOnWebinarEnd(ctx, hostID, wb.ID, trigger)
		if err != nil {
			s.log.Error("drip trigger: webinar ended", "webinar", wb.ID,
				"trigger", trigger, "error", err)
			continue
		}
		if n > 0 {
			s.log.Info("drip enrolled on webinar end", "webinar", wb.ID,
				"trigger", trigger, "enrolled", n)
		}
	}
	s.applyFollowupTiming(ctx, wb.ID, since)
}

/* OnScored enrolls the `attended` sequences narrowed to engagement tiers, now that the
 * webinar's tiers exist. Mirrors enrollDripsOnWebinarEnd, which skips those sequences. */
func (s *Module) OnScored(ctx context.Context, slug string) {
	s.refreshAudience(ctx, slug)
	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil {
		s.log.Error("drip trigger: scored: could not load webinar", "webinar", slug, "error", err)
		return
	}
	if !wb.Options.WhatsAppReminders {
		return
	}
	hostID, err := s.store.HostIDFor(ctx, slug)
	if err != nil {
		s.log.Error("drip trigger: could not resolve host", "webinar", slug, "error", err)
		return
	}
	since := time.Now().Add(-30 * time.Second)
	n, err := s.store.EnrollOnScored(ctx, hostID, slug)
	if err != nil {
		s.log.Error("drip trigger: scored", "webinar", slug, "error", err)
		return
	}
	if n > 0 {
		s.log.Info("drip enrolled on engagement", "webinar", slug, "enrolled", n)
	}
	s.applyFollowupTiming(ctx, slug, since)
}

// ----------------------------------------------------------------- sweeping

/* AdvanceDrips queues every step that has come due, and closes the enrollments that
 * should not receive one.
 *
 * Exported, unlike the other sweeps in sweeper.go, because it is the one with no side
 * door: an outbox flush can be provoked by registering somebody, and nothing at all
 * makes a sequence advance except time passing. A test that cannot run one pass could
 * only ever assert that a drip was created.
 *
 * Run from the sweeper immediately before the WhatsApp outbox is flushed, so a step
 * that comes due is queued and sent in the same tick rather than waiting another
 * thirty seconds for the flush to come round again.
 *
 * Two outcomes per enrollment and the difference matters. A contact who can still be
 * messaged gets the step written into the outbox and their enrollment moved on. One who
 * cannot — they opted out, or lost their number — is exited with the reason, because
 * queueing a message the outbox will refuse to send leaves a row pending for ever and
 * a host looking at somebody who is apparently still part-way through.
 */
func (s *Module) AdvanceDrips(ctx context.Context) {
	due, err := s.store.DueDripSteps(ctx, dripStepsPerSweep)
	if err != nil {
		s.log.Error("drip sweep: query failed", "error", err)
		return
	}
	if len(due) == 0 {
		return
	}

	// One webinar is usually the source for many enrollments — everybody a finished
	// webinar just enrolled shares it — so it is read once per sweep, not per person.
	webinars := map[string]types.Webinar{}
	slotCache := map[string][]types.MessageSlot{}
	queued, exited := 0, 0
	for _, step := range due {
		if s.cfg.EngageSlots && step.Recipe != "" && step.WebinarSlug != "" {
			slots, ok := slotCache[step.WebinarSlug]
			if !ok {
				var err error
				slots, err = s.ResolveSlots(ctx, step.WebinarSlug)
				if err != nil {
					s.log.Error("drip sweep: message slots", "webinar", step.WebinarSlug, "error", err)
					continue
				}
				slotCache[step.WebinarSlug] = slots
			}
			if followupBlocked(slots, step.Recipe) {
				if err := s.store.ExitDripEnrollment(ctx, step.DripID, step.EnrollmentID, "message slot off"); err != nil {
					s.log.Error("drip sweep: slot off", "enrollment", step.EnrollmentID, "error", err)
				}
				exited++
				continue
			}
		}
		// A step that sends nothing to the person: no consent check, no outbox.
		if step.Kind == types.DripStepTag || step.Kind == types.DripStepNotify {
			s.runSilentStep(ctx, step)
			continue
		}
		if !step.Reachable {
			if err := s.store.ExitDripEnrollment(ctx, step.DripID, step.EnrollmentID,
				"no WhatsApp consent"); err != nil && !errors.Is(err, store.ErrNotFound) {
				s.log.Error("drip sweep: could not exit", "enrollment", step.EnrollmentID, "error", err)
				continue
			}
			exited++
			continue
		}

		wb := types.Webinar{}
		if step.WebinarSlug != "" {
			loaded, ok := webinars[step.WebinarSlug]
			if !ok {
				loaded, err = s.store.WebinarBySlug(ctx, step.WebinarSlug)
				if err != nil {
					// Left due rather than exited: a webinar that cannot be read right
					// now is a reason to try again, not to end somebody's sequence.
					s.log.Error("drip sweep: could not read webinar",
						"slug", step.WebinarSlug, "error", err)
					continue
				}
				webinars[step.WebinarSlug] = loaded
			}
			wb = loaded
		}

		contact := types.CRMContact{ID: step.ContactID, Name: step.ContactName}
		params := resolveBroadcastParams(step.Params, contact, wb, step.HostName, 0)
		err := s.store.QueueDripStep(ctx, step, params)
		if errors.Is(err, store.ErrConflict) {
			// Another sweep got there first. Nothing to say about it.
			continue
		}
		if err != nil {
			s.log.Error("drip sweep: could not queue step", "enrollment", step.EnrollmentID,
				"position", step.Position, "error", err)
			continue
		}
		queued++
	}
	if queued > 0 || exited > 0 {
		s.log.Info("drip sweep", "queued", queued, "exited", exited, "due", len(due))
	}
}

/* runSilentStep does a tag or notify step and moves the person on. A failure leaves them
 * where they are, to be tried again next sweep. */
func (s *Module) runSilentStep(ctx context.Context, step crmstore.DripDue) {
	switch step.Kind {
	case types.DripStepTag:
		if step.TagID != "" {
			host, err := s.store.UserByID(ctx, step.HostID)
			if err != nil {
				s.log.Error("rule step: host", "host", step.HostID, "error", err)
				return
			}
			if err := s.applyTag(ctx, host, step.ContactID, step.TagID); err != nil {
				s.log.Error("rule step: tag", "enrollment", step.EnrollmentID, "error", err)
				return
			}
		}
	case types.DripStepNotify:
		if s.mail != nil && s.mail.Configured() && step.HostEmail != "" {
			name := step.ContactName
			if name == "" {
				name = "Someone"
			}
			body := name + " just matched your automation \"" + step.DripName + "\"."
			if step.Note != "" {
				body += "\n\n" + step.Note
			}
			body += "\n\nOpen their conversation: " + strings.TrimRight(s.cfg.WebBaseURL, "/") +
				"/host?tab=messages&contact=" + step.ContactID + "\n"
			if err := s.mail.Send(ctx, notify.Message{To: step.HostEmail,
				Subject: name + " · " + step.DripName, Body: body}); err != nil {
				s.log.Error("rule step: notify", "enrollment", step.EnrollmentID, "error", err)
				return
			}
		}
	}
	if err := s.store.AdvanceDripStep(ctx, step); err != nil && !errors.Is(err, store.ErrConflict) {
		s.log.Error("rule step: advance", "enrollment", step.EnrollmentID, "error", err)
	}
}

/* OnPollAnswer is the poll_answer trigger: someone in the room chose an answer. Identity
 * is the room's (att_<join key>); a guest with no registration has no contact and is
 * skipped. */
func (s *Module) OnPollAnswer(ctx context.Context, slug, identity, question, answer string) {
	hostID, contactID, err := s.store.ContactForIdentity(ctx, slug, identity)
	if err != nil {
		return
	}
	n, err := s.store.EnrollOnEvent(ctx, hostID, contactID, slug, types.DripPollAnswer,
		types.CRMDripMatch{Question: question, Answer: answer})
	if err != nil {
		s.log.Warn("rule trigger: poll answer", "webinar", slug, "error", err)
		return
	}
	if n > 0 {
		s.log.Info("rule enrolled on poll answer", "webinar", slug, "contact", contactID, "rules", n)
	}
}

/* onInboundRules is the button_tap and keyword_in triggers, from a message just filed. */
func (s *Module) onInboundRules(ctx context.Context, hostID, contactID, kind, text string) {
	trigger := types.DripKeywordIn
	if kind == "button" {
		trigger = types.DripButtonTap
	}
	n, err := s.store.EnrollOnEvent(ctx, hostID, contactID, "", trigger, types.CRMDripMatch{Text: text})
	if err != nil {
		s.log.Warn("rule trigger: inbound", "host", hostID, "error", err)
		return
	}
	if n > 0 {
		s.log.Info("rule enrolled on message", "host", hostID, "contact", contactID, "trigger", trigger, "rules", n)
	}
}
