package engage

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/internal/store"
)

const inboxSecretHeader = "X-Inbox-Webhook-Secret"

type inboxView struct {
	Address   string         `json:"address"`
	Local     string         `json:"local"`
	CanRename bool           `json:"canRename"`
	Alias     string         `json:"alias,omitempty"`
	Messages  []inboxMessage `json:"messages"`
}

type inboxMessage struct {
	ID        string `json:"id"`
	Direction string `json:"direction"`
	From      string `json:"from"`
	To        string `json:"to"`
	Subject   string `json:"subject"`
	Body      string `json:"body"`
	At        string `json:"at"`
}

type inboxRename struct {
	Local string `json:"local"`
}

type inboxReply struct {
	Body string `json:"body"`
}

type inboundMail struct {
	To        string `json:"to"`
	From      string `json:"from"`
	Subject   string `json:"subject"`
	Text      string `json:"text"`
	MessageID string `json:"messageId"`
	InReplyTo string `json:"inReplyTo"`
}

func (s *Module) mountEmail(public, host chi.Router) {
	public.Post("/webhooks/email", s.handleInboundEmail)
	host.Get("/email-inbox", s.handleEmailInbox)
	host.Put("/email-inbox/address", s.handleRenameEmailInbox)
	host.Post("/email-inbox/{id}/reply", s.handleReplyEmail)
}

func (s *Module) handleEmailInbox(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	view, err := s.inboxFor(r, user)
	if err != nil {
		s.fail(w, r, "email inbox", err)
		return
	}
	httpx.JSON(w, http.StatusOK, view)
}

func (s *Module) handleRenameEmailInbox(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	var body inboxRename
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_json", "Could not read that request.")
		return
	}
	inbox, err := s.store.RenameInbox(r.Context(), user.ID, user.Name, body.Local)
	if err != nil {
		switch {
		case err == store.ErrInboxTaken:
			httpx.Error(w, http.StatusConflict, "address_taken", "That address is taken.")
		case err == store.ErrInboxLocked:
			httpx.Error(w, http.StatusConflict, "address_locked",
				"You've already changed this address. Contact support to change it again.")
		case err == store.ErrInboxInvalid:
			httpx.Error(w, http.StatusUnprocessableEntity, "address_invalid",
				"Use lowercase letters, digits and hyphens only.")
		default:
			s.fail(w, r, "rename inbox", err)
		}
		return
	}
	msgs, err := s.store.ListHostEmails(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "email inbox", err)
		return
	}
	httpx.JSON(w, http.StatusOK, inboxJSON(inbox, msgs))
}

func (s *Module) handleReplyEmail(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	var body inboxReply
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_json", "Could not read that request.")
		return
	}
	text := strings.TrimSpace(body.Body)
	if text == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "empty", "Write a reply first.")
		return
	}
	if s.mail == nil || !s.mail.Configured() {
		httpx.Error(w, http.StatusServiceUnavailable, "mail_unconfigured",
			"Outbound email is not configured.")
		return
	}
	parent, err := s.store.HostEmailForUser(r.Context(), user.ID, chi.URLParam(r, "id"))
	if err == store.ErrNotFound {
		httpx.Error(w, http.StatusNotFound, "not_found", "That message is not in your inbox.")
		return
	}
	if err != nil {
		s.fail(w, r, "email reply", err)
		return
	}
	inbox, err := s.store.EnsureInbox(r.Context(), user.ID, user.Name)
	if err != nil {
		s.fail(w, r, "email reply inbox", err)
		return
	}
	to := parent.From
	if parent.Direction == "out" {
		to = parent.To
	}
	subject := replySubject(parent.Subject)
	thread := parent.MessageID
	if thread != "" && !strings.HasPrefix(thread, "<") {
		thread = "<" + thread + ">"
	}
	msg := notify.Message{
		To:         to,
		Subject:    subject,
		Body:       text,
		ReplyTo:    notify.InboxAddress(inbox.Local),
		InReplyTo:  thread,
		References: thread,
	}
	if err := s.mail.Send(r.Context(), msg); err != nil {
		s.fail(w, r, "email reply send", err)
		return
	}
	saved, err := s.store.InsertHostEmail(r.Context(), store.HostEmail{
		UserID:    user.ID,
		Direction: "out",
		From:      "webinar",
		To:        to,
		Subject:   subject,
		Body:      text,
		InReplyTo: thread,
	})
	if err != nil {
		s.fail(w, r, "email reply store", err)
		return
	}
	httpx.JSON(w, http.StatusOK, inboxMessage{
		ID: saved.ID, Direction: saved.Direction, From: saved.From, To: saved.To,
		Subject: saved.Subject, Body: saved.Body, At: saved.CreatedAt.UTC().Format(time.RFC3339),
	})
}

