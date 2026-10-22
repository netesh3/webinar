package api

import (
	"errors"
	"io"
	"net/http"
	"path"
	"strconv"
	"strings"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/knowledge"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* handleImportVault is POST /api/host/knowledge/vault?filename=…: an Obsidian vault, zipped,
 * the raw file as the body. Every Markdown note becomes a document (knowledge.ReadVault), its
 * folder kept as a tag, all in one transaction within the library's caps: a vault that does
 * not fit is refused whole, with how much room there is, rather than half imported. */
func (s *Server) handleImportVault(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if !s.featureAllowed(w, user, types.FeatureAI) {
		return
	}
	filename := clipRunes(path.Base(strings.ReplaceAll(strings.TrimSpace(r.URL.Query().Get("filename")), "\\", "/")), 200)
	if !strings.EqualFold(path.Ext(filename), ".zip") {
		httpx.Error(w, http.StatusUnsupportedMediaType, "unsupported",
			"Upload your vault as a .zip file: zip the vault's folder and upload that.")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, types.KnowledgeMaxUploadBytes+1))
	if err != nil || len(body) > types.KnowledgeMaxUploadBytes {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "too_large",
			"Zipped vaults must be under "+strconv.Itoa(types.KnowledgeMaxUploadBytes>>20)+" MB.")
		return
	}
	notes, err := knowledge.ReadVault(body)
	if err != nil {
		vaultError(w, err)
		return
	}

	var (
		docs  []store.NewKnowledgeDoc
		words int
	)
	for _, n := range notes {
		d := store.NewKnowledgeDoc{
			Title: knowledgeTitle(n.Title), Source: knowledge.SourceMD, Filename: clipRunes(n.Path, 200),
			Bytes: int64(len(n.Body)), Body: n.Body, Folder: clipRunes(n.Folder, 200),
		}
		if d.Title == "" {
			d.Title = "Untitled"
		}
		d.Words = knowledge.Words(d.Body)
		if d.Words > types.KnowledgeMaxDocWords {
			httpx.Error(w, http.StatusUnprocessableEntity, "too_long",
				"“"+n.Path+"” is "+strconv.Itoa(d.Words)+" words. A document can hold up to "+
					strconv.Itoa(types.KnowledgeMaxDocWords)+"; split that note, or leave it out of the zip.")
			return
		}
		d.Chunks = knowledge.Split(d.Body)
		words += d.Words
		docs = append(docs, d)
	}
	created, err := s.store.CreateKnowledgeDocs(r.Context(), user.ID, docs)
	if errors.Is(err, store.ErrLibraryFull) {
		have, used, uerr := s.store.KnowledgeUsage(r.Context(), user.ID)
		if uerr != nil {
			s.fail(w, r, "knowledge vault: usage", uerr)
			return
		}
		httpx.Error(w, http.StatusUnprocessableEntity, "library_full", vaultFullMessage(len(docs), words, have, used))
		return
	}
	if err != nil {
		s.fail(w, r, "knowledge vault: create", err)
		return
	}
	s.backfillEmbeddings(r.Context(), user.ID)
	httpx.JSON(w, http.StatusCreated, types.KnowledgeVaultImport{Docs: created, Skipped: vaultSkipped(body, len(notes))})
}

// vaultFullMessage says why a vault does not fit, and how much does.
func vaultFullMessage(notes, words, haveDocs, usedWords int) string {
	roomDocs := max(0, types.KnowledgeMaxDocs-haveDocs)
	roomWords := max(0, types.KnowledgeMaxWords-usedWords)
	return "That vault has " + strconv.Itoa(notes) + " notes (" + strconv.Itoa(words) + " words), " +
		"and your AI knowledge has room for " + strconv.Itoa(roomDocs) + " more documents and " +
		strconv.Itoa(roomWords) + " more words. Zip only the notes the assistant needs, or delete documents first."
}

// vaultSkipped is how many of the zip's files were not imported as notes.
func vaultSkipped(data []byte, notes int) int {
	n, err := knowledge.ZipFileCount(data)
	if err != nil {
		return 0
	}
	return max(0, n-notes)
}

func vaultError(w http.ResponseWriter, err error) {
	var ve *knowledge.VaultError
	name := ""
	if errors.As(err, &ve) {
		name = "“" + ve.Path + "” "
	}
	switch {
	case errors.Is(err, knowledge.ErrVaultNotZip):
		httpx.Error(w, http.StatusUnprocessableEntity, "unreadable", "That isn't a zip file we can open.")
	case errors.Is(err, knowledge.ErrVaultTooManyEntries):
		httpx.Error(w, http.StatusUnprocessableEntity, "too_many_files",
			"That zip has more than "+strconv.Itoa(knowledge.VaultMaxEntries)+" files. Zip only the notes the assistant needs.")
	case errors.Is(err, knowledge.ErrVaultFileTooLarge):
		httpx.Error(w, http.StatusUnprocessableEntity, "note_too_large",
			"The note "+name+"is over "+strconv.Itoa(knowledge.VaultMaxFileBytes>>20)+" MB. Split it or leave it out.")
	case errors.Is(err, knowledge.ErrVaultTooLarge):
		httpx.Error(w, http.StatusUnprocessableEntity, "vault_too_large",
			"The notes in that zip are over "+strconv.Itoa(knowledge.VaultMaxTotalBytes>>20)+" MB in all. Zip fewer of them.")
	case errors.Is(err, knowledge.ErrVaultEmpty):
		httpx.Error(w, http.StatusUnprocessableEntity, "no_notes",
			"There are no Markdown (.md) notes with text in that zip.")
	default:
		httpx.Error(w, http.StatusUnprocessableEntity, "unreadable", "We couldn't read the note "+name+"in that zip.")
	}
}
