package engage

import (
	"testing"

	"github.com/netkumar/webcast/api/types"
)

func fields(ps []types.CRMParam) []string {
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = p.Field
		if p.Field == "" {
			out[i] = "text:" + p.Text
		}
	}
	return out
}

func same(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestGuessParams(t *testing.T) {
	for _, tc := range []struct {
		body string
		n    int
		kind types.NotificationKind
		want []string
	}{
		{"Hi {{1}}, your webinar {{2}} starts {{3}}.", 3, types.NotifyWhatsAppReminder, []string{"first_name", "topic", "starts_in"}},
		{"Hi {{1}}, thanks for joining {{2}} on {{3}}.", 3, "", []string{"first_name", "topic", "when"}},
		{"Hi {{1}}, the recording is here: {{2}}", 2, types.NotifyWhatsAppReplay, []string{"first_name", "replay"}},
		// Off the replay message the replay link has no value, so it is never suggested.
		{"Hi {{1}}, the recording is here: {{2}}", 2, types.NotifyWhatsAppDrip, []string{"first_name", "topic"}},
	} {
		if got := fields(guessParams(tc.body, tc.n, tc.kind)); !same(got, tc.want) {
			t.Errorf("guessParams(%q, %s) = %v, want %v", tc.body, tc.kind, got, tc.want)
		}
	}
}

func TestTemplateDefaultsPerKind(t *testing.T) {
	tmpl := types.CRMTemplate{
		Body: "Hi {{1}}, it starts {{2}}", Variables: 2, DefaultParamsSaved: true,
		DefaultParams: []types.CRMParam{{Text: "friend"}, {Field: "starts_in"}},
	}
	if got := fields(templateDefaults(tmpl, types.NotifyWhatsAppReminder)); !same(got, []string{"text:friend", "starts_in"}) {
		t.Errorf("reminder = %v", got)
	}
	// starts_in has no value on a drip, so that blank falls back to the suggestion.
	if got := fields(templateDefaults(tmpl, types.NotifyWhatsAppDrip)); got[0] != "text:friend" || got[1] == "starts_in" {
		t.Errorf("drip = %v, want starts_in replaced", got)
	}
	// A saved mapping that no longer fits the template is ignored.
	tmpl.Variables = 3
	if got := templateDefaults(tmpl, ""); len(got) != 3 {
		t.Errorf("stale mapping = %v", got)
	}
}

func TestWordingParams(t *testing.T) {
	if got := wordingParams("Hi {{1}}", 1, nil); got != nil {
		t.Errorf("nothing chosen = %v, want no mapping saved", got)
	}
	got := wordingParams("Hi {{1}}, thanks for registering for {{2}} at {{3}}", 3,
		[]types.CRMParam{{Field: "name"}, {}, {Text: "  the  usual time "}})
	if !same(fields(got), []string{"name", "topic", "text:the usual time"}) {
		t.Errorf("wordingParams = %v", fields(got))
	}
	if ex := paramExample(types.CRMParam{Field: "first_name"}); ex != "Thandi" {
		t.Errorf("example = %q", ex)
	}
}
