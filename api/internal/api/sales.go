package api

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/internal/sales"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The home page's sales chat.
 *
 *   POST /api/sales/chat               public   start; returns the token once
 *   GET  /api/sales/chat?after=N       token    poll: status and new messages
 *   POST /api/sales/chat/messages      token    the visitor writes; the assistant answers
 *   POST /api/sales/chat/handoff       token    "talk to a person"
 *   POST /api/sales/chat/contact       token    where to reply if the team misses them
 *
 *   GET  /api/admin/sales?filter=      admin    the inbox; also marks the admin online
 *   GET  /api/admin/sales/{id}?after=N admin    one conversation
 *   POST /api/admin/sales/{id}/join    admin    take it over; the assistant goes quiet
 *   POST /api/admin/sales/{id}/messages admin   reply in the chat, or by email
 *   POST /api/admin/sales/{id}/close   admin
 *
 * The visitor has no account, so the browser holds a random token (X-Chat-Token)
 * and the server stores its SHA-256. Realtime is polling: a couple of seconds while
 * a person is involved is plenty for chat, and it works through the Cloudflare
 * Worker and Cloud Run scaling to zero without a socket to keep alive.
 *
 * Handing off is the assistant's safe answer to everything it should not answer,
 * and also what happens when no model is available or the conversation has run
 * long: the visitor always ends up with a person rather than an error.
 */

const (
	salesTokenHeader = "X-Chat-Token" // #nosec G101 -- a header name, not a credential
	// salesMaxBody is the longest message accepted, in characters.
	salesMaxBody = 1000
	// salesMaxAIReplies is when the assistant hands a long conversation to a person,
	// which also bounds what one visitor can spend of a free model allowance.
	salesMaxAIReplies = 20
	// salesVisitorOnline: a visitor polled this recently is still on the page.
	salesVisitorOnline = 45 * time.Second
	// salesTeamOnline: an admin polled the inbox this recently is "online".
	salesTeamOnline = 2 * time.Minute
)

func newSalesToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// ------------------------------------------------------------------ visitor

func (s *Server) handleStartSalesChat(w http.ResponseWriter, r *http.Request) {
	if ok, _ := s.salesStartLimit.Allow(httpx.ClientIP(r)); !ok {
		httpx.Error(w, http.StatusTooManyRequests, "rate_limited", "Too many chats from here. Try again in a minute.")
		return
	}
	var req types.StartSalesChatRequest
	_ = httpx.DecodeJSON(w, r, &req) // an empty body is fine
	token, err := newSalesToken()
	if err != nil {
		s.fail(w, r, "sales: token", err)
		return
	}
	var userID, name, email string
	if u, ok := s.optionalUser(r); ok {
		userID, name, email = u.ID, u.Name, u.Email
	}
	conv, err := s.store.CreateSalesConversation(r.Context(), store.HashSalesToken(token),
		userID, name, email, clipRunes(req.Page, 200), sales.Greeting)
	if err != nil {
		s.fail(w, r, "sales: create", err)
		return
	}
	chat, err := s.salesChatView(r.Context(), conv, 0)
	if err != nil {
		s.fail(w, r, "sales: view", err)
		return
	}
	chat.Token = token
	httpx.JSON(w, http.StatusCreated, chat)
}

// salesVisitor resolves the X-Chat-Token header to its conversation.
func (s *Server) salesVisitor(w http.ResponseWriter, r *http.Request) (store.SalesConversation, bool) {
	token := strings.TrimSpace(r.Header.Get(salesTokenHeader))
	if token == "" {
		httpx.Error(w, http.StatusUnauthorized, "no_chat", "No chat to continue.")
		return store.SalesConversation{}, false
	}
	conv, err := s.store.SalesConversationByToken(r.Context(), store.HashSalesToken(token))
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "no_chat", "That chat has ended. Start a new one.")
		return store.SalesConversation{}, false
	}
	if err != nil {
		s.fail(w, r, "sales: lookup", err)
		return store.SalesConversation{}, false
	}
	return conv, true
}

func (s *Server) handleSalesChat(w http.ResponseWriter, r *http.Request) {
	conv, ok := s.salesVisitor(w, r)
	if !ok {
		return
	}
	chat, err := s.salesChatView(r.Context(), conv, afterParam(r))
	if err != nil {
		s.fail(w, r, "sales: view", err)
		return
	}
	httpx.JSON(w, http.StatusOK, chat)
}

