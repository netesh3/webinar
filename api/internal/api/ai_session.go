package api

import (
	"context"

	"github.com/netkumar/webcast/api/types"
)

/* sessionAIAllowed is the one gate on AI processing of a session's content: the lead
 * reasons, the follow-up drafts, and anything else that sends what was said or typed in
 * a session to a model. Today it is the webinar's host account's "ai" switch
 * (types.FeatureAI, opt-in by an admin). The host's account decides, not the caller's:
 * a co-host looking at Results cannot turn AI on for somebody else's session. */
func (s *Server) sessionAIAllowed(ctx context.Context, wb types.Webinar) bool {
	if wb.Host.ID == "" {
		return false
	}
	host, err := s.store.UserByID(ctx, wb.Host.ID)
	if err != nil {
		return false
	}
	return host.HasFeature(types.FeatureAI)
}
