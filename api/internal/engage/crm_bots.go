package engage

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/wa"
	"github.com/netkumar/webcast/api/types"
)

/* Bots: the CRM answering for itself.
 *
 * The fourth way this server sends a WhatsApp message and the first one nobody starts.
 * A reminder follows a webinar's clock, a broadcast a moment the host picked, a drip a
 * rule the host wrote — all three send outwards. A bot sends because somebody wrote in,
 * and everything unusual about this file follows from that:
 *
 *   - it does not use the outbox. Every other send here is a notification row a sweep
 *     picks up within thirty seconds, which is right for a reminder and wrong for a
 *     reply: an answer that arrives half a minute late, in whatever order a sweep read
 *     its rows, is not a conversation. Bot messages go to Graph inline, on the webhook's
 *     own request, and the only thing the sweeper owns is a flow that asked to wait.
 *   - it is free-form text, not templates, and that is legal for exactly one reason:
 *     the person just messaged the business, so Meta's 24-hour service window is open.
 *     A flow that sleeps past the window cannot speak, and is stopped rather than
 *     queued as a template — a template would need approving, and a bot that
 *     occasionally answers you a day later with pre-approved marketing copy is not the
 *     feature anybody asked for.
 *   - it needs no marketing opt-in. Somebody who writes to a business has asked it a
 *     question; requiring a consent checkbox before answering would be consent theatre
 *     of the kind the send path already refuses to do. Opt-OUT is honoured absolutely,
 *     and "STOP" is handled before any of this runs.
 *
 * The two guards worth reading the code for are both about money. A flow's own step
 * budget (botNodesPerTurn, botNodesPerSession) bounds what one conversation can cost,
 * and the session's last_wamid bounds what Meta's webhook retries can cost: without it,
 * a redelivered answer would be read as a second answer and the flow would run twice.
 */

const (
	// maxBotKeywords is how many words may start one bot. A list longer than this is a
	// host trying to write "any message" the hard way, which is the other trigger.
	maxBotKeywords = 20
	// maxBotKeywordLen bounds one keyword. Matching is whole-message, so a keyword
	// longer than a short phrase can never match anything a person would actually type.
	maxBotKeywordLen = 64

	/* botNodesPerTurn is how many nodes one turn may run before the flow is stopped.
	 *
	 * Not a performance limit — it is a spend limit. A turn that runs twelve message
	 * nodes has sent twelve WhatsApp messages, billed to the host, out of one message
	 * from a customer. Any flow that wants more than this in one breath is a mistake in
	 * the flowchart, and stopping is the cheap way to find out.
	 */
	botNodesPerTurn = 12
	/* botNodesPerSession is the same bound over the whole conversation.
	 *
	 * Cycles are refused when a bot is saved, but a host may edit a flow while somebody
	 * is standing in it, and the edit can make one. This is what that costs instead of a
	 * bill.
	 */
	botNodesPerSession = 60
	// botSessionsPerSweep is how many sleeping flows one tick wakes. A flow with a
	// one-minute wait and a thousand people in it is a thousand messages; this makes it
	// a thousand messages over ten minutes instead of in one second.
	botSessionsPerSweep = 50
)

// ---------------------------------------------------------------- the screens

// handleCRMBots lists the host's bots, newest first, with their flows and stats.
func (s *Module) handleCRMBots(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())

	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	list, err := s.store.Bots(r.Context(), user.ID, limit)
	if err != nil {
		s.fail(w, r, "crm bots", err)
		return
	}
	sequences, err := s.store.BotSequences(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "crm bots: sequences", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.CRMBotsResponse{
		Bots: list,
		// The same triggers and kinds this file enforces, so the builder cannot offer
		// one that would be refused on save.
		Triggers:          []string{types.BotAnyMessage, types.BotKeyword},
		NodeKinds:         nodeKindsFor(user),
		Sequences:         sequences,
		Tags:              s.hostTags(r.Context(), user),
		WhatsAppConnected: user.WhatsAppToken != "",
	})
}

// botNodeKinds is the node vocabulary, in the order a host is offered it. Iterated by
// the validation below and sent to the builder, so a new kind is added here rather
// than in a switch and a form.
var botNodeKinds = []string{
	types.BotNodeMessage, types.BotNodeAsk, types.BotNodeWait,
	types.BotNodeEnroll, types.BotNodeHandoff, types.BotNodeTag,
}

/* nodeKindsFor is the vocabulary THIS account may use.
 *
 * set_tag is dropped for a host without the tags feature, because the builder renders one
 * control per kind and a step whose only setting is a tag picker with nothing in it is a
 * step that can only be saved wrong. The refusal on save is still there (flowAllowed) —
 * this is what keeps the host from reaching it.
 */
func nodeKindsFor(user store.User) []string {
	if user.HasFeature(types.FeatureCRMTags) {
		return botNodeKinds
	}
	out := make([]string, 0, len(botNodeKinds))
	for _, k := range botNodeKinds {
		if k != types.BotNodeTag {
			out = append(out, k)
		}
	}
	return out
}

