package knowledge

import (
	"math"
	"sort"
)

/* Hybrid retrieval: reciprocal-rank fusion of the full-text ranking and the vector ranking.
 *
 * The two scores are not comparable (ts_rank is unbounded and depends on document length,
 * cosine distance is not), so the fusion uses only each list's ORDER: an item at rank r
 * (from 1) of a list scores 1/(RRFK + r) there, and its scores add up across lists. RRFK
 * = 60 is the constant of Cormack et al. (2009), the usual default: large enough that the
 * first few places of one list do not swamp agreement between both.
 *
 * So a chunk both searches found ranks above one only either found, and a paraphrase full-text
 * search misses entirely ("how much does it cost" for a chunk about "the fee") still comes in
 * from the vector list. */

// RRFK is the fusion's rank constant.
const RRFK = 60

// FuseRRF orders the keys of several best-first rankings by their fused score, best first.
// Ties keep the order of first appearance (the first list's order before the second's).
func FuseRRF(lists ...[]string) []string {
	score := map[string]float64{}
	first := map[string]int{}
	var order []string
	for _, l := range lists {
		for r, k := range l {
			if _, ok := first[k]; !ok {
				first[k] = len(order)
				order = append(order, k)
			}
			score[k] += 1 / float64(RRFK+r+1)
		}
	}
	sort.SliceStable(order, func(i, j int) bool {
		a, b := score[order[i]], score[order[j]]
		if math.Abs(a-b) > 1e-12 {
			return a > b
		}
		return first[order[i]] < first[order[j]]
	})
	return order
}

/* SameQuestion is the repeat test without embeddings: two questions with the same searchable
 * words (Terms), or nearly so (Jaccard ≥ 0.8 over at least three words). With embeddings the
 * store compares vectors instead (cosine similarity ≥ RepeatSimilarity). */
func SameQuestion(a, b string) bool {
	sa, sb := singulars(a), singulars(b)
	if len(sa) == 0 || len(sb) == 0 {
		return false
	}
	inter := 0
	for t := range sb {
		if sa[t] {
			inter++
		}
	}
	union := len(sa) + len(sb) - inter
	if inter == union {
		return true
	}
	return union >= 3 && float64(inter)/float64(union) >= 0.8
}

// RepeatSimilarity is the cosine similarity of two questions' embeddings at which a new answer
// updates an existing entry instead of adding one.
const RepeatSimilarity = 0.9

func singulars(q string) map[string]bool {
	out := map[string]bool{}
	for _, t := range Terms(q) {
		out[singular(t)] = true
	}
	return out
}
