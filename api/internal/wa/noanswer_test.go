package wa

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

/* NoAnswer separates "Meta may have sent it" from "nothing was sent", which is what decides
 * whether the outbox may try a WhatsApp message again (1 Nov 2026). */
func TestNoAnswerOnlyWhenMetaMayHaveActed(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		_, _ = w.Write([]byte(`{"messages":[{"id":"wamid.X"}]}`))
	}))
	defer slow.Close()
	refused := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"(#131000) Something went wrong","code":131000}}`))
	}))
	defer refused.Close()
	// A port nobody listens on: the call never leaves this machine.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closed := "http://" + l.Addr().String()
	_ = l.Close()

	msg := OutgoingTemplate{To: "+27820000000", Name: "t", Language: "en_US"}
	send := func(ctx context.Context, graph string) error {
		c := New("app", "secret", "cfg")
		c.Graph = graph
		_, err := c.SendTemplate(ctx, "token", "phone-1", msg)
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := send(ctx, slow.URL); err == nil || !NoAnswer(err) {
		t.Errorf("timed out waiting for Meta: err=%v NoAnswer=%v, want true", err, NoAnswer(err))
	}
	if err := send(context.Background(), refused.URL); err == nil || NoAnswer(err) {
		t.Errorf("Meta refused: err=%v NoAnswer=%v, want false", err, NoAnswer(err))
	}
	if err := send(context.Background(), closed); err == nil || NoAnswer(err) {
		t.Errorf("connection refused: err=%v NoAnswer=%v, want false", err, NoAnswer(err))
	}
	spent, cancelSpent := context.WithCancel(context.Background())
	cancelSpent()
	if err := send(spent, slow.URL); err == nil || NoAnswer(err) {
		t.Errorf("deadline already spent: err=%v NoAnswer=%v, want false", err, NoAnswer(err))
	}
}