// handleCRMBot reads one bot with the conversations it has had.
func (s *Module) handleCRMBot(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())

	out, ok := s.botResponse(w, r, user.ID, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// botResponse reads a bot and its sessions, writing the refusal for one that is not
// this host's. Shared by every handler here that answers with a bot.
func (s *Module) botResponse(w http.ResponseWriter, r *http.Request, hostID, id string) (types.CRMBotResponse, bool) {
	bot, err := s.store.Bot(r.Context(), hostID, id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such bot.")
		return types.CRMBotResponse{}, false
	}
	if err != nil {
		s.fail(w, r, "crm bot", err)
		return types.CRMBotResponse{}, false
	}
	sessions, err := s.store.BotSessions(r.Context(), id, 0)
	if err != nil {
		s.fail(w, r, "crm bot: sessions", err)
		return types.CRMBotResponse{}, false
	}
	return types.CRMBotResponse{Bot: bot, Sessions: sessions}, true
}

// handleCreateCRMBot writes a bot. Nothing is sent by this request: a bot does nothing
// at all until somebody messages the host's number.
func (s *Module) handleCreateCRMBot(w http.ResponseWriter, r *http.Request) {
	s.saveBot(w, r, "")
}

/* handleUpdateCRMBot replaces one, flow and all.
 *
 * Allowed while conversations are in it, and the consequence is worth stating: somebody
 * parked at a question whose node has been deleted is stopped the next time they write,
 * and somebody parked at one that still exists carries on into the new flow. Freezing a
 * copy of the flow per conversation would be the alternative, and it would mean a host
 * fixing a typo fixes it for nobody currently reading it.
 */
func (s *Module) handleUpdateCRMBot(w http.ResponseWriter, r *http.Request) {
	s.saveBot(w, r, chi.URLParam(r, "id"))
}

func (s *Module) saveBot(w http.ResponseWriter, r *http.Request, id string) {
	user := authctx.User(r.Context())

	var body types.CRMBotRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	/* Whose bot it is, before anything else about it.
	 *
	 * An id belonging to another host has to read as "no such bot" rather than as
	 * advice about WhatsApp: the connection checks below are about the caller's own
	 * account, and answering them for somebody else's row would confirm it exists.
	 */
	if id != "" {
		if _, err := s.store.Bot(r.Context(), user.ID, id); errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found", "No such bot.")
			return
		} else if err != nil {
			s.fail(w, r, "crm bot: save", err)
			return
		}
	}
	if s.whatsapp == nil || !s.whatsapp.Enabled() {
		httpx.Error(w, http.StatusServiceUnavailable, "whatsapp_unset",
			"WhatsApp is not set up on this instance.")
		return
	}
	if user.WhatsAppToken == "" || user.WhatsAppPhoneNumberID == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "whatsapp_not_connected",
			"Connect your WhatsApp Business account in Account settings before building a bot.")
		return
	}

	name := strings.Join(strings.Fields(body.Name), " ")
	if name == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_name",
			"Give the bot a name, so you can tell it from the next one.")
		return
	}

	trigger := strings.TrimSpace(body.Trigger)
	if trigger != types.BotAnyMessage && trigger != types.BotKeyword {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_trigger",
			"Pick what starts this bot.")
		return
	}
	keywords, ok := botKeywords(w, trigger, body.Keywords)
	if !ok {
		return
	}

	nodes, ok := s.flowAllowed(w, r, user, body.Nodes, strings.TrimSpace(body.Entry))
	if !ok {
		return
	}

	saved, err := s.store.SaveBot(r.Context(), user.ID, id, store.BotInput{
		Name:     name,
		Trigger:  trigger,
		Keywords: keywords,
		Entry:    strings.TrimSpace(body.Entry),
		Active:   body.Active,
		Nodes:    nodes,
	})
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such bot.")
		return
	}
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "crm_bot_catch_all",
			"You already have a bot switched on that answers every message. Switch that one off first, or start this one from a keyword.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm bot: save", err)
		return
	}

	out, ok := s.botResponse(w, r, user.ID, saved)
	if !ok {
		return
	}
	s.log.Info("whatsapp bot saved", "host", user.ID, "bot", saved, "trigger", trigger,
		"nodes", len(nodes), "active", body.Active, "created", id == "")
	status := http.StatusOK
	if id == "" {
		status = http.StatusCreated
	}
	httpx.JSON(w, status, out)
}

/* botKeywords normalises the words that start a keyword bot.
 *
 * Lower-cased, whitespace collapsed and de-duplicated, because that is how they are
 * matched: an inbound message is compared whole against this list, so " Price " and
 * "price" are the same keyword and storing both would only make the list confusing to
 * read back.
 */
func botKeywords(w http.ResponseWriter, trigger string, in []string) ([]string, bool) {
	if trigger != types.BotKeyword {
		// A catch-all with words left over from before the host changed their mind is
		// not an error worth a red message; the words simply stop meaning anything.
		return []string{}, true
	}
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, raw := range in {
		word := strings.ToLower(strings.Join(strings.Fields(raw), " "))
		if word == "" || seen[word] {
			continue
		}
		if len([]rune(word)) > maxBotKeywordLen {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_bad_keyword",
				"\""+word[:20]+"…\" is too long to be a keyword — it has to match a whole message somebody typed.")
			return nil, false
		}
		seen[word] = true
		out = append(out, word)
	}
	if len(out) == 0 {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_no_keywords",
			"Give at least one word that starts this bot, or have it answer every message instead.")
		return nil, false
	}
	if len(out) > maxBotKeywords {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_no_keywords",
			"A bot can start from at most "+strconv.Itoa(maxBotKeywords)+" keywords.")
		return nil, false
	}
	return out, true
}

/* flowAllowed checks the whole flow and returns it normalised.
 *
 * All of it before anything is written, and the edges are why this cannot be done a
 * node at a time: a `next` that names a node which does not exist is a conversation
 * that stops in the middle, days later, with nobody watching. The same goes for the
 * cycle check — a flow that loops is not a flow that hangs, it is a flow that sends
 * somebody a message per second until the host's Meta bill says so.
 */
