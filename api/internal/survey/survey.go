// Package survey holds the post-event survey's rules with no I/O: what a host may configure,
// what an attendee may submit, and how responses become the results page. The store loads
// and writes; the handlers translate; everything worth unit-testing is here.
package survey

import (
	"fmt"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/netkumar/webcast/api/types"
)

/* ValidationError names the field a host or attendee got wrong, so the handler can answer
 * with a sentence rather than a constraint name. */
type ValidationError struct {
	Field   string
	Message string
}

func (e *ValidationError) Error() string { return e.Message }

func invalid(field, format string, args ...any) error {
	return &ValidationError{Field: field, Message: fmt.Sprintf(format, args...)}
}

// Config is a validated, normalised SurveyInput.
type Config struct {
	Mode         types.SurveyMode
	Title        string
	ButtonLabel  string
	ExternalURL  string
	AskRating    bool
	SendAt       types.SurveySendAt
	SendAfterMin int
	Questions    []types.SurveyQuestionInput
}

// Defaults the builder shows and the attendee card falls back to when a field is blank.
const (
	DefaultTitle       = "How was the session?"
	DefaultButtonLabel = "Open survey"
)

/* Normalize checks a host's configuration and returns it trimmed and clamped to the limits.
 *
 * Refuses rather than truncating wherever truncating would change meaning — a URL cut at
 * 2,048 characters is a different URL, and a sixth question silently dropped is a question
 * the host thinks they asked. Free text that is merely long (a title) is refused too, so the
 * builder's counter and the server agree about what fits. */
func Normalize(in types.SurveyInput) (Config, error) {
	c := Config{
		Mode:        in.Mode,
		Title:       collapse(in.Title),
		ButtonLabel: collapse(in.ButtonLabel),
		AskRating:   in.AskRating,
		SendAt:      in.SendAt,
	}
	switch c.Mode {
	case types.SurveyBuiltin, types.SurveyLink:
	default:
		return c, invalid("mode", "Choose a rating survey or a survey link.")
	}
	if c.SendAt == "" {
		c.SendAt = types.SurveyOnEnd
	}
	switch c.SendAt {
	case types.SurveyOnEnd, types.SurveyManual:
	case types.SurveyAtMinute:
		if in.SendAfterMin < 1 || in.SendAfterMin > types.MaxSurveySendAfterMin {
			return c, invalid("sendAfterMin", "Pick a minute between 1 and %d.", types.MaxSurveySendAfterMin)
		}
		c.SendAfterMin = in.SendAfterMin
	default:
		return c, invalid("sendAt", "Send the survey yourself, at a set minute, or when the webinar ends.")
	}
	if n := utf8.RuneCountInString(c.Title); n > types.MaxSurveyTitleChars {
		return c, invalid("title", "Keep the title under %d characters.", types.MaxSurveyTitleChars)
	}
	if n := utf8.RuneCountInString(c.ButtonLabel); n > types.MaxSurveyButtonChars {
		return c, invalid("buttonLabel", "Keep the button label under %d characters.", types.MaxSurveyButtonChars)
	}

	if c.Mode == types.SurveyLink {
		u, err := ValidateURL(in.ExternalURL)
		if err != nil {
			return c, err
		}
		c.ExternalURL = u
		// A link survey's questions live on the other site.
		c.Questions = []types.SurveyQuestionInput{}
		return c, nil
	}

	// The built-in survey is the rating; there is nothing to turn off.
	c.AskRating = true
	if len(in.Questions) > types.MaxSurveyQuestions {
		return c, invalid("questions", "A survey can have at most %d extra questions.", types.MaxSurveyQuestions)
	}
	c.Questions = make([]types.SurveyQuestionInput, 0, len(in.Questions))
	seen := map[string]bool{}
	for i, q := range in.Questions {
		field := fmt.Sprintf("questions.%d", i)
		q.Prompt = collapse(q.Prompt)
		q.ID = strings.TrimSpace(q.ID)
		if q.ID != "" {
			if seen[q.ID] {
				return c, invalid(field, "Question %d appears twice.", i+1)
			}
			seen[q.ID] = true
		}
		if q.Prompt == "" {
			return c, invalid(field, "Question %d needs some text.", i+1)
		}
		if utf8.RuneCountInString(q.Prompt) > types.MaxSurveyPromptChars {
			return c, invalid(field, "Question %d is longer than %d characters.", i+1, types.MaxSurveyPromptChars)
		}
		switch q.Kind {
		case types.SurveyRating5, types.SurveyNPS10, types.SurveyText:
			q.Options = []string{}
		case types.SurveySingleChoice:
			opts := make([]string, 0, len(q.Options))
			for _, o := range q.Options {
				if o = collapse(o); o != "" {
					if utf8.RuneCountInString(o) > types.MaxSurveyOptionChars {
						return c, invalid(field, "An option in question %d is longer than %d characters.", i+1, types.MaxSurveyOptionChars)
					}
					opts = append(opts, o)
				}
			}
			if len(opts) < 2 {
				return c, invalid(field, "Question %d needs at least two options.", i+1)
			}
			if len(opts) > types.MaxSurveyOptions {
				return c, invalid(field, "Question %d can have at most %d options.", i+1, types.MaxSurveyOptions)
			}
			q.Options = opts
		default:
			return c, invalid(field, "Question %d has an unknown type.", i+1)
		}
		c.Questions = append(c.Questions, q)
	}
	return c, nil
}

