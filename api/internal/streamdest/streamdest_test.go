package streamdest

import "testing"

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
		err            error
	}{
		{base, "LIVEKEY99", base + "/LIVEKEY99", nil},
		{base + "/", " LIVEKEY99 ", base + "/LIVEKEY99", nil},
		{base, "", "", ErrLinkedInNeedKey},
		{"rtmp://live.example.com/app", "k", "rtmp://live.example.com/app/k", nil},
		{"", "k", "", ErrLinkedInNeedURL},
		{"https://linkedin.com/live", "k", "", ErrLinkedInNeedURL},
		{"rtmps://host.example", "", "", ErrLinkedInNeedKey},
		{base, "has space", "", ErrLinkedInNeedKey},
	}
	for _, c := range cases {
		got, err := LinkedInIngest(c.url, c.key)
		if err != c.err || got != c.want {
			t.Errorf("LinkedInIngest(%q, %q) = %q, %v; want %q, %v", c.url, c.key, got, err, c.want, c.err)
		}
	}
}

func TestHintHidesTheKey(t *testing.T) {
	got := Hint("rtmps://1a2b3c.channel.media.azure.net:2935/live/abc123/SECRETKEY99")
	if got != "1a2b3c.channel.media.azure.net · key ending EY99" {
		t.Errorf("Hint = %q", got)
	}
}
