// Package knowledge turns a host's documents into searchable text for the AI knowledge base:
// text extraction from an upload (TXT, Markdown, DOCX, PDF), chunking, and the full-text query
// a question is searched with. Storage and retrieval are store/knowledge.go; the handlers are
// api/knowledge.go.
package knowledge

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/ledongthuc/pdf"
)

// The kinds a document can be, as stored in knowledge_docs.source.
const (
	SourceText = "text" // pasted
	SourceTXT  = "txt"
	SourceMD   = "md"
	SourcePDF  = "pdf"
	SourceDOCX = "docx"
)

var (
	// ErrUnsupported is a file that is not TXT, MD, PDF or DOCX.
	ErrUnsupported = errors.New("knowledge: unsupported file type")
	// ErrUnreadable is a file of a supported type whose text could not be read.
	ErrUnreadable = errors.New("knowledge: could not read the file")
	// ErrNoText is a readable file with no text in it (a scanned PDF, say).
	ErrNoText = errors.New("knowledge: no text in the file")
)

// maxUnzipped bounds what a DOCX may inflate to, so a zip bomb is refused rather than read.
const maxUnzipped = 40 << 20

// maxPDFPages bounds the pages read from one PDF.
const maxPDFPages = 500

// SourceFor is the kind of a file, from its name's extension; "" when unsupported.
func SourceFor(filename string) string {
	switch strings.ToLower(path.Ext(filename)) {
	case ".txt", ".text":
		return SourceTXT
	case ".md", ".markdown":
		return SourceMD
	case ".pdf":
		return SourcePDF
	case ".docx":
		return SourceDOCX
	}
	return ""
}

// Extract is the text of an uploaded file, normalised (see Normalize), and its kind.
func Extract(filename string, data []byte) (text, source string, err error) {
	source = SourceFor(filename)
	switch {
	case source == "":
		return "", "", ErrUnsupported
	case source == SourcePDF && !bytes.HasPrefix(data, []byte("%PDF")):
		return "", source, ErrUnreadable
	case source == SourceDOCX && !bytes.HasPrefix(data, []byte("PK")):
		return "", source, ErrUnreadable
	}
	switch source {
	case SourceTXT, SourceMD:
		text, err = plainText(data)
	case SourceDOCX:
		text, err = DOCXText(data)
	case SourcePDF:
		text, err = PDFText(data)
	}
	if err != nil {
		return "", source, err
	}
	text = Normalize(text)
	if text == "" {
		return "", source, ErrNoText
	}
	return text, source, nil
}

// plainText reads a TXT or MD file: UTF-8 (a BOM is dropped), or Latin-1 when it is not UTF-8.
func plainText(data []byte) (string, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	if bytes.IndexByte(data, 0) >= 0 {
		// UTF-16 or binary: not a text file this reads.
		return "", ErrUnreadable
	}
	if utf8.Valid(data) {
		return string(data), nil
	}
	r := make([]rune, len(data))
	for i, b := range data {
		r[i] = rune(b)
	}
	return string(r), nil
}

/* DOCXText is the text of a Word document: word/document.xml's runs (w:t), with a paragraph
 * (w:p) or a table row ending a line, and tabs and breaks kept. Headers, footers, comments and
 * footnotes are left out: a knowledge base wants the body. */
func DOCXText(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", ErrUnreadable
	}
	var doc *zip.File
	for _, f := range zr.File {
		if f.Name == "word/document.xml" {
			doc = f
			break
		}
	}
	if doc == nil {
		return "", ErrUnreadable
	}
	rc, err := doc.Open()
	if err != nil {
		return "", ErrUnreadable
	}
	defer func() { _ = rc.Close() }()
	dec := xml.NewDecoder(io.LimitReader(rc, maxUnzipped))
	var b strings.Builder
	inText := false
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", ErrUnreadable
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "t":
				inText = true
			case "tab":
				b.WriteByte('\t')
			case "br", "cr":
				b.WriteByte('\n')
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				inText = false
			case "p", "tr":
				b.WriteByte('\n')
			case "tc":
				b.WriteByte('\t')
			}
		case xml.CharData:
			if inText {
				b.Write(t)
			}
		}
	}
	return b.String(), nil
}

/* PDFText is the text of a PDF's pages, page after page, with github.com/ledongthuc/pdf (pure
 * Go). A scanned PDF has no text and comes back empty; an encrypted or malformed one is
 * ErrUnreadable. The library panics on some malformed files, so a panic is that error too. */
func PDFText(data []byte) (text string, err error) {
	defer func() {
		if p := recover(); p != nil {
			text, err = "", fmt.Errorf("%w: %v", ErrUnreadable, p)
		}
	}()
	r, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", ErrUnreadable
	}
	var b strings.Builder
	fonts := map[string]*pdf.Font{}
	n := r.NumPage()
	if n > maxPDFPages {
		n = maxPDFPages
	}
	for i := 1; i <= n; i++ {
		p := r.Page(i)
		if p.V.IsNull() {
			continue
		}
		t, err := p.GetPlainText(fonts)
		if err != nil {
			continue
		}
		b.WriteString(t)
		b.WriteString("\n\n")
	}
	return b.String(), nil
}

var blankLines = regexp.MustCompile(`\n{3,}`)

/* Normalize tidies extracted text: line endings unified, control characters dropped, runs of
 * spaces and tabs collapsed, each line trimmed, and at most one blank line in a row. */
func Normalize(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	s = strings.ToValidUTF8(s, "")
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		l = strings.Map(func(r rune) rune {
			switch {
			case r == '\t' || r == ' ':
				return ' '
			case unicode.IsControl(r), r == '\uFFFD', r == '\u200B', r == '\uFEFF':
				return -1
			}
			return r
		}, l)
		lines[i] = strings.Join(strings.Fields(l), " ")
	}
	s = strings.Join(lines, "\n")
	return strings.TrimSpace(blankLines.ReplaceAllString(s, "\n\n"))
}

// Words counts the words in s, as the library's limits count them.
func Words(s string) int { return len(strings.Fields(s)) }