func (s *Module) flowAllowed(
	w http.ResponseWriter,
	r *http.Request,
	user store.User,
	nodes []types.CRMBotNode,
	entry string,
) ([]types.CRMBotNode, bool) {
	hostID := user.ID
	if len(nodes) == 0 {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_no_nodes",
			"A bot needs at least one step.")
		return nil, false
	}
	if len(nodes) > types.BotMaxNodes {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_no_nodes",
			"A bot can have at most "+strconv.Itoa(types.BotMaxNodes)+" steps.")
		return nil, false
	}

	out := make([]types.CRMBotNode, 0, len(nodes))
	keys := map[string]bool{}
	for i, node := range nodes {
		at := "Step " + strconv.Itoa(i+1) + ": "
		key := strings.TrimSpace(node.Key)
		if key == "" || len(key) > 64 {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_bad_key",
				at+"that step has no name.")
			return nil, false
		}
		if keys[key] {
			// Two nodes with one name makes every edge to it ambiguous, and the primary
			// key would refuse it anyway — with a message about an index.
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_bad_key",
				at+"two steps have the same name.")
			return nil, false
		}
		keys[key] = true

		clean := types.CRMBotNode{Key: key, Kind: strings.TrimSpace(node.Kind)}
		if !knownBotNodeKind(clean.Kind) {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_bad_kind",
				at+"that is not something a bot can do.")
			return nil, false
		}
		if clean.Kind == types.BotNodeTag && !s.featureAllowed(w, user, types.FeatureCRMTags) {
			return nil, false
		}
		clean.Next = strings.TrimSpace(node.Next)

		text := strings.TrimSpace(node.Text)
		switch clean.Kind {
		case types.BotNodeMessage, types.BotNodeAsk:
			if text == "" {
				httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_no_text",
					at+"say something, or use a different kind of step.")
				return nil, false
			}
		}
		if len([]rune(text)) > types.BotMaxText {
			/* One limit for every kind, and it is the interactive one.
			 *
			 * Plain text may be 4096 characters and a message with buttons only 1024, so
			 * a single limit means adding a button to a message can never make its text
			 * retrospectively invalid — which is the edit a host is most likely to make. */
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_text_too_long",
				at+"WhatsApp allows at most "+strconv.Itoa(types.BotMaxText)+" characters in a message with buttons.")
			return nil, false
		}
		clean.Text = text

		switch clean.Kind {
		case types.BotNodeAsk:
			buttons := make([]types.CRMBotButton, 0, len(node.Buttons))
			labels := map[string]bool{}
			for _, b := range node.Buttons {
				label := strings.Join(strings.Fields(b.Label), " ")
				if label == "" {
					continue
				}
				if len([]rune(label)) > types.BotMaxButtonLabel {
					httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_bad_button",
						at+"\""+label+"\" is too long for a button — WhatsApp allows "+
							strconv.Itoa(types.BotMaxButtonLabel)+" characters.")
					return nil, false
				}
				/* Labels have to be distinct, and not only because Meta says so: somebody
				 * who types their answer instead of pressing anything is matched on the
				 * label, and two buttons saying "Yes" would make that answer a coin toss. */
				if labels[strings.ToLower(label)] {
					httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_bad_button",
						at+"two buttons say \""+label+"\".")
					return nil, false
				}
				labels[strings.ToLower(label)] = true
				buttons = append(buttons, types.CRMBotButton{
					Label: label, Next: strings.TrimSpace(b.Next),
				})
			}
			if len(buttons) == 0 {
				httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_bad_button",
					at+"a question needs at least one button.")
				return nil, false
			}
			if len(buttons) > types.BotMaxButtons {
				httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_bad_button",
					at+"WhatsApp allows at most "+strconv.Itoa(types.BotMaxButtons)+" buttons on a question.")
				return nil, false
			}
			clean.Buttons = buttons
		case types.BotNodeWait:
			if node.DelayMinutes < 0 || node.DelayMinutes > 24*60 {
				/* A day, and it is Meta's number rather than a preference: the service
				 * window closes 24 hours after the person's last message, so a flow that
				 * sleeps longer than that wakes up unable to say anything. */
				httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_bad_delay",
					at+"a bot can wait at most 24 hours — after that WhatsApp no longer allows a typed reply.")
				return nil, false
			}
			clean.DelayMinutes = node.DelayMinutes
		case types.BotNodeEnroll:
			dripID := strings.TrimSpace(node.DripID)
			if dripID == "" {
				httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_no_sequence",
					at+"pick the sequence to put them on.")
				return nil, false
			}
			// Checked here so another host's id reads as "not one of yours" rather than
			// being stored as NULL and quietly doing nothing for ever.
			drip, err := s.store.Drip(r.Context(), hostID, dripID)
			if errors.Is(err, store.ErrNotFound) {
				httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_no_sequence",
					at+"that sequence is not one of yours.")
				return nil, false
			}
			if err != nil {
				s.fail(w, r, "crm bot: sequence", err)
				return nil, false
			}
			clean.DripID = drip.ID
		case types.BotNodeTag:
			tagID := strings.TrimSpace(node.TagID)
			if tagID == "" {
				httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_no_tag",
					at+"pick the tag to put on them.")
				return nil, false
			}
			// Same reason as the sequence above: another host's id would otherwise be
			// stored as NULL and label nobody, for ever, silently.
			tag, err := s.store.Tag(r.Context(), hostID, tagID)
			if errors.Is(err, store.ErrNotFound) {
				httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_no_tag",
					at+"that tag is not one of yours.")
				return nil, false
			}
			if err != nil {
				s.fail(w, r, "crm bot: tag", err)
				return nil, false
			}
			clean.TagID = tag.ID
		}
		out = append(out, clean)
	}

	if entry == "" || !keys[entry] {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_no_entry",
			"Say which step a conversation starts at.")
		return nil, false
	}
	// Every edge, after every key is known: a flow is written top to bottom and an edge
	// pointing at a step further down is the ordinary case.
	for _, node := range out {
		for _, edge := range botEdges(node) {
			if !keys[edge] {
				httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_bad_link",
					"\""+node.Key+"\" goes to a step that is not there any more.")
				return nil, false
			}
		}
	}
	if loop := botCycle(out, entry); loop != "" {
		/* Refused rather than bounded, even though the runtime bounds it anyway.
		 *
		 * A loop is never what somebody drew on purpose — there is no variable in this
		 * flow to escape one with — and the runtime's budget turns it into sixty real
		 * messages to a real person before it stops. Better to refuse the drawing. */
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_bot_loop",
			"\""+loop+"\" leads back to itself, so this bot would keep messaging the same person. Break the loop and save again.")
		return nil, false
	}
	return out, true
}

