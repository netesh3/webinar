package api_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/knowledge"
	"github.com/netkumar/webcast/api/types"
)

/* The AI knowledge (knowledge.go) and the draft answers it grounds (qa_drafts.go), against the
 * fake gpt-5-nano: the library is the host's own, a session can leave documents out, a search
 * ranks the right chunk first, drafts cite the documents they came from or say they did not,
 * automatic drafts are one call per pass and capped, and nothing reaches the audience until a
 * host posts it. */

const courseFAQ = `Course FAQ

The fee for the Money Basics course is 499 rupees, paid once. EMI is available on cards over 3,000 rupees only.

Every live class is recorded and the recording is shared within 24 hours.`

const refundPolicy = `Refund policy

A full refund is given within 7 days of purchase if fewer than two modules were watched. Refunds reach the original payment method in 5 to 7 working days.`

func (h *harness) addKnowledge(title, text string) types.KnowledgeDoc {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/knowledge", types.KnowledgeCreateRequest{Title: title, Text: text})
	if res.StatusCode != http.StatusCreated {
		h.t.Fatalf("add knowledge: %d %s", res.StatusCode, raw)
	}
	var d types.KnowledgeDoc
	h.decode(raw, &d)
	return d
}

func (h *harness) uploadKnowledge(filename, title string, body []byte) (*http.Response, []byte) {
	h.t.Helper()
	q := url.Values{"filename": {filename}}
	if title != "" {
		q.Set("title", title)
	}
	return h.doRaw(http.MethodPost, "/api/host/knowledge/upload?"+q.Encode(), "application/octet-stream", body, nil)
}

