// Package aiwrite holds the prompts and output shapes of the host-facing AI writing
// features. Each one is a system prompt, a JSON schema the model must answer in, and a
// Parse that turns the validated JSON into the API type, tidied.
package aiwrite

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/types"
)

/* "Write with AI" on the schedule form: one line from the host, a first draft back.
 *
 * The host is usually an Indian coach — fitness, finance, careers, astrology, exam
 * prep — scheduling their own webinar, often on a phone. What they need is copy that
 * sounds like them on a good day: warm, plain and specific about what the attendee
 * will walk away with. What they do not need is the internet's webinar voice
 * ("unlock", "transform your life", "game-changer", "secrets"), which their audience
 * has learnt to scroll past. The prompt says so in as many words, because small
 * models reach for exactly those words when told to "make it engaging".
 *
 * Nothing it writes is saved. The form fills in, and the host edits and saves.
 */

// MaxIdeaRunes bounds the host's one line.
const MaxIdeaRunes = 300

// Languages a draft can be written in. "" is English.
const (
	LangEnglish  = "en"
	LangHinglish = "hinglish"
	LangHindi    = "hi-roman"
)

// ValidLanguage reports whether lang is one of the above (or empty).
func ValidLanguage(lang string) bool {
	switch lang {
	case "", LangEnglish, LangHinglish, LangHindi:
		return true
	}
	return false
}

const setupPrompt = `You write the copy for a webinar that a coach or teacher in India is about to schedule on a webinar platform. They give you one line about it. You give back a first draft they will edit.

Who reads it: the coach's own audience in India — students, working professionals, small-business owners, parents — usually on a phone, often arriving from WhatsApp or Instagram.

How to write:
- Warm, plain and specific. Say who it is for and what they will be able to do or understand afterwards.
- Short sentences. Everyday words. Write the way a good teacher talks to a class.
- No hype. Never use: unlock, transform, game-changer, secret, revolutionary, ultimate, skyrocket, hack, journey, empower, "life-changing", "don't miss out". No ALL CAPS, no exclamation marks in a row.
- Do not invent facts: no prices, dates, times, numbers of attendees, guarantees, results, credentials or testimonials the coach did not give you. If something is unknown, leave it out rather than making it up.
- No hashtags except in the Instagram post (at most 5, at the end). Emojis only in the Instagram and WhatsApp posts, and at most 2 each.
- Plain text only. No markdown, no asterisks, no headings.

What to return (as JSON):
- title: the webinar's name, under 80 characters. Clear before clever.
- description: 2 to 4 short paragraphs for the registration page, separated by a blank line: what it is about, who it is for, what they will take away, and a simple line inviting them to register.
- registrationHeadline: one line, under 100 characters, for the top of the registration page.
- registrationBullets: 3 to 5 short points ("what you will learn"), each under 90 characters, no full stops at the end.
- socialPosts.linkedin: 3 to 5 sentences, professional but friendly, ending with an invitation to register.
- socialPosts.instagram: a caption, 2 to 4 short lines, then up to 5 relevant hashtags.
- socialPosts.whatsapp: a message the coach can forward to their groups: 2 to 4 short lines, friendly, ending with "Register here:" so they can paste their link after it.`

var languageNotes = map[string]string{
	LangEnglish:  "Language: simple Indian English.",
	LangHinglish: "Language: Hinglish — Hindi and English mixed the way people text in India, written entirely in Roman (Latin) script. Never use Devanagari. Keep common English words (webinar, register, session) in English.",
	LangHindi:    "Language: Hindi, written entirely in Roman (Latin) script (for example \"aap is session mein seekhenge\"). Never use Devanagari. Common English words like webinar and register may stay in English.",
}

// SetupSchema is the shape every provider must answer in. Strict-mode compatible:
// every object lists all its properties as required and allows nothing else.
var SetupSchema = ai.NewSchema("webinar_setup", `{
  "type": "object",
  "additionalProperties": false,
  "required": ["title", "description", "registrationHeadline", "registrationBullets", "socialPosts"],
  "properties": {
    "title": {"type": "string"},
    "description": {"type": "string"},
    "registrationHeadline": {"type": "string"},
    "registrationBullets": {"type": "array", "minItems": 3, "maxItems": 5, "items": {"type": "string"}},
    "socialPosts": {
      "type": "object",
      "additionalProperties": false,
      "required": ["linkedin", "instagram", "whatsapp"],
      "properties": {
        "linkedin": {"type": "string"},
        "instagram": {"type": "string"},
        "whatsapp": {"type": "string"}
      }
    }
  }
}`)

// SetupMessages is the conversation for one idea. lang must be ValidLanguage.
func SetupMessages(idea, lang string) []ai.Message {
	if lang == "" {
		lang = LangEnglish
	}
	return []ai.Message{
		{Role: "system", Content: setupPrompt + "\n\n" + languageNotes[lang]},
		// Quoted, so a line that reads like an instruction is still only a topic.
		{Role: "user", Content: "The coach's webinar, in their words: \"" + strings.TrimSpace(idea) + "\""},
	}
}

// ParseSetup turns validated JSON into the API type: trimmed, clipped to what the
// form accepts, and with empty bullets dropped.
func ParseSetup(raw string) (types.AIWebinarSetup, error) {
	var out types.AIWebinarSetup
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return out, err
	}
	out.Title = clip(oneLine(out.Title), 120)
	out.Description = tidyParagraphs(out.Description)
	out.RegistrationHeadline = clip(oneLine(out.RegistrationHeadline), 160)
	bullets := make([]string, 0, len(out.RegistrationBullets))
	for _, b := range out.RegistrationBullets {
		b = strings.TrimSpace(strings.TrimLeft(oneLine(b), "-•* "))
		if b != "" {
			bullets = append(bullets, clip(b, 160))
		}
	}
	out.RegistrationBullets = bullets
	out.SocialPosts.LinkedIn = strings.TrimSpace(out.SocialPosts.LinkedIn)
	out.SocialPosts.Instagram = strings.TrimSpace(out.SocialPosts.Instagram)
	out.SocialPosts.WhatsApp = strings.TrimSpace(out.SocialPosts.WhatsApp)
	return out, nil
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

// tidyParagraphs normalises to paragraphs separated by one blank line.
func tidyParagraphs(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	var paras []string
	for _, p := range strings.Split(s, "\n\n") {
		if p = strings.TrimSpace(p); p != "" {
			paras = append(paras, p)
		}
	}
	return strings.Join(paras, "\n\n")
}

func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(string(r[:n-1])) + "…"
}
