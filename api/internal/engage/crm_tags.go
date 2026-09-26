package engage

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Tags: labelling people, and the three things that read a label.
 *
 * A tag is the first thing in the CRM that is not a message. It is the host's own
 * judgement about somebody — "interested", "already a customer" — and it is worth having
 * because three other features can act on one: a broadcast can be addressed to it, a
 * sequence can start when it is applied, and a bot step can apply it without the person on
 * the other end seeing anything happen.
 *
 * That last pair is why applyTag exists rather than each caller doing its own insert. The
 * `tag_added` trigger has to fire whoever applied the label, and it must fire exactly once
 * per person per label — a host clicking a chip twice, or a flow a contact walks through
 * again, must not restart a sequence. One function, one decision.
 *
 * Gated on types.FeatureCRMTags for every endpoint here. The tables are not: a switch that
 * is turned off has to be turnable back on without losing what the host wrote under it.
 */

// handleCRMTags lists the host's labels with their contact counts.
func (s *Module) handleCRMTags(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if !s.featureAllowed(w, user, types.FeatureCRMTags) {
		return
	}
	tags, err := s.store.Tags(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "crm tags", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.CRMTagsResponse{Tags: tags})
}

/* handleCreateCRMTag adds a label.
 *
 * 200 with the existing tag when the name is already taken, not 409. A host typing a label
 * they have used before is asking for that label, and the thing they want back in both
 * cases is the tag they are about to apply — see store.CreateTag.
 */
func (s *Module) handleCreateCRMTag(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if !s.featureAllowed(w, user, types.FeatureCRMTags) {
		return
	}

	var body types.CRMTagRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	tag, err := s.store.CreateTag(r.Context(), user.ID, body.Name)
	switch {
	case errors.Is(err, store.ErrInvalid):
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_tag",
			"A tag needs a name of at most "+strconv.Itoa(types.TagMaxLength)+" characters.")
		return
	case errors.Is(err, store.ErrFull):
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_too_many_tags",
			"That's "+strconv.Itoa(types.TagMaxPerHost)+" tags already. Delete one you no longer use.")
		return
	case err != nil:
		s.fail(w, r, "crm create tag", err)
		return
	}
	httpx.JSON(w, http.StatusCreated, tag)
}

// handleRenameCRMTag changes a label's name, keeping it on everybody who has it.
func (s *Module) handleRenameCRMTag(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if !s.featureAllowed(w, user, types.FeatureCRMTags) {
		return
	}

	var body types.CRMTagRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	tag, err := s.store.RenameTag(r.Context(), user.ID, chi.URLParam(r, "id"), body.Name)
	switch {
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "No such tag.")
		return
	case errors.Is(err, store.ErrInvalid):
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_tag",
			"A tag needs a name of at most "+strconv.Itoa(types.TagMaxLength)+" characters.")
		return
	case errors.Is(err, store.ErrConflict):
		/* Refused rather than merged. Two labels becoming one moves every contact on
		 * one of them to the other and changes what the sequences pointing at it mean —
		 * a real operation, and not one to perform because two names collided. */
		httpx.Error(w, http.StatusConflict, "crm_tag_exists",
			"You already have a tag with that name.")
		return
	case err != nil:
		s.fail(w, r, "crm rename tag", err)
		return
	}
	httpx.JSON(w, http.StatusOK, tag)
}

/* handleDeleteCRMTag removes a label from the account and from everybody who carries it.
 *
 * Refused while a sequence triggers on it, and the refusal names the sequence. The reason
 * is in migrations/0049: an empty trigger_tag_id means "any tag", so clearing it would
 * widen the rule to every label rather than break it, and the host would find out by
 * somebody being messaged.
 */
func (s *Module) handleDeleteCRMTag(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if !s.featureAllowed(w, user, types.FeatureCRMTags) {
		return
	}
	id := chi.URLParam(r, "id")

	err := s.store.DeleteTag(r.Context(), user.ID, id)
	switch {
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "No such tag.")
		return
	case errors.Is(err, store.ErrInUse):
		msg := "A sequence starts when this tag is added. Change that sequence's trigger first."
		if names, nerr := s.store.DripsUsingTag(r.Context(), user.ID, id); nerr == nil && len(names) > 0 {
			msg = "\"" + strings.Join(names, "\", \"") +
				"\" starts when this tag is added. Change that sequence's trigger first."
		}
		httpx.Error(w, http.StatusConflict, "crm_tag_in_use", msg)
		return
	case err != nil:
		s.fail(w, r, "crm delete tag", err)
		return
	}
	s.log.Info("crm tag deleted", "host", user.ID, "tag", id)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "deleted"})
}