func (s *Server) handleSalesVisitorMessage(w http.ResponseWriter, r *http.Request) {
	conv, ok := s.salesVisitor(w, r)
	if !ok {
		return
	}
	if ok, _ := s.salesMsgLimit.Allow("conv:" + conv.ID); !ok {
		httpx.Error(w, http.StatusTooManyRequests, "rate_limited", "You're sending messages quickly — give it a few seconds.")
		return
	}
	if ok, _ := s.salesMsgLimit.Allow("ip:" + httpx.ClientIP(r)); !ok {
		httpx.Error(w, http.StatusTooManyRequests, "rate_limited", "Too many messages from here. Try again in a minute.")
		return
	}
	var req types.SalesMessageRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that message.")
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		httpx.Fields(w, map[string]string{"body": "Type a message."})
		return
	}
	if utf8.RuneCountInString(body) > salesMaxBody {
		httpx.Fields(w, map[string]string{"body": "Keep it under 1,000 characters."})
		return
	}
	after := afterParam(r)
	ctx := r.Context()
	if _, err := s.store.AddSalesMessage(ctx, conv.ID, store.SalesMessage{
		Role: types.SalesFromVisitor, AuthorName: conv.Name, Body: body,
	}); err != nil {
		s.fail(w, r, "sales: add", err)
		return
	}

	// Writing into a closed chat starts it again with the assistant.
	if conv.Status == types.SalesClosed {
		if err := s.store.ReopenSalesConversation(ctx, conv.ID); err != nil {
			s.fail(w, r, "sales: reopen", err)
			return
		}
		conv.Status = types.SalesAI
	}
	// The assistant only answers a conversation no person has taken.
	if conv.Status == types.SalesAI {
		if err := s.salesAssistantTurn(ctx, conv, body); err != nil {
			s.fail(w, r, "sales: assistant", err)
			return
		}
	}

	conv, err := s.store.SalesConversationByID(ctx, conv.ID)
	if err != nil {
		s.fail(w, r, "sales: reload", err)
		return
	}
	chat, err := s.salesChatView(ctx, conv, after)
	if err != nil {
		s.fail(w, r, "sales: view", err)
		return
	}
	httpx.JSON(w, http.StatusOK, chat)
}

/* salesAssistantTurn answers the visitor's latest message, or hands off.
 *
 * Handoff, in the order checked: the visitor asked for a person in so many words;
 * the conversation has had its share of assistant replies; no model could answer;
 * the model itself said it should not answer this.
 */
func (s *Server) salesAssistantTurn(ctx context.Context, conv store.SalesConversation, latest string) error {
	if sales.AsksForPerson(latest) {
		return s.salesHandoff(ctx, conv, "asked for a person", sales.HandoffReply, latest)
	}
	if conv.AIReplies >= salesMaxAIReplies {
		return s.salesHandoff(ctx, conv, "long conversation — the assistant stepped back", sales.LimitReply, latest)
	}
	if !s.ai.Enabled() {
		return s.salesHandoff(ctx, conv, "AI is not configured", sales.UnavailableReply, latest)
	}

	msgs, err := s.store.SalesMessages(ctx, conv.ID, 0)
	if err != nil {
		return err
	}
	var history []sales.Turn
	for _, m := range msgs {
		switch m.Role {
		case types.SalesFromVisitor:
			history = append(history, sales.Turn{FromVisitor: true, Text: m.Body})
		case types.SalesFromAI:
			history = append(history, sales.Turn{Text: m.Body})
		}
	}
	aiCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	reply, err := s.aiComplete(aiCtx, types.AIFeatureSalesChat, "",
		ai.Request{Messages: sales.Messages(s.cfg.BillingGSTPercent, history), MaxTokens: 350})
	if errors.Is(err, errAILimit) {
		return s.salesHandoff(ctx, conv, "AI monthly limit reached", sales.UnavailableReply, latest)
	}
	if errors.Is(err, ai.ErrUnavailable) || (err != nil && ctx.Err() == nil) {
		return s.salesHandoff(ctx, conv, "AI unavailable", sales.UnavailableReply, latest)
	}
	if err != nil {
		return err
	}
	text, handoff, reason := sales.ParseReply(reply.Text)
	if handoff || text == "" {
		if reason == "" {
			reason = "the assistant could not answer"
		}
		return s.salesHandoff(ctx, conv, reason, sales.HandoffReply, latest)
	}
	_, err = s.store.AddSalesMessage(ctx, conv.ID, store.SalesMessage{Role: types.SalesFromAI, AuthorName: "AI Agent", Body: text})
	return err
}

