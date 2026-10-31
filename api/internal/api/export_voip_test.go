package api

import (
	"context"

	"github.com/netkumar/webcast/api/internal/push"
)

// SendVoIPCall is sendVoIPCall, for tests (31 Oct 2026). WaitBackground waits for the sends.
func SendVoIPCall(s *Server, ctx context.Context, userID string, payload map[string]string) {
	s.sendVoIPCall(ctx, userID, payload)
}

// UseVoIPSender replaces the APNs VoIP sender (a fake APNs needs the test server's TLS client).
func UseVoIPSender(s *Server, v *push.VoIPSender) { s.voip = v }

// VoIPEnabled is whether the server built a VoIP sender from its config.
func VoIPEnabled(s *Server) bool { return s.voip != nil }
