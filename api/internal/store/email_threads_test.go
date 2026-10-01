package store

import (
	"encoding/base64"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestGroupEmailThreadsByReplyChainOnly(t *testing.T) {
	base := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	at := func(m int) time.Time { return base.Add(time.Duration(m) * time.Minute) }
	msgs := []HostEmail{
		{ID: "a", To: "guest@example.com", Subject: "You're registered: Alpha", MessageID: "outbox:a", CreatedAt: at(0)},
		{ID: "b", To: "guest@example.com", Subject: "Reminder: Beta", MessageID: "outbox:b", CreatedAt: at(1)},
		{ID: "c", To: "guest@example.com", Subject: "Reminder", MessageID: "outbox:c", CreatedAt: at(2)},
		{ID: "d", To: "guest@example.com", Subject: "Reminder", MessageID: "outbox:d", CreatedAt: at(3)},
		{ID: "r", To: "guest@example.com", Subject: "Re: You're registered: Alpha", InReplyTo: "<outbox:a>", CreatedAt: at(4)},
	}
	threads := groupEmailThreads(msgs)
	if len(threads) != 4 {
		t.Fatalf("got %d threads, want 4 separate rows plus the alpha reply", len(threads))
	}
	byRoot := map[string]int{}
	for _, thread := range threads {
		byRoot[thread[0].ThreadID] = len(thread)
		for _, m := range thread {
			if m.ThreadID != thread[0].ThreadID {
				t.Fatalf("mixed thread ids in %+v", thread)
			}
		}
	}
	if byRoot["a"] != 2 || byRoot["b"] != 1 || byRoot["c"] != 1 || byRoot["d"] != 1 {
		t.Fatalf("rows = %+v", byRoot)
	}
	if threads[0][0].ThreadID != "a" {
		t.Fatalf("newest thread = %s, want the reply chain", threads[0][0].ThreadID)
	}
}

func TestGroupEmailThreadsSharedReplyWithoutParent(t *testing.T) {
	base := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	threads := groupEmailThreads([]HostEmail{
		{ID: "r1", InReplyTo: "<missing@x>", CreatedAt: base},
		{ID: "r2", InReplyTo: "<missing@x>", CreatedAt: base.Add(time.Minute)},
		{ID: "solo", Subject: "Reminder", To: "guest@example.com", CreatedAt: base.Add(2 * time.Minute)},
	})
	if len(threads) != 2 {
		t.Fatalf("got %d threads, want the two replies together and the reminder alone", len(threads))
	}
}

func TestGroupEmailThreadsUsesRowID(t *testing.T) {
	base := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	threads := groupEmailThreads([]HostEmail{
		{ID: "parent-row", Subject: "Hi", CreatedAt: base},
		{ID: "reply-row", InReplyTo: "parent-row", Subject: "Re: Hi", CreatedAt: base.Add(time.Minute)},
	})
	if len(threads) != 1 || len(threads[0]) != 2 || threads[0][0].ThreadID != "parent-row" {
		t.Fatalf("row-id chain = %+v", threads)
	}
}

func conversationIDs(msgs []HostEmail) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range msgs {
		id := m.ThreadID
		if id == "" {
			id = m.ID
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

func datedThreads(n int) [][]HostEmail {
	base := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	msgs := make([]HostEmail, n)
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("m%03d", i)
		msgs[i] = HostEmail{ID: id, CreatedAt: base.Add(time.Duration(i) * time.Minute)}
	}
	return groupEmailThreads(msgs)
}

func TestEmailThreadCursorPages(t *testing.T) {
	threads := datedThreads(12)
	page1, err := pageEmailThreads(threads, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if page1.Total != 12 || page1.NextCursor == "" {
		t.Fatalf("first page total=%d cursor=%q", page1.Total, page1.NextCursor)
	}
	got1 := conversationIDs(page1.Messages)
	if len(got1) != EmailInboxPageSize || got1[0] != "m011" || got1[4] != "m007" {
		t.Fatalf("first page = %v, want the 5 newest", got1)
	}

	page2, err := pageEmailThreads(threads, EmailInboxPageSize, page1.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	got2 := conversationIDs(page2.Messages)
	if len(got2) != 5 || got2[0] != "m006" || got2[4] != "m002" || page2.NextCursor == "" {
		t.Fatalf("second page = %v cursor=%q", got2, page2.NextCursor)
	}
	for _, id := range got2 {
		for _, prev := range got1 {
			if id == prev {
				t.Fatalf("page 2 repeats %s", id)
			}
		}
	}

	page3, err := pageEmailThreads(threads, EmailInboxPageSize, page2.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	got3 := conversationIDs(page3.Messages)
	if len(got3) != 2 || got3[0] != "m001" || got3[1] != "m000" || page3.NextCursor != "" {
		t.Fatalf("last page = %v cursor=%q, want m001 m000 and no nextCursor", got3, page3.NextCursor)
	}

	empty, err := pageEmailThreads(nil, 5, "")
	if err != nil || len(empty.Messages) != 0 || empty.Total != 0 || empty.NextCursor != "" {
		t.Fatalf("empty page = %+v err=%v", empty, err)
	}

	wide, err := pageEmailThreads(datedThreads(60), 1000, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(conversationIDs(wide.Messages)) != EmailInboxMaxPage || wide.NextCursor == "" {
		t.Fatalf("cap = %d cursor=%q, want %d and a next cursor", len(conversationIDs(wide.Messages)), wide.NextCursor, EmailInboxMaxPage)
	}
}

// Same timestamp on the page boundary must not drop or repeat a row. A cursor
// that only stored the time would either skip the rest or hand them back again.
func TestEmailThreadCursorTiebreaker(t *testing.T) {
	at := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	var msgs []HostEmail
	for _, id := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		msgs = append(msgs, HostEmail{ID: id, CreatedAt: at})
	}
	threads := groupEmailThreads(msgs)
	page1, err := pageEmailThreads(threads, 5, "")
	if err != nil {
		t.Fatal(err)
	}
	page2, err := pageEmailThreads(threads, 5, page1.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	got := append(conversationIDs(page1.Messages), conversationIDs(page2.Messages)...)
	want := []string{"g", "f", "e", "d", "c", "b", "a"}
	if len(got) != len(want) || page2.NextCursor != "" {
		t.Fatalf("pages = %v next=%q, want %v and no further page", got, page2.NextCursor, want)
	}
	seen := map[string]bool{}
	for i, id := range got {
		if id != want[i] || seen[id] {
			t.Fatalf("order = %v, want %v", got, want)
		}
		seen[id] = true
	}

	// A letter newer than the cursor belongs on the first page. Asking for the
	// next page with the old cursor still starts where it did.
	newer := []HostEmail{{ID: "z", CreatedAt: at.Add(time.Minute)}}
	again, err := pageEmailThreads(groupEmailThreads(append(newer, msgs...)), 5, page1.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	rest := conversationIDs(again.Messages)
	if len(rest) != 2 || rest[0] != "b" || rest[1] != "a" {
		t.Fatalf("after a newer letter, page 2 = %v, want b a", rest)
	}
}

// The handler maps ErrInvalid from a bad cursor to HTTP 400.
func TestEmailThreadCursorRejectsMalformed(t *testing.T) {
	bad := []string{
		"%%%",
		"not-a-cursor",
		base64.RawURLEncoding.EncodeToString([]byte("{}")),
		base64.RawURLEncoding.EncodeToString([]byte(`{"at":0,"id":"x"}`)),
		base64.RawURLEncoding.EncodeToString([]byte(`{"id":"abc"}`)),
		base64.RawURLEncoding.EncodeToString([]byte("[]")),
		base64.RawURLEncoding.EncodeToString([]byte("null")),
	}
	for _, cursor := range bad {
		_, err := pageEmailThreads(nil, 5, cursor)
		if !errors.Is(err, ErrInvalid) {
			t.Fatalf("cursor %q err = %v, want ErrInvalid", cursor, err)
		}
	}
	if _, err := pageEmailThreads(nil, 5, "   "); err != nil {
		t.Fatalf("blank cursor err = %v", err)
	}
}
