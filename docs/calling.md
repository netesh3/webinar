# Calling (31 Oct 2026)

A host can **call** another Webinar Liv user. The callee's phone, browser or desktop app rings;
Accept drops them into a meeting room. Callees are people with accounts only.

Code: `api/internal/api/calls.go` (HTTP, delivery), `call_push.go` (push fan-out),
`call_voip.go` (the iOS VoIP hook), `api/internal/store/calls.go` (SQL),
`migrations/0176_calls.sql`, `api/types/calls.go` (wire types). Web:
`web/components/incoming-call.tsx`, `web/components/room/call-someone.tsx`, `web/lib/calls.ts`,
`web/lib/calls-api.ts`, `web/lib/ringtone.ts`, `web/public/sw.js`. Desktop:
`apps/desktop/src/preload.ts` (`ringAttention`) and `main.ts`.

## The contract

This is what the web app, the service worker and the mobile apps rely on. Change it only
together with them.

### HTTP

| Route | Who | What |
| --- | --- | --- |
| `POST /api/calls` | signed-in host | `{"calleeUserId": "<uuid>", "meetingSlug": "<optional>"}` → `201 {callId, meetingSlug, joinUrl, expiresAt, meetingCreated}` |
| `GET /api/calls/{id}` | caller or callee | the call: `{callId, state, meetingSlug, topic, joinUrl, expiresAt, callerName, calleeName, role}` |
| `POST /api/calls/{id}/accept` | callee only | `200` the call (with `joinUrl`, the callee's way in) |
| `POST /api/calls/{id}/decline` | callee only | `200` the call |
| `POST /api/calls/{id}/cancel` | caller only | `200` the call |
| `GET /api/contacts?q=` | signed-in host | `{contacts: [{userId, name, avatarUrl?, initials, hue, email?}]}` |
| `GET /api/me/events` | signed-in | `text/event-stream`, event `call` (below) |

- **States:** `ringing`, `accepted`, `declined`, `cancelled`, `missed`. A call rings for **45 s**
  (`expiresAt`) and then is `missed`. A transition is only valid out of `ringing`, and only one
  wins (a conditional UPDATE). Asking for the state the call is already in is a `200`
  (idempotent); a call that already ended another way is `409 {"error":"call_ended",
  "message", "call"}` with the call as it stands. An accept after the 45 s is `409` with state
  `missed`.
- **Permissions:** anybody but the caller and the callee gets `404` for every call route. The
  callee cancelling, or the caller accepting/declining, is `403`.
- **Who may call:** the hosting capability (`requireHost`) and the meetings switch
  (`FeatureMeetings`, on by default), the same gate a meeting's create has. Calling does **not**
  need the instant-meeting switch (`instant_webinar`), which only "Start a meeting" asks for.
  With `meetingSlug`, the caller must host or co-host that meeting, it must be a meeting (a
  webinar is `422 not_a_meeting`), and not over (`409 meeting_ended`). Another host's meeting
  is `404`.
- **No meeting given:** the API makes an instant meeting through the ordinary create path
  (`createWebinarWith(..., createOptions{forCall: true})`, every check but the instant switch),
  named "<caller> and <callee>", and warms the video server. `meetingCreated` is true; the
  caller then starts it (`POST /api/host/webinars/{slug}/start`) and opens
  `/host/{slug}/room`, as "Start a meeting" does.
- **The callee's way in:** placing a call gives the callee a seat on the meeting's panel
  (`webinar_panelists`), which is how anybody invited by name reaches a meeting's stage. So
  `joinUrl` is `/host/{slug}/room` and the existing join (`POST
  /api/host/webinars/{slug}/join`) lets them in, no lobby. The seat is taken back when the call
  is declined, cancelled or missed (unless they already had it); accepted keeps it.
- **Abuse limits:** at most 10 calls per caller per hour (`429 rate_limited`); a callee who
  declined the same caller 3 times in a row is not rung by them again for an hour (`429
  callee_unavailable`). Pressing Call twice into the same meeting returns the call already
  ringing (`200`). TODO: a callee blocking a caller outright.

### Who can be called (`GET /api/contacts?q=`)

There is no team or address book in the product, so "people the host knows" is what the data
already says:

- the panelists and co-hosts of the host's own sessions ("team");
- the hosts of sessions the host was a panelist on;
- the signed-in attendees of the host's sessions (an approved registration with an account,
  or a meeting guest who knocked signed in);
- **and** the one account whose address exactly matches `q`, when `q` is a whole email
  address (case-insensitive). Never a prefix or substring of an address.

`q` otherwise matches names only. Rows carry name, avatar (only a public Google photo; an
uploaded photo is served to its own account alone, so others see initials), initials, hue and
userId. No address is ever returned except the one the host typed in full. Rate limited at 30
searches a minute per account. The host's own account is never listed.

### Events: the same JSON everywhere

```json
{"type":"incoming_call","callId":"…","callerName":"…","callerAvatarUrl":"https://…"|null,
 "meetingSlug":"…","topic":"…","joinUrl":"/host/<slug>/room","expiresAt":"RFC3339"}

{"type":"call_ended","callId":"…","state":"accepted|declined|cancelled|missed"}
```

`incoming_call` goes to the callee. `call_ended` goes to the callee's other devices (to stop
ringing) and to the caller (to update their UI).

