package aiwrite

import (
	"strings"
	"testing"
)

func TestSetupMessagesCarryTheLanguage(t *testing.T) {
	for lang, want := range map[string]string{
		"":           "simple Indian English",
		LangEnglish:  "simple Indian English",
		LangHinglish: "Roman (Latin) script",
		LangHindi:    "Hindi, written entirely in Roman",
	} {
		msgs := SetupMessages("  yoga for desk workers ", lang)
		if len(msgs) != 2 || msgs[0].Role != "system" || !strings.Contains(msgs[0].Content, want) {
			t.Errorf("%q: system prompt lacks %q", lang, want)
		}
		if !strings.Contains(msgs[1].Content, `"yoga for desk workers"`) {
			t.Errorf("%q: user message = %q", lang, msgs[1].Content)
		}
	}
	if !strings.Contains(setupPrompt, "No hype") || !strings.Contains(setupPrompt, "Do not invent facts") {
		t.Error("the prompt lost its rules")
	}
}

func TestSchemaAcceptsAFullDraftOnly(t *testing.T) {
	full := `{"title":"t","description":"d","registrationHeadline":"h","registrationBullets":["a","b","c"],` +
		`"socialPosts":{"linkedin":"l","instagram":"i","whatsapp":"w"}}`
	if _, err := SetupSchema.Extract(full); err != nil {
		t.Fatalf("full draft refused: %v", err)
	}
	for _, bad := range []string{
		`{"title":"t"}`,
		strings.Replace(full, `["a","b","c"]`, `["a","b"]`, 1),
		strings.Replace(full, `"whatsapp":"w"`, `"whatsapp":3`, 1),
	} {
		if _, err := SetupSchema.Extract(bad); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}

func TestParseSetupTidies(t *testing.T) {
	out, err := ParseSetup(`{"title":"  A\n title ","description":"one\r\n\r\n\r\ntwo\n\n","registrationHeadline":"h",` +
		`"registrationBullets":["• first","","- second"],"socialPosts":{"linkedin":" l ","instagram":"i","whatsapp":"w"}}`)
	if err != nil {
		t.Fatal(err)
	}
	if out.Title != "A title" || out.Description != "one\n\ntwo" || out.SocialPosts.LinkedIn != "l" {
		t.Fatalf("out = %+v", out)
	}
	if len(out.RegistrationBullets) != 2 || out.RegistrationBullets[0] != "first" || out.RegistrationBullets[1] != "second" {
		t.Fatalf("bullets = %q", out.RegistrationBullets)
	}
	long, _ := ParseSetup(`{"title":"` + strings.Repeat("x", 300) + `"}`)
	if n := len([]rune(long.Title)); n != 120 {
		t.Fatalf("title clipped to %d runes, want 120", n)
	}
}

func TestValidLanguage(t *testing.T) {
	for _, l := range []string{"", "en", "hinglish", "hi-roman"} {
		if !ValidLanguage(l) {
			t.Errorf("%q refused", l)
		}
	}
	if ValidLanguage("hi") || ValidLanguage("fr") {
		t.Error("accepted an unsupported language")
	}
}
