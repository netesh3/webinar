package knowledge

import (
	"archive/zip"
	"bytes"
	"errors"
	"reflect"
	"strings"
	"testing"
)

type zipEntry struct {
	name, body string
	store      bool // uncompressed, so the header's size is honest
}

func zipOf(t *testing.T, entries ...zipEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		method := zip.Deflate
		if e.store {
			method = zip.Store
		}
		w, err := zw.CreateHeader(&zip.FileHeader{Name: e.name, Method: method})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(e.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestReadVault(t *testing.T) {
	data := zipOf(t,
		zipEntry{name: "My Vault/.obsidian/workspace.json", body: `{"a":1}`},
		zipEntry{name: "My Vault/.obsidian/plugins/x.md", body: "# Not a note"},
		zipEntry{name: "My Vault/.trash/old.md", body: "deleted"},
		zipEntry{name: "__MACOSX/My Vault/._Fees.md", body: "junk"},
		zipEntry{name: "My Vault/attachments/qr.png", body: "\x89PNG"},
		zipEntry{name: "My Vault/Course/Week 1/Fees.md", body: "---\ntags: [fees]\naliases: Pricing\n---\n# Course fees\nThe fee is 499 rupees. See [[Refund policy|our refunds]] and [[Batches#Timings]].\n![[qr.png]]\n![[Payment steps]]\n%% private note %%Pay by UPI."},
		zipEntry{name: "My Vault/Refund policy.md", body: "Refunds within 7 days, see [[#Exceptions]]."},
		zipEntry{name: "My Vault/Empty.md", body: "---\ntitle: x\n---\n\n"},
	)
	notes, err := ReadVault(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) != 2 {
		t.Fatalf("notes = %+v", notes)
	}
	fees := notes[0]
	if fees.Title != "Course fees" || fees.Folder != "Course/Week 1" || fees.Path != "My Vault/Course/Week 1/Fees.md" {
		t.Fatalf("fees = %+v", fees)
	}
	want := "The fee is 499 rupees. See our refunds and Batches (Timings).\n\nPayment steps\nPay by UPI."
	if fees.Body != want {
		t.Fatalf("body = %q\nwant  %q", fees.Body, want)
	}
	if strings.Contains(fees.Body, "tags") || strings.Contains(fees.Body, "private") || strings.Contains(fees.Body, "qr.png") {
		t.Fatalf("front-matter, comment or attachment kept: %q", fees.Body)
	}
	ref := notes[1]
	if ref.Title != "Refund policy" || ref.Folder != "" || ref.Body != "Refunds within 7 days, see Exceptions." {
		t.Fatalf("refund = %+v", ref)
	}
}

func TestReadVaultKeepsTopFolderWhenNotesDiffer(t *testing.T) {
	notes, err := ReadVault(zipOf(t,
		zipEntry{name: "A/one.md", body: "one"},
		zipEntry{name: "two.md", body: "two"},
	))
	if err != nil {
		t.Fatal(err)
	}
	if got := []string{notes[0].Folder, notes[1].Folder}; !reflect.DeepEqual(got, []string{"A", ""}) {
		t.Fatalf("folders = %v", got)
	}
}

func TestReadVaultRefusesBombsAndJunk(t *testing.T) {
	if _, err := ReadVault([]byte("not a zip")); !errors.Is(err, ErrVaultNotZip) {
		t.Fatalf("not zip: %v", err)
	}
	// Too many entries: refused before anything is read.
	many := make([]zipEntry, VaultMaxEntries+1)
	for i := range many {
		many[i] = zipEntry{name: "n/" + strings.Repeat("x", 1+i%5) + string(rune('a'+i%26)) + ".txt"}
	}
	if _, err := ReadVault(zipOf(t, many...)); !errors.Is(err, ErrVaultTooManyEntries) {
		t.Fatalf("entries: %v", err)
	}
	// One note that inflates past the per-file limit (deflate makes 2 MB of zeros tiny).
	big := strings.Repeat("a", VaultMaxFileBytes+1)
	data := zipOf(t, zipEntry{name: "big.md", body: big})
	if len(data) > 100_000 {
		t.Fatalf("test zip not compressed: %d", len(data))
	}
	var ve *VaultError
	if _, err := ReadVault(data); !errors.Is(err, ErrVaultFileTooLarge) || !errors.As(err, &ve) || ve.Path != "big.md" {
		t.Fatalf("big note: %v", err)
	}
	// A header that lies about the size is held by the reader's limit all the same.
	lying := lieAboutSize(t, "liar.md", big)
	if _, err := ReadVault(lying); !errors.Is(err, ErrVaultFileTooLarge) && !errors.Is(err, ErrUnreadable) {
		t.Fatalf("lying header: %v", err)
	}
	// Many notes each under the limit, over the total.
	var es []zipEntry
	for i := 0; i*(VaultMaxFileBytes-10) <= VaultMaxTotalBytes; i++ {
		es = append(es, zipEntry{name: "n" + strings.Repeat("i", i+1) + ".md", body: strings.Repeat("b ", (VaultMaxFileBytes-10)/2)})
	}
	if _, err := ReadVault(zipOf(t, es...)); !errors.Is(err, ErrVaultTooLarge) {
		t.Fatalf("total: %v", err)
	}
	if _, err := ReadVault(zipOf(t, zipEntry{name: ".obsidian/app.json", body: "{}"}, zipEntry{name: "x.png", body: "p"})); !errors.Is(err, ErrVaultEmpty) {
		t.Fatalf("no notes: %v", err)
	}
}

// lieAboutSize is a zip whose one entry claims to be 10 bytes uncompressed.
func lieAboutSize(t *testing.T, name, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.CreateRaw(&zip.FileHeader{Name: name, Method: zip.Store,
		CompressedSize64: uint64(len(body)), UncompressedSize64: 10})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte(body))
	_ = zw.Close()
	return buf.Bytes()
}

func TestWikiToPlain(t *testing.T) {
	for in, want := range map[string]string{
		"[[Note]]":            "Note",
		"[[Folder/Note.md]]":  "Note",
		"[[Note|the alias]]":  "the alias",
		"[[Note#Heading|x]]":  "x",
		"[[Note#Heading]]":    "Note (Heading)",
		"[[Note#^block1]]":    "Note (block1)",
		"[[#Local]]":          "Local",
		"![[Note]]":           "Note",
		"![[pic.png]]":        "",
		"![[deck.pdf|200]]":   "",
		"a [[x]] b [[y|z]] c": "a x b z c",
		"no links [here](u)":  "no links [here](u)",
		"[[unclosed":          "[[unclosed",
	} {
		if got := WikiToPlain(in); got != want {
			t.Errorf("WikiToPlain(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestScrubPII(t *testing.T) {
	for in, want := range map[string]string{
		"Mail priya.s+course@gmail.com today":       "Mail [email] today",
		"Call 98765 43210 or +91-98765-43210":       "Call [phone] or [phone]",
		"WhatsApp (022) 2345 6789 now":              "WhatsApp [phone] now",
		"Fee is ₹4,999, batch 12 starts 2026-10-22": "Fee is ₹4,999, batch 12 starts 2026-10-22",
		"Pay 499 by 31.12.2026":                     "Pay 499 by 31.12.2026",
		"Card 4111 1111 1111 1111":                  "Card [phone]",
		"UPI host@okaxis is fine":                   "UPI host@okaxis is fine",
	} {
		if got := ScrubPII(in); got != want {
			t.Errorf("ScrubPII(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFuseRRF(t *testing.T) {
	// "b" is second in both lists and beats "a", first in one only.
	got := FuseRRF([]string{"a", "b", "c"}, []string{"d", "b"})
	if want := []string{"b", "a", "d", "c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("fused = %v, want %v", got, want)
	}
	// A list the other misses entirely still contributes: a paraphrase found by vectors alone.
	if got := FuseRRF(nil, []string{"x"}); !reflect.DeepEqual(got, []string{"x"}) {
		t.Fatalf("vector only = %v", got)
	}
	if got := FuseRRF([]string{"p", "q"}); !reflect.DeepEqual(got, []string{"p", "q"}) {
		t.Fatalf("fts only = %v", got)
	}
}

func TestSameQuestion(t *testing.T) {
	if !SameQuestion("What is the fee?", "the fees?") {
		t.Fatal("same words not matched")
	}
	if !SameQuestion("What is the course fee?", "course fee kya hai") {
		t.Fatal("Hinglish repeat not matched")
	}
	if SameQuestion("What is the fee?", "When is the refund?") {
		t.Fatal("different questions matched")
	}
	if SameQuestion("hi", "hello") {
		t.Fatal("no content words matched")
	}
}
