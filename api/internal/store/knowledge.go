package store

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

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
	// Folder is a vault note's folder, as a tag; "" otherwise.
	Folder string
	// Chunks are the document's pieces (knowledge.Split of Body).
	Chunks []knowledge.Chunk
}

// knowledgeDocColumns is a document as the list shows it: the first 280 characters of its text
// as the preview.
const knowledgeDocColumns = `d.id::text, d.title, d.source, d.filename, d.folder, d.bytes, d.words,
	(SELECT count(*)::int FROM knowledge_chunks c WHERE c.doc_id = d.id),
	left(d.body, 280), d.created_at, d.updated_at`

type rowScanner interface{ Scan(dest ...any) error }

func scanKnowledgeDoc(r rowScanner) (types.KnowledgeDoc, error) {
	var (
		d        types.KnowledgeDoc
		cre, upd time.Time
	)
	if err := r.Scan(&d.ID, &d.Title, &d.Source, &d.Filename, &d.Folder, &d.Bytes, &d.Words, &d.Chunks,
		&d.Preview, &cre, &upd); err != nil {
		return d, err
	}
	d.CreatedAt, d.UpdatedAt = cre.UTC().Format(time.RFC3339), upd.UTC().Format(time.RFC3339)
	return d, nil
}

/* CreateKnowledgeDocs stores documents and their chunks in one transaction, all or none,
 * within the library's limits (ErrLibraryFull): a vault import is refused whole rather than
 * half added. The host's row is locked for the count, so two uploads at once cannot both
 * squeeze under the cap. */
func (s *Store) CreateKnowledgeDocs(ctx context.Context, hostID string, ds []NewKnowledgeDoc) ([]types.KnowledgeDoc, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, hostID); err != nil {
		return nil, err
	}
	var docs, words int
	if err := tx.QueryRow(ctx, `
		SELECT count(*)::int, COALESCE(sum(words), 0)::int FROM knowledge_docs WHERE host_id = $1`,
		hostID).Scan(&docs, &words); err != nil {
		return nil, err
	}
	adding := 0
	for _, d := range ds {
		adding += d.Words
	}
	if docs+len(ds) > types.KnowledgeMaxDocs || words+adding > types.KnowledgeMaxWords {
		return nil, ErrLibraryFull
	}
	out := make([]types.KnowledgeDoc, 0, len(ds))
	for _, d := range ds {
		var id string
		if err := tx.QueryRow(ctx, `
			INSERT INTO knowledge_docs (host_id, title, source, filename, bytes, body, words, folder)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text`,
			hostID, d.Title, d.Source, d.Filename, d.Bytes, d.Body, d.Words, d.Folder).Scan(&id); err != nil {
			return nil, err
		}
		for _, c := range d.Chunks {
			if _, err := tx.Exec(ctx, `
				INSERT INTO knowledge_chunks (doc_id, seq, body, tokens) VALUES ($1, $2, $3, $4)`,
				id, c.Seq, c.Text, c.Tokens); err != nil {
				return nil, err
			}
		}
		doc, err := scanKnowledgeDoc(tx.QueryRow(ctx, `SELECT `+knowledgeDocColumns+`
			FROM knowledge_docs d WHERE d.id = $1`, id))
		if err != nil {
			return nil, err
		}
		out = append(out, doc)
	}
	return out, tx.Commit(ctx)
}

// CreateKnowledgeDoc stores one document (CreateKnowledgeDocs).
func (s *Store) CreateKnowledgeDoc(ctx context.Context, hostID string, d NewKnowledgeDoc) (types.KnowledgeDoc, error) {
	out, err := s.CreateKnowledgeDocs(ctx, hostID, []NewKnowledgeDoc{d})
	if err != nil {
		return types.KnowledgeDoc{}, err
	}
	return out[0], nil
}

