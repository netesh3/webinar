package knowledge

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestExtractTXTAndMarkdown(t *testing.T) {
	text, src, err := Extract("faq.TXT", []byte("\xef\xbb\xbfFees:\t 499 rupees.\r\n\r\n\r\n\r\nRefunds   within 7 days.\n"))
	if err != nil || src != SourceTXT {
		t.Fatalf("txt: %q %v", src, err)
	}
	if text != "Fees: 499 rupees.\n\nRefunds within 7 days." {
		t.Fatalf("txt text = %q", text)
	}
	text, src, err = Extract("notes.md", []byte("# Course FAQ\n\n- EMI available\n"))
	if err != nil || src != SourceMD || text != "# Course FAQ\n\n- EMI available" {
		t.Fatalf("md: %q %q %v", text, src, err)
	}
	// Latin-1, not UTF-8: read byte for byte rather than refused.
	if text, _, err := Extract("old.txt", []byte("caf\xe9")); err != nil || text != "café" {
		t.Fatalf("latin-1: %q %v", text, err)
	}
	if _, _, err := Extract("utf16.txt", []byte("h\x00i\x00")); !errors.Is(err, ErrUnreadable) {
		t.Fatalf("utf-16: %v", err)
	}
	if _, _, err := Extract("blank.txt", []byte(" \n\t\n")); !errors.Is(err, ErrNoText) {
		t.Fatalf("blank: %v", err)
	}
	if _, _, err := Extract("slides.pptx", []byte("PK")); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("pptx: %v", err)
	}
}

