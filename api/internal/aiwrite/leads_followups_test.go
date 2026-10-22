package aiwrite

import (
	"strings"
	"testing"
)

func TestLeadsMessagesAreBoundedAndCarryNoContactDetails(t *testing.T) {
	in := LeadsInput{Topic: "SIP basics"}
	for i := 0; i < 30; i++ {
		l := LeadIn{ID: LeadID(i), FirstName: "Asha", Signals: []string{"watched 58 of 60 min live"}}
		for j := 0; j < 9; j++ {
			l.Questions = append(l.Questions, "What does it cost? "+strings.Repeat("x", 300))
			l.Chat = append(l.Chat, "chat line")
		}
		in.Leads = append(in.Leads, l)
	}
	msgs := LeadsMessages(in)
	user := msgs[1].Content
	if strings.Contains(user, "id 26") || !strings.Contains(user, "id 25") {
		t.Fatal("more than MaxLeads leads in the call")
	}
	if n := strings.Count(user, "Asked: "); n != MaxLeads*MaxLeadQuestions {
		t.Fatalf("%d questions, want %d", n, MaxLeads*MaxLeadQuestions)
	}
	if n := strings.Count(user, "Chat: "); n != MaxLeads*MaxLeadChatLines {
		t.Fatalf("%d chat lines", n)
	}
	if strings.Contains(user, strings.Repeat("x", 250)) {
		t.Fatal("a question was not clipped")
	}
}

func TestParseLeadsKeepsOnlyAskedIDs(t *testing.T) {
	in := LeadsInput{Leads: []LeadIn{{ID: "1"}, {ID: "2"}}}
	got, err := ParseLeads(`{"reasons":[{"id":"1","reason":" \"Asked about pricing twice.\" "},{"id":"1","reason":"again"},{"id":"9","reason":"stranger"},{"id":"2","reason":""}]}`, in)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got["1"] != "Asked about pricing twice." {
		t.Fatalf("reasons = %v", got)
	}
}

func TestFollowupsPromptFollowsTheInput(t *testing.T) {
	in := FollowupsInput{Topic: "Yoga for desk workers", HostName: "Meera", Language: LangHinglish,
		RecapSummary: "Covered three stretches.", KeyPoints: []string{"Neck rolls"},
		Groups: []FollowupGroupIn{{Key: "attended", Count: 3}, {Key: "no_show", Count: 2}}}
	msgs := FollowupsMessages(in)
	if !strings.Contains(msgs[0].Content, "Roman (Latin) script") {
		t.Fatal("Hinglish note missing")
	}
	u := msgs[1].Content
	for _, want := range []string{"Covered three stretches.", "Neck rolls", "no replay", "no offer", "attended:", "no_show:"} {
		if !strings.Contains(u, want) {
			t.Errorf("prompt missing %q:\n%s", want, u)
		}
	}
	if strings.Contains(u, "left_early:") {
		t.Error("a group that was not asked for is in the prompt")
	}
	in.Language, in.HasReplay, in.HasOffer, in.OfferTitle = "", true, true, "1:1 plan"
	msgs = FollowupsMessages(in)
	if !strings.Contains(msgs[0].Content, "simple Indian English") || !strings.Contains(msgs[1].Content, "{{replay_link}}") ||
		!strings.Contains(msgs[1].Content, "\"1:1 plan\"") {
		t.Fatalf("english prompt: %s", msgs[1].Content)
	}
}

func TestParseFollowupsStripsRuledOutPlaceholders(t *testing.T) {
	in := FollowupsInput{Groups: []FollowupGroupIn{{Key: "attended"}, {Key: "no_show"}}}
	raw := `{"drafts":[
	  {"group":"attended","emailSubject":"Thanks","emailBody":"Hi {{first_name}},\n\nReplay: {{replay_link}}","whatsapp":"Hi {{first_name}} {{offer_link}}"},
	  {"group":"attended","emailSubject":"dup","emailBody":"x","whatsapp":"x"},
	  {"group":"hot","emailSubject":"not asked","emailBody":"x","whatsapp":"x"}]}`
	got, err := ParseFollowups(raw, in)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("drafts = %v", got)
	}
	d := got["attended"]
	if d.EmailSubject != "Thanks" || strings.Contains(d.EmailBody, "{{replay_link}}") || strings.Contains(d.WhatsApp, "{{offer_link}}") ||
		!strings.Contains(d.WhatsApp, "{{first_name}}") {
		t.Fatalf("draft = %+v", d)
	}
}

func TestDetectLanguage(t *testing.T) {
	english := "Today we will talk about how to plan your first salary and start a simple SIP every month without stress."
	hinglish := "Dekho, aaj hum baat karenge ki pehli salary ka plan kaise karna hai. Matlab SIP shuru karna bahut simple hai, aap tension mat lo."
	if got := DetectLanguage(english); got != LangEnglish {
		t.Errorf("english → %s", got)
	}
	if got := DetectLanguage(hinglish + " " + hinglish); got != LangHinglish {
		t.Errorf("hinglish → %s", got)
	}
	if got := DetectLanguage("नमस्ते दोस्तों, आज हम बात करेंगे"); got != LangHinglish {
		t.Errorf("devanagari → %s", got)
	}
	if got := DetectLanguage(""); got != LangEnglish {
		t.Errorf("empty → %s", got)
	}
}
