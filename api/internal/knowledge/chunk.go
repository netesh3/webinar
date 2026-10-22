package knowledge

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

/* Chunking: a document is searched, and handed to the model, in pieces of about 400 words.
 * Small enough that five of them fit a ~3k-token budget, big enough that an answer is not
 * cut in half. Consecutive pieces overlap by ChunkOverlap words, so a passage that falls on a
 * boundary is whole in one of them. A piece ends at a sentence or paragraph end between
 * ChunkMinWords and ChunkMaxWords when there is one. */
const (
	ChunkMinWords    = 300
	ChunkTargetWords = 400
	ChunkMaxWords    = 500
	ChunkOverlap     = 50
)

// Chunk is one piece of a document.
type Chunk struct {
	Seq  int
	Text string
	// Tokens is an estimate of the model tokens it costs (EstimateTokens).
	Tokens int
}

type word struct {
	text string
	// end is set when the word ends a sentence or a paragraph: a good place to cut.
	end bool
}

// Split cuts normalised text into overlapping chunks. Text of ChunkMaxWords or fewer is one.
func Split(text string) []Chunk {
	var words []word
	for _, para := range strings.Split(text, "\n") {
		fields := strings.Fields(para)
		for i, f := range fields {
			words = append(words, word{text: f, end: i == len(fields)-1 || sentenceEnd(f)})
		}
	}
	if len(words) == 0 {
		return nil
	}
	var out []Chunk
	for start := 0; ; {
		end := len(words)
		if end-start > ChunkMaxWords {
			end = start + ChunkTargetWords
			for i := start + ChunkMaxWords - 1; i >= start+ChunkMinWords-1; i-- {
				if words[i].end {
					end = i + 1
					break
				}
			}
		}
		parts := make([]string, 0, end-start)
		for _, w := range words[start:end] {
			parts = append(parts, w.text)
		}
		body := strings.Join(parts, " ")
		out = append(out, Chunk{Seq: len(out), Text: body, Tokens: EstimateTokens(body)})
		if end >= len(words) {
			return out
		}
		start = end - ChunkOverlap
	}
}

func sentenceEnd(w string) bool {
	w = strings.TrimRight(w, `"')]»”’`)
	r, _ := utf8.DecodeLastRuneInString(w)
	return r == '.' || r == '?' || r == '!' || r == '।' || r == ':'
}

// EstimateTokens is a model-token estimate: about four characters a token for Latin script,
// and a token a character for anything else (Devanagari tokenises far worse than English).
func EstimateTokens(s string) int {
	latin, other := 0, 0
	for _, r := range s {
		if r < 0x250 || unicode.IsSpace(r) || unicode.IsPunct(r) {
			latin++
		} else {
			other++
		}
	}
	return (latin+3)/4 + other
}
