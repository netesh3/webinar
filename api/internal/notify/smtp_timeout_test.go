package notify

import (
	"context"
	"errors"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"
)

/* A quiet SMTP server must end on this transport's own deadline. The caller's
 * deadline, when it is longer, is not how long Gmail may hold the call.
 */
func TestSMTPSendUsesItsOwnTimeout(t *testing.T) {
	ln := hangSMTP(t)
	host, port := splitHostPort(t, ln.Addr().String())

	parent, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	err := (SMTP{
		Host: host, Port: port, From: "a@example.test",
		Timeout: 200 * time.Millisecond,
	}).Send(parent, Message{To: "b@example.test", Subject: "Hi", Body: "hello"})
	elapsed := time.Since(start)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want the smtp deadline", err)
	}
	if elapsed > time.Second {
		t.Fatalf("send took %s; a longer parent deadline was used", elapsed)
	}
}

func TestSMTPSendStopsWhenTheCallerDoes(t *testing.T) {
	ln := hangSMTP(t)
	host, port := splitHostPort(t, ln.Addr().String())

	parent, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	err := (SMTP{
		Host: host, Port: port, From: "a@example.test",
		Timeout: 5 * time.Second,
	}).Send(parent, Message{To: "b@example.test", Subject: "Hi", Body: "hello"})
	elapsed := time.Since(start)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want the caller deadline", err)
	}
	if elapsed > time.Second {
		t.Fatalf("send took %s after the caller was done", elapsed)
	}
}

func hangSMTP(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var conns []net.Conn
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
		}
	}()
	t.Cleanup(func() {
		ln.Close()
		mu.Lock()
		defer mu.Unlock()
		for _, c := range conns {
			c.Close()
		}
	})
	return ln
}

func splitHostPort(t *testing.T, addr string) (string, int) {
	t.Helper()
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatal(err)
	}
	n, err := strconv.Atoi(port)
	if err != nil {
		t.Fatal(err)
	}
	return host, n
}