/* salesHandoff brings a person in: the conversation moves to "waiting", the visitor
 * is told so, and every admin is emailed — once per conversation, however many
 * times it is asked for. */
func (s *Server) salesHandoff(ctx context.Context, conv store.SalesConversation, reason, reply, question string) error {
	changed, err := s.store.RequestSalesHandoff(ctx, conv.ID, clipRunes(reason, 200))
	if err != nil {
		return err
	}
	if !changed {
		return nil
	}
	if _, err := s.store.AddSalesMessage(ctx, conv.ID, store.SalesMessage{Role: types.SalesFromAI, AuthorName: "AI Agent", Body: reply}); err != nil {
		return err
	}
	s.log.Info("sales: handoff", "conversation", conv.ID, "reason", reason)
	return s.notifySalesAdmins(ctx, conv, reason, question)
}

func (s *Server) notifySalesAdmins(ctx context.Context, conv store.SalesConversation, reason, question string) error {
	to, err := s.store.AdminEmails(ctx)
	if err != nil {
		return err
	}
	if len(to) == 0 {
		to = []string{notify.HostRequestRecipient}
	}
	visitor := firstNonBlank(conv.Name, conv.Email, conv.AccountEmail)
	subject, body := notify.SalesHandoffEmail(notify.SalesHandoffNotice{
		Visitor:  visitor,
		Email:    firstNonBlank(conv.Email, conv.AccountEmail),
		Reason:   reason,
		Question: clipRunes(question, 500),
		Page:     conv.Page,
		Link:     strings.TrimRight(s.cfg.WebBaseURL, "/") + "/admin/sales?c=" + conv.ID,
	})
	insertCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	for _, addr := range to {
		if err := s.store.Notify(insertCtx, s.store.DB(), store.Notification{
			Email: addr, Kind: types.NotifySalesHandoff, Subject: subject, Body: body,
			ReplyTo: firstNonBlank(conv.Email, conv.AccountEmail),
		}); err != nil {
			return err
		}
	}
	s.inBackground(func(ctx context.Context) { s.flushOutbox(ctx) })
	return nil
}

func (s *Server) handleSalesHandoff(w http.ResponseWriter, r *http.Request) {
	conv, ok := s.salesVisitor(w, r)
	if !ok {
		return
	}
	var req types.SalesHandoffRequest
	_ = httpx.DecodeJSON(w, r, &req)
	reason := firstNonBlank(clipRunes(req.Reason, 200), "asked for a person")
	if conv.Status == types.SalesClosed {
		// A closed conversation reopened by asking for a person is a new request.
		if err := s.store.ReopenSalesConversation(r.Context(), conv.ID); err != nil {
			s.fail(w, r, "sales: reopen", err)
			return
		}
		conv.Status = types.SalesAI
	}
	if err := s.salesHandoff(r.Context(), conv, reason, sales.HandoffReply, lastVisitorText(r.Context(), s, conv.ID)); err != nil {
		s.fail(w, r, "sales: handoff", err)
		return
	}
	conv, err := s.store.SalesConversationByID(r.Context(), conv.ID)
	if err != nil {
		s.fail(w, r, "sales: reload", err)
		return
	}
	chat, err := s.salesChatView(r.Context(), conv, afterParam(r))
	if err != nil {
		s.fail(w, r, "sales: view", err)
		return
	}
	httpx.JSON(w, http.StatusOK, chat)
}

func (s *Server) handleSalesContact(w http.ResponseWriter, r *http.Request) {
	conv, ok := s.salesVisitor(w, r)
	if !ok {
		return
	}
	var req types.SalesContactRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that.")
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if a, err := mail.ParseAddress(email); err != nil || a.Address != email || !strings.Contains(email[strings.LastIndex(email, "@")+1:], ".") {
		httpx.Fields(w, map[string]string{"email": "That doesn't look like an email address."})
		return
	}
	name := clipRunes(strings.TrimSpace(req.Name), 80)
	if err := s.store.SetSalesContact(r.Context(), conv.ID, name, email); err != nil {
		s.fail(w, r, "sales: contact", err)
		return
	}
	if _, err := s.store.AddSalesMessage(r.Context(), conv.ID, store.SalesMessage{
		Role: types.SalesFromSystem, Body: "We'll reply to " + email + " if we miss you here.",
	}); err != nil {
		s.fail(w, r, "sales: contact note", err)
		return
	}
	conv, err := s.store.SalesConversationByID(r.Context(), conv.ID)
	if err != nil {
		s.fail(w, r, "sales: reload", err)
		return
	}
	chat, err := s.salesChatView(r.Context(), conv, afterParam(r))
	if err != nil {
		s.fail(w, r, "sales: view", err)
		return
	}
	httpx.JSON(w, http.StatusOK, chat)
}