// botEdges is every step a node can lead to.
func botEdges(node types.CRMBotNode) []string {
	out := []string{}
	if node.Next != "" {
		out = append(out, node.Next)
	}
	for _, b := range node.Buttons {
		if b.Next != "" {
			out = append(out, b.Next)
		}
	}
	return out
}

/* botCycle names a node that leads back to itself, or "" when the flow is a tree.
 *
 * An ordinary three-colour depth-first search from the entry, which is the only part of
 * the graph that can run: an unreachable loop is a mistake in a draft the host is still
 * editing, not something that can cost them anything, so it is left alone.
 */
func botCycle(nodes []types.CRMBotNode, entry string) string {
	by := make(map[string]types.CRMBotNode, len(nodes))
	for _, n := range nodes {
		by[n.Key] = n
	}
	const (
		open = 1 // on the current path
		done = 2 // fully explored, no cycle through it
	)
	state := make(map[string]int, len(nodes))

	var walk func(key string) string
	walk = func(key string) string {
		switch state[key] {
		case open:
			return key
		case done:
			return ""
		}
		state[key] = open
		for _, edge := range botEdges(by[key]) {
			if loop := walk(edge); loop != "" {
				return loop
			}
		}
		state[key] = done
		return ""
	}
	return walk(entry)
}

func knownBotNodeKind(kind string) bool {
	for _, k := range botNodeKinds {
		if k == kind {
			return true
		}
	}
	return false
}

/* handleDeleteCRMBot removes a bot.
 *
 * Deleting forgets the conversations it had; switching it off (a PUT with active false)
 * stops it and keeps them. The messages it sent stay in each contact's thread either
 * way — they were really sent, and there is no unsend on WhatsApp.
 */
func (s *Module) handleDeleteCRMBot(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	id := chi.URLParam(r, "id")

	err := s.store.DeleteBot(r.Context(), user.ID, id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such bot.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm bot: delete", err)
		return
	}
	s.log.Info("whatsapp bot deleted", "host", user.ID, "bot", id)
	w.WriteHeader(http.StatusNoContent)
}

/* handleCRMContactBot is the handoff, from either direction.
 *
 * The plan's "handoff to a human inbox" as a switch on the contact rather than an
 * inbox of its own, because the inbox already exists: a paused conversation is one the
 * host reads and answers in the thread they were already using. What the flag changes
 * is that no bot interrupts them while they do it.
 *
 * Reversible on purpose. A host who has finished dealing with somebody turns the bots
 * back on for them, and the next message that person sends starts a flow from the top —
 * not from the question they were asked before a human got involved.
 */
func (s *Module) handleCRMContactBot(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	id := chi.URLParam(r, "id")

	var body types.CRMBotPauseRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if err := s.store.SetContactBotPaused(r.Context(), user.ID, id, body.Paused,
		"host_took_over"); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such contact.")
		return
	} else if err != nil {
		s.fail(w, r, "crm contact bot", err)
		return
	}
	contact, err := s.store.Contact(r.Context(), user.ID, id)
	if err != nil {
		s.fail(w, r, "crm contact bot: reload", err)
		return
	}
	s.log.Info("crm bot pause", "host", user.ID, "contact", id, "paused", body.Paused)
	httpx.JSON(w, http.StatusOK, contact)
}

// ---------------------------------------------------------------- the runtime

/* botTurn is one pass through a flow: everything it needs, read once.
 *
 * A turn is the unit because of the two things that must be read exactly once — the
 * flow itself, and the service window. Reading the nodes per step would put the
 * webhook's response time at the mercy of how long the host's flowchart is; reading the
 * window per send would let a turn's own messages appear to extend it.
 */
type botTurn struct {
	host    store.User
	contact types.CRMContact
	run     store.BotRun
	nodes   map[string]types.CRMBotNode
	// steps is the whole conversation's count, not this turn's.
	steps int
	// wamid is the inbound message being acted on, and empty for a turn the sweeper
	// started: nothing arrived, so there is nothing new to remember having acted on.
	wamid string
	// window is when free-form text stops being allowed. Zero means it already has.
	window time.Time
}

