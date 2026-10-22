package store

import (
	"context"
	"errors"
	"time"

	"github.com/netkumar/webcast/api/internal/knowledge"
	"github.com/netkumar/webcast/api/types"
)

/* The AI knowledge (migration 0134): a host's documents, chunked and full-text indexed, that
 * ground the Q&A assistant's draft answers; which of them a session leaves out; and the drafts
 * themselves. See api/internal/api/knowledge.go and qa_assist.go.
 *
 * Every read of a document is scoped to its owner (host_id) or, for a session, to the
 * session's host: another host's documents are not found, not forbidden. */

var (
	// ErrLibraryFull is an addition past types.KnowledgeMaxDocs or types.KnowledgeMaxWords.
	ErrLibraryFull = errors.New("knowledge: library full")
)

// NewKnowledgeDoc is a document to add, its text already extracted and normalised.
type NewKnowledgeDoc struct {
	Title    string
	Source   string
	Filename string
	Bytes    int64
	Body     string
	Words    int
}

// knowledgeDocColumns is a document as the list shows it: the first 280 characters of its text
// as the preview.
const knowledgeDocColumns = `d.id::text, d.title, d.source, d.filename, d.bytes, d.words,
	(SELECT count(*)::int FROM knowledge_chunks c WHERE c.doc_id = d.id),
	left(d.body, 280), d.created_at, d.updated_at`

type rowScanner interface{ Scan(dest ...any) error }

func scanKnowledgeDoc(r rowScanner) (types.KnowledgeDoc, error) {
	var (
		d        types.KnowledgeDoc
		cre, upd time.Time
	)
	if err := r.Scan(&d.ID, &d.Title, &d.Source, &d.Filename, &d.Bytes, &d.Words, &d.Chunks,
		&d.Preview, &cre, &upd); err != nil {
		return d, err
	}
	d.CreatedAt, d.UpdatedAt = cre.UTC().Format(time.RFC3339), upd.UTC().Format(time.RFC3339)
	return d, nil
}

/* CreateKnowledgeDoc stores a document and its chunks in one transaction, within the
 * library's limits (ErrLibraryFull). The host's row is locked for the count, so two uploads at
 * once cannot both squeeze under the cap. */
func (s *Store) CreateKnowledgeDoc(ctx context.Context, hostID string, d NewKnowledgeDoc, chunks []knowledge.Chunk) (types.KnowledgeDoc, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return types.KnowledgeDoc{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, hostID); err != nil {
		return types.KnowledgeDoc{}, err
	}
	var docs, words int
	if err := tx.QueryRow(ctx, `
		SELECT count(*)::int, COALESCE(sum(words), 0)::int FROM knowledge_docs WHERE host_id = $1`,
		hostID).Scan(&docs, &words); err != nil {
		return types.KnowledgeDoc{}, err
	}
	if docs >= types.KnowledgeMaxDocs || words+d.Words > types.KnowledgeMaxWords {
		return types.KnowledgeDoc{}, ErrLibraryFull
	}
	var id string
	if err := tx.QueryRow(ctx, `
		INSERT INTO knowledge_docs (host_id, title, source, filename, bytes, body, words)
		VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text`,
		hostID, d.Title, d.Source, d.Filename, d.Bytes, d.Body, d.Words).Scan(&id); err != nil {
		return types.KnowledgeDoc{}, err
	}
	for _, c := range chunks {
		if _, err := tx.Exec(ctx, `
			INSERT INTO knowledge_chunks (doc_id, seq, body, tokens) VALUES ($1, $2, $3, $4)`,
			id, c.Seq, c.Text, c.Tokens); err != nil {
			return types.KnowledgeDoc{}, err
		}
	}
	doc, err := scanKnowledgeDoc(tx.QueryRow(ctx, `SELECT `+knowledgeDocColumns+`
		FROM knowledge_docs d WHERE d.id = $1`, id))
	if err != nil {
		return types.KnowledgeDoc{}, err
	}
	return doc, tx.Commit(ctx)
}

// KnowledgeDocs is a host's library, newest first, and the words it holds in all.
func (s *Store) KnowledgeDocs(ctx context.Context, hostID string) ([]types.KnowledgeDoc, int, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+knowledgeDocColumns+`
		FROM knowledge_docs d WHERE d.host_id = $1
		ORDER BY d.created_at DESC, d.id`, hostID)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []types.KnowledgeDoc{}
	words := 0
	for rows.Next() {
		d, err := scanKnowledgeDoc(rows)
		if err != nil {
			return nil, 0, err
		}
		words += d.Words
		out = append(out, d)
	}
	return out, words, rows.Err()
}

