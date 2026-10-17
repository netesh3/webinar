package api

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/netkumar/webcast/api/internal/auth"
	"github.com/netkumar/webcast/api/types"
)

var rejoinSecret = []byte("test-secret-test-secret-test-secret-32")

func TestRejoinTokenRoundTrip(t *testing.T) {
	now := time.Date(2026, 10, 17, 10, 0, 0, 0, time.UTC)
	tok, err := signRejoin(rejoinSecret, "reg-1", "my-webinar", now, now.Add(2*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(tok, "JOINKEY") {
		t.Fatal("token must not carry a join key")
	}
	got, err := verifyRejoin(rejoinSecret, tok, "my-webinar", now.Add(time.Hour))
	if err != nil || got != "reg-1" {
		t.Fatalf("verify = %q, %v; want reg-1", got, err)
	}
}

func TestRejoinTokenRefusals(t *testing.T) {
	now := time.Date(2026, 10, 17, 10, 0, 0, 0, time.UTC)
	tok, err := signRejoin(rejoinSecret, "reg-1", "my-webinar", now, now.Add(2*time.Hour))
	if err != nil {
		t.Fatal(err)
	}

	cases := map[string]func() (string, error){
		"expired": func() (string, error) {
			return verifyRejoin(rejoinSecret, tok, "my-webinar", now.Add(3*time.Hour))
		},
		"other webinar": func() (string, error) {
			return verifyRejoin(rejoinSecret, tok, "another-webinar", now)
		},
		"other secret": func() (string, error) {
			return verifyRejoin([]byte("a-different-secret-entirely-000000"), tok, "my-webinar", now)
		},
		"tampered payload": func() (string, error) {
			parts := strings.Split(tok, ".")
			// Flip one character of the claims; the signature no longer matches.
			b := []byte(parts[1])
			if b[5] == 'A' {
				b[5] = 'B'
			} else {
				b[5] = 'A'
			}
			parts[1] = string(b)
			return verifyRejoin(rejoinSecret, strings.Join(parts, "."), "my-webinar", now)
		},
		"garbage": func() (string, error) {
			return verifyRejoin(rejoinSecret, "not-a-token", "my-webinar", now)
		},
		"alg none": func() (string, error) {
			unsigned := jwt.NewWithClaims(jwt.SigningMethodNone, rejoinClaims{
				RegisteredClaims: jwt.RegisteredClaims{
					Subject: "reg-1", Audience: jwt.ClaimStrings{"my-webinar"},
					Issuer: rejoinIssuer, ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour)),
				},
			})
			s, err := unsigned.SignedString(jwt.UnsafeAllowNoneSignatureType)
			if err != nil {
				t.Fatal(err)
			}
			return verifyRejoin(rejoinSecret, s, "my-webinar", now)
		},
	}
	for name, run := range cases {
		t.Run(name, func(t *testing.T) {
			got, err := run()
			if !errors.Is(err, errRejoinInvalid) || got != "" {
				t.Fatalf("verify = %q, %v; want errRejoinInvalid", got, err)
			}
		})
	}
}

// A session and a rejoin token share the signing secret; neither may pass as the other.
func TestRejoinTokenIsNotASession(t *testing.T) {
	now := time.Now()
	tok, err := signRejoin(rejoinSecret, "user-1", "my-webinar", now, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	sessions := auth.NewSessions(string(rejoinSecret), time.Hour, false)
	if _, err := sessions.Verify(tok); err == nil {
		t.Fatal("a rejoin token verified as a session")
	}
	session, _, err := sessions.Issue("user-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := verifyRejoin(rejoinSecret, session, "my-webinar", now); err == nil {
		t.Fatal("a session verified as a rejoin token")
	}
}

func TestRejoinExpiryIsScheduledEndPlusTail(t *testing.T) {
	now := time.Date(2026, 10, 17, 10, 0, 0, 0, time.UTC)
	wb := types.Webinar{StartsAt: now.Add(30 * time.Minute).Format(time.RFC3339), Duration: 60}
	want := now.Add(90 * time.Minute).Add(rejoinTail)
	if got := rejoinExpiry(wb, now); !got.Equal(want) {
		t.Fatalf("expiry %v, want %v", got, want)
	}
	// Running past the schedule: the cookie still outlives the next refresh.
	late := now.Add(10 * time.Hour)
	if got := rejoinExpiry(wb, late); !got.Equal(late.Add(rejoinTail)) {
		t.Fatalf("overrun expiry %v, want %v", got, late.Add(rejoinTail))
	}
}
