package engage

import (
	"strings"
	"testing"
)

// The same cases as web/engage/template-name.test.mts.
func TestNormaliseTemplateName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Webinar reminder 1 hour", "webinar_reminder_1_hour"},
		{"  Webinar Reminder  ", "webinar_reminder"},
		{"follow-up - day 2", "follow_up_day_2"},
		{"Already_snake_case", "already_snake_case"},
		{"__Lots___of____underscores__", "lots_of_underscores"},
		{"Café déjà vu", "caf_dj_vu"},
		{"Reminder 🎉 party", "reminder_party"},
		{"नमस्ते", ""},
		{"🎉🎉", ""},
		{"", ""},
		{"   ", ""},
		{"1 hour reminder", "t_1_hour_reminder"},
		{"_1st", "t_1st"},
		{"2024", "t_2024"},
		{"Price: $49 / month!", "price_49_month"},
		{strings.Repeat("a", 80), strings.Repeat("a", 60)},
		// Cut at 60 lands on an underscore, which is trimmed.
		{strings.Repeat("ab ", 30), strings.Repeat("ab_", 19) + "ab"},
		{"9" + strings.Repeat("x", 70), "t_9" + strings.Repeat("x", 57)},
	}
	for _, c := range cases {
		got := normaliseTemplateName(c.in)
		if got != c.want {
			t.Errorf("normaliseTemplateName(%q) = %q, want %q", c.in, got, c.want)
		}
		if len(got) > templateNameMax {
			t.Errorf("normaliseTemplateName(%q) is %d long", c.in, len(got))
		}
		if again := normaliseTemplateName(got); again != got {
			t.Errorf("not idempotent: %q -> %q -> %q", c.in, got, again)
		}
	}
}

func TestNextFreeTemplateName(t *testing.T) {
	taken := map[string]bool{"reminder": true, "reminder_2": true}
	if got := nextFreeTemplateName("reminder", func(n string) bool { return taken[n] }); got != "reminder_3" {
		t.Fatalf("got %q, want reminder_3", got)
	}
	got := nextFreeTemplateName(strings.Repeat("a", 60), func(string) bool { return false })
	if want := strings.Repeat("a", 58) + "_2"; got != want {
		t.Fatalf("long: got %q, want %q", got, want)
	}
}
