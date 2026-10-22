package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"path"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/knowledge"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The AI knowledge: a host's library of documents that grounds the live Q&A assistant's
 * draft answers (qa_assist.go).
 *
 *   library    pasted text, or a TXT, Markdown, PDF or DOCX upload. The text is extracted here
 *              (internal/knowledge), cut into overlapping ~400-word chunks and stored with a
 *              'simple' tsvector (migration 0134). The file itself is not kept, so the library
 *              does not count against the media quota; it has its own small caps instead
 *              (types.KnowledgeMax*: documents, words per document and in all, upload size).
 *   sessions   every session uses every document of its host's; a host or co-host can untick
 *              documents for one session (session_knowledge_exclusions).
 *   retrieval  a question's content words, OR-ed as prefixes (knowledge.TSQuery), ranked with
 *              ts_rank over the session's chunks, fused with a vector ranking when embeddings
 *              are available (knowledge_embed.go); the best few within a token budget
 *              (pickKnowledge) are what the model is given. Approved past answers
 *              (knowledge_answers.go) are searched alongside the chunks.
 *
 * Only for accounts with the ai feature: the library routes say feature_off otherwise, and a
 * session's list follows its host's account. */

const (
	// knowledgeSearchLimit is how many ranked chunks a search reads before the budget picks.
	knowledgeSearchLimit = 20
	// A suggested answer is given the best knowledgeTopChunks within knowledgeTokenBudget.
	knowledgeTopChunks   = 5
	knowledgeTokenBudget = 3000
	// Each question of an automatic-draft batch gets fewer, so the batch stays one call.
	autoDraftTopChunks   = 3
	autoDraftTokenBudget = 1200
)

/* pickKnowledge takes ranked hits, best first, up to n of them within budget tokens: a chunk
 * that would overflow the budget is passed over for a smaller one further down. */
func pickKnowledge(hits []store.KnowledgeHit, n, budget int) []store.KnowledgeHit {
	out := []store.KnowledgeHit{}
	used := 0
	for _, h := range hits {
		if len(out) == n {
			break
		}
		if used+h.Tokens > budget {
			continue
		}
		used += h.Tokens
		out = append(out, h)
	}
	return out
}

// ---------------------------------------------------------------- the library

func knowledgeLimits() types.KnowledgeLimits {
	return types.KnowledgeLimits{
		MaxDocs: types.KnowledgeMaxDocs, MaxDocWords: types.KnowledgeMaxDocWords,
		MaxWords: types.KnowledgeMaxWords, MaxUploadBytes: types.KnowledgeMaxUploadBytes,
	}
}

// knowledgeTitle is a title as stored: one line, at most KnowledgeMaxTitleRunes.
func knowledgeTitle(s string) string {
	return clipRunes(strings.Join(strings.Fields(s), " "), types.KnowledgeMaxTitleRunes)
}

// handleKnowledgeLibrary is GET /api/host/knowledge.
func (s *Server) handleKnowledgeLibrary(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if !s.featureAllowed(w, user, types.FeatureAIKnowledge) {
		return
	}
	// What earlier adds could not embed (no key then, a cap, an outage).
	s.backfillEmbeddings(r.Context(), user.ID)
	docs, words, err := s.store.KnowledgeDocs(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "knowledge: list", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.KnowledgeLibrary{Docs: docs, UsedWords: words, Limits: knowledgeLimits()})
}

// handleCreateKnowledge is POST /api/host/knowledge: a pasted document.
func (s *Server) handleCreateKnowledge(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if !s.featureAllowed(w, user, types.FeatureAIKnowledge) {
		return
	}
	var in types.KnowledgeCreateRequest
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		if tooBig := new(http.MaxBytesError); errors.As(err, &tooBig) {
			httpx.Error(w, http.StatusRequestEntityTooLarge, "too_large", "That's too much text to paste at once. Upload it as a file instead.")
			return
		}
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	title := knowledgeTitle(in.Title)
	text := knowledge.Normalize(in.Text)
	fields := map[string]string{}
	if title == "" {
		fields["title"] = "Give it a title."
	}
	if text == "" {
		fields["text"] = "Paste the text this document should hold."
	}
	if len(fields) > 0 {
		httpx.Fields(w, fields)
		return
	}
	s.addKnowledgeDoc(w, r, user, store.NewKnowledgeDoc{Title: title, Source: knowledge.SourceText, Body: text})
}

/* handleUploadKnowledge is POST /api/host/knowledge/upload?filename=…&title=…: the raw file
 * as the body, like a cover image. The type comes from the file name's extension and is
 * checked against the content (a PDF must start %PDF, a DOCX is a zip). The title defaults to
 * the file name without its extension. */