func docxBytes(t *testing.T, paragraphs ...string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("word/document.xml")
	if err != nil {
		t.Fatal(err)
	}
	var body strings.Builder
	for _, p := range paragraphs {
		body.WriteString("<w:p><w:r><w:t>" + p + "</w:t></w:r></w:p>")
	}
	_, _ = w.Write([]byte(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		body.String() + `</w:body></w:document>`))
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestKnowledgeLibrary(t *testing.T) {
	h, _ := aiHarness(t, "{}", nil)
	h.signup("KB Host", "kb-host@test.dev", true)

	// Without the ai feature: not for this account.
	if res, raw := h.do(http.MethodGet, "/api/host/knowledge", nil); res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "feature_off" {
		t.Fatalf("without ai: %d %s", res.StatusCode, raw)
	}
	enableAI(t, h, "kb-host@test.dev")

	faq := h.addKnowledge("  Course   FAQ ", courseFAQ)
	if faq.Title != "Course FAQ" || faq.Source != knowledge.SourceText || faq.Words != knowledge.Words(courseFAQ) || faq.Chunks != 1 || !strings.HasPrefix(faq.Preview, "Course FAQ") {
		t.Fatalf("pasted doc = %+v", faq)
	}
	res, raw := h.uploadKnowledge(`C:\docs\Refunds.docx`, "", docxBytes(t, "Refund policy", "Full refund within 7 days."))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("docx upload: %d %s", res.StatusCode, raw)
	}
	var docx types.KnowledgeDoc
	h.decode(raw, &docx)
	if docx.Title != "Refunds" || docx.Source != knowledge.SourceDOCX || docx.Filename != "Refunds.docx" || docx.Bytes == 0 || docx.Words != 7 {
		t.Fatalf("docx doc = %+v", docx)
	}
	if res, raw := h.uploadKnowledge("notes.md", "Notes", []byte("# Batches\n\nWeekend batch starts Saturday.")); res.StatusCode != http.StatusCreated {
		t.Fatalf("md upload: %d %s", res.StatusCode, raw)
	}

	// Refusals.
	for _, c := range []struct {
		name, file string
		body       []byte
		status     int
		code       string
	}{
		{"pptx", "deck.pptx", []byte("PK.."), http.StatusUnsupportedMediaType, "unsupported"},
		{"empty", "a.txt", nil, http.StatusBadRequest, "empty"},
		{"fake pdf", "a.pdf", []byte("not a pdf"), http.StatusUnprocessableEntity, "unreadable"},
		{"blank", "a.txt", []byte("   \n\n "), http.StatusUnprocessableEntity, "no_text"},
		{"huge", "a.txt", bytes.Repeat([]byte("a "), types.KnowledgeMaxUploadBytes/2+1), http.StatusRequestEntityTooLarge, "too_large"},
	} {
		if res, raw := h.uploadKnowledge(c.file, "", c.body); res.StatusCode != c.status || errorCode(t, raw) != c.code {
			t.Errorf("%s: %d %s", c.name, res.StatusCode, raw)
		}
	}
	long := strings.Repeat("word ", types.KnowledgeMaxDocWords+1)
	if res, raw := h.do(http.MethodPost, "/api/host/knowledge", types.KnowledgeCreateRequest{Title: "Long", Text: long}); res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "too_long" {
		t.Fatalf("too long: %d %s", res.StatusCode, raw)
	}
	if res, _ := h.do(http.MethodPost, "/api/host/knowledge", types.KnowledgeCreateRequest{Title: "", Text: ""}); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("no title or text: %d", res.StatusCode)
	}

	res, raw = h.do(http.MethodGet, "/api/host/knowledge", nil)
	var lib types.KnowledgeLibrary
	h.decode(raw, &lib)
	if res.StatusCode != http.StatusOK || len(lib.Docs) != 3 || lib.Docs[2].ID != faq.ID || lib.Limits.MaxDocs != types.KnowledgeMaxDocs {
		t.Fatalf("library = %d %+v", res.StatusCode, lib)
	}
	if lib.UsedWords != faq.Words+docx.Words+lib.Docs[0].Words {
		t.Fatalf("used words = %d", lib.UsedWords)
	}

	res, raw = h.do(http.MethodGet, "/api/host/knowledge/"+faq.ID, nil)
	var detail types.KnowledgeDocDetail
	h.decode(raw, &detail)
	if res.StatusCode != http.StatusOK || !strings.Contains(detail.Text, "499 rupees") || detail.Truncated {
		t.Fatalf("detail = %d %+v", res.StatusCode, detail)
	}
	if res, raw := h.do(http.MethodPatch, "/api/host/knowledge/"+faq.ID, types.KnowledgeRenameRequest{Title: "Money Basics FAQ"}); res.StatusCode != http.StatusOK || !strings.Contains(string(raw), "Money Basics FAQ") {
		t.Fatalf("rename: %d %s", res.StatusCode, raw)
	}

	// Another host: none of it exists for them.
	h.signup("KB Other", "kb-other@test.dev", true)
	enableAI(t, h, "kb-other@test.dev")
	_, raw = h.do(http.MethodGet, "/api/host/knowledge", nil)
	h.decode(raw, &lib)
	if len(lib.Docs) != 0 {
		t.Fatalf("another host sees %+v", lib.Docs)
	}
	for _, m := range []string{http.MethodGet, http.MethodDelete} {
		if res, _ := h.do(m, "/api/host/knowledge/"+faq.ID, nil); res.StatusCode != http.StatusNotFound {
			t.Fatalf("another host %s: %d", m, res.StatusCode)
		}
	}
	if res, _ := h.do(http.MethodPatch, "/api/host/knowledge/"+faq.ID, types.KnowledgeRenameRequest{Title: "Mine"}); res.StatusCode != http.StatusNotFound {
		t.Fatalf("another host rename: %d", res.StatusCode)
	}
	if res, _ := h.do(http.MethodGet, "/api/host/knowledge/not-a-uuid", nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("bad id: %d", res.StatusCode)
	}
	h.logout()
	if res, _ := h.do(http.MethodGet, "/api/host/knowledge", nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("signed out: %d", res.StatusCode)
	}

	h.login("kb-host@test.dev")
	if res, _ := h.do(http.MethodDelete, "/api/host/knowledge/"+faq.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("delete: %d", res.StatusCode)
	}
	if res, _ := h.do(http.MethodGet, "/api/host/knowledge/"+faq.ID, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("deleted doc: %d", res.StatusCode)
	}
}

