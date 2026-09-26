# Tags and notes

**Status:** shipped (feature-flagged)  
**Code:** `store/crm_tags.go`, `crm_notes.go`, `crm-tags.tsx`, `crm-notes.tsx`  
**Flags:** `FeatureCRMTags`, `FeatureCRMNotes`

## Tags

Host-scoped labels. Used as:

- chips on a contact
- broadcast audience `tag`
- drip trigger `tag_added`
- bot node `set_tag`

Applying a tag goes through **one** store function so a bot’s label starts a
sequence exactly as the host’s click does.

`DELETE` of a tag that a drip triggers on is `ErrInUse` (RESTRICT). NULL on
the drip means “any tag”; deleting would silently widen the rule.

### API

`GET/POST /crm/tags`, `PATCH/DELETE /crm/tags/{id}`,
`POST/DELETE /crm/contacts/{id}/tags/{tagId}`

## Notes

Internal, never sent. Newest first. **No edit** — a dated observation is
corrected by writing a new one. Delete is allowed.

`GET/POST /crm/contacts/{id}/notes`, `DELETE /crm/notes/{id}`

## Coupling

None required. Webinar Liv does not show tags.

## Calls

Tags for the open contact come with the contact UI; the manager list is one
GET. Do not attach every tag to every contact on the list — `AttachTags` is
for the visible page only.

## Tests

`crm_tags_test.go`, `crm_notes_test.go`, isolation, in-use delete.
