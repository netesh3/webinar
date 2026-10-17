package engage

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Contact import: a CSV of people (most often a TagMango export) becomes contacts and
 * a saved list a broadcast can go to.
 *
 * Two steps, because the host has to see what will happen before anything is written:
 * POST /crm/imports reads the file and answers with a preview and a guessed column
 * mapping; POST /crm/imports/{id}/commit writes it with the mapping the host settled on.
 *
 * WhatsApp needs prior opt-in, and a CSV does not say whether these people gave it. So
 * the commit takes the host's confirmation, and only then are the imported people opted
 * in — recorded as source "import", with the import and the time. Without it they are
 * saved but left out of WhatsApp audiences like any contact who never opted in.
 */

// invalidShown caps the rows a preview lists as left out.
const invalidShown = 50

// importPreviewSample is how many people a preview shows.
const importPreviewSample = 10

func (s *Module) handleCRMImport(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if !s.featureAllowed(w, user, types.FeatureWhatsAppCRM) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, types.CRMImportMaxBytes+64<<10)
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "import_too_large",
			"That file is over 5 MB. Split it into smaller files.")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		httpx.Error(w, http.StatusUnprocessableEntity, "import_no_file", "Choose a CSV file to upload.")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, types.CRMImportMaxBytes+1))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "import_unreadable", "Could not read that file.")
		return
	}
	if len(data) > types.CRMImportMaxBytes {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "import_too_large",
			"That file is over 5 MB. Split it into smaller files.")
		return
	}
	columns, rows, err := readImportCSV(data)
	if err != nil || len(rows) == 0 {
		httpx.Error(w, http.StatusUnprocessableEntity, "import_empty",
			"That file has no rows to import. Save it as CSV with a header row.")
		return
	}
	if len(rows) > types.CRMImportMaxRows {
		httpx.Error(w, http.StatusUnprocessableEntity, "import_too_many_rows",
			"That file has over "+strconv.Itoa(types.CRMImportMaxRows)+" rows. Split it into smaller files.")
		return
	}
	mapping := detectMapping(columns)
	preview, ok := s.importPreview(w, r, user.ID, columns, mapping, rows)
	if !ok {
		return
	}
	name := filepath.Base(strings.TrimSpace(header.Filename))
	counts, _ := json.Marshal(map[string]int{"rows": preview.Rows, "valid": preview.Valid,
		"invalid": preview.InvalidCount, "duplicates": preview.Duplicates})
	id, err := s.store.CreateImport(r.Context(), user.ID, name, string(data), counts)
	if err != nil {
		s.fail(w, r, "crm import: save", err)
		return
	}
	preview.ID = id
	preview.FileName = name
	httpx.JSON(w, http.StatusOK, preview)
}

// importPreview counts what a mapping would import.
func (s *Module) importPreview(w http.ResponseWriter, r *http.Request, hostID string,
	columns, mapping []string, rows [][]string) (types.CRMImportPreview, bool) {
	people, invalid, dupes := buildImport(mapping, rows)
	phones := make([]string, 0, len(people))
	emails := []string{}
	for _, p := range people {
		phones = append(phones, p.Phone)
		if p.Email != "" {
			emails = append(emails, p.Email)
		}
	}
	existing, err := s.store.ExistingContacts(r.Context(), hostID, phones, emails)
	if err != nil {
		s.fail(w, r, "crm import: existing", err)
		return types.CRMImportPreview{}, false
	}
	out := types.CRMImportPreview{
		Columns: columns, Mapping: mapping, Rows: len(rows), Valid: len(people),
		Invalid: []types.CRMImportRowError{}, InvalidCount: len(invalid), Duplicates: dupes,
		Existing: existing, Sample: []types.CRMImportRow{},
	}
	if len(invalid) > invalidShown {
		out.Invalid = invalid[:invalidShown]
	} else if invalid != nil {
		out.Invalid = invalid
	}
	for i, p := range people {
		if i == importPreviewSample {
			break
		}
		out.Sample = append(out.Sample, types.CRMImportRow{Name: p.Name, Email: p.Email, Phone: p.Phone, Attributes: p.Attrs})
	}
	return out, true
}

