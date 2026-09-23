package api_test

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* Tags: the host's own judgement about somebody, and the three things that act on one.
 *
 * A label on its own would not be worth a migration. What makes it worth having is that
 * something happens when it is applied — a sequence starts, a segment a broadcast can be
 * addressed to grows by one, a bot can apply it mid-conversation without saying anything.
 * So most of this file is not about tags at all; it is about those three, and about the
 * one rule they share: applying a label somebody already has must do nothing.
 *
 * That rule is the reason applyTag exists. Without it a host clicking a chip twice, or a
 * contact walking a flow again, restarts a sequence of paid messages to somebody who has
 * already had them.
 */

func createTag(t *testing.T, h *harness, name string) types.CRMTag {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/crm/tags", types.CRMTagRequest{Name: name})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create tag %q: status %d body %s", name, res.StatusCode, raw)
	}
	var tag types.CRMTag
	h.decode(raw, &tag)
	return tag
}

func tagContact(t *testing.T, h *harness, contactID, tagID string) []types.CRMTag {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/crm/contacts/"+contactID+"/tags",
		types.CRMContactTagRequest{TagID: tagID})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("tag contact: status %d body %s", res.StatusCode, raw)
	}
	var out types.CRMTagsResponse
	h.decode(raw, &out)
	return out.Tags
}

func hostTags(t *testing.T, h *harness) []types.CRMTag {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/crm/tags", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("tags: status %d body %s", res.StatusCode, raw)
	}
	var out types.CRMTagsResponse
	h.decode(raw, &out)
	return out.Tags
}

func tagNames(tags []types.CRMTag) []string {
	out := make([]string, 0, len(tags))
	for _, tag := range tags {
		out = append(out, tag.Name)
	}
	return out
}

// tagsHost is a connected host with the tags switch on, which every test here needs.
func tagsHost(t *testing.T) (*fakeGraph, *harness) {
	t.Helper()
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	grantFeature(t, h, meAccount(t, h).ID, types.FeatureCRMTags)
	return g, h
}