/* handleAddCRMContactTag puts a label on somebody, and starts whatever that starts.
 *
 * Answers with the contact's labels rather than a status, so the chips on the thread are
 * the server's list and not the browser's guess at what it just became.
 */
func (s *Module) handleAddCRMContactTag(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if !s.featureAllowed(w, user, types.FeatureCRMTags) {
		return
	}
	contactID := chi.URLParam(r, "id")

	var body types.CRMContactTagRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if strings.TrimSpace(body.TagID) == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_tag", "Pick a tag.")
		return
	}

	if err := s.applyTag(r.Context(), user, contactID, strings.TrimSpace(body.TagID)); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// Either id, and deliberately not distinguished: both mean "not yours".
			httpx.Error(w, http.StatusNotFound, "not_found", "No such contact or tag.")
			return
		}
		s.fail(w, r, "crm add contact tag", err)
		return
	}

	tags, err := s.store.ContactTags(r.Context(), user.ID, contactID)
	if err != nil {
		s.fail(w, r, "crm contact tags", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.CRMTagsResponse{Tags: tags})
}

// handleRemoveCRMContactTag takes a label off somebody. Nothing fires: no trigger in this
// application listens for a tag being removed, and a sequence already running carries on —
// the host stops that by exiting the enrollment, which is its own visible action.
func (s *Module) handleRemoveCRMContactTag(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if !s.featureAllowed(w, user, types.FeatureCRMTags) {
		return
	}
	contactID := chi.URLParam(r, "id")

	if err := s.store.RemoveContactTag(r.Context(), user.ID, contactID,
		chi.URLParam(r, "tagId")); err != nil {
		s.fail(w, r, "crm remove contact tag", err)
		return
	}
	tags, err := s.store.ContactTags(r.Context(), user.ID, contactID)
	if err != nil {
		s.fail(w, r, "crm contact tags", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.CRMTagsResponse{Tags: tags})
}

/* applyTag is the one place a label is put on somebody.
 *
 * Both callers go through it — the host from the inbox, and a bot's set_tag node — so the
 * `tag_added` trigger cannot fire for one and not the other, which is exactly the kind of
 * divergence that makes a host's sequence look broken on Tuesdays.
 *
 * The enrollment is only attempted when the label is NEW to this contact. That is the whole
 * value of the boolean AddContactTag returns: re-applying a tag somebody already has must
 * not put them back on a sequence they have been through, and the insert is the only thing
 * that can tell the difference.
 *
 * Enrollment failures are logged and swallowed. The tag is what was asked for and it is
 * already written; failing the request would leave the host pressing the button again
 * against a label that is already there.
 */
func (s *Module) applyTag(ctx context.Context, user store.User, contactID, tagID string) error {
	added, err := s.store.AddContactTag(ctx, user.ID, contactID, tagID)
	if err != nil {
		return err
	}
	if !added {
		return nil
	}
	n, err := s.store.EnrollOnTagAdded(ctx, user.ID, contactID, tagID)
	if err != nil {
		s.log.Warn("crm: tag_added enrollment", "error", err, "host", user.ID, "tag", tagID)
		return nil
	}
	if n > 0 {
		s.log.Info("crm drip enrolled on tag", "host", user.ID, "tag", tagID,
			"contact", contactID, "enrollments", n)
	}
	return nil
}

/* crmTagAllowed checks a tag belongs to the caller, writing the refusal itself.
 *
 * The same shape as crmWebinarAllowed and for the same reason: a tag id is the one part of
 * a broadcast or a sequence that names a row, and "not yours" has to be answered before
 * anything is stored against it.
 */
func (s *Module) crmTagAllowed(w http.ResponseWriter, r *http.Request, hostID, tagID string) bool {
	_, err := s.store.Tag(r.Context(), hostID, tagID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_tag", "That tag is not one of yours.")
		return false
	}
	if err != nil {
		s.fail(w, r, "crm: tag owner", err)
		return false
	}
	return true
}

/* hostTags is the tag list that rides along with the contacts, broadcasts, sequences and
 * bots responses, so each of those screens can offer a picker without a request per row.
 *
 * Empty when the feature is off, which is also when none of those screens show a picker. A
 * failure to read them is logged and returns empty rather than failing the page: the tags
 * are a control on somebody else's screen, and the contacts are what was asked for.
 */
func (s *Module) hostTags(ctx context.Context, user store.User) []types.CRMTag {
	if !user.HasFeature(types.FeatureCRMTags) {
		return []types.CRMTag{}
	}
	tags, err := s.store.Tags(ctx, user.ID)
	if err != nil {
		s.log.Warn("crm: could not load tags", "error", err, "host", user.ID)
		return []types.CRMTag{}
	}
	return tags
}
