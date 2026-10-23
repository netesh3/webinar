package aiwrite

import (
	"regexp"
	"strings"
)

/* When the Q&A assistant may answer: the one place its thresholds live.
 *
 * The rule is "confident, from the host's own material, or nothing". There is no general
 * answer any more: a question the knowledge does not clearly answer gets no draft text at all
 * (the host's panel says "No confident answer in your knowledge") and stays open. Every path
 * goes through the same gate, in two steps:
 *
 *   1. retrieval   before any call: the best excerpt found for the question must be close
 *                  enough (Policy.Retrieved). Below it there is no call at all, so a question
 *                  the library has nothing for costs nothing.
 *   2. the reply   after the call (Policy.Decide): the model said grounded, with a confidence
 *                  at or over the policy's, citing at least one source it was actually given,
 *                  with a non-empty answer, and every number in the answer appears in what it
 *                  cited (CitedNumbersOK). Anything else is dropped.
 *
 * DraftPolicy is for what a host reviews before it is posted (✨ Suggest an answer, the
 * automatic drafts, the past answers written down from a transcript). AutoPolicy is for a
 * simulive's Auto mode, which posts to the audience with nobody reviewing it, so it is stricter
 * on both steps. */

// Policy is one path's thresholds.
type Policy struct {
	// MinConfidence is the model's own 0–1 confidence an answer needs.
	MinConfidence float64
	// MinSimilarity is the cosine similarity (text-embedding-3-small) the best vector hit needs.
	// Unrelated text sits around 0.1–0.2; store.VectorMinSimilarity (0.3) is the floor below
	// which a neighbour is not even a hit.
	MinSimilarity float64
	// MinCoverage is the share of the question's searchable words (knowledge.Terms) the best
	// full-text hit must contain, for retrieval without embeddings (or when the vector side
	// found nothing close). "What is the fee?" has one searchable word, so a chunk with "fee"
	// covers it fully; "Is every live class recorded?" has four.
	MinCoverage float64
}

var (
	// DraftPolicy gates what the host team reviews before anyone sees it.
	DraftPolicy = Policy{MinConfidence: 0.75, MinSimilarity: 0.35, MinCoverage: 0.34}
	// AutoPolicy gates Auto mode, which posts without review: stricter on every count.
	AutoPolicy = Policy{MinConfidence: 0.85, MinSimilarity: 0.45, MinCoverage: 0.5}
	// HarvestMinConfidence is what a past answer written down from a transcript needs. It is
	// pending until the host approves it, so the draft bar.
	HarvestMinConfidence = DraftPolicy.MinConfidence
)

// Evidence is how well retrieval matched a question: the best vector similarity and the best
// full-text coverage among the excerpts the call would be given (0 when there were none).
type Evidence struct {
	TopSimilarity float64
	TopCoverage   float64
}

// Retrieved is whether the evidence is good enough to ask the model at all.
func (p Policy) Retrieved(e Evidence) bool {
	return e.TopSimilarity >= p.MinSimilarity || e.TopCoverage >= p.MinCoverage
}

// Verdict is what the gate decided for one question, for the log (no question text in it).
type Verdict string

const (
	VerdictAnswered         Verdict = "answered"
	VerdictNoEvidence       Verdict = "no_evidence"       // retrieval below the policy: no call
	VerdictUngrounded       Verdict = "ungrounded"        // the model said the excerpts don't answer it
	VerdictLowConfidence    Verdict = "low_confidence"    // grounded, but under MinConfidence
	VerdictNoSource         Verdict = "no_source"         // no source it was given was cited
	VerdictUnverifiedNumber Verdict = "unverified_number" // a number in the answer is not in what it cited
	VerdictEmpty            Verdict = "empty"             // no answer text (or the reply skipped it)
)

/* Decide is the gate on a parsed answer. excerpts are what the call was given (a.Sources index
 * them); transcript is the recent transcript the call was given, "" when none (a.Transcript
 * says the answer cited it). */
func (p Policy) Decide(a QAAnswer, excerpts []QAExcerpt, transcript string) Verdict {
	if !a.Grounded {
		return VerdictUngrounded
	}
	if strings.TrimSpace(a.Answer) == "" {
		return VerdictEmpty
	}
	var cited []string
	for _, i := range a.Sources {
		if i >= 0 && i < len(excerpts) {
			cited = append(cited, excerpts[i].Text)
		}
	}
	if a.Transcript && strings.TrimSpace(transcript) != "" {
		cited = append(cited, transcript)
	}
	if len(cited) == 0 {
		return VerdictNoSource
	}
	if a.Confidence < p.MinConfidence {
		return VerdictLowConfidence
	}
	if !CitedNumbersOK(a.Answer, cited...) {
		return VerdictUnverifiedNumber
	}
	return VerdictAnswered
}

// numberRE is a number as written: digits, with thousands separators and a decimal part.
var numberRE = regexp.MustCompile(`\d[\d,]*(?:\.\d+)?`)

// numbers is the numbers in s, normalised: "3,000" and "₹3000" are both "3000", "07" is "7".
func numbers(s string) []string {
	var out []string
	for _, m := range numberRE.FindAllString(s, -1) {
		m = strings.TrimRight(strings.ReplaceAll(m, ",", ""), ".")
		if whole, frac, ok := strings.Cut(m, "."); ok {
			m = trimZeros(whole) + "." + frac
		} else {
			m = trimZeros(m)
		}
		out = append(out, m)
	}
	return out
}

func trimZeros(s string) string {
	if t := strings.TrimLeft(s, "0"); t != "" {
		return t
	}
	return "0"
}

/* CitedNumbersOK is whether every number in the answer (prices, dates, durations, counts)
 * appears in one of the sources it cited. A model that rounds, converts or invents a number is
 * rejected outright rather than trusted: a wrong price is worse than no answer. */
func CitedNumbersOK(answer string, sources ...string) bool {
	want := numbers(answer)
	if len(want) == 0 {
		return true
	}
	have := map[string]bool{}
	for _, s := range sources {
		for _, n := range numbers(s) {
			have[n] = true
		}
	}
	for _, n := range want {
		if !have[n] {
			return false
		}
	}
	return true
}