func (s *Server) handleUploadKnowledge(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if !s.featureAllowed(w, user, types.FeatureAIKnowledge) {
		return
	}
	filename := clipRunes(path.Base(strings.ReplaceAll(strings.TrimSpace(r.URL.Query().Get("filename")), "\\", "/")), 200)
	if knowledge.SourceFor(filename) == "" {
		httpx.Error(w, http.StatusUnsupportedMediaType, "unsupported",
			"Upload a PDF, Word (.docx), text (.txt) or Markdown (.md) file.")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, types.KnowledgeMaxUploadBytes+1))
	if err != nil || len(body) > types.KnowledgeMaxUploadBytes {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "too_large",
			"Files must be under "+strconv.Itoa(types.KnowledgeMaxUploadBytes>>20)+" MB.")
		return
	}
	if len(body) == 0 {
		httpx.Error(w, http.StatusBadRequest, "empty", "That upload was empty.")
		return
	}
	text, source, err := knowledge.Extract(filename, body)
	switch {
	case errors.Is(err, knowledge.ErrNoText):
		httpx.Error(w, http.StatusUnprocessableEntity, "no_text",
			"There's no text in that file. A scanned PDF is pictures of pages; paste the text instead.")
		return
	case err != nil:
		s.log.Info("knowledge: unreadable upload", "source", source, "error", err)
		httpx.Error(w, http.StatusUnprocessableEntity, "unreadable",
			"We couldn't read that file. If it's password-protected, remove the password, or paste the text instead.")
		return
	}
	title := knowledgeTitle(r.URL.Query().Get("title"))
	if title == "" {
		title = knowledgeTitle(strings.TrimSuffix(filename, path.Ext(filename)))
	}
	if title == "" {
		title = "Untitled"
	}
	s.addKnowledgeDoc(w, r, user, store.NewKnowledgeDoc{
		Title: title, Source: source, Filename: filename, Bytes: int64(len(body)), Body: text,
	})
}

// addKnowledgeDoc chunks and stores a document within the library's limits; 201 with it.
func (s *Server) addKnowledgeDoc(w http.ResponseWriter, r *http.Request, user store.User, d store.NewKnowledgeDoc) {
	d.Words = knowledge.Words(d.Body)
	if d.Words > types.KnowledgeMaxDocWords {
		httpx.Error(w, http.StatusUnprocessableEntity, "too_long",
			"That's "+strconv.Itoa(d.Words)+" words. A document can hold up to "+
				strconv.Itoa(types.KnowledgeMaxDocWords)+"; split it into parts.")
		return
	}
	d.Chunks = knowledge.Split(d.Body)
	doc, err := s.store.CreateKnowledgeDoc(r.Context(), user.ID, d)
	if errors.Is(err, store.ErrLibraryFull) {
		httpx.Error(w, http.StatusUnprocessableEntity, "library_full",
			"Your AI knowledge is full ("+strconv.Itoa(types.KnowledgeMaxDocs)+" documents or "+
				strconv.Itoa(types.KnowledgeMaxWords)+" words in all). Delete a document to add this one.")
		return
	}
	if err != nil {
		s.fail(w, r, "knowledge: create", err)
		return
	}
	// Embedded now, while this request has the CPU; what fails is backfilled on a later read.
	s.backfillEmbeddings(r.Context(), user.ID)
	httpx.JSON(w, http.StatusCreated, doc)
}

// handleKnowledgeDoc is GET /api/host/knowledge/{id}: the document and its extracted text.
func (s *Server) handleKnowledgeDoc(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if !s.featureAllowed(w, user, types.FeatureAIKnowledge) {
		return
	}
	doc, body, err := s.store.KnowledgeDoc(r.Context(), user.ID, chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That document isn't in your AI knowledge.")
		return
	}
	if err != nil {
		s.fail(w, r, "knowledge: doc", err)
		return
	}
	out := types.KnowledgeDocDetail{Doc: doc, Text: body}
	if utf8.RuneCountInString(body) > types.KnowledgeTextPreviewRunes {
		out.Text, out.Truncated = string([]rune(body)[:types.KnowledgeTextPreviewRunes]), true
	}
	httpx.JSON(w, http.StatusOK, out)
}

