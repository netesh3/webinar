package useragent

import "testing"

func TestParse(t *testing.T) {
	cases := []struct {
		name, ua string
		want     Device
	}{
		{"mac chrome", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
			Device{ClassDesktop, OSMacOS, BrowserChrome}},
		{"mac safari", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.2 Safari/605.1.15",
			Device{ClassDesktop, OSMacOS, BrowserSafari}},
		{"windows edge", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0",
			Device{ClassDesktop, OSWindows, BrowserEdge}},
		{"windows firefox", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
			Device{ClassDesktop, OSWindows, BrowserFirefox}},
		{"linux chrome", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
			Device{ClassDesktop, OSLinux, BrowserChrome}},
		{"chromebook", "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
			Device{ClassDesktop, OSChromeOS, BrowserChrome}},
		{"android chrome", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
			Device{ClassPhone, OSAndroid, BrowserChrome}},
		{"samsung internet", "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36",
			Device{ClassPhone, OSAndroid, BrowserSamsung}},
		{"android tablet", "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
			Device{ClassTablet, OSAndroid, BrowserChrome}},
		{"android webview", "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.0.0 Mobile Safari/537.36",
			Device{ClassPhone, OSAndroid, Other}},
		{"iphone safari", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1",
			Device{ClassPhone, OSIOS, BrowserSafari}},
		{"iphone chrome", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/154.0.0.0 Mobile/15E148 Safari/604.1",
			Device{ClassPhone, OSIOS, BrowserChrome}},
		{"iphone instagram", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0",
			Device{ClassPhone, OSIOS, Other}},
		{"ipad", "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
			Device{ClassTablet, OSIPadOS, BrowserSafari}},
		{"mix headless chrome", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/138.0.0.0 Safari/537.36",
			Device{ClassBot, Other, Other}},
		{"load test node", "node", Device{ClassBot, Other, Other}},
		{"googlebot", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", Device{ClassBot, Other, Other}},
		{"empty", "", Device{ClassUnknown, Other, Other}},
		{"garbage", "something", Device{ClassUnknown, Other, Other}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Parse(c.ua); got != c.want {
				t.Fatalf("Parse(%q) = %+v, want %+v", c.ua, got, c.want)
			}
		})
	}
	if (Device{Class: ClassBot}).Counted() || (Device{Class: ClassUnknown}).Counted() || !(Device{Class: ClassPhone}).Counted() {
		t.Fatal("Counted: only real devices count")
	}
}
