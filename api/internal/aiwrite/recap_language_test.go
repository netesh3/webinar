package aiwrite

import (
	"strings"
	"testing"
)

// The recap is told what language the session was captioned in, when it is known.
func TestRecapHeaderNamesTheCaptionsLanguage(t *testing.T) {
	with := RecapInput{Topic: "Tamil class", Language: "Tamil"}
	without := RecapInput{Topic: "Tamil class"}
	if got := sessionHeader(with); !strings.Contains(got, "Spoken language (as captioned): Tamil\n") {
		t.Fatalf("header = %q, want the language line", got)
	}
	if got := sessionHeader(without); strings.Contains(got, "Spoken language") {
		t.Fatalf("header = %q, want no language line", got)
	}
}
