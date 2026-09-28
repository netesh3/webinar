package api

import (
	"fmt"
	"strings"

	"github.com/netkumar/webcast/api/types"
)

/* The host's registration questions and an attendee's answers to them.
 *
 * The three types each constrain the answer differently, and until these rules existed
 * none of it was checked: a "Choose one" could be saved with no options at all — a
 * required one then made the registration form impossible to submit — and any string was
 * accepted as its answer, or as a checkbox's.
 */

const (
	questionShort    = "short"
	questionSelect   = "select"
	questionCheckbox = "checkbox"

	// checkboxYes is what the registration form sends for a ticked box; unticked is "".
	checkboxYes = "yes"

	minQuestionOptions = 2
	maxQuestionOptions = 20
	maxOptionChars     = 200
	maxAnswerChars     = 2000
)

/* normalizeQuestions trims what the host typed and reports the first problem, worded for
 * the host. Options only mean something on a "Choose one", so any a question kept from an
 * earlier type are dropped rather than stored against a checkbox. */
func normalizeQuestions(qs []types.CustomQuestion) ([]types.CustomQuestion, string) {
	out := make([]types.CustomQuestion, 0, len(qs))
	for _, q := range qs {
		q.Label = strings.TrimSpace(q.Label)
		switch q.Type {
		case questionSelect, questionCheckbox:
		default:
			q.Type = questionShort
		}
		if q.Type != questionSelect {
			q.Options = nil
			out = append(out, q)
			continue
		}

		name := q.Label
		if name == "" {
			name = "A “Choose one” question"
		} else {
			name = "“" + name + "”"
		}
		opts := make([]string, 0, len(q.Options))
		seen := map[string]bool{}
		for _, o := range q.Options {
			o = strings.TrimSpace(o)
			if o == "" {
				continue
			}
			if len(o) > maxOptionChars {
				return nil, fmt.Sprintf("Keep each option of %s under %d characters.", name, maxOptionChars)
			}
			key := strings.ToLower(o)
			if seen[key] {
				return nil, fmt.Sprintf("%s lists “%s” twice.", name, o)
			}
			seen[key] = true
			opts = append(opts, o)
		}
		if len(opts) < minQuestionOptions {
			return nil, fmt.Sprintf("%s needs at least %d options to choose from.", name, minQuestionOptions)
		}
		if len(opts) > maxQuestionOptions {
			return nil, fmt.Sprintf("%s can have at most %d options.", name, maxQuestionOptions)
		}
		q.Options = opts
		out = append(out, q)
	}
	return out, ""
}

/* registrationAnswers keeps an answer for each of the webinar's questions and nothing
 * else, trimmed, so what is stored — and exported to the host — is only what was asked. */
func registrationAnswers(in map[string]string, qs []types.CustomQuestion) map[string]string {
	out := map[string]string{}
	for _, q := range qs {
		if a := strings.TrimSpace(in[q.ID]); a != "" {
			out[q.ID] = a
		}
	}
	return out
}

// answerProblem is the field error for one answer, or "" when it is acceptable.
func answerProblem(q types.CustomQuestion, answer string) string {
	if answer == "" {
		if q.Required {
			if q.Type == questionCheckbox {
				return "Tick this to continue."
			}
			return "Required."
		}
		return ""
	}
	switch q.Type {
	case questionSelect:
		for _, o := range q.Options {
			if o == answer {
				return ""
			}
		}
		return "Pick one of the options."
	case questionCheckbox:
		if answer != checkboxYes {
			return "Tick the box or leave it empty."
		}
	default:
		if len(answer) > maxAnswerChars {
			return fmt.Sprintf("Keep your answer under %d characters.", maxAnswerChars)
		}
	}
	return ""
}