/* runBot answers one inbound message, if anything is listening.
 *
 * Called from ingestWhatsApp after the message has been filed and after STOP has been
 * honoured — in that order, because a bot must never be the reason an opt-out was
 * missed, and because the flow's own reply belongs after the message it answers.
 *
 * Every exit here is silent by design. Most messages to most hosts are not for a bot,
 * and a log line per message would be both noise and, eventually, a record of who
 * writes to whom. Content is never logged; see ingestWhatsApp.
 */
func (s *Module) runBot(ctx context.Context, host store.User, contact types.CRMContact, in wa.Inbound) {
	if s.whatsapp == nil || host.WhatsAppToken == "" || host.WhatsAppPhoneNumberID == "" {
		return
	}
	// A person has this conversation. The whole point of the handoff.
	if contact.BotPausedAt != "" {
		return
	}
	// Opted out, and no later opt-in: nothing may be sent to them, question or not.
	if contact.WhatsAppOptOutAt != "" && !contact.WhatsAppOptIn {
		return
	}
	if contact.Phone == "" {
		return
	}

	run, err := s.store.LatestBotSession(ctx, host.ID, contact.ID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		s.startBot(ctx, host, contact, in)
		return
	case err != nil:
		s.log.Error("bot: could not read session", "error", err, "host", host.ID,
			"contact", contact.ID)
		return
	}

	/* A retry of the message this session already acted on, whatever became of it.
	 *
	 * Meta redelivers anything it did not see a 2xx for, and the flow has moved since:
	 * acting again would read a redelivered answer as a second answer and send the next
	 * step twice. Checked against the last session and not only against a live one,
	 * because the most likely retry of all is of the answer that ENDED a flow — which
	 * would otherwise find nothing under way and start the whole thing again.
	 *
	 * AppendMessage is idempotent on the same id, so the thread is already correct; this
	 * is the half that is not free to repeat.
	 */
	if run.LastWAMID != "" && run.LastWAMID == in.WAMID {
		return
	}
	if run.State != "waiting" && run.State != "sleeping" {
		// Whatever they were in is over. This message is a new conversation, and may
		// start a different bot than the one they last spoke to.
		s.startBot(ctx, host, contact, in)
		return
	}
	// Switched off mid-conversation. Ended rather than left waiting, so the host's list
	// does not show a flow that is apparently still going in a bot that is not running.
	if !run.Active {
		s.endBotSession(ctx, run, "bot_off")
		return
	}
	/* Asleep on a wait node, and somebody wrote anyway.
	 *
	 * Left alone: the sweeper owns a sleeping session, and treating this message as an
	 * answer would mean answering a question the flow has not asked yet. The message is
	 * in the thread, where the host can see it.
	 */
	if run.State == "sleeping" {
		return
	}

	turn, ok := s.openBotTurn(ctx, host, contact, run, in.WAMID)
	if !ok {
		return
	}
	next, ok := s.botAnswer(ctx, turn, in)
	if !ok {
		return
	}
	s.runFlow(ctx, turn, next)
}

/* startBot opens a conversation, when a bot claims this message.
 *
 * The session is created before anything is sent, and that order is load-bearing: the
 * unique index on one live session per contact is what decides between two messages
 * arriving together, so a flow that sent first and filed afterwards could answer the
 * same person twice.
 */
func (s *Module) startBot(ctx context.Context, host store.User, contact types.CRMContact, in wa.Inbound) {
	start, err := s.store.BotForMessage(ctx, host.ID, in.Body)
	if errors.Is(err, store.ErrNotFound) {
		return
	}
	if err != nil {
		s.log.Error("bot: could not match a bot", "error", err, "host", host.ID)
		return
	}

	id, err := s.store.StartBotSession(ctx, start.BotID, contact.ID, start.Entry, in.WAMID)
	if errors.Is(err, store.ErrConflict) {
		// Another message from the same person, in the same instant. One flow is the
		// right number.
		return
	}
	if err != nil {
		s.log.Error("bot: could not start", "error", err, "host", host.ID,
			"bot", start.BotID, "contact", contact.ID)
		return
	}
	run := store.BotRun{
		SessionID: id, BotID: start.BotID, BotName: start.BotName,
		Active: true, State: "waiting", NodeKey: start.Entry,
	}
	s.log.Info("bot started", "host", host.ID, "bot", start.BotID, "contact", contact.ID)

	turn, ok := s.openBotTurn(ctx, host, contact, run, in.WAMID)
	if !ok {
		return
	}
	s.runFlow(ctx, turn, start.Entry)
}

// openBotTurn reads the flow and the window. A failure to read either one leaves the
// session exactly as it was, which is the state a retry can recover from.
func (s *Module) openBotTurn(
	ctx context.Context,
	host store.User,
	contact types.CRMContact,
	run store.BotRun,
	wamid string,
) (*botTurn, bool) {
	nodes, err := s.store.BotNodes(ctx, run.BotID)
	if err != nil {
		s.log.Error("bot: could not read the flow", "error", err, "bot", run.BotID)
		return nil, false
	}
	until, err := s.serviceWindow(ctx, host.ID, contact.ID)
	if err != nil {
		s.log.Error("bot: could not read the service window", "error", err,
			"host", host.ID, "contact", contact.ID)
		return nil, false
	}
	return &botTurn{
		host: host, contact: contact, run: run, nodes: nodes,
		steps: run.Steps, wamid: wamid, window: until,
	}, true
}