/* ValidateURL accepts an absolute https URL with a host and nothing a browser would treat
 * as something else: no credentials, no whitespace, no control characters. Returned as the
 * parser re-serialised it, so what is stored is what will be opened. */
func ValidateURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", invalid("externalUrl", "Paste the link to your survey.")
	}
	if len(raw) > types.MaxSurveyURLChars {
		return "", invalid("externalUrl", "That link is too long.")
	}
	for _, r := range raw {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return "", invalid("externalUrl", "That link has spaces in it.")
		}
	}
	u, err := url.Parse(raw)
	if err != nil || !u.IsAbs() {
		return "", invalid("externalUrl", "That doesn't look like a web link.")
	}
	if !strings.EqualFold(u.Scheme, "https") {
		return "", invalid("externalUrl", "Use an https:// link.")
	}
	if u.User != nil {
		return "", invalid("externalUrl", "Links with a username or password aren't allowed.")
	}
	host := u.Hostname()
	if host == "" || !strings.Contains(host, ".") {
		return "", invalid("externalUrl", "That link has no website in it.")
	}
	u.Scheme = "https"
	out := u.String()
	if len(out) > types.MaxSurveyURLChars {
		return "", invalid("externalUrl", "That link is too long.")
	}
	return out, nil
}

// collapse trims and folds runs of whitespace (including newlines) to one space.
func collapse(s string) string { return strings.Join(strings.Fields(s), " ") }

// ---------------------------------------------------------------- submissions

// Answer is one validated answer, ready to store.
type Answer struct {
	QuestionID string
	Number     *int
	Text       string
}

/* ValidateSubmission checks an attendee's response against the survey they were shown.
 *
 * Unknown question ids are refused rather than ignored: they mean the attendee's copy is
 * stale (the host edited the survey), and storing half an answer set against a changed
 * survey is worse than asking them to reload. Optional questions may be skipped; a blank
 * text answer counts as skipped. Text is trimmed and must fit MaxSurveyTextAnswerChars. */
func ValidateSubmission(s types.Survey, req types.SurveySubmitRequest) (*int, []Answer, error) {
	var rating *int
	if s.Mode == types.SurveyBuiltin || s.AskRating {
		if req.Rating == nil {
			return nil, nil, invalid("rating", "Pick a rating from 1 to 5 stars.")
		}
		if *req.Rating < 1 || *req.Rating > 5 {
			return nil, nil, invalid("rating", "Ratings go from 1 to 5 stars.")
		}
		v := *req.Rating
		rating = &v
	}
	if s.Mode == types.SurveyLink {
		// Nothing else is asked here; the rest is on the host's own form.
		return rating, []Answer{}, nil
	}

	byID := make(map[string]types.SurveyQuestion, len(s.Questions))
	for _, q := range s.Questions {
		byID[q.ID] = q
	}
	if len(req.Answers) > len(s.Questions) {
		return nil, nil, invalid("answers", "There are more answers than questions.")
	}
	given := map[string]Answer{}
	for _, a := range req.Answers {
		q, ok := byID[a.QuestionID]
		if !ok {
			return nil, nil, invalid("answers", "This survey has changed. Reload to see the latest questions.")
		}
		if _, dup := given[q.ID]; dup {
			return nil, nil, invalid("answers", "A question was answered twice.")
		}
		ans, skipped, err := checkAnswer(q, a)
		if err != nil {
			return nil, nil, err
		}
		if !skipped {
			given[q.ID] = ans
		}
	}
	out := make([]Answer, 0, len(given))
	for _, q := range s.Questions {
		a, ok := given[q.ID]
		if !ok {
			if q.Required {
				return nil, nil, invalid("answers", "Please answer “%s”.", q.Prompt)
			}
			continue
		}
		out = append(out, a)
	}
	return rating, out, nil
}

func checkAnswer(q types.SurveyQuestion, a types.SurveyAnswerInput) (Answer, bool, error) {
	out := Answer{QuestionID: q.ID}
	if q.Kind == types.SurveyText {
		text := strings.TrimSpace(a.Text)
		if text == "" {
			return out, true, nil
		}
		if utf8.RuneCountInString(text) > types.MaxSurveyTextAnswerChars {
			return out, false, invalid("answers", "Keep your answer under %d characters.", types.MaxSurveyTextAnswerChars)
		}
		out.Text = text
		return out, false, nil
	}
	if a.Number == nil {
		return out, true, nil
	}
	lo, hi := Range(q)
	if *a.Number < lo || *a.Number > hi {
		return out, false, invalid("answers", "“%s” needs an answer from %d to %d.", q.Prompt, lo, hi)
	}
	v := *a.Number
	out.Number = &v
	return out, false, nil
}

// Range is the inclusive range of a numeric question's answers.
func Range(q types.SurveyQuestion) (int, int) {
	switch q.Kind {
	case types.SurveyRating5:
		return 1, 5
	case types.SurveyNPS10:
		return 0, 10
	case types.SurveySingleChoice:
		return 0, len(q.Options) - 1
	}
	return 0, -1
}