// KnowledgeDoc is one of a host's documents and its whole text; ErrNotFound for another's.
func (s *Store) KnowledgeDoc(ctx context.Context, hostID, id string) (types.KnowledgeDoc, string, error) {
	var body string
	row := s.pool.QueryRow(ctx, `SELECT `+knowledgeDocColumns+`, d.body
		FROM knowledge_docs d WHERE d.id::text = $1 AND d.host_id = $2`, id, hostID)
	var (
		d        types.KnowledgeDoc
		cre, upd time.Time
	)
	err := row.Scan(&d.ID, &d.Title, &d.Source, &d.Filename, &d.Bytes, &d.Words, &d.Chunks,
		&d.Preview, &cre, &upd, &body)
	if noRows(err) {
		return d, "", ErrNotFound
	}
	if err != nil {
		return d, "", err
	}
	d.CreatedAt, d.UpdatedAt = cre.UTC().Format(time.RFC3339), upd.UTC().Format(time.RFC3339)
	return d, body, nil
}

// RenameKnowledgeDoc retitles one of a host's documents; ErrNotFound for another's.
func (s *Store) RenameKnowledgeDoc(ctx context.Context, hostID, id, title string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE knowledge_docs SET title = $3, updated_at = now()
		 WHERE id::text = $1 AND host_id = $2`, id, hostID, title)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// DeleteKnowledgeDoc removes one of a host's documents, its chunks and every session's
// exclusion of it; ErrNotFound for another's.
func (s *Store) DeleteKnowledgeDoc(ctx context.Context, hostID, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM knowledge_docs WHERE id::text = $1 AND host_id = $2`, id, hostID)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// SessionKnowledgeDocs is the session host's library with each document's tick for this
// session, newest first.
func (s *Store) SessionKnowledgeDocs(ctx context.Context, slug string) ([]types.SessionKnowledgeDoc, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT d.id::text, d.title, d.source, d.words,
		       NOT EXISTS (SELECT 1 FROM session_knowledge_exclusions e
		                    WHERE e.webinar_id = w.id AND e.doc_id = d.id)
		  FROM webinars w
		  JOIN knowledge_docs d ON d.host_id = w.host_id
		 WHERE w.slug = $1
		 ORDER BY d.created_at DESC, d.id`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []types.SessionKnowledgeDoc{}
	for rows.Next() {
		var d types.SessionKnowledgeDoc
		if err := rows.Scan(&d.ID, &d.Title, &d.Source, &d.Words, &d.Included); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// SetSessionKnowledge ticks or unticks one of the session host's documents for this session;
// ErrNotFound when the document is not the session host's.
func (s *Store) SetSessionKnowledge(ctx context.Context, slug, docID string, included bool) error {
	var webinarID, id string
	err := s.pool.QueryRow(ctx, `
		SELECT w.id::text, d.id::text FROM webinars w
		  JOIN knowledge_docs d ON d.host_id = w.host_id
		 WHERE w.slug = $1 AND d.id::text = $2`, slug, docID).Scan(&webinarID, &id)
	if noRows(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if included {
		_, err = s.pool.Exec(ctx, `
			DELETE FROM session_knowledge_exclusions WHERE webinar_id = $1 AND doc_id = $2`, webinarID, id)
	} else {
		_, err = s.pool.Exec(ctx, `
			INSERT INTO session_knowledge_exclusions (webinar_id, doc_id) VALUES ($1, $2)
			ON CONFLICT DO NOTHING`, webinarID, id)
	}
	return err
}

// SessionHasKnowledge reports whether the session has any document to draw on: one of its
// host's, not left out of it.
func (s *Store) SessionHasKnowledge(ctx context.Context, slug string) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM webinars w
			  JOIN knowledge_docs d ON d.host_id = w.host_id
			 WHERE w.slug = $1
			   AND NOT EXISTS (SELECT 1 FROM session_knowledge_exclusions e
			                    WHERE e.webinar_id = w.id AND e.doc_id = d.id))`, slug).Scan(&ok)
	return ok, err
}

// KnowledgeHit is one chunk a search found.
type KnowledgeHit struct {
	DocID  string
	Title  string
	Seq    int
	Text   string
	Tokens int
	Rank   float64
}

/* SearchKnowledge is the session's chunks matching a to_tsquery('simple', …) query (see
 * knowledge.TSQuery), best first, at most limit: only the session host's documents, and none
 * the session left out. Ties go to the older document's earlier chunk. */