func (s *Module) handleCRMImportCommit(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if !s.featureAllowed(w, user, types.FeatureWhatsAppCRM) {
		return
	}
	id := chi.URLParam(r, "id")
	var body types.CRMImportCommitRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	fileName, raw, status, err := s.store.ImportFile(r.Context(), user.ID, id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That upload has expired. Upload the file again.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm import: load", err)
		return
	}
	if status != "preview" {
		httpx.Error(w, http.StatusConflict, "import_done", "That file has already been imported.")
		return
	}
	columns, rows, err := readImportCSV([]byte(raw))
	if err != nil {
		s.fail(w, r, "crm import: reparse", err)
		return
	}
	mapping := body.Mapping
	if len(mapping) == 0 {
		mapping = detectMapping(columns)
	}
	if len(mapping) != len(columns) {
		httpx.Error(w, http.StatusUnprocessableEntity, "import_bad_mapping", "Map each column once.")
		return
	}
	seen := map[string]bool{}
	for _, f := range mapping {
		if !importFields[f] || (f != "" && seen[f]) {
			httpx.Error(w, http.StatusUnprocessableEntity, "import_bad_mapping",
				"Each field can come from one column only.")
			return
		}
		seen[f] = true
	}
	if !seen[types.ImportFieldPhone] {
		httpx.Error(w, http.StatusUnprocessableEntity, "import_no_phone",
			"Choose which column has the phone numbers.")
		return
	}
	people, invalid, _ := buildImport(mapping, rows)
	if len(people) == 0 {
		httpx.Error(w, http.StatusUnprocessableEntity, "import_none_valid",
			"None of the rows has a phone number that can be used.")
		return
	}
	listName := strings.TrimSpace(body.ListName)
	if listName == "" {
		listName = defaultListName(fileName, time.Now())
	}
	writes := make([]crmstore.ImportPerson, 0, len(people))
	for _, p := range people {
		tag := ""
		if p.Service != "" {
			tag = serviceTag(p.Service)
		}
		writes = append(writes, crmstore.ImportPerson{
			Name: p.Name, Email: p.Email, Phone: p.Phone, ServiceTag: tag, Attributes: p.Attrs,
		})
	}
	res, err := s.store.CommitImport(r.Context(), user.ID, id, strings.TrimSpace(body.ListID), listName,
		body.ConsentConfirmed, writes, len(invalid))
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_list", "That list is not one of yours.")
		return
	}
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "import_done", "That file has already been imported.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm import: commit", err)
		return
	}
	s.log.Info("crm import committed", "host", user.ID, "import", id, "list", res.List.ID,
		"created", res.Created, "updated", res.Updated, "opted_in", res.OptedIn,
		"consent", body.ConsentConfirmed)
	httpx.JSON(w, http.StatusOK, res)
}

// defaultListName is "<file name> · <date>", without the extension.
func defaultListName(fileName string, now time.Time) string {
	base := strings.TrimSuffix(fileName, filepath.Ext(fileName))
	base = strings.Join(strings.Fields(base), " ")
	if base == "" {
		base = "Imported contacts"
	}
	return base + " · " + now.In(ist).Format("2 Jan 2006")
}

func (s *Module) handleCRMLists(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if !s.featureAllowed(w, user, types.FeatureWhatsAppCRM) {
		return
	}
	lists, err := s.store.Lists(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "crm lists", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.CRMListsResponse{Lists: lists})
}

func (s *Module) handleRenameCRMList(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if !s.featureAllowed(w, user, types.FeatureWhatsAppCRM) {
		return
	}
	var body types.CRMListRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	l, err := s.store.RenameList(r.Context(), user.ID, chi.URLParam(r, "id"), body.Name)
	switch {
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "No such list.")
	case errors.Is(err, store.ErrInvalid):
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_list_name", "Name the list, in up to 120 characters.")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "crm_list_exists", "You already have a list with that name.")
	case err != nil:
		s.fail(w, r, "crm rename list", err)
	default:
		httpx.JSON(w, http.StatusOK, l)
	}
}

func (s *Module) handleDeleteCRMList(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if !s.featureAllowed(w, user, types.FeatureWhatsAppCRM) {
		return
	}
	err := s.store.DeleteList(r.Context(), user.ID, chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such list.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm delete list", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "deleted"})
}
