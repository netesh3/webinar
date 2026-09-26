# Contacts

**Status:** partial  
**Mock:** `contacts.html`, `modal-import-contacts.html`  
**Code:** `store/crm.go`, `handleCRMContacts`, `handleCRMThread`,
`crm-screen.tsx`

## Purpose

The people Engage knows: phone (E.164), email, name, company, source,
consent timestamps, tags, notes, optional stage/owner.

A contact list whose rows do not open a conversation is a spreadsheet. Desktop
shows list + thread; phone shows one at a time.

## Done looks like

- Search (name / email / phone), status chips (replied, opted-in, no opt-in,
  opted-out, no number), optional webinar scope.
- Counts on the chips are the **unfiltered** universe (already true).
- Contact 360 tabs: **Profile | Messages | Activity**.
- Profile: fields, tags, stage, owner, opt-out.
- Messages: same thread as inbox.
- Activity: notes + enrollment/broadcast history (planned; notes exist).
- Empty phone is allowed only if email exists; registration without either
  is not stored.

## Already built

| Route | Behaviour |
| --- | --- |
| `GET /crm/contacts` | `q`, `limit` (max 200), `status`, `webinarId` |
| `GET /crm/contacts/{id}` | contact + messages |
| `POST /crm/contacts/{id}/opt-out` | timestamps; exits drips |
| Upsert from registration | `ContactFromRegistration` |
| Upsert from inbound | `ingestWhatsApp`; Weak names fill blanks only |

Consent is two timestamps, not a boolean. `whatsappOptIn` on the wire is
computed. There is **no opt-in API** — consent comes from the person
(register checkbox or a future import column).

## To build

- Keyset cursor when >200 (`last_seen_at, id`).
- `PATCH /crm/contacts/{id}` for stage/owner (pipelines).
- Import: [import.md](import.md).
- Activity timeline (enrollments, broadcasts) — read-only join, not a new log
  table in v1 if `crm_drip_enrollments` + messages suffice.

## Coupling

`?webinarId=` is the Webinar Liv hook (“View in CRM”). Scope 404s if the slug
is not this host’s webinar.

Registration form: opt-in checkbox **after** a number is typed, default off.

## Calls

One GET for the list (includes counts + last message). Opening a row is one
GET for the thread. Notes/tags are extra only on the open contact (already
separate routes). Do not prefetch notes for every row.

## Tests

One contact per registrant however many times they register; other host → 404;
opt-in with no number not stored; inbound merges into registrant.

## Import duplicate policy

The import dialog asks: update on E.164, skip, or create a second record. Default is update. That is the merge UI (plan G). Company is a contact attribute from the CSV, not a separate accounts object.