func TestKnowledgeRetrievalRanksAndHonoursTheSessionPick(t *testing.T) {
	h, _ := aiHarness(t, "{}", nil)
	ctx := context.Background()
	h.signup("KB Rank", "kb-rank@test.dev", true)
	enableAI(t, h, "kb-rank@test.dev")
	faq := h.addKnowledge("Course FAQ", courseFAQ)
	h.addKnowledge("Refund policy", refundPolicy)
	h.addKnowledge("Hinglish notes", "Recording milegi? Haan, har class ki recording 24 ghante mein mil jayegi.")
	wb := h.liveWebinar("Money basics", nil)

	search := func(q string) []string {
		t.Helper()
		hits, err := h.store.SearchKnowledge(ctx, wb.ID, knowledge.TSQuery(q), 10)
		if err != nil {
			t.Fatal(err)
		}
		var titles []string
		for _, hit := range hits {
			titles = append(titles, hit.Title)
		}
		return titles
	}
	if got := search("What is the fee for the course?"); len(got) == 0 || got[0] != "Course FAQ" {
		t.Fatalf("fee → %v", got)
	}
	if got := search("How do refunds work?"); len(got) == 0 || got[0] != "Refund policy" {
		t.Fatalf("refunds → %v", got)
	}
	if got := search("recording kab milegi"); len(got) == 0 || got[0] != "Hinglish notes" {
		t.Fatalf("hinglish → %v", got)
	}
	if got := search("Is there a certificate?"); len(got) != 0 {
		t.Fatalf("certificate → %v", got)
	}

	// Another host's library, however well it matches, is not this session's.
	h.signup("KB Rival", "kb-rival@test.dev", true)
	enableAI(t, h, "kb-rival@test.dev")
	h.addKnowledge("Rival fees", "fee fee fee course course course fee")
	if got := search("What is the fee for the course?"); strings.Contains(strings.Join(got, ","), "Rival") {
		t.Fatalf("another host's doc found: %v", got)
	}
	// Nor can the rival read or change the session's pick.
	if res, _ := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/knowledge", nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("rival reads the pick: %d", res.StatusCode)
	}

	h.login("kb-rank@test.dev")
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/knowledge", nil)
	var pick types.SessionKnowledge
	h.decode(raw, &pick)
	if res.StatusCode != http.StatusOK || len(pick.Docs) != 3 {
		t.Fatalf("pick = %d %+v", res.StatusCode, pick)
	}
	for _, d := range pick.Docs {
		if !d.Included {
			t.Fatalf("%s is not on by default", d.Title)
		}
	}
	// Untick the FAQ for this session: the fee question now finds no FAQ.
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/knowledge/"+faq.ID, types.SessionKnowledgePatch{Included: false})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("untick: %d %s", res.StatusCode, raw)
	}
	h.decode(raw, &pick)
	for _, d := range pick.Docs {
		if d.Included != (d.ID != faq.ID) {
			t.Fatalf("after untick: %+v", pick.Docs)
		}
	}
	if got := search("What is the fee for the course?"); strings.Contains(strings.Join(got, ","), "Course FAQ") {
		t.Fatalf("an excluded doc was found: %v", got)
	}
	// Another session of the same host still has it.
	other := h.liveWebinar("Money basics, again", nil)
	hits, err := h.store.SearchKnowledge(ctx, other.ID, knowledge.TSQuery("fee"), 10)
	if err != nil || len(hits) == 0 || hits[0].DocID != faq.ID {
		t.Fatalf("other session: %v %v", hits, err)
	}
	// Ticked back on.
	if res, _ := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/knowledge/"+faq.ID, types.SessionKnowledgePatch{Included: true}); res.StatusCode != http.StatusOK {
		t.Fatalf("tick: %d", res.StatusCode)
	}
	if got := search("fee"); len(got) == 0 || got[0] != "Course FAQ" {
		t.Fatalf("after tick: %v", got)
	}
	// A doc that is not the host's cannot be picked.
	if res, _ := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/knowledge/00000000-0000-0000-0000-000000000000", types.SessionKnowledgePatch{Included: false}); res.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown doc: %d", res.StatusCode)
	}
}

func (h *harness) qaDraftOf(slug, clusterID string) *types.QADraft {
	h.t.Helper()
	for _, c := range h.qaClusters(slug).Clusters {
		if c.ID == clusterID {
			return c.Draft
		}
	}
	h.t.Fatalf("no cluster %s", clusterID)
	return nil
}

