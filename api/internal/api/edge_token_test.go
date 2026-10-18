package api

import (
	"testing"
	"time"
)

func TestEventsTokenRoundTripAndScope(t *testing.T) {
	secret := []byte("test-secret")
	now := time.Now()
	tok, err := signEvents(secret, "att_k1", "Alice", "w1", now)
	if err != nil {
		t.Fatal(err)
	}
	id, name, err := verifyEvents(secret, tok, "w1", now)
	if err != nil || id != "att_k1" || name != "Alice" {
		t.Fatalf("verify = %q %q %v", id, name, err)
	}
	if _, _, err := verifyEvents(secret, tok, "w2", now); err == nil {
		t.Fatal("a token for one webinar opened another")
	}
	if _, _, err := verifyEvents([]byte("other"), tok, "w1", now); err == nil {
		t.Fatal("a token signed with another secret verified")
	}
	if _, _, err := verifyEvents(secret, tok, "w1", now.Add(eventsTokenTTL+time.Minute)); err == nil {
		t.Fatal("an expired token verified")
	}
	// A rejoin token (same secret, other issuer) must not pass as an events token.
	rejoin, err := signRejoin(secret, "reg-1", "w1", now, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := verifyEvents(secret, rejoin, "w1", now); err == nil {
		t.Fatal("a rejoin token passed as an events token")
	}
}