// KnowledgeUsage is how many documents and words a host's library holds.
func (s *Store) KnowledgeUsage(ctx context.Context, hostID string) (docs, words int, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT count(*)::int, COALESCE(sum(words), 0)::int FROM knowledge_docs WHERE host_id = $1`,
		hostID).Scan(&docs, &words)
	return docs, words, err
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
	err := row.Scan(&d.ID, &d.Title, &d.Source, &d.Filename, &d.Folder, &d.Bytes, &d.Words, &d.Chunks,
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

// SessionHasKnowledge reports whether the session has anything to draw on: one of its host's
// documents not left out of it, or an approved past answer while past answers are on.
func (s *Store) SessionHasKnowledge(ctx context.Context, slug string) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM webinars w
			  JOIN knowledge_docs d ON d.host_id = w.host_id
			 WHERE w.slug = $1
			   AND NOT EXISTS (SELECT 1 FROM session_knowledge_exclusions e
			                    WHERE e.webinar_id = w.id AND e.doc_id = d.id))
		    OR EXISTS (
			SELECT 1 FROM webinars w
			  JOIN knowledge_answers a ON a.host_id = w.host_id AND a.status = 'approved'
			 WHERE w.slug = $1
			   AND NOT EXISTS (SELECT 1 FROM session_past_answers_off o WHERE o.webinar_id = w.id))`,
		slug).Scan(&ok)
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

// PastAnswersTitle is what a past answer is cited as, among the documents.
const PastAnswersTitle = "Past answers"

// pastAnswerHitPrefix marks a hit's DocID as a past answer's id.
const pastAnswerHitPrefix = "pa:"

// IsPastAnswer reports whether a hit is a past answer rather than a document chunk.
func (h KnowledgeHit) IsPastAnswer() bool { return strings.HasPrefix(h.DocID, pastAnswerHitPrefix) }

/* SearchKnowledge is the session's chunks and approved past answers matching a
 * to_tsquery('simple', …) query (see knowledge.TSQuery), best first, at most limit: only the
 * session host's, none of the documents the session left out, and no past answer when it left
 * those out. Ties go to the older document's earlier chunk. */
func (s *Store) SearchKnowledge(ctx context.Context, slug, tsquery string, limit int) ([]KnowledgeHit, error) {
	if tsquery == "" {
		return []KnowledgeHit{}, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, title, seq, body, tokens, rank FROM (
			SELECT d.id::text AS id, d.title, c.seq, c.body, c.tokens, ts_rank(c.tsv, q, 1) AS rank,
			       d.created_at AS at
			  FROM webinars w
			  JOIN knowledge_docs d ON d.host_id = w.host_id
			  JOIN knowledge_chunks c ON c.doc_id = d.id,
			       to_tsquery('simple', $2) q
			 WHERE w.slug = $1 AND c.tsv @@ q
			   AND NOT EXISTS (SELECT 1 FROM session_knowledge_exclusions e
			                    WHERE e.webinar_id = w.id AND e.doc_id = d.id)
			UNION ALL
			SELECT 'pa:' || a.id::text, $4, 0, 'Q: ' || a.question || E'\nA: ' || a.answer, 0,
			       ts_rank(a.tsv, q, 1), a.created_at
			  FROM webinars w
			  JOIN knowledge_answers a ON a.host_id = w.host_id AND a.status = 'approved',
			       to_tsquery('simple', $2) q
			 WHERE w.slug = $1 AND a.tsv @@ q
			   AND NOT EXISTS (SELECT 1 FROM session_past_answers_off o WHERE o.webinar_id = w.id)
		) hits
		 ORDER BY rank DESC, at, seq
		 LIMIT $3`, slug, tsquery, limit, PastAnswersTitle)
	if err != nil {
		return nil, err
	}
	return scanHits(rows)
}

func scanHits(rows pgx.Rows) ([]KnowledgeHit, error) {
	defer rows.Close()
	out := []KnowledgeHit{}
	for rows.Next() {
		var h KnowledgeHit
		if err := rows.Scan(&h.DocID, &h.Title, &h.Seq, &h.Text, &h.Tokens, &h.Rank); err != nil {
			return nil, err
		}
		if h.IsPastAnswer() {
			h.Tokens = knowledge.EstimateTokens(h.Text)
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// VectorMinSimilarity is the cosine similarity below which a vector neighbour is not a hit:
// unrelated text sits around 0.1 to 0.2 with text-embedding-3-small. Without a floor every
// question would "find" something, and the assistant would draft from noise.
const VectorMinSimilarity = 0.3

/* SearchKnowledgeByVector is the session's embedded chunks and approved past answers nearest
 * a question's embedding (cosine), best first, at most limit each, above VectorMinSimilarity;
 * the same scope as SearchKnowledge. Rank is the similarity.
 *
 * The HNSW indexes are scanned iteratively (pgvector 0.8's hnsw.iterative_scan) so the host
 * and exclusion filters cannot leave the LIMIT unfilled; on a pgvector without the setting the
 * search runs without it. */
func (s *Store) SearchKnowledgeByVector(ctx context.Context, slug string, vec []float32, limit int) ([]KnowledgeHit, error) {
	if len(vec) == 0 {
		return []KnowledgeHit{}, nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SAVEPOINT iter`); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SET LOCAL hnsw.iterative_scan = relaxed_order`); err != nil {
		if _, err := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT iter`); err != nil {
			return nil, err
		}
	}
	rows, err := tx.Query(ctx, `
		SELECT id, title, seq, body, tokens, sim FROM (
			(SELECT d.id::text AS id, d.title, c.seq, c.body, c.tokens,
			        1 - (c.embedding <=> $2::halfvec) AS sim, d.created_at AS at
			   FROM webinars w
			   JOIN knowledge_docs d ON d.host_id = w.host_id
			   JOIN knowledge_chunks c ON c.doc_id = d.id
			  WHERE w.slug = $1 AND c.embedding IS NOT NULL
			    AND NOT EXISTS (SELECT 1 FROM session_knowledge_exclusions e
			                     WHERE e.webinar_id = w.id AND e.doc_id = d.id)
			  ORDER BY c.embedding <=> $2::halfvec
			  LIMIT $3)
			UNION ALL
			(SELECT 'pa:' || a.id::text, $4, 0, 'Q: ' || a.question || E'\nA: ' || a.answer, 0,
			        1 - (a.embedding <=> $2::halfvec), a.created_at
			   FROM webinars w
			   JOIN knowledge_answers a ON a.host_id = w.host_id AND a.status = 'approved'
			  WHERE w.slug = $1 AND a.embedding IS NOT NULL
			    AND NOT EXISTS (SELECT 1 FROM session_past_answers_off o WHERE o.webinar_id = w.id)
			  ORDER BY a.embedding <=> $2::halfvec
			  LIMIT $3)
		) hits
		 WHERE sim >= $5
		 ORDER BY sim DESC, at, seq
		 LIMIT $3`, slug, VectorLiteral(vec), limit, PastAnswersTitle, VectorMinSimilarity)
	if err != nil {
		return nil, err
	}
	return scanHits(rows)
}