func TestQADraftGroundedPostedOnlyOnPost(t *testing.T) {
	h, model, wb, g := qaSetup(t, feeClusters, nil)
	h.addKnowledge("Course FAQ", courseFAQ)
	h.ask(wb.ID, g[0], "q-fee-0001", "Fees kitni hai?")
	h.ask(wb.ID, g[1], "q-fee-0002", "What does the course cost?")
	h.ask(wb.ID, g[2], "q-rec-0001", "Will I get the recording?")
	var cluster types.QACluster
	for _, c := range h.qaClusters(wb.ID).Clusters {
		if len(c.QuestionIDs) == 2 {
			cluster = c
		}
	}
	if cluster.ID == "" {
		t.Fatal("no fee cluster")
	}

	// Grounded: the FAQ chunk is in the prompt as k1, and the draft cites it by title.
	model.bySchema = map[string]string{"qa_answer": `{"answer":"Course ki fee 499 rupees hai, ek baar. EMI sirf 3,000 se upar ke card payments par.","grounded":true,"confidence":0.9,"sources":["k1","k9"],"missing":""}`}
	path := "/api/host/webinars/" + wb.ID + "/qa/clusters/" + cluster.ID + "/suggest"
	res, raw := h.do(http.MethodPost, path, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("suggest: %d %s", res.StatusCode, raw)
	}
	var out types.QASuggestResponse
	h.decode(raw, &out)
	if !out.Draft.Grounded || strings.Join(out.Draft.Sources, ",") != "Course FAQ" || strings.HasPrefix(out.Answer, "Not in your knowledge") {
		t.Fatalf("grounded draft = %+v", out.Draft)
	}
	p := model.userPrompt(model.callCount() - 1)
	if !strings.Contains(p, `[k1] From "Course FAQ"`) || !strings.Contains(p, "499 rupees") || strings.Contains(p, "[k2]") {
		t.Fatalf("suggest prompt = %s", p)
	}
	if d := h.qaDraftOf(wb.ID, cluster.ID); d == nil || d.ID != out.Draft.ID {
		t.Fatalf("the draft is not on the cluster: %+v", d)
	}

	// Not answered by the knowledge, not confident, or a number the excerpt does not have: no
	// draft text at all, nothing saved, and the question stays open. Never a general answer.
	recPath := "/api/host/webinars/" + wb.ID + "/qa/clusters/q_q-rec-0001/suggest"
	for name, reply := range map[string]string{
		"ungrounded":     `{"answer":"Most courses share recordings; check with the host.","grounded":false,"confidence":0.4,"sources":["k1"],"missing":"recording policy"}`,
		"low confidence": `{"answer":"Every live class is recorded.","grounded":true,"confidence":0.6,"sources":["k1"],"missing":""}`,
		"invented hours": `{"answer":"The recording is shared within 48 hours.","grounded":true,"confidence":0.95,"sources":["k1"],"missing":""}`,
	} {
		model.bySchema = map[string]string{"qa_answer": reply}
		calls := model.callCount()
		res, raw = h.do(http.MethodPost, recPath, nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("%s: %d %s", name, res.StatusCode, raw)
		}
		var none types.QASuggestResponse
		h.decode(raw, &none)
		if !none.NoConfidentAnswer || none.Draft != nil || none.Answer != "" || model.callCount() != calls+1 {
			t.Fatalf("%s: %s", name, raw)
		}
		for _, c := range h.qaClusters(wb.ID).Clusters {
			if c.Draft != nil && c.ID != cluster.ID {
				t.Fatalf("%s: a draft was saved: %+v", name, c.Draft)
			}
		}
	}
	// Nothing in the knowledge close enough, and no transcript: no call at all.
	h.ask(wb.ID, g[1], "q-cert-001", "Certificate milega?")
	calls := model.callCount()
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/qa/clusters/q_q-cert-001/suggest", nil)
	var noHit types.QASuggestResponse
	h.decode(raw, &noHit)
	if res.StatusCode != http.StatusOK || !noHit.NoConfidentAnswer || model.callCount() != calls {
		t.Fatalf("no hit: %d %s, calls %d → %d", res.StatusCode, raw, calls, model.callCount())
	}
	// Covered: a draft, for the discard below.
	model.bySchema = map[string]string{"qa_answer": `{"answer":"Every live class is recorded and shared within 24 hours.","grounded":true,"confidence":0.9,"sources":["k1"],"missing":""}`}
	res, raw = h.do(http.MethodPost, recPath, nil)
	var general types.QASuggestResponse
	h.decode(raw, &general)
	if res.StatusCode != http.StatusOK || general.Draft == nil || !general.Draft.Grounded {
		t.Fatalf("recording draft: %d %s", res.StatusCode, raw)
	}

	// Before Post, the audience sees no answer, and cannot reach the drafts.
	for _, q := range h.questionsAsGuest(wb.ID, g[0].JoinKey).Questions {
		if q.Answered || q.Answer != "" {
			t.Fatalf("answered before Post: %+v", q)
		}
	}
	h.rooms.mu.Lock()
	before := len(h.rooms.sent)
	for _, pk := range h.rooms.sent {
		if strings.Contains(string(pk.data), "499 rupees") {
			t.Errorf("a draft went to the room: %s to %v", pk.data, pk.to)
		}
	}
	h.rooms.mu.Unlock()

	// Another host cannot post or discard it.
	h.signup("Draft Rival", "draft-rival@test.dev", true)
	post := "/api/host/webinars/" + wb.ID + "/qa/drafts/" + out.Draft.ID + "/post"
	if res, _ := h.do(http.MethodPost, post, types.QAPostDraftRequest{Answer: "x"}); res.StatusCode != http.StatusNotFound {
		t.Fatalf("rival post: %d", res.StatusCode)
	}
	if res, _ := h.do(http.MethodDelete, "/api/host/webinars/"+wb.ID+"/qa/drafts/"+out.Draft.ID, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("rival discard: %d", res.StatusCode)
	}
	h.logout()
	if res, _ := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/qa/clusters", nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("attendee reads drafts: %d", res.StatusCode)
	}

	// The host posts it, edited: the host's answer on both questions, told to the room.
	h.login("qa-host-" + strings.ToLower(t.Name()) + "@test.dev")
	if res, raw := h.do(http.MethodPost, post, types.QAPostDraftRequest{Answer: "   "}); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("empty post: %d %s", res.StatusCode, raw)
	}
	edited := "The course is 499 rupees, paid once. EMI is on cards over 3,000 rupees."
	res, raw = h.do(http.MethodPost, post, types.QAPostDraftRequest{Answer: edited})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("post: %d %s", res.StatusCode, raw)
	}
	var posted types.QAPostDraftResponse
	h.decode(raw, &posted)
	if strings.Join(posted.QuestionIDs, ",") != "q-fee-0001,q-fee-0002" || posted.Answer != edited {
		t.Fatalf("posted = %+v", posted)
	}
	answers := map[string]string{}
	for _, q := range h.questionsAsGuest(wb.ID, g[2].JoinKey).Questions {
		if q.Answered {
			answers[q.ID] = q.Answer
		}
	}
	if len(answers) != 2 || answers["q-fee-0001"] != edited || answers["q-fee-0002"] != edited {
		t.Fatalf("the audience sees %v", answers)
	}
	h.rooms.mu.Lock()
	qmods := 0
	for _, pk := range h.rooms.sent[before:] {
		var m map[string]any
		if json.Unmarshal(pk.data, &m) == nil && m["kind"] == "qmod" {
			qmods++
			if pk.to != nil || m["answer"] != edited || m["answered"] != true {
				t.Errorf("qmod = %s to %v", pk.data, pk.to)
			}
		}
	}
	h.rooms.mu.Unlock()
	if qmods != 2 {
		t.Fatalf("qmod packets = %d, want 2", qmods)
	}
	if d := h.qaDraftOf(wb.ID, cluster.ID); d != nil {
		t.Fatalf("a posted draft is still shown: %+v", d)
	}
	if res, _ := h.do(http.MethodPost, post, types.QAPostDraftRequest{Answer: edited}); res.StatusCode != http.StatusNotFound {
		t.Fatalf("posted twice: %d", res.StatusCode)
	}

	// Discard: gone, nothing posted.
	if res, _ := h.do(http.MethodDelete, "/api/host/webinars/"+wb.ID+"/qa/drafts/"+general.Draft.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("discard: %d", res.StatusCode)
	}
	for _, q := range h.questionsAsGuest(wb.ID, g[2].JoinKey).Questions {
		if q.ID == "q-rec-0001" && q.Answered {
			t.Fatal("a discarded draft was posted")
		}
	}

	// The session ends: the answer as posted (the host's edit, not the draft) becomes one past
	// answer for the cluster; the discarded draft's question has no typed answer and is not one.
	h.endSession(wb.ID)
	past := h.pastAnswers()
	if len(past.Answers) != 1 || past.Answers[0].Answer != edited || past.Answers[0].Question != cluster.Canonical {
		t.Fatalf("past answers = %+v", past.Answers)
	}
}