func (s *Store) SearchKnowledge(ctx context.Context, slug, tsquery string, limit int) ([]KnowledgeHit, error) {
	if tsquery == "" {
		return []KnowledgeHit{}, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT d.id::text, d.title, c.seq, c.body, c.tokens, ts_rank(c.tsv, q, 1) AS rank
		  FROM webinars w
		  JOIN knowledge_docs d ON d.host_id = w.host_id
		  JOIN knowledge_chunks c ON c.doc_id = d.id,
		       to_tsquery('simple', $2) q
		 WHERE w.slug = $1 AND c.tsv @@ q
		   AND NOT EXISTS (SELECT 1 FROM session_knowledge_exclusions e
		                    WHERE e.webinar_id = w.id AND e.doc_id = d.id)
		 ORDER BY rank DESC, d.created_at, c.seq
		 LIMIT $3`, slug, tsquery, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []KnowledgeHit{}
	for rows.Next() {
		var h KnowledgeHit
		if err := rows.Scan(&h.DocID, &h.Title, &h.Seq, &h.Text, &h.Tokens, &h.Rank); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------- drafts

// QADraft is a stored draft answer.
type QADraft struct {
	ID         string
	ClusterKey string
	Answer     string
	Grounded   bool
	Sources    []string
	Auto       bool
	Status     string
	CreatedAt  time.Time
}

// QA draft states.
const (
	QADraftOpen      = "draft"
	QADraftPosted    = "posted"
	QADraftDiscarded = "discarded"
)

/* SaveQADraft stores a draft for its cluster key, in place of any open draft the key had (a
 * second "Suggest an answer" replaces the first). */
func (s *Store) SaveQADraft(ctx context.Context, slug string, d QADraft) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		DELETE FROM session_qa_drafts dr USING webinars w
		 WHERE dr.webinar_id = w.id AND w.slug = $1 AND dr.cluster_key = $2 AND dr.status = 'draft'`,
		slug, d.ClusterKey); err != nil {
		return err
	}
	sources := d.Sources
	if sources == nil {
		sources = []string{}
	}
	tag, err := tx.Exec(ctx, `
		INSERT INTO session_qa_drafts (id, webinar_id, cluster_key, answer, grounded, sources, auto)
		SELECT $1, w.id, $3, $4, $5, $6, $7 FROM webinars w WHERE w.slug = $2`,
		d.ID, slug, d.ClusterKey, d.Answer, d.Grounded, sources, d.Auto)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

const qaDraftColumns = `dr.id, dr.cluster_key, dr.answer, dr.grounded, dr.sources, dr.auto, dr.status, dr.created_at`

func scanQADraft(r rowScanner) (QADraft, error) {
	var d QADraft
	err := r.Scan(&d.ID, &d.ClusterKey, &d.Answer, &d.Grounded, &d.Sources, &d.Auto, &d.Status, &d.CreatedAt)
	return d, err
}

// QADrafts is the session's open drafts, oldest first.
func (s *Store) QADrafts(ctx context.Context, slug string) ([]QADraft, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+qaDraftColumns+`
		  FROM session_qa_drafts dr JOIN webinars w ON w.id = dr.webinar_id
		 WHERE w.slug = $1 AND dr.status = 'draft'
		 ORDER BY dr.created_at, dr.id`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []QADraft{}
	for rows.Next() {
		d, err := scanQADraft(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// QADraftByID is one open draft of the session; ErrNotFound for another session's, or one
// already posted or discarded.
func (s *Store) QADraftByID(ctx context.Context, slug, id string) (QADraft, error) {
	d, err := scanQADraft(s.pool.QueryRow(ctx, `SELECT `+qaDraftColumns+`
		  FROM session_qa_drafts dr JOIN webinars w ON w.id = dr.webinar_id
		 WHERE w.slug = $1 AND dr.id = $2 AND dr.status = 'draft'`, slug, id))
	if noRows(err) {
		return d, ErrNotFound
	}
	return d, err
}

// CloseQADraft marks an open draft posted (with the answer as posted) or discarded. Reports
// false when it was no longer open: another host got there first.
func (s *Store) CloseQADraft(ctx context.Context, slug, id, status, answer string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE session_qa_drafts dr
		   SET status = $3, answer = CASE WHEN $4 = '' THEN dr.answer ELSE $4 END, updated_at = now()
		  FROM webinars w
		 WHERE dr.webinar_id = w.id AND w.slug = $1 AND dr.id = $2 AND dr.status = 'draft'`,
		slug, id, status, answer)
	return err == nil && tag.RowsAffected() > 0, err
}

// QADraftKeys is every cluster key the session has had a draft for, in any state: an
// automatic draft is not written again for a question a host already saw one for.
func (s *Store) QADraftKeys(ctx context.Context, slug string) (map[string]bool, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT dr.cluster_key FROM session_qa_drafts dr
		  JOIN webinars w ON w.id = dr.webinar_id WHERE w.slug = $1`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		out[k] = true
	}
	return out, rows.Err()
}

// QAAutoDraftCount is how many drafts the assistant has written unasked in this session.
func (s *Store) QAAutoDraftCount(ctx context.Context, slug string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
		SELECT count(*)::int FROM session_qa_drafts dr
		  JOIN webinars w ON w.id = dr.webinar_id WHERE w.slug = $1 AND dr.auto`, slug).Scan(&n)
	return n, err
}

/* QAOpenQuestionIDs is the questions an answer to a cluster key goes on: the cluster's
 * questions that are neither answered nor hidden, or the one question for a "q_" key while it
 * is open. Oldest first. */
func (s *Store) QAOpenQuestionIDs(ctx context.Context, slug, clusterID, questionID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT q.id FROM session_questions q
		  JOIN webinars w ON w.id = q.webinar_id
		 WHERE w.slug = $1 AND NOT q.answered AND NOT q.dismissed
		   AND (($2 <> '' AND q.cluster_id = $2) OR ($3 <> '' AND q.id = $3))
		 ORDER BY q.created_at, q.id`, slug, clusterID, questionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
