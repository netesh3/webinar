package engage

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/netkumar/webcast/api/internal/wa"
	"github.com/netkumar/webcast/api/types"
)

func TestTemplateParamFollowsMetaRules(t *testing.T) {
	got := TemplateParam("Thanks for coming!\n\nThe replay:\thttps://x.test/r     and more\r\n", 0)
	if strings.ContainsAny(got, "\n\r\t") || strings.Contains(got, "    ") {
		t.Fatalf("param still has a newline, tab or 4 spaces: %q", got)
	}
	if got != "Thanks for coming! The replay: https://x.test/r and more" {
		t.Fatalf("param = %q", got)
	}
	long := TemplateParam(strings.Repeat("word ", 400), 50)
	if n := utf8.RuneCountInString(long); n != 50 || !strings.HasSuffix(long, "…") {
		t.Fatalf("clipped to %d runes: %q", n, long)
	}
}

func TestFollowupTemplateParamsStayWithinTheBody(t *testing.T) {
	p := FollowupTemplateParams("", "", "Hi Priya,\nthank you for your questions today.")
	if p[0] != "there" || p[1] != "the session" {
		t.Fatalf("defaults = %q", p)
	}
	if p[2] != "thank you for your questions today." {
		t.Fatalf("greeting not stripped: %q", p[2])
	}
	p = FollowupTemplateParams("Priya", strings.Repeat("Topic ", 50), strings.Repeat("A long line of text. ", 200))
	body := wa.Render(FollowupTemplateBody, p)
	if n := utf8.RuneCountInString(body); n > whatsappTemplateBodyMax {
		t.Fatalf("rendered body is %d characters", n)
	}
	for _, v := range p {
		if strings.ContainsAny(v, "\n\t") {
			t.Fatalf("variable has a newline or tab: %q", v)
		}
	}
	// A message that is only a greeting keeps it, rather than sending an empty variable.
	if p = FollowupTemplateParams("Priya", "Topic", "Hi Priya!"); p[2] == "" {
		t.Fatalf("empty message variable")
	}
}

func TestFollowupRoute(t *testing.T) {
	cases := []struct {
		name             string
		connected        bool
		status, contact  string
		window, approved bool
		mode, reason     string
	}{
		{"not connected", false, types.CRMStatusOptedIn, "c", true, true, "", types.FollowupReasonNotConnected},
		{"no contact", true, "", "", true, true, "", types.FollowupReasonNoContact},
		{"no number", true, types.CRMStatusNoNumber, "c", true, true, "", types.FollowupReasonNoNumber},
		{"opted out", true, types.CRMStatusOptedOut, "c", true, true, "", types.FollowupReasonOptedOut},
		{"no opt-in, even in the window", true, types.CRMStatusNoOptIn, "c", true, true, "", types.FollowupReasonNoOptIn},
		{"in window: free-form", true, types.CRMStatusOptedIn, "c", true, false, types.FollowupModeFreeform, ""},
		{"outside: template", true, types.CRMStatusOptedIn, "c", false, true, types.FollowupModeTemplate, ""},
		{"outside, template not approved", true, types.CRMStatusOptedIn, "c", false, false, "", types.FollowupReasonTemplate},
	}
	for _, c := range cases {
		mode, reason := followupRoute(c.connected, c.status, c.contact, c.window, c.approved)
		if mode != c.mode || reason != c.reason {
			t.Errorf("%s: got (%q, %q), want (%q, %q)", c.name, mode, reason, c.mode, c.reason)
		}
	}
}

func TestFollowupTemplateIsSubmittable(t *testing.T) {
	tmpl := followupTemplate()
	if tmpl.Category != "MARKETING" || len(tmpl.Examples) != 3 {
		t.Fatalf("template = %+v", tmpl)
	}
	body := strings.TrimSpace(tmpl.Body)
	if strings.HasPrefix(body, "{{") || strings.HasSuffix(body, "}}") {
		t.Fatal("Meta refuses a body that starts or ends with a variable")
	}
	if _, err := bodyExamples(body); err != nil {
		t.Fatalf("body examples: %v", err)
	}
}
