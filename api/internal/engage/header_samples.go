package engage

import (
	_ "embed"
	"strings"
)

/* Neutral sample files for Meta's review of a media-header template.
 *
 * Meta requires example.header_handle on every IMAGE, VIDEO or DOCUMENT header
 * (developers.facebook.com/docs/whatsapp/business-management-api/message-templates/components)
 * but only reviews it — the file a person receives is chosen at send time. So a coach
 * who has not picked the real file yet submits with one of these instead. They are
 * never stored in the coach's media library, never count toward the quota, and are
 * never the template's default file. */

//go:embed samples/sample.jpg
var sampleImage []byte

//go:embed samples/sample.mp4
var sampleVideo []byte

//go:embed samples/sample.pdf
var sampleDocument []byte

type headerSampleFile struct {
	name string
	mime string
	data []byte
}

func headerSampleFor(format string) (headerSampleFile, bool) {
	switch strings.ToUpper(format) {
	case "IMAGE":
		return headerSampleFile{"sample.jpg", "image/jpeg", sampleImage}, true
	case "VIDEO":
		return headerSampleFile{"sample.mp4", "video/mp4", sampleVideo}, true
	case "DOCUMENT":
		return headerSampleFile{"sample.pdf", "application/pdf", sampleDocument}, true
	}
	return headerSampleFile{}, false
}
