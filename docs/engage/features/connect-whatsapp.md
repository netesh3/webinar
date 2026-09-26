# Connect WhatsApp

**Status:** shipped  
**Mock:** `settings-channels.html`, Account card  
**Code:** `api/internal/wa/`, `api/internal/api/whatsapp.go`, `web/lib/whatsapp-signup.ts`, `web/components/whatsapp-card.tsx`

## Purpose

The host connects **their** WhatsApp Business Account so every later send is
billed to them. Without this, Engage is a CRM with no channel.

## Done looks like

1. Signed-in host with `canHost` and `whatsappConnect` sees Connect on Account
   (and later Engage Settings → Channels).
2. Embedded Signup returns a code + `wabaId` + `phoneNumberId`.
3. Server exchanges the code, stores the grant on `users`, subscribes the app
   to the WABA.
4. If the number was created in that dialog, the host types their two-step PIN
   once; it is never stored.
5. Disconnect unsubscribes and clears the columns.
6. UI copy says Meta bills the host’s Business account.

## Already built

| Item | Where |
| --- | --- |
| Graph client, HMAC, pinned `v23.0` | `internal/wa` |
| Columns on `users` | `0041_whatsapp_connect.sql` |
| `GET /api/host/whatsapp/connect` | signup payload (app id, config id, Graph version) |
| `POST /api/host/whatsapp/callback` | exchange → persist |
| `POST /api/host/whatsapp/register` | `/{phone-number-id}/register` with PIN |
| `DELETE /api/host/whatsapp` | disconnect |
| `GET\|POST /api/webhooks/whatsapp` | verify + ingest |
| Account UI | `whatsapp-card.tsx` |

## Rules

- No OAuth redirect / state cookie. The SDK popup posts back to our page; the
  session cookie already proves who is connecting.
- `wabaId` and `phoneNumberId` are required with the code.
- Mid-connect: a failed display-name lookup still stores the grant. A rejected
  token is not stored.
- One number per host in v1. Several numbers ⇒ `crm_conversations` (see inbox).
- Tokens never appear on the wire after callback.

## Coupling

Shared with Webinar Liv Account settings. Engage Settings should **embed the
same card**, not a second connect flow.

Webhooks stay on the API origin:
`https://<api>/api/webhooks/whatsapp`.

## Scale / calls

Connect is rare (once per host). Template refresh is the Graph-heavy action
and is manual. Webhook ingest is one upsert + one insert per message.

## Tests

`whatsapp_test.go`, `whatsapp_register_test.go`. HMAC reject, verify token,
callback without code, disconnect.

## Non-goals

QR login, BSP, shared platform number, Webcast-paid conversations.
