# Import contacts

**Status:** planned  
**Mock:** `modal-import-contacts.html`

## Purpose

Bring a list without a webinar. Every row that should be campaignable needs
a phone **and** an explicit opt-in column. Silent “imported = consented” is
forbidden.

## Done looks like

1. CSV or paste: name, phone, email, company, opt-in (`yes`/`true`/timestamp).
2. Preview counts: parsed, missing phone, missing consent, duplicates
   (match existing by E.164).
3. Commit: upsert; Weak names do not overwrite registration names (same as
   inbound).
4. Never send on import.

Cap a single import (e.g. 5,000 rows) so we don’t hold one HTTP request
open for a 50k file. Larger = background job later.

## API

`POST /crm/contacts/import` with parsed rows JSON from the browser **or**
multipart CSV processed in Go. Prefer Go parse + validate; don’t trust the
browser’s eligible count.

## Coupling

None. Optional default tag “imported”.

## Tests

No opt-in column → those rows stored without `whatsapp_opt_in_at`.
Duplicate phone merges. Other host’s file cannot assign their ids.

## Also in the dialog (plans G and I)

- Column mapping, tags applied on commit, duplicate policy (update on E.164, skip, or second record).
- On import: enrol in a named journey, update only, or send an opt-in template. Never treat the file as consent by itself.
- Sync tab: Webinar Liv, Google Sheets, custom webhook (those connectors are plan I).
- Single contact form.