func (s *Server) salesChatView(ctx context.Context, conv store.SalesConversation, after int64) (types.SalesChat, error) {
	msgs, err := s.store.SalesMessages(ctx, conv.ID, after)
	if err != nil {
		return types.SalesChat{}, err
	}
	online, err := s.store.SalesTeamOnline(ctx, salesTeamOnline)
	if err != nil {
		return types.SalesChat{}, err
	}
	chat := types.SalesChat{
		Status: conv.Status, Name: conv.Name, Email: conv.Email,
		TeamOnline: online, AIEnabled: s.ai.Enabled(), Messages: make([]types.SalesMessage, 0, len(msgs)),
	}
	if conv.Status == types.SalesHuman {
		chat.AgentName = firstName(conv.AssignedName)
	}
	for _, m := range msgs {
		wire := salesMessageWire(m)
		if m.Role == types.SalesFromAdmin {
			wire.AuthorName = firstName(m.AuthorName) // a visitor sees "Netesh", not a full name
		}
		chat.Messages = append(chat.Messages, wire)
	}
	return chat, nil
}

// ------------------------------------------------------------------ admin

func (s *Server) handleAdminSalesInbox(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	_ = s.store.TouchSalesAdmin(r.Context(), admin.ID)
	list, waiting, err := s.store.SalesInbox(r.Context(), r.URL.Query().Get("filter"), 100)
	if err != nil {
		s.fail(w, r, "sales: inbox", err)
		return
	}
	out := types.SalesInbox{NeedsYou: waiting, Conversations: make([]types.SalesConversation, 0, len(list))}
	for _, c := range list {
		out.Conversations = append(out.Conversations, salesConversationWire(c))
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (s *Server) handleAdminSalesConversation(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	_ = s.store.TouchSalesAdmin(r.Context(), admin.ID)
	s.writeAdminSalesDetail(w, r, chi.URLParam(r, "id"), afterParam(r))
}

func (s *Server) writeAdminSalesDetail(w http.ResponseWriter, r *http.Request, id string, after int64) {
	conv, err := s.store.SalesConversationByID(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such conversation.")
		return
	}
	if err != nil {
		s.fail(w, r, "sales: conversation", err)
		return
	}
	msgs, err := s.store.SalesMessages(r.Context(), id, after)
	if err != nil {
		s.fail(w, r, "sales: messages", err)
		return
	}
	out := types.SalesConversationDetail{Conversation: salesConversationWire(conv), Messages: make([]types.SalesMessage, 0, len(msgs))}
	for _, m := range msgs {
		out.Messages = append(out.Messages, salesMessageWire(m))
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (s *Server) handleAdminSalesJoin(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	id := chi.URLParam(r, "id")
	if err := s.salesJoin(r.Context(), id, admin); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found", "No such conversation.")
			return
		}
		s.fail(w, r, "sales: join", err)
		return
	}
	s.writeAdminSalesDetail(w, r, id, afterParam(r))
}

func (s *Server) salesJoin(ctx context.Context, id string, admin store.User) error {
	joined, err := s.store.JoinSalesConversation(ctx, id, admin.ID)
	if err != nil || !joined {
		return err
	}
	_, err = s.store.AddSalesMessage(ctx, id, store.SalesMessage{
		Role: types.SalesFromSystem, Body: firstName(firstNonBlank(admin.Name, "Someone from the team")) + " joined the chat",
	})
	s.log.Info("sales: admin joined", "conversation", id, "admin", admin.ID)
	return err
}

/* handleAdminSalesMessage is an admin's reply.
 *
 * It goes to the chat when the visitor is still on the page, and to their email
 * when they have left — or when the admin chooses email. Replying is taking the
 * conversation: an admin who answers has joined it, and the assistant stops. */
func (s *Server) handleAdminSalesMessage(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	id := chi.URLParam(r, "id")
	var req types.SalesMessageRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that reply.")
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		httpx.Fields(w, map[string]string{"body": "Type a reply."})
		return
	}
	if utf8.RuneCountInString(body) > 4000 {
		httpx.Fields(w, map[string]string{"body": "Keep it under 4,000 characters."})
		return
	}
	conv, err := s.store.SalesConversationByID(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such conversation.")
		return
	}
	if err != nil {
		s.fail(w, r, "sales: conversation", err)
		return
	}
	replyTo := firstNonBlank(conv.Email, conv.AccountEmail)
	online := time.Since(conv.VisitorSeenAt) < salesVisitorOnline
	var emailed bool
	switch req.Via {
	case "email":
		if replyTo == "" {
			httpx.Fields(w, map[string]string{"via": "They haven't left an email. Reply in the chat while they're here."})
			return
		}
		emailed = true
	case "chat":
	default:
		emailed = !online && replyTo != ""
	}

	if conv.Status != types.SalesHuman || conv.AssignedAdminID != admin.ID {
		if err := s.salesJoin(r.Context(), id, admin); err != nil {
			s.fail(w, r, "sales: join", err)
			return
		}
	}
	if _, err := s.store.AddSalesMessage(r.Context(), id, store.SalesMessage{
		Role: types.SalesFromAdmin, AuthorID: admin.ID, AuthorName: admin.Name, Body: body, Emailed: emailed,
	}); err != nil {
		s.fail(w, r, "sales: reply", err)
		return
	}
	if emailed {
		subject, text := notify.SalesReplyEmail(notify.SalesReplyNotice{
			VisitorName: conv.Name,
			AdminName:   admin.Name,
			Reply:       body,
			Question:    lastVisitorText(r.Context(), s, id),
			ResumeLink:  strings.TrimRight(s.cfg.WebBaseURL, "/") + "/#chat",
		})
		insertCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
		defer cancel()
		if err := s.store.Notify(insertCtx, s.store.DB(), store.Notification{
			Email: replyTo, Kind: types.NotifySalesReply, Subject: subject, Body: text, ReplyTo: admin.Email,
		}); err != nil {
			s.fail(w, r, "sales: reply email", err)
			return
		}
		s.inBackground(func(ctx context.Context) { s.flushOutbox(ctx) })
	}
	s.writeAdminSalesDetail(w, r, id, afterParam(r))
}

func (s *Server) handleAdminSalesClose(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.store.CloseSalesConversation(r.Context(), id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found", "No such conversation.")
			return
		}
		s.fail(w, r, "sales: close", err)
		return
	}
	_, _ = s.store.AddSalesMessage(r.Context(), id, store.SalesMessage{Role: types.SalesFromSystem, Body: "The team closed this chat. Write again any time."})
	s.writeAdminSalesDetail(w, r, id, afterParam(r))
}

