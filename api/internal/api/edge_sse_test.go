package api

import "testing"

func TestSSEFrameKeepsFieldsIntact(t *testing.T) {
	got := sseFrame(7, "chat\nevent: forged", []byte("line1\r\nid: 99\nline3"))
	want := "id: 7\nevent: chatevent: forged\ndata: line1\ndata: id: 99\ndata: line3\n\n"
	if got != want {
		t.Fatalf("sseFrame:\n got %q\nwant %q", got, want)
	}
	if got := sseFrame(1, "meta", []byte(`{"a":1}`)); got != "id: 1\nevent: meta\ndata: {\"a\":1}\n\n" {
		t.Fatalf("single line: %q", got)
	}
}
