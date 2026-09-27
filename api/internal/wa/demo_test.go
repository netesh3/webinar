package wa

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// The demo account's token must never reach Meta: sends succeed locally, the health
// check says healthy, and the template list says "ask nobody".
func TestDemoTokenNeverCallsMeta(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, `{"error":{"code":190}}`, http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := &Client{AppID: "app", AppSecret: "secret", Graph: srv.URL}
	ctx := context.Background()
	token := DemoTokenPrefix + "abc"

	id, err := c.SendText(ctx, token, "demo-phone-number", "+919800000000", "hi")
	if err != nil || id == "" {
		t.Fatalf("SendText = %q, %v; want an id and no error", id, err)
	}
	if h, err := c.CheckToken(ctx, token); err != nil || !h.Valid {
		t.Fatalf("CheckToken = %+v, %v; want valid", h, err)
	}
	if _, err := c.Templates(ctx, token, "demo-waba"); err != ErrDemo {
		t.Fatalf("Templates err = %v; want ErrDemo", err)
	}
	if n := calls.Load(); n != 0 {
		t.Fatalf("Meta was called %d times for the demo token", n)
	}
}