/* botAnswer works out which way an answer goes, and returns the next node.
 *
 * Three ways, in order of how sure they are:
 *
 *   - the reply id Meta echoes back, which is the button this flow put there. Exact,
 *     and unaffected by the host rewording the label since.
 *   - the text, compared against the labels, for somebody who typed "yes" instead of
 *     pressing Yes. People do this constantly.
 *   - the node's own fallback, for an answer that was neither.
 *
 * With no fallback, an unrecognised answer is handed to a person rather than guessed
 * at. That is the conservative reading of a bot that did not understand somebody, and
 * the alternative — repeating the question — is how a customer ends up in a loop with a
 * robot.
 */
func (s *Module) botAnswer(ctx context.Context, t *botTurn, in wa.Inbound) (string, bool) {
	node, ok := t.nodes[t.run.NodeKey]
	if !ok {
		// The question they were asked has been edited away.
		s.endBotSession(ctx, t.run, "node_missing")
		return "", false
	}
	if node.Kind != types.BotNodeAsk {
		// Only an ask parks a session waiting, so this is a flow that was edited under
		// somebody: the step they are standing on is no longer a question.
		s.endBotSession(ctx, t.run, "node_missing")
		return "", false
	}

	if id := strings.TrimSpace(in.ReplyID); id != "" {
		if i, ok := botButtonIndex(node.Key, id); ok && i < len(node.Buttons) {
			return node.Buttons[i].Next, true
		}
	}
	typed := strings.ToLower(strings.Join(strings.Fields(in.Body), " "))
	if typed != "" {
		for _, b := range node.Buttons {
			if strings.ToLower(b.Label) == typed {
				return b.Next, true
			}
		}
	}
	if node.Next != "" {
		return node.Next, true
	}
	s.handOffBot(ctx, t, "")
	return "", false
}

/* runFlow executes nodes until the conversation parks, ends, or runs out of budget.
 *
 * The loop is the bot. Everything it can do is here, and every exit from it writes the
 * session exactly once — a turn that left the session in two states, or in none, is how
 * a flow ends up answering the same message twice.
 */
func (s *Module) runFlow(ctx context.Context, t *botTurn, key string) {
	for ran := 0; ; ran++ {
		if key == "" {
			s.saveBotStep(ctx, t, store.BotStep{State: "done"})
			return
		}
		/* Both budgets, checked before the node rather than after: the cost of a step is
		 * the message it sends, so a bound that stops after the send is not a bound on
		 * anything. */
		if ran >= botNodesPerTurn || t.steps >= botNodesPerSession {
			s.log.Warn("bot: flow stopped on its step budget", "bot", t.run.BotID,
				"session", t.run.SessionID, "node", key, "steps", t.steps)
			s.saveBotStep(ctx, t, store.BotStep{
				State: "stopped", NodeKey: key, Reason: "too_many_steps",
			})
			return
		}
		node, ok := t.nodes[key]
		if !ok {
			s.saveBotStep(ctx, t, store.BotStep{
				State: "stopped", NodeKey: key, Reason: "node_missing",
			})
			return
		}
		t.steps++

		switch node.Kind {
		case types.BotNodeMessage:
			if !s.botSend(ctx, t, node, nil) {
				return
			}
			key = node.Next

		case types.BotNodeAsk:
			buttons := make([]wa.Button, 0, len(node.Buttons))
			for i, b := range node.Buttons {
				// The node's own key in the id, so an answer that arrives after the flow
				// has moved on cannot be read as an answer to the current question.
				buttons = append(buttons, wa.Button{
					ID: node.Key + ":" + strconv.Itoa(i), Title: b.Label,
				})
			}
			if !s.botSend(ctx, t, node, buttons) {
				return
			}
			// Parked at the question, not past it: this is the node the answer is about.
			s.saveBotStep(ctx, t, store.BotStep{State: "waiting", NodeKey: node.Key})
			return

		case types.BotNodeWait:
			next := node.Next
			if next == "" {
				// Nothing to wake up for.
				s.saveBotStep(ctx, t, store.BotStep{State: "done"})
				return
			}
			s.saveBotStep(ctx, t, store.BotStep{
				State: "sleeping", NodeKey: next,
				// Where it is going, not where it is: a sleeping session stores the node
				// to run when it wakes, so waking is one lookup and no special case.
				ResumeAt: time.Now().Add(time.Duration(node.DelayMinutes) * time.Minute),
			})
			return

		case types.BotNodeEnroll:
			s.botEnroll(ctx, t, node)
			key = node.Next

		case types.BotNodeTag:
			s.botTag(ctx, t, node)
			key = node.Next

		case types.BotNodeHandoff:
			s.handOffBot(ctx, t, node.Text)
			return

		default:
			// A kind written by a newer version of this server. Stopping is the honest
			// answer: carrying on would skip a step the host meant to happen.
			s.saveBotStep(ctx, t, store.BotStep{
				State: "stopped", NodeKey: key, Reason: "node_missing",
			})
			return
		}
	}
}

/* botSend writes one of the flow's messages to WhatsApp and to the thread.
 *
 * Reports whether the conversation may carry on. It may not when the window has closed
 * — a flow that slept past Meta's 24 hours cannot type anything, and the alternative of
 * queueing an approved template instead would answer somebody a day late with marketing
 * copy — or when Graph refused the send, which is a reason to stop rather than to press
 * on down a flow whose last message never arrived.
 */
