package egresspool

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func fakePool(t *testing.T, h http.HandlerFunc) *Pool {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &Pool{GCPProject: "p", Zone: "z", Label: "india", Endpoint: srv.URL,
		Token: func(context.Context) (string, error) { return "tok", nil }}
}

func TestListFiltersByLabel(t *testing.T) {
	p := fakePool(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			t.Errorf("no bearer token")
		}
		if got := r.URL.Query().Get("filter"); got != "labels.egress-pool=india" {
			t.Errorf("filter = %q", got)
		}
		_, _ = w.Write([]byte(`{"items":[{"name":"india-egress-1","status":"TERMINATED"},{"name":"india-egress-2","status":"RUNNING"}]}`))
	})
	ws, err := p.List(context.Background())
	if err != nil || len(ws) != 2 || !ws[0].Startable() || !ws[1].Busy() {
		t.Fatalf("List = %+v, %v", ws, err)
	}
}

func TestStartWaitsForTheOperation(t *testing.T) {
	polls := 0
	p := fakePool(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/instances/india-egress-1/start"):
			_, _ = w.Write([]byte(`{"name":"op1","status":"RUNNING"}`))
		case strings.HasSuffix(r.URL.Path, "/operations/op1"):
			polls++
			_, _ = w.Write([]byte(`{"name":"op1","status":"DONE"}`))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
	})
	if err := p.Start(context.Background(), "india-egress-1"); err != nil || polls != 1 {
		t.Fatalf("Start: err=%v polls=%d", err, polls)
	}
}

func TestACapacityRefusalIsErrCapacity(t *testing.T) {
	p := fakePool(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"name":"op1","status":"DONE","error":{"errors":[{"code":"ZONE_RESOURCE_POOL_EXHAUSTED","message":"The zone does not have enough resources"}]}}`))
	})
	if err := p.Start(context.Background(), "india-egress-1"); !errors.Is(err, ErrCapacity) {
		t.Fatalf("Start = %v, want ErrCapacity", err)
	}
}