// VectorLiteral is a vector as pgvector reads it: "[0.1,0.2,…]".
func VectorLiteral(v []float32) string {
	var b strings.Builder
	b.Grow(len(v) * 10)
	b.WriteByte('[')
	for i, x := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(float64(x), 'g', -1, 32))
	}
	b.WriteByte(']')
	return b.String()
}

// ChunkRef is a chunk to embed.
type ChunkRef struct {
	DocID string
	Seq   int
	Text  string
}

// ChunksWithoutEmbedding is up to limit of a host's chunks not embedded yet, oldest first.
func (s *Store) ChunksWithoutEmbedding(ctx context.Context, hostID string, limit int) ([]ChunkRef, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.doc_id::text, c.seq, c.body FROM knowledge_chunks c
		  JOIN knowledge_docs d ON d.id = c.doc_id
		 WHERE d.host_id = $1 AND c.embedding IS NULL
		 ORDER BY d.created_at, c.doc_id, c.seq
		 LIMIT $2`, hostID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ChunkRef{}
	for rows.Next() {
		var c ChunkRef
		if err := rows.Scan(&c.DocID, &c.Seq, &c.Text); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// SetChunkEmbeddings stores each chunk's vector, unless the chunk's text changed meanwhile.
func (s *Store) SetChunkEmbeddings(ctx context.Context, refs []ChunkRef, vecs [][]float32) error {
	batch := &pgx.Batch{}
	for i, c := range refs {
		if i >= len(vecs) || len(vecs[i]) == 0 {
			continue
		}
		batch.Queue(`UPDATE knowledge_chunks SET embedding = $3::halfvec
			WHERE doc_id::text = $1 AND seq = $2 AND body = $4`, c.DocID, c.Seq, VectorLiteral(vecs[i]), c.Text)
	}
	if batch.Len() == 0 {
		return nil
	}
	return s.pool.SendBatch(ctx, batch).Close()
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
