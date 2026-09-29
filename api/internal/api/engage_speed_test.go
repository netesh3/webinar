package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* Snooze hides a waiting conversation until later, and a new message from them wakes it;
 * hot leads are a view of their own in Messages and a chip in People. */
func TestInboxSnoozeAndHotLeads(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	grantFeature(t, h, meAccount(t, h).ID, types.FeatureWhatsAppCRM)
	connectWhatsApp(t, h)
	wb := autoWebinar(t, h, "Speed")
	thandi := registerWithPhone(t, h, wb.ID, "Thandi", "thandi@example.com", crmContactPhone, true)

	postWebhook(t, h, inboundNow("wamid.S1", crmPhoneDigits, "Thandi", "Is there a replay?"))
	if in := inbox(t, h, types.InboxNeedsReply); in.Counts.NeedsReply != 1 {
		t.Fatalf("needs reply = %+v", in.Counts)
	}

	snooze := func(until string) *http.Response {
		res, _ := h.do(http.MethodPut, "/api/host/crm/contacts/"+thandi.ID+"/snooze", types.CRMSnoozeRequest{Until: until})
		return res
	}
	if res := snooze(time.Now().Add(-time.Hour).Format(time.RFC3339)); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("snooze into the past = %d, want 422", res.StatusCode)
	}
	if res := snooze(time.Now().Add(3 * time.Hour).Format(time.RFC3339)); res.StatusCode != http.StatusNoContent {
		t.Fatalf("snooze = %d", res.StatusCode)
	}
	in := inbox(t, h, types.InboxSnoozed)
	if in.Counts.NeedsReply != 0 || in.Counts.Snoozed != 1 || len(in.Threads) != 1 || in.Threads[0].SnoozedUntil == "" {
		t.Fatalf("after snooze = %+v threads %+v", in.Counts, in.Threads)
	}

	// A new message from them wakes it early.
	time.Sleep(1100 * time.Millisecond)
	postWebhook(t, h, inboundNow("wamid.S2", crmPhoneDigits, "Thandi", "Also, the price?"))
	if in := inbox(t, h, types.InboxNeedsReply); in.Counts.NeedsReply != 1 || in.Counts.Snoozed != 0 {
		t.Errorf("after new message = %+v, want back in needs reply", in.Counts)
	}

	// Wake by hand works too.
	snooze(time.Now().Add(time.Hour).Format(time.RFC3339))
	if res := snooze(""); res.StatusCode != http.StatusNoContent {
		t.Fatalf("wake = %d", res.StatusCode)
	}
	if in := inbox(t, h, types.InboxNeedsReply); in.Counts.NeedsReply != 1 {
		t.Errorf("after wake = %+v", in.Counts)
	}

	// Hot leads: the recipe tags her, and both lists can show just those.
	saveRecipe(t, h, types.RecipeHotLeads, types.CRMRecipeRequest{Active: true, Words: []string{"price"}})
	postWebhook(t, h, inboundNow("wamid.S3", crmPhoneDigits, "Thandi", "what's the price"))
	in = inbox(t, h, types.InboxHotLeads)
	if in.Counts.HotLeads != 1 || len(in.Threads) != 1 || !in.Threads[0].HotLead {
		t.Errorf("hot leads view = %+v %+v", in.Counts, in.Threads)
	}
	res, raw := h.do(http.MethodGet, "/api/host/crm/people?filter="+types.PeopleHotLeads, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("people hot leads: %d %s", res.StatusCode, raw)
	}
	var people types.CRMPeopleResponse
	h.decode(raw, &people)
	if people.Counts.HotLeads != 1 || len(people.People) != 1 || people.People[0].Contact.ID != thandi.ID {
		t.Errorf("people hot leads = %+v", people)
	}
}

// Quick replies: create, list in order, edit, cap, delete.
func TestInboxSnippets(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")

	create := func(title, body string) (int, types.CRMSnippet) {
		res, raw := h.do(http.MethodPost, "/api/host/crm/snippets", types.CRMSnippetRequest{Title: title, Body: body})
		var out types.CRMSnippet
		if res.StatusCode == http.StatusCreated {
			h.decode(raw, &out)
		}
		return res.StatusCode, out
	}
	code, first := create("Replay", "Here's the replay: https://example.com/r")
	if code != http.StatusCreated || first.ID == "" {
		t.Fatalf("create = %d %+v", code, first)
	}
	create("Price", "The program is ₹4,999.")
	if code, _ := create("", "no title"); code != http.StatusUnprocessableEntity {
		t.Errorf("no title = %d", code)
	}

	list := func() []types.CRMSnippet {
		res, raw := h.do(http.MethodGet, "/api/host/crm/snippets", nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("list = %d", res.StatusCode)
		}
		var out types.CRMSnippetsResponse
		h.decode(raw, &out)
		return out.Snippets
	}
	if s := list(); len(s) != 2 || s[0].Title != "Replay" || s[1].Title != "Price" {
		t.Errorf("list = %+v", s)
	}

	res, _ := h.do(http.MethodPut, "/api/host/crm/snippets/"+first.ID, types.CRMSnippetRequest{Title: "Replay link", Body: "Replay: x"})
	if res.StatusCode != http.StatusOK || list()[0].Title != "Replay link" {
		t.Errorf("update = %d %+v", res.StatusCode, list())
	}

	for i := 0; i < 18; i++ {
		create("n", "b")
	}
	if code, _ := create("one more", "b"); code != http.StatusUnprocessableEntity {
		t.Errorf("21st = %d, want 422", code)
	}

	res, _ = h.do(http.MethodDelete, "/api/host/crm/snippets/"+first.ID, nil)
	if res.StatusCode != http.StatusNoContent || len(list()) != 19 {
		t.Errorf("delete = %d, %d left", res.StatusCode, len(list()))
	}

	// Another host sees none of them.
	h.logout()
	h.login("lucia@cabify.com")
	if s := list(); len(s) != 0 {
		t.Errorf("other host sees %d", len(s))
	}
}
