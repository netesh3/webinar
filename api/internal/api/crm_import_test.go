package api_test

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

const importSample = "name,email,phone,Service,Payment cycle,Last transaction date,Subscription expiry date\r\n" +
	"Moon salat,moonsalat59@gmail.com,+91-9184338388,AI Agents Workshop,onetime,17/10/2026 1:49 PM (IST),31/12/2030 6:24 PM (IST)\r\n" +
	"Neeraj,ratkarwa0010@gmail.com,+91-9624837650,AI Agents Workshop,onetime,17/10/2026 12:23 PM (IST),31/12/2030 6:24 PM (IST)\r\n"

// uploadCSV posts a file to the import endpoint.
func uploadCSV(t *testing.T, h *harness, name, content string) (*http.Response, []byte) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fw.Write([]byte(content))
	_ = mw.Close()
	return h.doRaw(http.MethodPost, "/api/host/crm/imports", mw.FormDataContentType(), buf.Bytes(), nil)
}

func previewCSV(t *testing.T, h *harness, name, content string) types.CRMImportPreview {
	t.Helper()
	res, raw := uploadCSV(t, h, name, content)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("upload %s: status %d body %s", name, res.StatusCode, raw)
	}
	var p types.CRMImportPreview
	h.decode(raw, &p)
	return p
}

func commitImport(t *testing.T, h *harness, id string, body types.CRMImportCommitRequest) types.CRMImportResult {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/crm/imports/"+id+"/commit", body)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("commit: status %d body %s", res.StatusCode, raw)
	}
	var out types.CRMImportResult
	h.decode(raw, &out)
	return out
}

/* A TagMango export becomes contacts and a saved list. Existing contacts are updated,
 * not duplicated; consent opts in only people with no opt-out on file; the broadcast
 * to the list reaches only the opted-in; deleting the list keeps the contacts. */
func TestCRMImportTagMangoToABroadcast(t *testing.T) {
	g, h := tagsHost(t)
	wb := autoWebinar(t, h, "Import drain")
	ctx := t.Context()

	// Neeraj is already a contact, and asked to stop.
	neeraj := registerWithPhone(t, h, wb.ID, "Neeraj R", "ratkarwa0010@gmail.com", "+91 96248 37650", true)
	if res, raw := h.do(http.MethodPost, "/api/host/crm/contacts/"+neeraj.ID+"/opt-out", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("opt out: %d %s", res.StatusCode, raw)
	}

	file := importSample + "Bad Row,bad@example.com,12345,,,,\r\nMoon again,moon2@example.com,9184338388,,,,\r\n"
	p := previewCSV(t, h, "tagmango-export.csv", file)
	wantMap := []string{types.ImportFieldName, types.ImportFieldEmail, types.ImportFieldPhone, types.ImportFieldService,
		types.ImportFieldPaymentCycle, types.ImportFieldLastTransaction, types.ImportFieldSubscriptionExpiry}
	if strings.Join(p.Mapping, ",") != strings.Join(wantMap, ",") {
		t.Errorf("mapping = %v, want %v", p.Mapping, wantMap)
	}
	if p.Rows != 4 || p.Valid != 2 || p.InvalidCount != 1 || p.Duplicates != 1 || p.Existing != 1 {
		t.Fatalf("preview = %+v", p)
	}
	if p.Invalid[0].Row != 4 || p.Sample[0].Phone != "+919184338388" {
		t.Errorf("invalid %+v sample %+v", p.Invalid, p.Sample)
	}

	res := commitImport(t, h, p.ID, types.CRMImportCommitRequest{ListName: "Workshop buyers", ConsentConfirmed: true})
	if res.Created != 1 || res.Updated != 1 || res.OptedIn != 1 || res.OptedOut != 1 || res.Invalid != 1 {
		t.Fatalf("commit = %+v", res)
	}
	if res.List.Name != "Workshop buyers" || res.List.Size != 2 || res.List.OptedIn != 1 {
		t.Errorf("list = %+v", res.List)
	}
	if again, raw := h.do(http.MethodPost, "/api/host/crm/imports/"+p.ID+"/commit", types.CRMImportCommitRequest{}); again.StatusCode != http.StatusConflict {
		t.Errorf("second commit: %d %s, want 409", again.StatusCode, raw)
	}

	var source, importID, service, expiry, name string
	if err := h.store.Pool().QueryRow(ctx, `
		SELECT whatsapp_opt_in_source, COALESCE(whatsapp_opt_in_import_id::text,''),
		       attributes->>'service', attributes->>'subscription_expires_at', name
		  FROM crm_contacts WHERE phone = '+919184338388'`).Scan(&source, &importID, &service, &expiry, &name); err != nil {
		t.Fatal(err)
	}
	if source != "import" || importID != p.ID || service != "AI Agents Workshop" ||
		expiry != "2030-12-31T18:24:00+05:30" || name != "Moon salat" {
		t.Errorf("moon = source %q import %q service %q expiry %q name %q", source, importID, service, expiry, name)
	}
	var keptName string
	var optedOut bool
	if err := h.store.Pool().QueryRow(ctx, `
		SELECT name, whatsapp_opt_out_at IS NOT NULL AND whatsapp_opt_out_at >= COALESCE(whatsapp_opt_in_at, 'epoch')
		  FROM crm_contacts WHERE id = $1::uuid`, neeraj.ID).Scan(&keptName, &optedOut); err != nil {
		t.Fatal(err)
	}
	if keptName != "Neeraj R" || !optedOut {
		t.Errorf("existing contact = name %q opted out %v, want the name and the opt-out kept", keptName, optedOut)
	}
	var tagged int
	if err := h.store.Pool().QueryRow(ctx, `
		SELECT count(*) FROM crm_contact_tags ct JOIN crm_tags t ON t.id = ct.tag_id
		 WHERE t.name = 'Service: AI Agents Workshop'`).Scan(&tagged); err != nil || tagged != 2 {
		t.Errorf("service tag on %d contacts (%v), want 2", tagged, err)
	}

	preview := audiencePreview(t, h, "?audience=list&listId="+res.List.ID)
	if preview.Recipients != 1 || preview.OptedOut != 1 {
		t.Errorf("list audience = %+v", preview)
	}
	b := createBroadcast(t, h, types.CRMBroadcastRequest{
		Name: "Workshop follow-up", Template: testTemplateUtility, Language: "en_US",
		Params: []types.CRMParam{{Field: "name"}}, Audience: types.AudienceList, ListID: res.List.ID,
	})
	if b.Stats.Recipients != 1 || b.ListID != res.List.ID || b.ListName != "Workshop buyers" {
		t.Fatalf("broadcast = %+v", b)
	}
	drainWhatsAppOutbox(t, h, wb.ID)
	sends := g.sent()
	if len(sends) != 1 || sends[0]["to"] != "919184338388" {
		t.Fatalf("sends = %v, want only Moon", sends)
	}

	lres, raw := h.do(http.MethodGet, "/api/host/crm/lists", nil)
	var lists types.CRMListsResponse
	h.decode(raw, &lists)
	if lres.StatusCode != http.StatusOK || len(lists.Lists) != 1 {
		t.Fatalf("lists: %d %s", lres.StatusCode, raw)
	}
	if d, raw := h.do(http.MethodDelete, "/api/host/crm/lists/"+res.List.ID, nil); d.StatusCode != http.StatusOK {
		t.Fatalf("delete list: %d %s", d.StatusCode, raw)
	}
	var left int
	if err := h.store.Pool().QueryRow(ctx, `SELECT count(*) FROM crm_contacts WHERE phone IN ('+919184338388','+919624837650')`).Scan(&left); err != nil || left != 2 {
		t.Errorf("contacts after deleting the list = %d (%v), want 2", left, err)
	}
	if got := readBroadcast(t, h, b.ID); got.ListID != "" || got.Stats.Recipients != 1 {
		t.Errorf("broadcast after deleting its list = %+v", got)
	}
}