func (s *Module) handleInboundEmail(w http.ResponseWriter, r *http.Request) {
	want := strings.TrimSpace(s.cfg.InboxWebhookSecret)
	if want == "" {
		httpx.Error(w, http.StatusServiceUnavailable, "inbox_unset", "Inbound email is not configured.")
		return
	}
	got := r.Header.Get(inboxSecretHeader)
	if subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "Unauthorized.")
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_body", "Could not read that message.")
		return
	}
	var in inboundMail
	if err := json.Unmarshal(raw, &in); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_json", "Could not read that message.")
		return
	}
	local := localPart(in.To)
	userID, ok, err := s.store.HostForInboxLocal(r.Context(), local)
	if err != nil {
		s.fail(w, r, "inbound email", err)
		return
	}
	if !ok {
		httpx.JSON(w, http.StatusOK, map[string]bool{"stored": false})
		return
	}
	subject := decodeMailHeader(in.Subject)
	if _, err := s.store.InsertHostEmail(r.Context(), store.HostEmail{
		UserID:    userID,
		Direction: "in",
		From:      strings.TrimSpace(in.From),
		To:        strings.TrimSpace(in.To),
		Subject:   subject,
		Body:      in.Text,
		MessageID: strings.TrimSpace(in.MessageID),
		InReplyTo: strings.TrimSpace(in.InReplyTo),
	}); err != nil {
		s.fail(w, r, "inbound email store", err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"stored": true})
}

func (s *Module) inboxFor(r *http.Request, user store.User) (inboxView, error) {
	inbox, err := s.store.EnsureInbox(r.Context(), user.ID, user.Name)
	if err != nil {
		return inboxView{}, err
	}
	msgs, err := s.store.ListHostEmails(r.Context(), user.ID)
	if err != nil {
		return inboxView{}, err
	}
	return inboxJSON(inbox, msgs), nil
}

func inboxJSON(inbox store.Inbox, msgs []store.HostEmail) inboxView {
	view := inboxView{
		Address:   inbox.Address,
		Local:     inbox.Local,
		CanRename: !inbox.Renamed,
		Alias:     inbox.Alias,
		Messages:  []inboxMessage{},
	}
	for _, m := range msgs {
		view.Messages = append(view.Messages, inboxMessage{
			ID: m.ID, Direction: m.Direction, From: m.From, To: m.To,
			Subject: m.Subject, Body: m.Body, At: m.CreatedAt.UTC().Format(time.RFC3339),
		})
	}
	return view
}

func localPart(addr string) string {
	addr = strings.ToLower(strings.TrimSpace(addr))
	if i := strings.LastIndex(addr, "<"); i >= 0 {
		addr = strings.Trim(addr[i+1:], ">")
	}
	at := strings.LastIndex(addr, "@")
	if at <= 0 {
		return ""
	}
	if !strings.HasSuffix(addr[at:], "@webinarliv.com") && addr[at+1:] != "webinarliv.com" {
		return ""
	}
	return addr[:at]
}

func replySubject(subject string) string {
	subject = strings.TrimSpace(subject)
	if subject == "" {
		return "Re: (no subject)"
	}
	if strings.HasPrefix(strings.ToLower(subject), "re:") {
		return subject
	}
	return "Re: " + subject
}

func decodeMailHeader(s string) string {
	dec := new(mime.WordDecoder)
	out, err := dec.DecodeHeader(s)
	if err != nil || out == "" {
		return s
	}
	return out
}
