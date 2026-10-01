package store

import (
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

func TestEmailThreadPagesDoNotRepeat(t *testing.T) {
	threads := make([][]HostEmail, 30)
	for i := range threads {
		id := fmt.Sprintf("m%02d", i)
		threads[i] = []HostEmail{{ID: id, ThreadID: id}}
	}
	page1, total, page := pageEmailThreads(threads, 1)
	page2, _, pageOut := pageEmailThreads(threads, 2)
	if total != 30 || page != 1 || pageOut != 2 || len(page1) != EmailInboxPageSize || len(page2) != 5 {
		t.Fatalf("page1=%d page2=%d total=%d page numbers %d %d", len(page1), len(page2), total, page, pageOut)
	}
	seen := map[string]bool{}
	for _, m := range page1 {
		seen[m.ID] = true
	}
	for _, m := range page2 {
		if seen[m.ID] {
			t.Fatalf("page 2 repeats %s", m.ID)
		}
	}
	empty, total0, page0 := pageEmailThreads(nil, 5)
	if len(empty) != 0 || total0 != 0 || page0 != 1 {
		t.Fatalf("empty page = %d messages, total %d, page %d", len(empty), total0, page0)
	}
	_, _, clamped := pageEmailThreads(threads, 9)
	if clamped != 2 {
		t.Fatalf("page past the end = %d, want the last page", clamped)
	}
}