/* Without the host's confirmation nobody is opted in, so a broadcast to the list has
 * nobody to send to. Another host can't see or use the list or the upload. */
func TestCRMImportWithoutConsentAndAcrossHosts(t *testing.T) {
	_, h := tagsHost(t)
	p := previewCSV(t, h, "students.tsv", strings.ReplaceAll(importSample, ",", "\t"))
	if p.Valid != 2 {
		t.Fatalf("tab-separated preview = %+v", p)
	}
	res := commitImport(t, h, p.ID, types.CRMImportCommitRequest{})
	if res.OptedIn != 0 || res.Created != 2 || !strings.HasPrefix(res.List.Name, "students · ") {
		t.Fatalf("commit = %+v", res)
	}
	preview := audiencePreview(t, h, "?audience=list&listId="+res.List.ID)
	if preview.Recipients != 0 || preview.NoOptIn != 2 {
		t.Errorf("list audience without consent = %+v", preview)
	}
	r, raw := h.do(http.MethodPost, "/api/host/crm/broadcasts", types.CRMBroadcastRequest{
		Name: "x", Template: testTemplateUtility, Language: "en_US", Params: []types.CRMParam{{Field: "name"}},
		Audience: types.AudienceList, ListID: res.List.ID,
	})
	if r.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "crm_audience_empty" {
		t.Errorf("broadcast without consent: %d %s", r.StatusCode, raw)
	}
	second := previewCSV(t, h, "again.csv", importSample)

	other := h.signup("Other Coach", "other-coach@test.dev", true)
	grantFeature(t, h, other.ID, types.FeatureWhatsAppCRM)
	lr, lraw := h.do(http.MethodGet, "/api/host/crm/lists", nil)
	var lists types.CRMListsResponse
	h.decode(lraw, &lists)
	if lr.StatusCode != http.StatusOK || len(lists.Lists) != 0 {
		t.Errorf("other host's lists: %d %s", lr.StatusCode, lraw)
	}
	if r, raw := h.do(http.MethodGet, "/api/host/crm/audience?audience=list&listId="+res.List.ID, nil); r.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "crm_no_list" {
		t.Errorf("other host's audience: %d %s", r.StatusCode, raw)
	}
	if r, raw := h.do(http.MethodPost, "/api/host/crm/imports/"+second.ID+"/commit", types.CRMImportCommitRequest{}); r.StatusCode != http.StatusNotFound {
		t.Errorf("other host's commit: %d %s", r.StatusCode, raw)
	}
	if r, raw := h.do(http.MethodDelete, "/api/host/crm/lists/"+res.List.ID, nil); r.StatusCode != http.StatusNotFound {
		t.Errorf("other host's delete: %d %s", r.StatusCode, raw)
	}
}

