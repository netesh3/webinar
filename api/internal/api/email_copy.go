package api

import (
	"context"
	"errors"

	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/internal/store"
)

/* A host's edited email template replaces the built-in wording for that message.
 * A row they have not edited is ignored, so mail stays exactly what the notify
 * functions already produce. A missing row falls back the same way.
 */

func (s *Server) registrantMail(
	ctx context.Context, hostID, key string, in notify.Invite, window string,
	builtin func() (string, string),
) (string, string) {
	if row, ok := s.customEmail(ctx, hostID, key); ok {
		return notify.FillEmail(row.Subject, row.Body, in, window)
	}
	return builtin()
}

func (s *Server) panelistMail(
	ctx context.Context, hostID, key string, in notify.Invite,
	builtin func() (string, string, string),
) (subject, text, html string) {
	subject, text, html = builtin()
	if row, ok := s.customEmail(ctx, hostID, key); ok {
		subject, text = notify.FillEmail(row.Subject, row.Body, in, "")
		html = ""
	}
	return subject, text, html
}

func (s *Server) customEmail(ctx context.Context, hostID, key string) (store.EmailTemplate, bool) {
	if hostID == "" || key == "" {
		return store.EmailTemplate{}, false
	}
	row, err := s.store.EmailTemplateByKey(ctx, hostID, key)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			s.log.Warn("email template", "key", key, "error", err)
		}
		return store.EmailTemplate{}, false
	}
	if !row.Customized {
		return store.EmailTemplate{}, false
	}
	return row, true
}