// handleRenameKnowledge is PATCH /api/host/knowledge/{id}.
func (s *Server) handleRenameKnowledge(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if !s.featureAllowed(w, user, types.FeatureAIKnowledge) {
		return
	}
	var in types.KnowledgeRenameRequest
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	title := knowledgeTitle(in.Title)
	if title == "" {
		httpx.Fields(w, map[string]string{"title": "Give it a title."})
		return
	}
	id := chi.URLParam(r, "id")
	if err := s.store.RenameKnowledgeDoc(r.Context(), user.ID, id, title); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That document isn't in your AI knowledge.")
		return
	} else if err != nil {
		s.fail(w, r, "knowledge: rename", err)
		return
	}
	doc, _, err := s.store.KnowledgeDoc(r.Context(), user.ID, id)
	if err != nil {
		s.fail(w, r, "knowledge: rename", err)
		return
	}
	httpx.JSON(w, http.StatusOK, doc)
}

// handleDeleteKnowledge is DELETE /api/host/knowledge/{id}.
func (s *Server) handleDeleteKnowledge(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if !s.featureAllowed(w, user, types.FeatureAIKnowledge) {
		return
	}
	if err := s.store.DeleteKnowledgeDoc(r.Context(), user.ID, chi.URLParam(r, "id")); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That document isn't in your AI knowledge.")
		return
	} else if err != nil {
		s.fail(w, r, "knowledge: delete", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
}

// ---------------------------------------------------------------- one session's pick

// sessionKnowledgeAllowed answers 403 feature_off unless the session's host has the ai feature.
func (s *Server) sessionKnowledgeAllowed(w http.ResponseWriter, r *http.Request) (string, bool) {
	slug := slugFromContext(r.Context())
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "session knowledge: webinar", err)
		return "", false
	}
	host, err := s.store.UserByID(r.Context(), wb.Host.ID)
	if err != nil {
		s.fail(w, r, "session knowledge: host", err)
		return "", false
	}
	if !host.HasFeature(types.FeatureAIKnowledge) {
		httpx.Error(w, http.StatusForbidden, "feature_off", featureLabel(types.FeatureAIKnowledge)+" isn't switched on for this account.")
		return "", false
	}
	return slug, true
}

// handleSessionKnowledge is GET /api/host/webinars/{slug}/knowledge.
func (s *Server) handleSessionKnowledge(w http.ResponseWriter, r *http.Request) {
	slug, ok := s.sessionKnowledgeAllowed(w, r)
	if !ok {
		return
	}
	s.writeSessionKnowledge(w, r, slug)
}

// writeSessionKnowledge is the session's documents and past-answers tick, 200.
func (s *Server) writeSessionKnowledge(w http.ResponseWriter, r *http.Request, slug string) {
	docs, err := s.store.SessionKnowledgeDocs(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "session knowledge", err)
		return
	}
	past, err := s.store.SessionPastAnswers(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "session knowledge: past answers", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.SessionKnowledge{Docs: docs, PastAnswers: past})
}

// handlePatchSessionPastAnswers is PATCH /api/host/webinars/{slug}/knowledge/past-answers.
func (s *Server) handlePatchSessionPastAnswers(w http.ResponseWriter, r *http.Request) {
	slug, ok := s.sessionKnowledgeAllowed(w, r)
	if !ok {
		return
	}
	var in types.SessionPastAnswersPatch
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if err := s.store.SetSessionPastAnswers(r.Context(), slug, in.Included); err != nil {
		s.fail(w, r, "session knowledge: past answers", err)
		return
	}
	s.writeSessionKnowledge(w, r, slug)
}

// handlePatchSessionKnowledge is PATCH /api/host/webinars/{slug}/knowledge/{docId}.
func (s *Server) handlePatchSessionKnowledge(w http.ResponseWriter, r *http.Request) {
	slug, ok := s.sessionKnowledgeAllowed(w, r)
	if !ok {
		return
	}
	var in types.SessionKnowledgePatch
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if err := s.store.SetSessionKnowledge(r.Context(), slug, chi.URLParam(r, "docId"), in.Included); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That document isn't in this session's AI knowledge.")
		return
	} else if err != nil {
		s.fail(w, r, "session knowledge: set", err)
		return
	}
	s.writeSessionKnowledge(w, r, slug)
}

/* sessionKnowledge is whether a session's Q&A drafts and Auto mode may draw on the host's AI
 * knowledge: the host has ai_knowledge (types.FeatureAIKnowledge, which needs ai) and the
 * session has some. Without the switch a draft is written from the topic and description
 * only, as for a session with no knowledge, and Auto mode answers nothing. */
func (s *Server) sessionKnowledge(ctx context.Context, wb types.Webinar) (bool, error) {
	if !s.hostFeature(ctx, wb.Host.ID, types.FeatureAIKnowledge) {
		return false, nil
	}
	return s.store.SessionHasKnowledge(ctx, wb.ID)
}