/* A second CSV can go into a list that already exists: people already on it are not
 * added twice. Lists can be renamed, and a name another list has is refused. */
func TestCRMImportIntoAnExistingListAndRename(t *testing.T) {
	_, h := tagsHost(t)
	first := commitImport(t, h, previewCSV(t, h, "batch1.csv", importSample).ID,
		types.CRMImportCommitRequest{ListName: "Students", ConsentConfirmed: true})
	more := "name,phone\nMoon salat,+91 91843 38388\nAsha,+91 98765 43210\n"
	added := commitImport(t, h, previewCSV(t, h, "batch2.csv", more).ID,
		types.CRMImportCommitRequest{ListID: first.List.ID, ConsentConfirmed: true})
	if added.List.ID != first.List.ID || added.List.Size != 3 || added.Created != 1 || added.Updated != 1 {
		t.Fatalf("append = %+v, want the same list with 3 people", added)
	}
	if added.List.UpdatedAt < first.List.UpdatedAt {
		t.Errorf("updatedAt did not move: %s then %s", first.List.UpdatedAt, added.List.UpdatedAt)
	}
	other := commitImport(t, h, previewCSV(t, h, "batch3.csv", "name,phone\nRavi,9123456780\n").ID,
		types.CRMImportCommitRequest{ListName: "Students"})
	if other.List.Name != "Students (2)" {
		t.Errorf("second list with the same name = %q, want it numbered", other.List.Name)
	}
	if r, raw := h.do(http.MethodPatch, "/api/host/crm/lists/"+first.List.ID, types.CRMListRequest{Name: "Students (2)"}); r.StatusCode != http.StatusConflict {
		t.Errorf("rename onto an existing name: %d %s", r.StatusCode, raw)
	}
	r, raw := h.do(http.MethodPatch, "/api/host/crm/lists/"+first.List.ID, types.CRMListRequest{Name: "  AI Workshop  buyers "})
	var renamed types.CRMList
	h.decode(raw, &renamed)
	if r.StatusCode != http.StatusOK || renamed.Name != "AI Workshop buyers" || renamed.Size != 3 {
		t.Errorf("rename: %d %s", r.StatusCode, raw)
	}
	if r, raw := h.do(http.MethodPost, "/api/host/crm/imports/"+previewCSV(t, h, "b4.csv", more).ID+"/commit",
		types.CRMImportCommitRequest{ListID: "00000000-0000-0000-0000-000000000000"}); r.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "crm_no_list" {
		t.Errorf("import into a list that isn't yours: %d %s", r.StatusCode, raw)
	}
}

func TestCRMImportRefusesBadFiles(t *testing.T) {
	_, h := tagsHost(t)
	var big strings.Builder
	big.WriteString("name,phone\n")
	for i := 0; i <= types.CRMImportMaxRows; i++ {
		big.WriteString("p," + strconv.Itoa(9000000000+i) + "\n")
	}
	for name, tc := range map[string]struct {
		content string
		status  int
		code    string
	}{
		"empty":     {"name,phone\n", http.StatusUnprocessableEntity, "import_empty"},
		"too many":  {big.String(), http.StatusUnprocessableEntity, "import_too_many_rows"},
		"too large": {"name,phone\n" + strings.Repeat("x", types.CRMImportMaxBytes), http.StatusRequestEntityTooLarge, "import_too_large"},
	} {
		res, raw := uploadCSV(t, h, name+".csv", tc.content)
		if res.StatusCode != tc.status || errorCode(t, raw) != tc.code {
			t.Errorf("%s: %d %s, want %d %s", name, res.StatusCode, raw, tc.status, tc.code)
		}
	}
	// A commit has to say which column is the phone.
	p := previewCSV(t, h, "x.csv", "who,number\nA,9184338388\n")
	if r, raw := h.do(http.MethodPost, "/api/host/crm/imports/"+p.ID+"/commit",
		types.CRMImportCommitRequest{Mapping: []string{types.ImportFieldName, ""}}); r.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "import_no_phone" {
		t.Errorf("commit without a phone column: %d %s", r.StatusCode, raw)
	}
}
