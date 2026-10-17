package streamdest

import (
	"errors"
	"strings"
	"testing"
)

func TestIngestURL(t *testing.T) {
	got, err := IngestURL("abcd-efgh-ijkl-mnop", "")
	if err != nil {
		t.Fatal(err)
	}
	want := DefaultYouTubeIngest + "/abcd-efgh-ijkl-mnop"
	if got != want {
		t.Errorf("key only = %q, want %q", got, want)
	}

	full := "rtmps://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop"
	got, err = IngestURL(full, "")
	if err != nil || got != full {
		t.Errorf("full URL = %q, %v, want itself", got, err)
	}

	got, err = IngestURL("secretkey", "rtmp://rtmp.example.com/live")
	if err != nil || got != "rtmp://rtmp.example.com/live/secretkey" {
		t.Errorf("custom ingest = %q, %v", got, err)
	}

	if _, err := IngestURL("", ""); err != ErrNeedKey {
		t.Errorf("empty key err = %v, want ErrNeedKey", err)
	}
	if _, err := IngestURL("has space", ""); err != ErrNeedKey {
		t.Errorf("spaced key err = %v, want ErrNeedKey", err)
	}
	if _, err := IngestURL("key", "https://example.com"); err != ErrBadIngest {
		t.Errorf("http ingest err = %v, want ErrBadIngest", err)
	}
}

func TestWatchURL(t *testing.T) {
	const id = "dQw4w9WgXcQ"
	want := "https://www.youtube.com/watch?v=" + id

	cases := []string{
		want,
		"https://youtu.be/" + id,
		"https://www.youtube.com/live/" + id,
		"https://youtube.com/watch?v=" + id + "&feature=share",
		"https://studio.youtube.com/video/" + id + "/livestreaming",
		"youtu.be/" + id,
	}
	for _, c := range cases {
		got, err := WatchURL(c)
		if err != nil || got != want {
			t.Errorf("WatchURL(%q) = %q, %v, want %q", c, got, err, want)
		}
	}

	if _, err := WatchURL(""); err != ErrNeedWatch {
		t.Errorf("empty watch err = %v, want ErrNeedWatch", err)
	}
	if _, err := WatchURL("https://vimeo.com/123"); err != ErrBadWatch {
		t.Errorf("vimeo err = %v, want ErrBadWatch", err)
	}
	if _, err := WatchURL("https://www.youtube.com/watch?v=short"); err != ErrBadWatch {
		t.Errorf("short id err = %v, want ErrBadWatch", err)
	}
}

func TestLinkedInIngest(t *testing.T) {
	const base = "rtmps://1a2b3c.channel.media.azure.net:2935/live/abc123"
	cases := []struct {
		url, key, want string
		field          string
	}{
		{base, "LIVEKEY99", base + "/LIVEKEY99", ""},
		{base + "/", " LIVEKEY99 ", base + "/LIVEKEY99", ""},
		{base, "", "", "streamKey"},
		// LinkedIn shows the key on the end of the Stream URL and again as the key.
		{"rtmps://ip-1-2-3-4.live-input-li.bitcod.in/live/081c7950-aaaa", "081c7950-aaaa", "rtmps://ip-1-2-3-4.live-input-li.bitcod.in/live/081c7950-aaaa", ""},
		{"rtmp://live.example.com/app", "k", "rtmp://live.example.com/app/k", ""},
		{"", "k", "", "streamUrl"},
		{"https://linkedin.com/live", "k", "", "streamUrl"},
		{"rtmps://host.example", "", "", "streamKey"},
		{base, "has space", "", "streamKey"},
	}
	for _, c := range cases {
		got, err := LinkedInIngest(c.url, c.key)
		field := ""
		var fe *FieldError
		if errors.As(err, &fe) {
			field = fe.Field
		} else if err != nil {
			field = "?" + err.Error()
		}
		if field != c.field || got != c.want {
			t.Errorf("LinkedInIngest(%q, %q) = %q, %q; want %q, %q", c.url, c.key, got, field, c.want, c.field)
		}
	}
}

func TestHintHidesTheKey(t *testing.T) {
	got := Hint("rtmps://1a2b3c.channel.media.azure.net:2935/live/abc123/SECRETKEY99")
	if got != "1a2b3c.channel.media.azure.net · key ending EY99" {
		t.Errorf("Hint = %q", got)
	}
}

func TestFixDoubledKey(t *testing.T) {
	for in, want := range map[string]string{
		"rtmps://h.example/live/abc-1/abc-1": "rtmps://h.example/live/abc-1",
		"rtmps://h.example/live/abc-1":       "rtmps://h.example/live/abc-1",
		"rtmps://h.example/live2/key":        "rtmps://h.example/live2/key",
	} {
		if got := FixDoubledKey(in); got != want {
			t.Errorf("FixDoubledKey(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRTMPIngestFacebookAndInstagram(t *testing.T) {
	// Facebook and Instagram give a server ending in /rtmp/ and a key with a
	// query string; both have to survive the join untouched.
	got, err := RTMPIngest("Facebook", "rtmps://live-api-s.facebook.com:443/rtmp/", "FB-123-0-AbCd?s_bl=1&s_sc=9&a=Xy")
	if err != nil || got != "rtmps://live-api-s.facebook.com:443/rtmp/FB-123-0-AbCd?s_bl=1&s_sc=9&a=Xy" {
		t.Fatalf("facebook = %q, %v", got, err)
	}
	_, err = RTMPIngest("Instagram", "", "k")
	if err == nil || !strings.Contains(err.Error(), "Instagram") {
		t.Fatalf("instagram message = %v", err)
	}
	if h := Hint(got); h != "live-api-s.facebook.com · key ending AbCd" {
		t.Errorf("hint = %q", h)
	}
}
