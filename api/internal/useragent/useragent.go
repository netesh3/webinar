/* Package useragent sorts a browser's User-Agent into the three things the audience
 * analytics show: what kind of device, which OS, which browser.
 *
 * Deliberately small. The host wants "how many watched on a phone", not a model number, and
 * a full parser is a dependency plus a regex database that has to be kept fresh. The raw
 * string is never stored (it is close to a fingerprint); only these three words are.
 *
 * What it cannot tell: an iPad on iPadOS 13+ asks for the desktop site by default and sends
 * the Mac's User-Agent, so it is counted as a Mac desktop. Client hints would tell them
 * apart, but only Chromium sends them and Safari is the browser in question. */
package useragent

import "strings"

const (
	ClassPhone   = "phone"
	ClassTablet  = "tablet"
	ClassDesktop = "desktop"
	// ClassBot is anything that is not a person watching: our own mix (headless Chrome),
	// the load-test kit, crawlers, HTTP libraries. Never stored, never counted.
	ClassBot     = "bot"
	ClassUnknown = "unknown"

	OSAndroid  = "Android"
	OSIOS      = "iOS"
	OSIPadOS   = "iPadOS"
	OSMacOS    = "macOS"
	OSWindows  = "Windows"
	OSLinux    = "Linux"
	OSChromeOS = "ChromeOS"

	BrowserChrome  = "Chrome"
	BrowserSafari  = "Safari"
	BrowserFirefox = "Firefox"
	BrowserEdge    = "Edge"
	BrowserSamsung = "Samsung Internet"

	Other = "other"
)

// Device is what one join's User-Agent says.
type Device struct {
	Class   string
	OS      string
	Browser string
}

// Counted reports whether this device belongs in the audience numbers.
func (d Device) Counted() bool { return d.Class != ClassBot && d.Class != ClassUnknown }

var botMarks = []string{
	"headlesschrome", "bot", "crawler", "spider", "slurp", "curl/", "wget/",
	"go-http-client", "python", "node", "undici", "okhttp", "axios", "postman",
	"lighthouse", "pagespeed", "preview",
}

// Parse classifies a User-Agent header.
func Parse(ua string) Device {
	ua = strings.TrimSpace(ua)
	if ua == "" {
		return Device{Class: ClassUnknown, OS: Other, Browser: Other}
	}
	low := strings.ToLower(ua)
	for _, m := range botMarks {
		if strings.Contains(low, m) {
			return Device{Class: ClassBot, OS: Other, Browser: Other}
		}
	}
	has := func(s string) bool { return strings.Contains(ua, s) }

	d := Device{OS: Other, Browser: Other}
	switch {
	case has("Windows"):
		d.OS = OSWindows
	case has("CrOS"):
		d.OS = OSChromeOS
	case has("Android"):
		d.OS = OSAndroid
	case has("iPad"):
		d.OS = OSIPadOS
	case has("iPhone"), has("iPod"):
		d.OS = OSIOS
	case has("Macintosh"), has("Mac OS X"):
		d.OS = OSMacOS
	case has("Linux"), has("X11"):
		d.OS = OSLinux
	}

	switch {
	case d.OS == OSIPadOS, has("Tablet"), d.OS == OSAndroid && !has("Mobile"):
		d.Class = ClassTablet
	case d.OS == OSIOS, has("Mobi"):
		d.Class = ClassPhone
	case d.OS != Other:
		d.Class = ClassDesktop
	default:
		d.Class = ClassUnknown
	}

	// Order matters: Edge, Samsung and the iOS wrappers all also say "Chrome" or "Safari".
	switch {
	case has("SamsungBrowser/"):
		d.Browser = BrowserSamsung
	case has("Edg/"), has("EdgA/"), has("EdgiOS/"):
		d.Browser = BrowserEdge
	case has("Firefox/"), has("FxiOS/"):
		d.Browser = BrowserFirefox
	case has("OPR/"), has("Opera"), has("FBAN"), has("FBAV"), has("Instagram"), has("; wv)"):
		// Opera, and the apps' own web views (Facebook, Instagram, Android WebView): not
		// the browser the person would name.
		d.Browser = Other
	case has("CriOS/"), has("Chrome/"), has("Chromium/"):
		d.Browser = BrowserChrome
	case has("Safari/") && (has("Version/") || d.OS == OSIOS || d.OS == OSIPadOS):
		d.Browser = BrowserSafari
	}
	return d
}
