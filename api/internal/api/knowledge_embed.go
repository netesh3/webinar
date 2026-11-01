package api

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"time"

	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/aiwrite"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/knowledge"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Hybrid retrieval for the AI knowledge: full-text search and vector search, fused.
 *
 *   embed      every chunk, and every past answer's question, is embedded with
 *              text-embedding-3-small (1536 dimensions) when it is added or edited, through
 *              aiEmbed: the monthly caps hold and each call is an ai_usage row (feature
 *              "embed"). Whatever could not be embedded then (no key, a cap, an outage) is
 *              embedded later by backfillEmbeddings, on the library's next read.
 *   search     a question is embedded once, then the session's chunks and approved past
 *              answers are ranked twice, by ts_rank (store.SearchKnowledge) and by cosine
 *              similarity (store.SearchKnowledgeByVector), and the two rankings are fused by
 *              reciprocal rank (knowledge.FuseRRF). The token budget then picks as before
 *              (pickKnowledge).
 *   fallback   no embedder, a cap, a provider error or a slow answer: the vector ranking is
 *              simply empty and the full-text one is used alone, as before embeddings. A
 *              host never sees an error because of it.
 *
 * Cost: $0.02 per million tokens. A full library (250,000 words, ~330k tokens with the
 * chunks' overlap) costs under a cent to embed once; a question is ~20 tokens. */

const (
	// queryEmbedTimeout bounds a question's embedding on the live path: past it, full-text only.
	queryEmbedTimeout = 3 * time.Second
	// backfillEmbedTimeout bounds one backfill.
	backfillEmbedTimeout = 20 * time.Second
	// backfillChunkLimit and backfillAnswerLimit bound what one backfill embeds.
	backfillChunkLimit  = 1024
	backfillAnswerLimit = 512
)

// newEmbedder is OpenAI's embeddings endpoint when it is configured, else none.
func newEmbedder(cfg config.Config, log *slog.Logger) ai.Embedder {
	p := cfg.AIEmbeddings
	if p == nil {
		log.Info("ai knowledge: no embeddings (set OPENAI_API_KEY); retrieval is full-text only")
		return ai.NoEmbedder{}
	}
	log.Info("ai knowledge: embeddings on", "provider", p.ID, "model", ai.EmbedModel)
	return ai.NewOpenAIEmbedder(p.ID, p.BaseURL, p.APIKey)
}

/* aiEmbed is the embedder for one host, as aiComplete is the chain: refused at a monthly cap
 * (errAILimit), recorded in ai_usage (feature "embed") whatever the outcome. */
func (s *Server) aiEmbed(ctx context.Context, hostID string, inputs []string) ([][]float32, error) {
	if len(inputs) == 0 {
		return nil, nil
	}
	if s.embedder == nil || !s.embedder.Enabled() {
		return nil, ai.ErrUnavailable
	}
	if err := s.aiPlanCheck(ctx, types.AIFeatureEmbed, hostID); err != nil {
		return nil, err
	}
	if err := s.aiCapCheck(ctx, types.AIFeatureEmbed, hostID); err != nil {
		return nil, err
	}
	res, err := s.embedder.Embed(ctx, inputs)
	if errors.Is(err, ai.ErrBenched) {
		return nil, err // nothing was sent: no usage row
	}
	if err == nil && len(res.Vectors) != len(inputs) {
		err = ai.ErrUnavailable
	}
	usage := store.AIUsage{Feature: types.AIFeatureEmbed, HostID: hostID, OK: err == nil,
		Provider: res.Provider, Model: res.Model, PromptTokens: res.PromptTokens}
	usage.CostUSD = ai.EstimateCostUSD(res.Provider, res.Model, res.PromptTokens, 0)
	if rerr := s.store.RecordAIUsage(context.WithoutCancel(ctx), usage); rerr != nil {
		s.log.Warn("ai: record usage", "feature", types.AIFeatureEmbed, "error", rerr)
	}
	if err != nil {
		return nil, err
	}
	return res.Vectors, nil
}

// queryVectors is each text's embedding, or a nil entry for each when there is none: the
// caller then searches full-text only. Never an error.
func (s *Server) queryVectors(ctx context.Context, hostID string, texts []string) [][]float32 {
	out := make([][]float32, len(texts))
	if len(texts) == 0 || s.embedder == nil || !s.embedder.Enabled() {
		return out
	}
	ctx, cancel := context.WithTimeout(ctx, queryEmbedTimeout)
	defer cancel()
	vecs, err := s.aiEmbed(ctx, hostID, texts)
	if err != nil {
		s.log.Info("ai knowledge: no query embedding, full-text only", "error", err)
		return out
	}
	copy(out, vecs)
	return out
}

/* backfillEmbeddings embeds what a host's library has not got vectors for yet: chunks added
 * while embeddings were unavailable (or before they existed) and past answers new or edited.
 * Bounded, best effort; what is left is done on a later call. */
func (s *Server) backfillEmbeddings(ctx context.Context, hostID string) {
	if s.embedder == nil || !s.embedder.Enabled() {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), backfillEmbedTimeout)
	defer cancel()
	if chunks, err := s.store.ChunksWithoutEmbedding(ctx, hostID, backfillChunkLimit); err != nil {
		s.log.Warn("ai knowledge: chunks to embed", "error", err)
	} else if len(chunks) > 0 {
		texts := make([]string, len(chunks))
		for i, c := range chunks {
			texts[i] = c.Text
		}
		vecs, err := s.aiEmbed(ctx, hostID, texts)
		if err != nil {
			s.log.Info("ai knowledge: embed chunks later", "chunks", len(chunks), "error", err)
			return
		}
		if err := s.store.SetChunkEmbeddings(ctx, chunks, vecs); err != nil {
			s.log.Warn("ai knowledge: save chunk embeddings", "error", err)
		}
	}
	answers, err := s.store.PastAnswersWithoutEmbedding(ctx, hostID, backfillAnswerLimit)
	if err != nil {
		s.log.Warn("ai knowledge: answers to embed", "error", err)
		return
	}
	if len(answers) == 0 {
		return
	}
	texts := make([]string, len(answers))
	for i, a := range answers {
		texts[i] = a.Question
	}
	vecs, err := s.aiEmbed(ctx, hostID, texts)
	if err != nil {
		s.log.Info("ai knowledge: embed past answers later", "answers", len(answers), "error", err)
		return
	}
	if err := s.store.SetPastAnswerEmbeddings(ctx, answers, vecs); err != nil {
		s.log.Warn("ai knowledge: save answer embeddings", "error", err)
	}
}