func (s *Module) botSend(ctx context.Context, t *botTurn, node types.CRMBotNode, buttons []wa.Button) bool {
	if t.window.IsZero() {
		s.saveBotStep(ctx, t, store.BotStep{
			State: "stopped", NodeKey: node.Key, Reason: "window_closed",
		})
		return false
	}
	if strings.TrimSpace(node.Text) == "" {
		// A handoff with nothing to say, which is allowed. Nothing to send, nothing to
		// record, and the flow carries on.
		return true
	}

	var (
		wamid string
		err   error
	)
	if len(buttons) > 0 {
		wamid, err = s.whatsapp.SendButtons(ctx, t.host.WhatsAppToken,
			t.host.WhatsAppPhoneNumberID, wa.OutgoingButtons{
				To: t.contact.Phone, Body: node.Text, Buttons: buttons,
			})
	} else {
		wamid, err = s.whatsapp.SendText(ctx, t.host.WhatsAppToken,
			t.host.WhatsAppPhoneNumberID, t.contact.Phone, node.Text)
	}
	if err != nil {
		// Meta's own words, at Warn: the usual causes are the host's to fix — a WABA
		// with no payment method, a number that is not registered.
		s.log.Warn("bot: send failed", "error", err, "host", t.host.ID,
			"bot", t.run.BotID, "node", node.Key)
		s.saveBotStep(ctx, t, store.BotStep{
			State: "stopped", NodeKey: node.Key, Reason: "send_failed",
		})
		return false
	}

	if _, err := s.store.AppendMessage(ctx, t.host.ID, t.contact.ID, store.MessageInput{
		Direction: "out",
		Body:      node.Text,
		Status:    "sent",
		WAMID:     wamid,
		BotID:     t.run.BotID,
	}); err != nil {
		/* Sent and not filed, and the flow continues anyway.
		 *
		 * Unlike handleCRMSend there is nobody to tell, and stopping would be the worse
		 * of the two: the message has been delivered and charged for, and abandoning the
		 * conversation half-way would leave the person waiting for a question that never
		 * comes. The thread is missing a line, which the log says. */
		s.log.Error("bot: sent but not recorded", "error", err, "host", t.host.ID,
			"contact", t.contact.ID, "wamid", wamid)
	}
	return true
}

/* botEnroll puts the contact on a sequence, and never stops the flow for failing.
 *
 * Three ordinary outcomes, none of them an error here: they are already on it (entry is
 * once per person per sequence), they have no marketing opt-in (a drip is marketing and
 * the store refuses it), or the sequence has been deleted and the node points at
 * nothing. In all three the conversation carries on, because the message after this one
 * is the part the person is waiting for.
 */
func (s *Module) botEnroll(ctx context.Context, t *botTurn, node types.CRMBotNode) {
	if node.DripID == "" {
		s.log.Warn("bot: enroll step has no sequence", "bot", t.run.BotID, "node", node.Key)
		return
	}
	err := s.store.EnrollByHand(ctx, t.host.ID, node.DripID, t.contact.ID, "")
	if errors.Is(err, store.ErrConflict) {
		return
	}
	if err != nil {
		s.log.Error("bot: could not enroll", "error", err, "host", t.host.ID,
			"bot", t.run.BotID, "drip", node.DripID, "contact", t.contact.ID)
		return
	}
	s.log.Info("bot enrolled on a sequence", "host", t.host.ID, "bot", t.run.BotID,
		"drip", node.DripID, "contact", t.contact.ID)
}

/* botTag puts one of the host's labels on the contact, silently.
 *
 * Nothing is sent and nothing is written to the thread: a label is what the business
 * knows about somebody, not something said to them, and a bot that announced every
 * tag it applied would be reading its own notes out loud.
 *
 * It goes through applyTag rather than the store, which is the point of that helper
 * existing — a tag put on by a flow has to start a tag_added sequence exactly as a tag
 * put on by hand does, and once only. A failure is logged and the flow carries on:
 * the alternative is a conversation that stops mid-answer because a label did not
 * stick.
 */
func (s *Module) botTag(ctx context.Context, t *botTurn, node types.CRMBotNode) {
	if node.TagID == "" {
		s.log.Warn("bot: tag step has no tag", "bot", t.run.BotID, "node", node.Key)
		return
	}
	/* Checked here as well as when the flow was saved, because the switch can be
	 * turned off in between: a host whose tags were withdrawn should not keep getting
	 * them applied by a bot that was built while they had them. */
	if !t.host.HasFeature(types.FeatureCRMTags) {
		return
	}
	if err := s.applyTag(ctx, t.host, t.contact.ID, node.TagID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// The tag was deleted after the flow was built. Not an error worth shouting
			// about, and not a reason to stop the conversation.
			s.log.Warn("bot: tag step names a tag that is gone", "host", t.host.ID,
				"bot", t.run.BotID, "node", node.Key)
			return
		}
		s.log.Error("bot: could not tag", "error", err, "host", t.host.ID,
			"bot", t.run.BotID, "contact", t.contact.ID)
		return
	}
	s.log.Info("bot tagged a contact", "host", t.host.ID, "bot", t.run.BotID,
		"tag", node.TagID, "contact", t.contact.ID)
}

/* handOffBot stops the bot and gives the conversation to a person.
 *
 * Two writes, in this order. The session is closed first, so the contact flag cannot
 * be set while a flow is still apparently waiting for an answer; then the flag, which
 * is what keeps every bot — this one and the next message's — out of the host's way
 * until they say otherwise.
 */
