package knowledge

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"path"
	"regexp"
	"strings"
)

/* An Obsidian vault, uploaded as a .zip: each Markdown note becomes a document.
 *
 *   title      the note's first line when it is a "# Heading", else its file name
 *   folder     the note's folder inside the vault ("Course/Week 1"), kept as a tag; a zip of
 *              the vault's own folder ("My Vault/…") has that one top folder dropped
 *   text       YAML front-matter removed, %%comments%% removed, [[Note]] / [[Note|alias]] /
 *              [[Note#Heading]] written as the plain words, ![[Note]] as the note's name and
 *              ![[picture.png]] (an attachment) dropped
 *   skipped    .obsidian/ and every other hidden folder or file, __MACOSX/, anything that is
 *              not .md, and notes left empty
 *
 * A zip is untrusted: its central directory may claim anything and its entries may inflate
 * a thousandfold. So the entry count is bounded before anything is read, every note is read
 * through a limit of VaultMaxFileBytes (whatever its header says), and the running total
 * through VaultMaxTotalBytes. Nothing is written to disk. */

const (
	// VaultMaxEntries bounds the zip's entries of every kind (folders, pictures, notes).
	VaultMaxEntries = 5000
	// VaultMaxFileBytes bounds one note, uncompressed.
	VaultMaxFileBytes = 2 << 20
	// VaultMaxTotalBytes bounds every note together, uncompressed.
	VaultMaxTotalBytes = 40 << 20
)

var (
	// ErrVaultNotZip is an upload that is not a zip archive.
	ErrVaultNotZip = errors.New("knowledge: not a zip file")
	// ErrVaultTooManyEntries is a zip of more than VaultMaxEntries entries.
	ErrVaultTooManyEntries = errors.New("knowledge: too many files in the zip")
	// ErrVaultFileTooLarge is a note over VaultMaxFileBytes.
	ErrVaultFileTooLarge = errors.New("knowledge: a note is too large")
	// ErrVaultTooLarge is notes over VaultMaxTotalBytes in all.
	ErrVaultTooLarge = errors.New("knowledge: the vault is too large")
	// ErrVaultEmpty is a zip with no Markdown note that has text.
	ErrVaultEmpty = errors.New("knowledge: no notes in the zip")
)

// VaultNote is one note, ready to store.
type VaultNote struct {
	// Path is the note's path inside the vault, as the zip names it.
	Path   string
	Folder string
	Title  string
	// Body is the text, normalised (Normalize).
	Body string
}

// VaultError names the note an error is about.
type VaultError struct {
	Path string
	Err  error
}

func (e *VaultError) Error() string { return e.Err.Error() + ": " + e.Path }
func (e *VaultError) Unwrap() error { return e.Err }

// ReadVault is a zipped vault's notes, in the zip's order.
func ReadVault(data []byte) ([]VaultNote, error) {
	if !bytes.HasPrefix(data, []byte("PK")) {
		return nil, ErrVaultNotZip
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, ErrVaultNotZip
	}
	if len(zr.File) > VaultMaxEntries {
		return nil, ErrVaultTooManyEntries
	}
	type raw struct {
		path string
		data []byte
	}
	var notes []raw
	var total int64
	for _, f := range zr.File {
		name := strings.TrimPrefix(path.Clean("/"+strings.ReplaceAll(f.Name, "\\", "/")), "/")
		if f.FileInfo().IsDir() || !vaultNote(name) {
			continue
		}
		if f.UncompressedSize64 > VaultMaxFileBytes {
			return nil, &VaultError{Path: name, Err: ErrVaultFileTooLarge}
		}
		rc, err := f.Open()
		if err != nil {
			return nil, &VaultError{Path: name, Err: ErrUnreadable}
		}
		// The header's size is a claim; the limit is what holds.
		b, err := io.ReadAll(io.LimitReader(rc, VaultMaxFileBytes+1))
		_ = rc.Close()
		if err != nil {
			return nil, &VaultError{Path: name, Err: ErrUnreadable}
		}
		if len(b) > VaultMaxFileBytes {
			return nil, &VaultError{Path: name, Err: ErrVaultFileTooLarge}
		}
		if total += int64(len(b)); total > VaultMaxTotalBytes {
			return nil, ErrVaultTooLarge
		}
		notes = append(notes, raw{path: name, data: b})
	}

	// A zip of the vault's folder has every note under that one folder: it is not a tag.
	paths := make([]string, len(notes))
	for i, n := range notes {
		paths[i] = n.path
	}
	root := commonRoot(paths)

	var out []VaultNote
	for _, n := range notes {
		text, err := plainText(n.data)
		if err != nil {
			continue // binary in a .md: not a note
		}
		rel := strings.TrimPrefix(n.path, root)
		folder := path.Dir(rel)
		if folder == "." {
			folder = ""
		}
		title, body := NoteText(strings.TrimSuffix(path.Base(rel), path.Ext(rel)), text)
		if body == "" {
			continue
		}
		out = append(out, VaultNote{Path: n.path, Folder: folder, Title: title, Body: body})
	}
	if len(out) == 0 {
		return nil, ErrVaultEmpty
	}
	return out, nil
}

