package config

import "testing"

func TestMixRecorderURLFor(t *testing.T) {
	c := Config{
		BroadcastRTMPBase: "rtmp://10.0.0.5:1935/live",
		BroadcastHLSBase:  "https://1-2-3-4.sslip.io/live",
		LiveKitProjects: []LiveKitProject{
			{ID: "do-blr", BroadcastHLSBase: "https://5-6-7-8.sslip.io/live"},
			{ID: "pinned", MixRecorderURL: "https://rec.example/mixrec"},
		},
	}
	if got := c.MixRecorderURLFor("do-blr"); got != "" {
		t.Fatalf("without MIXREC_SECRET = %q, want off", got)
	}
	c.MixRecSecret = "x"
	for project, want := range map[string]string{
		"":       "https://1-2-3-4.sslip.io/mixrec",
		"do-blr": "https://5-6-7-8.sslip.io/mixrec",
		"pinned": "https://rec.example/mixrec",
	} {
		if got := c.MixRecorderURLFor(project); got != want {
			t.Errorf("project %q: %q, want %q", project, got, want)
		}
	}
	c.MixRecURL = "http://127.0.0.1:7895"
	if got := c.MixRecorderURLFor("do-blr"); got != "http://127.0.0.1:7895" {
		t.Errorf("MIXREC_URL override: %q", got)
	}
	if got := c.MixRecRTMPURL("my-slug"); got != "rtmp://10.0.0.5:1935/rec/my-slug" {
		t.Errorf("rec RTMP URL = %q", got)
	}
	if got := (Config{}).MixRecRTMPURL("my-slug"); got != "" {
		t.Errorf("no origin: %q, want empty", got)
	}
}