func TestCRMTagsCRUD(t *testing.T) {
	_, h := tagsHost(t)

	vip := createTag(t, h, "  VIP  ")
	if vip.Name != "VIP" {
		t.Errorf("name = %q, want it trimmed", vip.Name)
	}
	if vip.Contacts != 0 {
		t.Errorf("contacts = %d on a new tag", vip.Contacts)
	}

	/* The same name again is the same tag, answered rather than refused.
	 *
	 * A host typing a label they have used before is asking for that label — and what
	 * they want back in both cases is the tag they are about to apply, so a 409 would
	 * only make the browser fetch the list to find the id it was already holding.
	 */
	again := createTag(t, h, "vip")
	if again.ID != vip.ID {
		t.Errorf("a second %q created a new tag %s, want the existing %s", "vip", again.ID, vip.ID)
	}
	if len(hostTags(t, h)) != 1 {
		t.Errorf("tags = %v, want one", tagNames(hostTags(t, h)))
	}

	// Renaming keeps the tag on everybody who has it, so it has to keep its id.
	res, raw := h.do(http.MethodPatch, "/api/host/crm/tags/"+vip.ID,
		types.CRMTagRequest{Name: "Priority"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("rename: status %d body %s", res.StatusCode, raw)
	}
	var renamed types.CRMTag
	h.decode(raw, &renamed)
	if renamed.ID != vip.ID || renamed.Name != "Priority" {
		t.Errorf("renamed = %+v, want the same tag under a new name", renamed)
	}

	// Two labels must not become one by accident: merging is a real operation and not
	// something to perform because two names collided.
	cold := createTag(t, h, "Cold")
	res, raw = h.do(http.MethodPatch, "/api/host/crm/tags/"+cold.ID,
		types.CRMTagRequest{Name: "priority"})
	if res.StatusCode != http.StatusConflict || errorCode(t, raw) != "crm_tag_exists" {
		t.Errorf("colliding rename: status %d code %q, want 409 crm_tag_exists",
			res.StatusCode, errorCode(t, raw))
	}

	for _, name := range []string{"", "   ", strings.Repeat("x", types.TagMaxLength+1)} {
		res, raw := h.do(http.MethodPost, "/api/host/crm/tags", types.CRMTagRequest{Name: name})
		if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "crm_bad_tag" {
			t.Errorf("name %q: status %d code %q, want 422 crm_bad_tag",
				name, res.StatusCode, errorCode(t, raw))
		}
	}

	res, raw = h.do(http.MethodPatch, "/api/host/crm/tags/"+cold.ID+"x",
		types.CRMTagRequest{Name: "Whatever"})
	if res.StatusCode == http.StatusOK {
		t.Errorf("renaming a tag that does not exist succeeded: %s", raw)
	}

	res, raw = h.do(http.MethodDelete, "/api/host/crm/tags/"+cold.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("delete: status %d body %s", res.StatusCode, raw)
	}
	if got := tagNames(hostTags(t, h)); len(got) != 1 || got[0] != "Priority" {
		t.Errorf("tags = %v after deleting one", got)
	}
}

/* The cap, which is a product decision rather than a storage one.
 *
 * A hundred labels is already more than anybody segments by hand, and an account that
 * reaches it is one where something is generating them. Refusing at the endpoint, with
 * the number in the sentence, is how a host finds that out instead of scrolling a picker
 * with four hundred chips in it.
 */
func TestCRMTagsAreCapped(t *testing.T) {
	_, h := tagsHost(t)
	ctx := context.Background()
	me := meAccount(t, h)

	// Through the store: this is about the hundred-and-first, and a hundred HTTP round
	// trips would only slow the suite down to prove the same thing.
	for i := 0; i < types.TagMaxPerHost; i++ {
		if _, err := h.store.CreateTag(ctx, me.ID, fmt.Sprintf("Segment %d", i)); err != nil {
			t.Fatalf("seed tag %d: %v", i, err)
		}
	}
	res, raw := h.do(http.MethodPost, "/api/host/crm/tags", types.CRMTagRequest{Name: "One more"})
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "crm_too_many_tags" {
		t.Fatalf("tag %d: status %d code %q, want 422 crm_too_many_tags",
			types.TagMaxPerHost+1, res.StatusCode, errorCode(t, raw))
	}
	if !strings.Contains(string(raw), fmt.Sprint(types.TagMaxPerHost)) {
		t.Errorf("the refusal does not say what the limit is: %s", raw)
	}
	// An existing name is still accepted at the cap: it creates nothing.
	if tag := createTag(t, h, "Segment 7"); tag.Name != "Segment 7" {
		t.Errorf("tag = %+v", tag)
	}
}

func TestCRMTagsOnAContact(t *testing.T) {
	_, h := tagsHost(t)
	wb := autoWebinar(t, h, "Scaling Postgres")
	thandi := registerOptedIn(t, h, wb.ID)
	sam := registerWithPhone(t, h, wb.ID, "Sam", "sam@example.com", broadcastPhone2, false)

	vip := createTag(t, h, "VIP")
	warm := createTag(t, h, "Warm")

	tags := tagContact(t, h, thandi.ID, vip.ID)
	if got := tagNames(tags); len(got) != 1 || got[0] != "VIP" {
		t.Fatalf("tags = %v after tagging, want VIP", got)
	}
	// Answered with the server's list rather than a status, so the chips on the screen
	// are not the browser's guess at what it just became.
	if got := tagNames(tagContact(t, h, thandi.ID, warm.ID)); len(got) != 2 {
		t.Errorf("tags = %v after a second tag", got)
	}
	// Applying the same label twice is not two labels.
	if got := tagNames(tagContact(t, h, thandi.ID, vip.ID)); len(got) != 2 {
		t.Errorf("tags = %v after re-applying VIP", got)
	}

	// The counts are what the manager screen shows, and they are per tag.
	for _, tag := range hostTags(t, h) {
		if tag.Contacts != 1 {
			t.Errorf("tag %q has %d contacts, want 1", tag.Name, tag.Contacts)
		}
	}

	// Chips travel with the contacts list and with the thread, because both screens
	// show them and neither should need a request per row.
	list := crmContacts(t, h)
	if len(list.Tags) != 2 {
		t.Errorf("the contacts response offers %d tags for the picker, want 2", len(list.Tags))
	}
	for _, c := range list.Contacts {
		want := 0
		if c.ID == thandi.ID {
			want = 2
		}
		if len(c.Tags) != want {
			t.Errorf("contact %s carries tags %v, want %d", c.Email, tagNames(c.Tags), want)
		}
	}
	if got := tagNames(crmThread(t, h, thandi.ID).Contact.Tags); len(got) != 2 {
		t.Errorf("thread tags = %v", got)
	}

	res, raw := h.do(http.MethodDelete,
		"/api/host/crm/contacts/"+thandi.ID+"/tags/"+warm.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("untag: status %d body %s", res.StatusCode, raw)
	}
	var left types.CRMTagsResponse
	h.decode(raw, &left)
	if got := tagNames(left.Tags); len(got) != 1 || got[0] != "VIP" {
		t.Errorf("tags = %v after removing Warm", got)
	}

	// Deleting a tag takes it off everybody, which is the only sane reading of deleting
	// a label — the alternative is chips pointing at a row that is gone.
	if res, raw := h.do(http.MethodDelete, "/api/host/crm/tags/"+vip.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("delete tag: status %d body %s", res.StatusCode, raw)
	}
	if got := tagNames(crmThread(t, h, thandi.ID).Contact.Tags); len(got) != 0 {
		t.Errorf("thread still shows %v after the tag was deleted", got)
	}

	// Neither id is another host's to name, and the refusal does not say which one was
	// wrong: both mean "not yours".
	res, raw = h.do(http.MethodPost, "/api/host/crm/contacts/"+sam.ID+"/tags",
		types.CRMContactTagRequest{TagID: warm.ID + ""})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("tagging Sam with a live tag: status %d body %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodPost, "/api/host/crm/contacts/"+sam.ID+"/tags",
		types.CRMContactTagRequest{TagID: vip.ID})
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("tagging with a deleted tag: status %d, want 404\n  body: %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodPost, "/api/host/crm/contacts/"+sam.ID+"/tags",
		types.CRMContactTagRequest{TagID: ""})
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "crm_no_tag" {
		t.Errorf("tagging with nothing: status %d code %q, want 422 crm_no_tag",
			res.StatusCode, errorCode(t, raw))
	}
}

/* A broadcast addressed to a tag: the only audience a host defines themselves.
 *
 * Worth its own test because the segment is the host's opinion and the consent rules are
 * not: a tag holds whoever the host put in it, and the send still goes only to the ones
 * who opted in and have a number. "Everybody I labelled VIP" is not consent.
 */
func TestCRMBroadcastToATag(t *testing.T) {
	g, h := tagsHost(t)
	wb := autoWebinar(t, h, "Scaling Postgres")
	thandi := registerWithPhone(t, h, wb.ID, "Thandi", "thandi@example.com", crmContactPhone, true)
	ayanda := registerWithPhone(t, h, wb.ID, "Ayanda", "ayanda@example.com", broadcastPhone2, true)
	sam := registerWithPhone(t, h, wb.ID, "Sam", "sam@example.com", broadcastPhone3, false)

	vip := createTag(t, h, "VIP")
	tagContact(t, h, thandi.ID, vip.ID)
	tagContact(t, h, sam.ID, vip.ID) // labelled, never agreed to be messaged
	_ = ayanda                       // opted in, not labelled

	// The preview is the decision: a host is entitled to know the segment is one person
	// before committing to it, and to know why the other one is not in it.
	preview := audiencePreview(t, h, "?audience=tag&tagId="+vip.ID)
	if preview.Recipients != 1 || preview.NoOptIn != 1 {
		t.Errorf("preview = %+v, want one reachable and one without consent", preview)
	}

	b := createBroadcast(t, h, types.CRMBroadcastRequest{
		Name: "VIP early access", Template: testTemplateUtility, Language: "en_US",
		Params: []types.CRMParam{{Field: "name"}}, Audience: types.AudienceTag, TagID: vip.ID,
	})
	if b.Stats.Recipients != 1 || b.TagID != vip.ID || b.TagName != "VIP" {
		t.Fatalf("broadcast = %+v, want one recipient and the segment named", b)
	}

	drainWhatsAppOutbox(t, h, wb.ID)
	sends := g.sent()
	if len(sends) != 1 {
		t.Fatalf("%d sends, want one: %v", len(sends), sends)
	}
	if sends[0]["to"] != crmPhoneDigits {
		t.Errorf("sent to %v, want the opted-in VIP", sends[0]["to"])
	}

	// A renamed tag is the same segment, and the history says what it is called now.
	if res, raw := h.do(http.MethodPatch, "/api/host/crm/tags/"+vip.ID,
		types.CRMTagRequest{Name: "Priority"}); res.StatusCode != http.StatusOK {
		t.Fatalf("rename: status %d body %s", res.StatusCode, raw)
	}
	if got := readBroadcast(t, h, b.ID); got.TagName != "Priority" {
		t.Errorf("tagName = %q after renaming the tag, want the current name", got.TagName)
	}

	// An audience needs a tag that exists, and a tag audience needs one at all.
	res, raw := h.do(http.MethodPost, "/api/host/crm/broadcasts", types.CRMBroadcastRequest{
		Name: "Nobody", Template: testTemplateMarketing, Language: "en_US",
		Audience: types.AudienceTag,
	})
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "crm_no_tag" {
		t.Errorf("tag audience with no tag: status %d code %q, want 422 crm_no_tag",
			res.StatusCode, errorCode(t, raw))
	}
}

/* A sequence that starts when a label is applied.
 *
 * The one trigger that is not about a webinar, and the one where a duplicate would be
 * invisible: nobody sees a tag being applied, so a host who re-labels a contact would
 * restart a sequence of paid messages without any signal that they had.
 */
func TestCRMDripTriggersOnTagAdded(t *testing.T) {
	g, h := tagsHost(t)
	wb := autoWebinar(t, h, "Scaling Postgres")
	thandi := registerOptedIn(t, h, wb.ID)

	vip := createTag(t, h, "VIP")
	other := createTag(t, h, "Cold")

	drip := createDrip(t, h, types.CRMDripRequest{
		Name: "VIP welcome", Trigger: types.DripTagAdded, TagID: vip.ID, Active: true,
		Steps: []types.CRMDripStep{dripStep(0)},
	})

	// The wrong label starts nothing, which is the whole point of naming one.
	tagContact(t, h, thandi.ID, other.ID)
	if n := len(readDrip(t, h, drip.Drip.ID).Enrollments); n != 0 {
		t.Fatalf("%d enrollments after an unrelated tag", n)
	}

	tagContact(t, h, thandi.ID, vip.ID)
	enrollment := onlyEnrollment(t, readDrip(t, h, drip.Drip.ID))
	if enrollment.ContactID != thandi.ID {
		t.Errorf("enrolled %s, want the tagged contact", enrollment.ContactID)
	}

	/* Re-applying does not re-enroll, and this is the assertion the whole applyTag
	 * indirection exists for: the insert is the only thing that can tell "tagged" from
	 * "tagged again", so the enrollment has to hang off it rather than off the request.
	 */
	tagContact(t, h, thandi.ID, vip.ID)
	if n := len(readDrip(t, h, drip.Drip.ID).Enrollments); n != 1 {
		t.Errorf("%d enrollments after re-applying the same tag, want one", n)
	}

	// Removing and re-applying also does not: the sequence has been through.
	if res, _ := h.do(http.MethodDelete,
		"/api/host/crm/contacts/"+thandi.ID+"/tags/"+vip.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatal("untag failed")
	}
	tagContact(t, h, thandi.ID, vip.ID)
	if n := len(readDrip(t, h, drip.Drip.ID).Enrollments); n != 1 {
		t.Errorf("%d enrollments after untagging and tagging again, want one", n)
	}

	runDrips(t, h, wb.ID)
	if n := len(g.sent()); n != 1 {
		t.Fatalf("%d sends, want the one step: %v", n, g.sent())
	}

	/* And the tag cannot be deleted out from under the trigger. An empty trigger tag
	 * means "any tag", so clearing it would widen the rule to every label instead of
	 * breaking it — the host would find out by somebody being messaged.
	 */
	res, raw := h.do(http.MethodDelete, "/api/host/crm/tags/"+vip.ID, nil)
	if res.StatusCode != http.StatusConflict || errorCode(t, raw) != "crm_tag_in_use" {
		t.Fatalf("delete a tag a sequence triggers on: status %d code %q, want 409 crm_tag_in_use",
			res.StatusCode, errorCode(t, raw))
	}
	if !strings.Contains(string(raw), "VIP welcome") {
		t.Errorf("the refusal does not name the sequence: %s", raw)
	}
}

/* A bot step that applies a label, which the person on the other end never sees.
 *
 * Nothing is sent and nothing is written to the thread, on purpose: a label is the
 * host's note about somebody, not something said to them. What it does do is start a
 * tag_added sequence, exactly once, through the same applyTag the inbox uses — a flow
 * that enrolled people the host's own chip did not would be the worst kind of bug here,
 * because both paths look identical from the CRM screen.
 */
func TestCRMBotSetTagStep(t *testing.T) {
	g, h := tagsHost(t)
	wb := autoWebinar(t, h, "Scaling Postgres")
	thandi := registerOptedIn(t, h, wb.ID)

	vip := createTag(t, h, "VIP")
	drip := createDrip(t, h, types.CRMDripRequest{
		Name: "VIP welcome", Trigger: types.DripTagAdded, TagID: vip.ID, Active: true,
		Steps: []types.CRMDripStep{dripStep(0)},
	})

	bot := createBot(t, h, types.CRMBotRequest{
		Name: "Front desk", Trigger: types.BotAnyMessage, Entry: "ask", Active: true,
		Nodes: []types.CRMBotNode{
			botAsk("ask", "Interested in the course?",
				types.CRMBotButton{Label: "Yes", Next: "label"}),
			{Key: "label", Kind: types.BotNodeTag, TagID: vip.ID, Next: "bye"},
			botNode("bye", types.BotNodeMessage, "Great — I'll send you the details.", ""),
		},
	})

	botInbound(t, h, "wamid.IN1", crmPhoneDigits, "Thandi", "hello?")
	before := len(g.sent())
	botPress(t, h, "wamid.IN2", crmPhoneDigits, "Thandi", "label:0", "Yes")

	// One message after the button: the step after the label, and not a word about the
	// label itself.
	if n := len(g.sent()) - before; n != 1 {
		t.Fatalf("%d sends after the button, want only the message that follows the label", n)
	}
	if got := fmt.Sprint(lastSend(t, g)); strings.Contains(got, "VIP") {
		t.Errorf("the label was said out loud to the contact:\n%s", got)
	}

	if got := tagNames(crmThread(t, h, thandi.ID).Contact.Tags); len(got) != 1 || got[0] != "VIP" {
		t.Fatalf("thread tags = %v, want VIP applied by the flow", got)
	}
	for _, m := range crmThread(t, h, thandi.ID).Messages {
		if strings.Contains(m.Body, "VIP") {
			t.Errorf("the label is in the conversation: %+v", m)
		}
	}

	// And the sequence started, once, exactly as if the host had clicked the chip.
	if e := onlyEnrollment(t, readDrip(t, h, drip.Drip.ID)); e.ContactID != thandi.ID {
		t.Errorf("enrolled %s, want the contact the flow tagged", e.ContactID)
	}
	if s := onlySession(t, readBot(t, h, bot.Bot.ID)); s.State != "done" {
		t.Errorf("session state = %q, want the flow to have run to the end", s.State)
	}
}
