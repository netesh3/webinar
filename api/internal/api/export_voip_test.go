package api

import (
	"context"
	"encoding/json"

	"github.com/netkumar/webcast/api/internal/push"
)

// PushVoIP is the calls API's VoIP hook, for tests (31 Oct 2026). WaitBackground waits for the sends.
func PushVoIP(s *Server, ctx context.Context, userID string, payload json.RawMessage) {
	s.pushVoIP(ctx, userID, payload)
}

// UseVoIPSender replaces the APNs VoIP sender (a fake APNs needs the test server's TLS client).
func UseVoIPSender(s *Server, v *push.VoIPSender) { s.voip = v }

// VoIPEnabled is whether the server built a VoIP sender from its config.
func VoIPEnabled(s *Server) bool { return s.voip != nil }
