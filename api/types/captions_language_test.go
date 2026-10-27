package types

import "testing"

func TestCaptionLanguagesDefaultAndCodes(t *testing.T) {
	if DefaultCaptionsLanguage != "en-IN" || !ValidCaptionLanguage(DefaultCaptionsLanguage) {
		t.Fatalf("default = %q, want en-IN on the list", DefaultCaptionsLanguage)
	}
	for _, code := range []string{"en-IN", "hi", "multi", "ta", "te", "kn", "mr", "bn", "gu", "ml"} {
		if !ValidCaptionLanguage(code) {
			t.Errorf("%q not on the list", code)
		}
	}
	for _, code := range []string{"", "en", "ar", "EN-IN", "multi,ml"} {
		if ValidCaptionLanguage(code) {
			t.Errorf("%q accepted, want refused", code)
		}
	}
	// Malayalam is offered but Deepgram has no model for it: it must say so.
	if l, _ := CaptionLanguageByCode("ml"); l.Live {
		t.Fatal("ml is Live, want false until a provider supports it")
	}
	if got := CaptionLanguageOrDefault("", "hi"); got != "hi" {
		t.Fatalf("empty with fallback hi = %q", got)
	}
	if got := CaptionLanguageOrDefault("xx", "yy"); got != "en-IN" {
		t.Fatalf("bad code and bad fallback = %q, want en-IN", got)
	}
}
