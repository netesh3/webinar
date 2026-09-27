package wa

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
	"time"
)

/* The demo account's pretend WhatsApp.
 *
 * `go run ./cmd/seed-demo` creates a coach whose "connection" is a token starting with
 * DemoTokenPrefix. Meta would refuse it (error 190), which would put a Reconnect
 * banner over every screen the demo is meant to show — so the client answers for it
 * instead: sends succeed with a made-up message id, the token check says healthy,
 * and nothing leaves this process. Real tokens from Meta never start with this, and
 * only the seed command ever writes one.
 */
const DemoTokenPrefix = "demo-"

// IsDemoToken reports whether a token is the demo account's pretend one.
func IsDemoToken(token string) bool {
	return strings.HasPrefix(strings.TrimSpace(token), DemoTokenPrefix)
}

func demoMessageID() string {
	var b [10]byte
	_, _ = rand.Read(b[:])
	return "wamid.demo." + hex.EncodeToString(b[:])
}

// demoHealth is a healthy, never-expiring token.
func demoHealth() TokenHealth { return TokenHealth{Valid: true, ExpiresAt: time.Time{}} }