func TestQAAutoDraftsBatchedCappedAndOnlyWithHits(t *testing.T) {
	t.Cleanup(api.SetQAAutoDraftCap(2))
	h, model, wb, g := qaSetup(t, feeClusters, nil)
	h.addKnowledge("Course FAQ", courseFAQ)
	h.addKnowledge("Refund policy", refundPolicy)
	model.bySchema = map[string]string{
		"qa_clusters": `{"groups":[{"existing":"","canonical":"","questions":["n1"]},{"existing":"","canonical":"","questions":["n2"]},{"existing":"","canonical":"","questions":["n3"]}]}`,
		"qa_drafts":   `{"answers":[{"question":"n1","answer":"The fee is 499 rupees, paid once.","grounded":true,"confidence":0.9,"sources":["k1"],"missing":""},{"question":"n2","answer":"A full refund is given within 7 days.","grounded":true,"confidence":0.9,"sources":["k2","k7"],"missing":""},{"question":"n2","answer":"dup","grounded":false,"confidence":0,"sources":[],"missing":""}]}`,
	}

	// Three questions make one pass: one grouping call and ONE drafting call, for the two that
	// the knowledge covers. The certificate question has no hits and gets no draft.
	h.ask(wb.ID, g[0], "q-fee-0001", "What is the fee?")
	h.ask(wb.ID, g[1], "q-cert-001", "Do we get a certificate?")
	h.ask(wb.ID, g[2], "q-ref-0001", "How do refunds work?")
	if n := model.callCount(); n != 2 {
		t.Fatalf("calls after one pass = %d, want 2 (group + one batched draft)", n)
	}
	p := model.userPrompt(1)
	if !strings.Contains(p, "n1: What is the fee?") || !strings.Contains(p, "n2: How do refunds work?") || strings.Contains(p, "certificate") || strings.Contains(p, "n3:") {
		t.Fatalf("draft prompt = %s", p)
	}
	drafts := map[string]*types.QADraft{}
	for _, c := range h.qaClusters(wb.ID).Clusters {
		if c.Draft != nil {
			drafts[c.Canonical] = c.Draft
		}
	}
	fee, ref := drafts["What is the fee?"], drafts["How do refunds work?"]
	if len(drafts) != 2 || fee == nil || ref == nil || !fee.Auto || strings.Join(fee.Sources, ",") != "Course FAQ" ||
		strings.Join(ref.Sources, ",") != "Refund policy" || ref.Answer != "A full refund is given within 7 days." {
		t.Fatalf("auto drafts = %+v", drafts)
	}
	// Drafted, not posted.
	for _, q := range h.questionsAsGuest(wb.ID, g[0].JoinKey).Questions {
		if q.Answered {
			t.Fatalf("an automatic draft was posted: %+v", q)
		}
	}
	st := h.adminAI()
	found := false
	for _, f := range st.Month.Features {
		if f.Feature == types.AIFeatureQAAutoDraft && f.Calls == 1 {
			found = true
		}
	}
	if !found {
		t.Fatalf("ai usage = %+v, want one qa_autodraft call", st.Month.Features)
	}

	// The session's cap (2 here) is spent: the next pass groups, and drafts nothing.
	h.ask(wb.ID, g[0], "q-emi-0001", "Is EMI available on the fee?")
	h.ask(wb.ID, g[1], "q-rec-0001", "Is every class recorded?")
	h.ask(wb.ID, g[2], "q-ref-0002", "Refund in how many days?")
	if n := model.callCount(); n != 3 {
		t.Fatalf("calls after the cap = %d, want 3 (one more grouping call only)", n)
	}
}

