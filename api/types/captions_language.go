package types

import "strings"

/* The language a webinar's live captions are in: one per webinar, chosen by the host when
 * scheduling (WebinarOptions.CaptionsLanguage) and changeable in the room
 * (ControlsPatch.CaptionsLanguage). The list lives here, once; the API validates against it,
 * the app config sends it to the web, and the captions worker reads the code from the room's
 * controls.
 *
 * Why one language per webinar: we used to stream to Deepgram with language=multi, its
 * code-switching mode, which only covers English, Spanish, French, German, Hindi, Russian,
 * Portuguese, Japanese, Italian and Dutch. A host speaking Malayalam got Arabic captions
 * (2026-10-27). Deepgram's streaming cannot be limited to a list either, so the host says
 * which language it is. Codes are Deepgram Nova-3's (its docs, 2026-10-27); "multi" is
 * offered only as Hindi + English mixed, which it does well. */

// CaptionLanguage is one entry of the captions language list.
type CaptionLanguage struct {
	// Code is what is stored and what the worker sends Deepgram (en-IN, hi, multi, ...).
	Code string `json:"code"`
	// Label is what the host sees.
	Label string `json:"label"`
	// Live is whether live captions can run in it today. False (Malayalam): the room gets no
	// captions rather than the wrong language, and the select says so.
	Live bool `json:"live"`
}

// DefaultCaptionsLanguage is the language when nothing was chosen: English, Indian accent.
const DefaultCaptionsLanguage = "en-IN"

// CaptionLanguages is every language a host can pick, in the order the select shows them.
var CaptionLanguages = []CaptionLanguage{
	{Code: "en-IN", Label: "English (India)", Live: true},
	{Code: "hi", Label: "Hindi", Live: true},
	{Code: "multi", Label: "Hindi + English (mixed)", Live: true},
	{Code: "ta", Label: "Tamil", Live: true},
	{Code: "te", Label: "Telugu", Live: true},
	{Code: "kn", Label: "Kannada", Live: true},
	{Code: "mr", Label: "Marathi", Live: true},
	{Code: "bn", Label: "Bengali", Live: true},
	{Code: "gu", Label: "Gujarati", Live: true},
	// Not in Deepgram Nova-3 (2026-10-27): pending a second provider.
	{Code: "ml", Label: "Malayalam", Live: false},
}

// CaptionLanguageByCode is the list entry for code, and whether there is one.
func CaptionLanguageByCode(code string) (CaptionLanguage, bool) {
	code = strings.TrimSpace(code)
	for _, l := range CaptionLanguages {
		if l.Code == code {
			return l, true
		}
	}
	return CaptionLanguage{}, false
}

// ValidCaptionLanguage is whether code is on the list.
func ValidCaptionLanguage(code string) bool {
	_, ok := CaptionLanguageByCode(code)
	return ok
}

// CaptionLanguageOrDefault is code when it is on the list, else fallback (itself checked), else
// DefaultCaptionsLanguage. For reading what is stored: rows from before the setting have none.
func CaptionLanguageOrDefault(code, fallback string) string {
	if ValidCaptionLanguage(code) {
		return strings.TrimSpace(code)
	}
	if ValidCaptionLanguage(fallback) {
		return strings.TrimSpace(fallback)
	}
	return DefaultCaptionsLanguage
}