func (s *Module) handOffBot(ctx context.Context, t *botTurn, text string) {
	if text != "" {
		if !s.botSend(ctx, t, types.CRMBotNode{Key: t.run.NodeKey, Text: text}, nil) {
			return
		}
	}
	s.saveBotStep(ctx, t, store.BotStep{
		State: "handoff", NodeKey: t.run.NodeKey, Reason: "handed_over",
	})
	if err := s.store.SetContactBotPaused(ctx, t.host.ID, t.contact.ID, true,
		"handed_over"); err != nil {
		s.log.Error("bot: could not pause for handoff", "error", err,
			"host", t.host.ID, "contact", t.contact.ID)
		return
	}
	s.log.Info("bot handed over", "host", t.host.ID, "bot", t.run.BotID,
		"contact", t.contact.ID)
}

// saveBotStep writes the outcome of a turn, carrying the counters and the message it
// acted on. The single place a session is written from, so a turn cannot leave it in
// two states.
func (s *Module) saveBotStep(ctx context.Context, t *botTurn, step store.BotStep) {
	step.Steps = t.steps
	step.WAMID = t.wamid
	if err := s.store.SaveBotSession(ctx, t.run.SessionID, step); err != nil {
		s.log.Error("bot: could not save the conversation", "error", err,
			"session", t.run.SessionID, "state", step.State)
	}
}

// endBotSession stops a conversation without a turn to hang it off — the cases decided
// before the flow was even read.
func (s *Module) endBotSession(ctx context.Context, run store.BotRun, reason string) {
	if err := s.store.SaveBotSession(ctx, run.SessionID, store.BotStep{
		State: "stopped", NodeKey: run.NodeKey, Reason: reason, Steps: run.Steps,
	}); err != nil {
		s.log.Error("bot: could not stop the conversation", "error", err,
			"session", run.SessionID, "reason", reason)
	}
}

// botButtonIndex reads back an id this server put on a button: "node:2". The node's own
// key has to match, so an answer to a question the flow has already moved past is not
// mistaken for an answer to the current one.
func botButtonIndex(nodeKey, id string) (int, bool) {
	rest, ok := strings.CutPrefix(id, nodeKey+":")
	if !ok {
		return 0, false
	}
	i, err := strconv.Atoi(rest)
	if err != nil || i < 0 {
		return 0, false
	}
	return i, true
}

// ----------------------------------------------------------------- sweeping

/* AdvanceBots wakes every flow whose wait is over.
 *
 * The only part of a bot the sweeper owns, and the reason `wait` is a node kind rather
 * than a sleep: a webhook request cannot be held open for four hours.
 *
 * Exported for the same reason AdvanceDrips is — nothing but time makes a wait end, so
 * a test with no way to run one pass could only assert that a bot was created. Run
 * after AdvanceDrips so a flow that enrols somebody and then waits is not a tick behind
 * the sequence it put them on.
 *
 * Two things may have changed while a flow slept, and each ends it rather than
 * continuing: the person opted out, or a human took the conversation over. Both are
 * read with the session in one query, because the alternative is waking a flow up to
 * discover it should not have been.
 */
func (s *Module) AdvanceBots(ctx context.Context) {
	due, err := s.store.DueBotSessions(ctx, botSessionsPerSweep)
	if err != nil {
		s.log.Error("bot sweep: query failed", "error", err)
		return
	}
	if len(due) == 0 {
		return
	}

	// One host usually owns many of the sleeping flows in a tick — they are all in the
	// same bot — so the token is read once per host, not once per conversation.
	hosts := map[string]store.User{}
	woken, ended := 0, 0
	for _, d := range due {
		run := store.BotRun{
			SessionID: d.SessionID, BotID: d.BotID, BotName: d.BotName,
			Active: true, State: "sleeping", NodeKey: d.NodeKey, Steps: d.Steps,
		}
		switch {
		case d.OptedOut:
			s.endBotSession(ctx, run, "opted_out")
			ended++
			continue
		case d.Paused:
			s.endBotSession(ctx, run, "host_took_over")
			ended++
			continue
		}

		host, ok := hosts[d.HostID]
		if !ok {
			host, err = s.store.UserByID(ctx, d.HostID)
			if err != nil {
				// Left asleep rather than ended: a host that cannot be read right now is
				// a reason to try again on the next tick.
				s.log.Error("bot sweep: could not read the host", "error", err, "host", d.HostID)
				continue
			}
			hosts[d.HostID] = host
		}
		if s.whatsapp == nil || host.WhatsAppToken == "" || host.WhatsAppPhoneNumberID == "" {
			// Disconnected since the flow went to sleep. Nothing can be sent for this
			// host at all, so the conversation is closed rather than left due for ever.
			s.endBotSession(ctx, run, "whatsapp_disconnected")
			ended++
			continue
		}
		contact, err := s.store.Contact(ctx, d.HostID, d.ContactID)
		if err != nil {
			s.log.Error("bot sweep: could not read the contact", "error", err,
				"host", d.HostID, "contact", d.ContactID)
			continue
		}

		// No wamid: nothing arrived, and the session's memory of the message it last
		// acted on has to survive the wake.
		turn, ok := s.openBotTurn(ctx, host, contact, run, "")
		if !ok {
			continue
		}
		s.runFlow(ctx, turn, d.NodeKey)
		woken++
	}
	if woken > 0 || ended > 0 {
		s.log.Info("bot sweep", "woken", woken, "ended", ended, "due", len(due))
	}
}
