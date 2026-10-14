package auth

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGooglePhoneNumber(t *testing.T) {
	const token = "people-access-token"
	var sawAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		switch r.URL.Query().Get("case") {
		case "deny":
			w.WriteHeader(http.StatusForbidden)
			_, _ = io.WriteString(w, `{"error":"insufficientPermissions"}`)
		case "empty":
			_, _ = io.WriteString(w, `{"phoneNumbers":[]}`)
		case "value":
			_, _ = io.WriteString(w, `{"phoneNumbers":[{"value":"+1 415-555-2671"}]}`)
		case "primary":
			_, _ = io.WriteString(w, `{"phoneNumbers":[{"value":"+1 202-555-0143"},{"canonicalForm":"+14155552671","metadata":{"primary":true}}]}`)
		default:
			_, _ = io.WriteString(w, `{"phoneNumbers":[{"canonicalForm":"+14155552671","metadata":{"primary":true}}]}`)
		}
	}))
	t.Cleanup(srv.Close)

	prevURL, prevClient := PeoplePhoneURL, PeopleHTTP
	t.Cleanup(func() {
		PeoplePhoneURL = prevURL
		PeopleHTTP = prevClient
	})
	PeopleHTTP = srv.Client()

	t.Run("empty token skips the call", func(t *testing.T) {
		sawAuth = ""
		PeoplePhoneURL = srv.URL + "?case=primary"
		got, err := GooglePhoneNumber(context.Background(), "  ")
		if err != nil || got != "" {
			t.Fatalf("phone %q err %v", got, err)
		}
		if sawAuth != "" {
			t.Fatal("People API was called without a token")
		}
	})

	t.Run("primary canonical form", func(t *testing.T) {
		PeoplePhoneURL = srv.URL + "?case=primary"
		got, err := GooglePhoneNumber(context.Background(), token)
		if err != nil {
			t.Fatal(err)
		}
		if got != "+14155552671" {
			t.Fatalf("phone %q", got)
		}
		if sawAuth != "Bearer "+token {
			t.Fatal("authorization header was not the bearer token")
		}
	})

	t.Run("value when canonical is absent", func(t *testing.T) {
		PeoplePhoneURL = srv.URL + "?case=value"
		got, err := GooglePhoneNumber(context.Background(), token)
		if err != nil || got != "+1 415-555-2671" {
			t.Fatalf("phone %q err %v", got, err)
		}
	})

	t.Run("no numbers", func(t *testing.T) {
		PeoplePhoneURL = srv.URL + "?case=empty"
		got, err := GooglePhoneNumber(context.Background(), token)
		if err != nil || got != "" {
			t.Fatalf("phone %q err %v", got, err)
		}
	})

	t.Run("denied scope", func(t *testing.T) {
		PeoplePhoneURL = srv.URL + "?case=deny"
		got, err := GooglePhoneNumber(context.Background(), token)
		if got != "" || err == nil {
			t.Fatalf("phone %q err %v", got, err)
		}
		if strings.Contains(err.Error(), token) || strings.Contains(err.Error(), "415") {
			t.Fatalf("error leaked token or number: %v", err)
		}
		if !strings.Contains(err.Error(), "403") {
			t.Fatalf("error %v", err)
		}
	})
}