// docxFixture is a minimal Word document: the parts Word itself needs are not needed to read it.
func docxFixture(t *testing.T, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("word/document.xml")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` + body + `</w:body></w:document>`))
	if w, err = zw.Create("word/header1.xml"); err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte(`<w:hdr xmlns:w="x"><w:p><w:r><w:t>CONFIDENTIAL HEADER</w:t></w:r></w:p></w:hdr>`))
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestExtractDOCX(t *testing.T) {
	data := docxFixture(t, `
<w:p><w:r><w:t>Course</w:t></w:r><w:r><w:t xml:space="preserve"> FAQ</w:t></w:r></w:p>
<w:p><w:r><w:t>Fee:</w:t></w:r><w:r><w:tab/><w:t>499 &amp; GST</w:t></w:r><w:r><w:br/><w:t>EMI ho jayega</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Batch</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Weekend</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`)
	text, src, err := Extract("FAQ.docx", data)
	if err != nil || src != SourceDOCX {
		t.Fatalf("docx: %q %v", src, err)
	}
	want := "Course FAQ\nFee: 499 & GST\nEMI ho jayega\nBatch\nWeekend"
	if text != want {
		t.Fatalf("docx text = %q, want %q", text, want)
	}
	if strings.Contains(text, "CONFIDENTIAL") {
		t.Fatal("the header was read as body text")
	}
	if _, _, err := Extract("broken.docx", []byte("PK not a zip")); !errors.Is(err, ErrUnreadable) {
		t.Fatalf("broken docx: %v", err)
	}
	if _, _, err := Extract("renamed.docx", []byte("%PDF-1.4")); !errors.Is(err, ErrUnreadable) {
		t.Fatalf("a pdf named .docx: %v", err)
	}
}

// pdfFixture is a one-page PDF with the lines drawn in Helvetica, offsets computed so the
// cross-reference table is exact.
func pdfFixture(lines ...string) []byte {
	var content strings.Builder
	content.WriteString("BT /F1 12 Tf 72 720 Td 14 TL\n")
	for _, l := range lines {
		content.WriteString("(" + l + ") Tj T*\n")
	}
	content.WriteString("ET")
	objs := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
		fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", content.Len(), content.String()),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
	}
	var b bytes.Buffer
	b.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objs))
	for i, o := range objs {
		offsets[i] = b.Len()
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", i+1, o)
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(objs)+1)
	for _, off := range offsets {
		fmt.Fprintf(&b, "%010d 00000 n \n", off)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objs)+1, xref)
	return b.Bytes()
}

func TestExtractPDF(t *testing.T) {
	text, src, err := Extract("guide.pdf", pdfFixture("Refund policy", "Full refund within seven days"))
	if err != nil || src != SourcePDF {
		t.Fatalf("pdf: %q %v", src, err)
	}
	if !strings.Contains(text, "Refund policy") || !strings.Contains(text, "seven days") {
		t.Fatalf("pdf text = %q", text)
	}
	if _, _, err := Extract("bad.pdf", []byte("%PDF-1.4 garbage")); !errors.Is(err, ErrUnreadable) {
		t.Fatalf("garbage pdf: %v", err)
	}
	if _, _, err := Extract("fake.pdf", []byte("hello")); !errors.Is(err, ErrUnreadable) {
		t.Fatalf("not a pdf: %v", err)
	}
}

func TestSplitChunks(t *testing.T) {
	if got := Split(""); len(got) != 0 {
		t.Fatalf("empty: %v", got)
	}
	short := Split("One short paragraph.\n\nAnd another.")
	if len(short) != 1 || short[0].Text != "One short paragraph. And another." || short[0].Seq != 0 {
		t.Fatalf("short = %+v", short)
	}

	// 1,200 words in sentences of ten.
	var b strings.Builder
	for i := 0; i < 1200; i++ {
		fmt.Fprintf(&b, "w%d", i)
		if i%10 == 9 {
			b.WriteString(". ")
		} else {
			b.WriteString(" ")
		}
	}
	chunks := Split(b.String())
	if len(chunks) < 3 || len(chunks) > 4 {
		t.Fatalf("chunks = %d", len(chunks))
	}
	for i, c := range chunks {
		n := Words(c.Text)
		if n > ChunkMaxWords || (i < len(chunks)-1 && n < ChunkMinWords) {
			t.Fatalf("chunk %d has %d words", i, n)
		}
		if i < len(chunks)-1 && !strings.HasSuffix(c.Text, ".") {
			t.Fatalf("chunk %d does not end at a sentence: …%s", i, c.Text[len(c.Text)-20:])
		}
		if c.Seq != i || c.Tokens <= 0 {
			t.Fatalf("chunk %d: seq %d tokens %d", i, c.Seq, c.Tokens)
		}
		if i > 0 {
			// The overlap: the previous chunk's last ChunkOverlap words open this one.
			prev := strings.Fields(chunks[i-1].Text)
			cur := strings.Fields(c.Text)
			if strings.Join(prev[len(prev)-ChunkOverlap:], " ") != strings.Join(cur[:ChunkOverlap], " ") {
				t.Fatalf("chunk %d does not overlap the previous one", i)
			}
		}
	}
	last := strings.Fields(chunks[len(chunks)-1].Text)
	if last[len(last)-1] != "w1199." {
		t.Fatalf("the last word is lost: %q", last[len(last)-1])
	}

	// No sentence end at all: cut at the target.
	unbroken := Split(strings.Repeat("word ", 1000))
	if Words(unbroken[0].Text) != ChunkTargetWords {
		t.Fatalf("unbroken first chunk = %d words", Words(unbroken[0].Text))
	}
}

func TestEstimateTokens(t *testing.T) {
	if n := EstimateTokens("abcdefgh"); n != 2 {
		t.Fatalf("latin = %d", n)
	}
	if n := EstimateTokens("फीस"); n != 3 {
		t.Fatalf("devanagari = %d", n)
	}
}

func TestTSQuery(t *testing.T) {
	if q := TSQuery("What is the fee for the course??"); q != "fee:* | course:*" {
		t.Fatalf("english = %q", q)
	}
	if q := TSQuery("Course ki fees kitni hai?"); q != "course:* | fee:*" {
		t.Fatalf("hinglish = %q", q)
	}
	if q := TSQuery("what is it?"); q != "" {
		t.Fatalf("only stop words = %q", q)
	}
	// Nothing of tsquery's own syntax survives.
	if q := TSQuery("refund' & !(EMI) | x:*"); q != "refund:* | emi:*" {
		t.Fatalf("syntax = %q", q)
	}
	if q := TSQuery("class class class"); q != "class:*" {
		t.Fatalf("repeat = %q", q)
	}
}