// ------------------------------------------------------------------ helpers

func salesMessageWire(m store.SalesMessage) types.SalesMessage {
	return types.SalesMessage{
		ID: m.ID, Role: m.Role, AuthorName: m.AuthorName, Body: m.Body, Emailed: m.Emailed,
		CreatedAt: m.CreatedAt.UTC().Format(time.RFC3339),
	}
}

func salesConversationWire(c store.SalesConversation) types.SalesConversation {
	out := types.SalesConversation{
		ID: c.ID, Status: c.Status, Name: c.Name, Email: c.Email, AccountEmail: c.AccountEmail,
		HandoffReason: c.HandoffReason, AssignedTo: c.AssignedName, Page: c.Page,
		VisitorOnline: time.Since(c.VisitorSeenAt) < salesVisitorOnline,
		LastMessage:   c.LastMessage,
		LastMessageAt: c.LastMessageAt.UTC().Format(time.RFC3339),
		CreatedAt:     c.CreatedAt.UTC().Format(time.RFC3339),
	}
	if c.HandoffAt != nil {
		out.HandoffAt = c.HandoffAt.UTC().Format(time.RFC3339)
	}
	return out
}

func lastVisitorText(ctx context.Context, s *Server, id string) string {
	msgs, err := s.store.SalesMessages(ctx, id, 0)
	if err != nil {
		return ""
	}
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == types.SalesFromVisitor {
			return msgs[i].Body
		}
	}
	return ""
}

func afterParam(r *http.Request) int64 {
	n, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	if n < 0 {
		return 0
	}
	return n
}

func firstNonBlank(vals ...string) string {
	for _, v := range vals {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
}

func firstName(full string) string {
	if f := strings.Fields(full); len(f) > 0 {
		return f[0]
	}
	return ""
}

func clipRunes(s string, max int) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > max {
		return string(r[:max])
	}
	return s
}
