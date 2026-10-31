package api

import "testing"

func TestCanonicalGoogleOrigin(t *testing.T) {
	const apex = "https://webinarliv.com"
	cases := []struct {
		origin, base, want string
	}{
		{"https://www.webinarliv.com", apex, apex},
		{"https://www.webinarliv.com/", apex, apex},
		{"https://webinarliv.com", apex, "https://webinarliv.com"},
		{"https://webinar-web.example.workers.dev", apex, "https://webinar-web.example.workers.dev"},
		{"http://localhost:3000", "http://localhost:3000", "http://localhost:3000"},
		{"https://www.webinarliv.com", "https://www.webinarliv.com", "https://www.webinarliv.com"},
		{"https://webinarliv.com", "https://www.webinarliv.com", "https://www.webinarliv.com"},
		{"", apex, ""},
	}
	for _, c := range cases {
		if got := canonicalGoogleOrigin(c.origin, c.base); got != c.want {
			t.Errorf("canonicalGoogleOrigin(%q, %q)=%q, want %q", c.origin, c.base, got, c.want)
		}
	}
}