// ZipFileCount is how many files (not folders) a zip holds, by its directory.
func ZipFileCount(data []byte) (int, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return 0, ErrVaultNotZip
	}
	n := 0
	for _, f := range zr.File {
		if !f.FileInfo().IsDir() {
			n++
		}
	}
	return n, nil
}

// vaultNote is whether a zip path is a note to read: Markdown, and not hidden or Apple's.
func vaultNote(name string) bool {
	for _, part := range strings.Split(name, "/") {
		if strings.HasPrefix(part, ".") || part == "__MACOSX" {
			return false
		}
	}
	ext := strings.ToLower(path.Ext(name))
	return ext == ".md" || ext == ".markdown"
}

// commonRoot is "Top/" when every path is inside the folder Top, else "".
func commonRoot(paths []string) string {
	root := ""
	for i, p := range paths {
		top, _, ok := strings.Cut(p, "/")
		if !ok {
			return ""
		}
		if i == 0 {
			root = top
		} else if top != root {
			return ""
		}
	}
	if root == "" {
		return ""
	}
	return root + "/"
}

var (
	frontMatter = regexp.MustCompile(`\A(?:\x{FEFF})?---[ \t]*\r?\n(?s:.*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|\z)`)
	obsComment  = regexp.MustCompile(`(?s)%%.*?%%`)
	wikiLink    = regexp.MustCompile(`(!?)\[\[([^\[\]|#^]*)((?:#\^?)[^\[\]|]*)?(?:\|([^\[\]]*))?\]\]`)
	firstH1     = regexp.MustCompile(`^#[ \t]+(.+?)[ \t#]*$`)
)

/* NoteText is a note's title and plain text: front-matter and comments removed, links as
 * words, normalised. The title is the note's first line when that is a "# Heading" (and the
 * line then leaves the body), else name. */
func NoteText(name, text string) (title, body string) {
	text = frontMatter.ReplaceAllString(text, "")
	text = obsComment.ReplaceAllString(text, "")
	text = WikiToPlain(text)
	text = Normalize(text)
	title = strings.TrimSpace(name)
	if first, rest, _ := strings.Cut(text, "\n"); firstH1.MatchString(first) {
		title = strings.TrimSpace(firstH1.FindStringSubmatch(first)[1])
		text = strings.TrimSpace(rest)
	}
	if title == "" {
		title = "Untitled"
	}
	return title, text
}

/* WikiToPlain writes Obsidian links as their words: [[Note|alias]] is "alias", [[Note]] and
 * [[Folder/Note.md]] are "Note", [[Note#Heading]] is "Note (Heading)" and [[#Heading]]
 * "Heading". An embed (![[…]]) of a note is its name; of anything else (a picture, a PDF) it
 * is dropped, since only its file name would be left. */
func WikiToPlain(s string) string {
	return wikiLink.ReplaceAllStringFunc(s, func(m string) string {
		g := wikiLink.FindStringSubmatch(m)
		embed, target, anchor, alias := g[1] == "!", strings.TrimSpace(g[2]), g[3], strings.TrimSpace(g[4])
		anchor = strings.TrimSpace(strings.TrimLeft(anchor, "#^"))
		ext := strings.ToLower(path.Ext(target))
		if embed && ext != "" && ext != ".md" {
			return ""
		}
		if alias != "" && !embed {
			return alias
		}
		name := strings.TrimSuffix(path.Base(target), path.Ext(target))
		if ext != ".md" && ext != "" {
			name = path.Base(target)
		}
		if target == "" {
			name = ""
		}
		switch {
		case name != "" && anchor != "":
			return name + " (" + anchor + ")"
		case name != "":
			return name
		default:
			return anchor
		}
	})
}