// retrieveKnowledge is the session's best chunks (and past answers) for a question.
func (s *Server) retrieveKnowledge(ctx context.Context, wb types.Webinar, question string, n, budget int) (retrieval, error) {
	return s.retrieveWith(ctx, wb.ID, question, s.queryVectors(ctx, wb.Host.ID, []string{question})[0], n, budget)
}

/* retrieval is what a search found for a question: the hits a call would be given, and the
 * best vector similarity among them (0 when none came from the vector side), for the Q&A
 * assistant's retrieval evidence (aiwrite.Policy.Retrieved). */
type retrieval struct {
	hits   []store.KnowledgeHit
	topSim float64
}

/* evidence is how well the hits match the question: the best similarity, and the best
 * full-text coverage (knowledge.Coverage) of any of its phrasings by any hit. Phrasings are
 * taken one at a time, so a cluster asked five ways is not diluted by the words of all five. */
func (r retrieval) evidence(phrasings ...string) aiwrite.Evidence {
	e := aiwrite.Evidence{TopSimilarity: r.topSim}
	for _, h := range r.hits {
		for _, q := range phrasings {
			e.TopCoverage = max(e.TopCoverage, knowledge.Coverage(q, h.Text))
		}
	}
	return e
}

/* retrieveWith ranks the session's knowledge for a question both ways and fuses the two;
 * vec nil (or a vector search that fails) is full-text alone. */
func (s *Server) retrieveWith(ctx context.Context, slug, question string, vec []float32, n, budget int) (retrieval, error) {
	q := knowledge.TSQuery(question)
	fts := []store.KnowledgeHit{}
	if q != "" {
		var err error
		if fts, err = s.store.SearchKnowledge(ctx, slug, q, knowledgeSearchLimit); err != nil {
			return retrieval{}, err
		}
	}
	var near []store.KnowledgeHit
	if len(vec) > 0 {
		var err error
		if near, err = s.store.SearchKnowledgeByVector(ctx, slug, vec, knowledgeSearchLimit); err != nil {
			s.log.Warn("ai knowledge: vector search, full-text only", "slug", slug, "error", err)
			near = nil
		}
	}
	out := retrieval{hits: pickKnowledge(fuseHits(fts, near), n, budget)}
	sim := map[string]float64{}
	for _, h := range near { // a vector hit's Rank is its cosine similarity
		sim[h.DocID+"#"+strconv.Itoa(h.Seq)] = h.Rank
	}
	for _, h := range out.hits {
		out.topSim = max(out.topSim, sim[h.DocID+"#"+strconv.Itoa(h.Seq)])
	}
	return out, nil
}

// fuseHits is the hits of several rankings, each once, in reciprocal-rank-fused order.
func fuseHits(lists ...[]store.KnowledgeHit) []store.KnowledgeHit {
	by := map[string]store.KnowledgeHit{}
	keys := make([][]string, len(lists))
	for i, l := range lists {
		for _, h := range l {
			k := h.DocID + "#" + strconv.Itoa(h.Seq)
			if _, ok := by[k]; !ok {
				by[k] = h
			}
			keys[i] = append(keys[i], k)
		}
	}
	out := []store.KnowledgeHit{}
	for _, k := range knowledge.FuseRRF(keys...) {
		out = append(out, by[k])
	}
	return out
}