func TestQAKnowledgeGatedOff(t *testing.T) {
	h, model, wb, g := qaSetup(t, feeClusters, nil)
	h.addKnowledge("Course FAQ", courseFAQ)
	model.bySchema = map[string]string{"qa_clusters": `{"groups":[{"existing":"","canonical":"","questions":["n1","n2","n3"]}]}`}
	if res, raw := h.patchAI(wb.ID, false); res.StatusCode != http.StatusOK {
		t.Fatalf("AI off: %d %s", res.StatusCode, raw)
	}
	h.ask(wb.ID, g[0], "q-fee-0011", "What is the fee?")
	h.ask(wb.ID, g[1], "q-fee-0012", "Fee for the course?")
	h.ask(wb.ID, g[2], "q-fee-0013", "Course fee?")
	h.qaClusters(wb.ID)
	if n := model.callCount(); n != 0 {
		t.Fatalf("calls with AI off = %d", n)
	}
	if res, _ := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/qa/clusters/q_q-fee-0011/suggest", nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("suggest with AI off: %d", res.StatusCode)
	}
	if res, _ := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/qa/drafts/qd_x/post", types.QAPostDraftRequest{Answer: "x"}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("post with AI off: %d", res.StatusCode)
	}

	// A host without the ai feature has no session pick either.
	h.signup("No AI KB", "kb-noai@test.dev", true)
	plain := h.liveWebinar("Plain", nil)
	if res, raw := h.do(http.MethodGet, "/api/host/webinars/"+plain.ID+"/knowledge", nil); res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "feature_off" {
		t.Fatalf("session pick without ai: %d %s", res.StatusCode, raw)
	}
}
