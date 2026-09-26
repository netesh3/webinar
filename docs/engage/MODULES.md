# Engage as a code module

How the WhatsApp CRM is kept apart from the webinar code, and what checks
that it stays apart. The product side of the same contract (events, UI hooks,
what each side must not do) is in [`PRODUCT.md`](PRODUCT.md).

**The rule:** webinar code never imports CRM code. It calls one interface
(Go) or renders slots from one entry point (web). The CRM can be switched off
by not wiring it, and webinars keep working. A test proves that.

## Layout

| | Webinar Liv | Engage (CRM) | Shared by both |
| --- | --- | --- | --- |
| Go handlers | `api/internal/api` | `api/internal/engage` | `httpx`, `config`, `authctx` |
| Go SQL | `api/internal/store` | `api/internal/engage/crmstore` | `store.Store` (pool, users, webinars reads) |
| Go clients | `lk`, `media`, `yt` | `wa` (Meta Graph) | `notify` (templates, local time) |
| Web | `components/`, `app/` | `web/engage/` | `components/{ui,controls,icons,providers}`, `lib/{http,api-types,format}` |
| Web API client | `lib/api.ts` (`api`) | `web/engage/api.ts` (`engageApi`) | `lib/http.ts` (fetch, `ApiError`) |
| Schema | `store/migrations` | same folder, `crm_*` tables | one database, one ordered history |

The only file that imports both Go modules is `api/cmd/server/main.go`:

```go
apiServer := api.NewServer(cfg, st, api.NewSFUPool(pool), recordings, log)
apiServer.UseEngage(engage.New(cfg, st, log))
```

Delete that second line and the server runs with `api.NoEngage`: no CRM
routes, no WhatsApp messages, no CRM columns on the roster, and `/config`
reports `whatsappConnect: false`, so the web app hides every slot.

## Go: the `api.Engage` interface

Defined by the webinar side in `api/internal/api/engage.go`. These are the
only calls webinar code makes into the CRM:

| Method | Called from | CRM does |
| --- | --- | --- |
| `Mount(public, host)` | `Routes()` | registers `/webhooks/whatsapp`, `/host/whatsapp/*`, `/host/crm/*` |
| `ConnectEnabled()` | `GET /config` | says whether Meta app credentials are set |
| `OnRegistered` | register handler, after commit | upsert contact, queue WhatsApp confirmation, `registered` drips, flush |
| `OnRegistrationsDecided` | approvals batch | skip declined seats' WhatsApp rows, flush the now-sendable ones |
| `OnRescheduled` | webinar PATCH | apply the webinar's start and reminder times to `wa_reminder` rows (move, drop, queue new) |
| `OnEnded` | end handler and meeting-limit sweeper | skip unsent WhatsApp reminders, `ended` / `attended` / `no_show` drips |
| `OnRecordingPublished` | recording made public | queue `wa_replay` for opted-in contacts |
| `DecorateRegistrants` | roster GET | fill `whatsappStatus` and `lastInboundAt` |
| `Tick` | 30 s sweeper | advance drips, advance bots, flush the WhatsApp outbox |

The contract for every hook:

- The webinar action has **already committed** when the hook runs. Nothing
  the CRM does can fail it or roll it back.
- The CRM **logs its own errors**. The hooks return nothing.
- A new hook is a change to this table and to `PRODUCT.md`, not a shortcut.

Splitting the outbox: `notifications` is one table with one sweeper per
channel. The webinar store retires and moves **email** kinds
(`reminder_*`, `registration_*`, `replay_ready`). `crmstore/webinars.go`
does the same for every `wa_*` kind. A new kind goes on one side only.

## Web: `@/engage`

Webinar screens import from `@/engage` only (`web/engage/index.ts`):

| Export | Used in | Shows when |
| --- | --- | --- |
| `WhatsAppRemindersToggle` | schedule form | deployment can connect WhatsApp (disabled until the host connects) |
| `WhatsAppOptInCheckbox` | register form | deployment can connect WhatsApp and a phone number was typed |
| `WhatsAppAccountRow` | account settings | deployment can connect WhatsApp and the account may host |
| `RosterContactsLink` | Attendees tab | always (contacts exist without a number) |
| `useRosterWhatsAppColumns`, `RosterWhatsAppHeaders`, `RosterWhatsAppCells` | Attendees tab | host has connected WhatsApp |
| `engageNavItem`, `ENGAGE_HOME` | top nav | account may host |
| `CRMScreen` | `app/host/(portal)/crm/page.tsx` | route |

Each slot decides for itself whether to render, based on app config and the
host's connection. A webinar screen never reads `account.whatsapp` or
`config.whatsappConnect`.

Still on the webinar side, deliberately: `options.whatsappReminders` on the
webinar (the host's per-webinar choice is stored with the webinar) and
`whatsappOptIn` on the registration request (consent is given on the
registration form). Both are plain fields that the CRM reads. Neither needs
CRM code to render or save.

## Checks

| Check | Where | Fails when |
| --- | --- | --- |
| `TestModuleBoundary` | `api/internal/engage/boundary_test.go` | `internal/api` or `internal/store` imports `engage` or `wa`; `engage` imports `api`, `lk`, `media` or `yt`; a shared package imports either module |
| `TestCRMStoreWritesOnlyItsOwnTables` | same file | a SQL string in `crmstore` INSERTs, UPDATEs or DELETEs anything except `crm_*`, `notifications`, or `users` (the `whatsapp_*` columns) |
| `TestWebinarsRunWithoutEngage` | `api/internal/api/noengage_test.go` | create, register, approve, roster or end breaks with `NoEngage`, or a CRM route is still mounted |
| `TestWhatsAppRemindersFollowWebinar`, `TestWhatsAppConfirmationSkippedOnDecline` | `api/internal/api/crm_hooks_test.go` | a hook is not called, or not called with the right webinar |
| `no-restricted-imports` | `web/eslint.config.mjs` | webinar code imports `@/engage/<anything>`; engage code imports a webinar screen or `@/app/*` |

## Still shared (known, accepted)

- **`store.User` carries the `whatsapp_*` fields.** `/me` returns them so the
  web app can tell whether a host is connected. The CRM is the only writer
  (`crmstore/users.go`).
- **`types/types.go`** holds CRM wire types next to webinar ones, because
  tygo generates one `api-types.ts` from it. Moving them into a separate Go
  package is a later, mechanical change (a second tygo package).
- **One Postgres, one migrations folder.** Splitting the schema would make
  the CRM's reads of `registrations` and `webinars` cross-database, for no
  isolation that the checks above don't already give.
- **CRM tests still live in `api/internal/api`**, because they boot the
  whole app through the same harness. They use `h.engage` and `h.crm` for
  the CRM module and its store.