- **Realtime** (`GET /api/me/events`): SSE event name `call`, data the JSON above.
- **Web Push**: `types.PushPayload` with `kind: "incoming_call"` and `data` the event. Because
  push data and FCM data are string maps, every value is a string there and
  `callerAvatarUrl` is `""` for none.
- **FCM**: the same string map as the message's `data`, plus `url` (absolute join URL),
  `kind` (`incoming_call`) and `tag` (`call-<id>`).
- **iOS VoIP**: `pushVoIP` gets the exact JSON bytes the realtime stream sends.

## Push

Push kind `types.PushIncomingCall = "incoming_call"`, a Settings → Notifications toggle
("Calls"), on by default. It covers both the ring and its end.

- **Web Push**: urgency high, TTL the rest of the ring (≤ 45 s), tag `call-<id>`, deduped per
  call. The service worker shows Accept / Decline with `requireInteraction`, calls the accept or
  decline endpoint with the session cookie, then opens or focuses `joinUrl`. A `call_ended`
  with the same tag closes it: a missed or cancelled call is replaced by "Missed call from …";
  one answered or declined elsewhere closes quietly. When a tab is focused the worker draws
  nothing and only tells the tab (the in-page card is already ringing).
- **Native (FCM)**: through the same push outbox and channels as `pushWentLive` (one
  `push_messages` row per install). The rows are marked `store.PushMessage.DataOnly` (column
  `push_messages.data_only`, with `data` jsonb), and `push.NativeMessage.DataOnly` makes the
  FCM sender send a **data message with no notification block**: Android `priority: HIGH`, so
  the app is woken to draw its own ringing UI. iOS does not wake a killed app for a data
  message, so a DataOnly message **with a title** also carries an APNs alert
  (`apns-push-type: alert`, priority 10) as the fallback; one with no title (the silent
  `call_ended` for accepted/declined) is `apns-push-type: background` with `content-available`.

### For the native work (hook names and fields)

- **`func (s *Server) pushVoIP(ctx context.Context, calleeUserID string, payload json.RawMessage)`**
  in `api/internal/api/call_voip.go` — a no-op today. Called once per ring with the
  `incoming_call` JSON, and once per end with the `call_ended` JSON (so CallKit can end a call
  still ringing). Replace the body (or the whole file) with the APNs VoIP send. Don't fail the
  caller; log errors.
- **`store.PushMessage.DataOnly bool`** and **`store.PushMessage.Data map[string]string`**
  (`push_messages.data_only`, `push_messages.data`), carried to
  **`push.NativeMessage.DataOnly` / `.Data`** by `sendNativeGroup`. FCM data keys: `type`,
  `callId`, `callerName`, `callerAvatarUrl` (`""` for none), `meetingSlug`, `topic`, `joinUrl`,
  `expiresAt` (or `type`, `callId`, `state` for `call_ended`), plus `url`, `kind`, `tag`.
- The app answers with `POST /api/calls/{id}/accept` or `/decline` (session cookie in the
  WebView), then opens `joinUrl` (already a seat on the panel, so opening it works even before
  the accept lands).
- In the foreground the WebView's own card (`incoming-call.tsx`) also rings, from the event
  stream. If the native ringing screen is up at the same time, the app can answer there; the
  card stops on the `call_ended` it causes.

## Realtime to open tabs: why a per-account SSE stream

The web app already had two live channels: the LiveKit data channel (only inside a room) and
the edge viewers' SSE stream (`GET /api/webinars/{slug}/events`, per webinar, with a signed
token). Neither reaches a signed-in user on an arbitrary page, and polling every tab every few
seconds for a ring that is rare would cost more than it saves.

`GET /api/me/events` is the edge stream with a per-account topic instead of a webinar's: the
same `realtime.Hub` (topic `user:<id>`, `realtime.UserTopic`), the same Postgres
LISTEN/NOTIFY `Bus` across Cloud Run instances, the same SSE framing, heartbeat (15 s) and
lifetime (25 min, then `reconnect`). Nothing new to run. It is authorized by the session cookie
(EventSource with `withCredentials`; in production the page and `/api` share an origin through
`web/worker.ts`, which streams the body through), so it needs no `EventsToken`. On every
(re)connect it sends the calls ringing for the account first, so a tab opened mid-ring, or one
that reconnected across the ring, still rings. These streams are left out of the edge viewers
gauge (`Hub.Total`). Expiry is noticed three ways: the tick's realtime lane (`sweepCalls`), any
read of the call, and each client's own timer from `expiresAt`.

## UI

- **In the meeting room:** Participants → "Call someone" (above "Share link"), for the host
  and co-hosts of a meeting. Search by name, or a whole email address; each call shows
  ringing with its countdown, then joining, declined or no answer, with Cancel and Call again.
- **Incoming call:** mounted once in `app/layout.tsx` for signed-in accounts, on every page.
  Full screen on phones, a corner card on desktop; the caller's photo (or initials), name and
  topic; Accept / Decline; a WebAudio two-tone ringtone (no audio file) and a vibration where
  supported, in one tab only (a Web Lock). It stops on `call_ended` or at `expiresAt`. Accept
  answers and navigates to `joinUrl`.
- **Desktop app:** the web UI, plus `window.webinarlivDesktop.ringAttention(on)` while it
  rings: the window flashes and the macOS dock bounces (attention, never focus).
