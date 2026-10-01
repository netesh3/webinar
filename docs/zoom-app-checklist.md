# Zoom app checklist

Create this as an unpublished OAuth app in the Zoom Marketplace, user-managed (not account-level). Do not submit it for review from this pass. Do not put any secret in git. The values below are names and URLs only.

The app stays in development until Marketplace review. Allowlist the hosts who will test Connect. After approval the same app can be published as unlisted. This build talks to whatever client id and secret the process is given.

## App type

- OAuth
- User-managed
- Development (unpublished)

## Redirect URL

Exact match, HTTPS, no trailing slash beyond the path:

```
{API origin}/api/host/zoom/callback
```

`{API origin}` is the public origin that serves `/api` (the same origin as `WEB_BASE_URL` when the site proxies `/api`). Set `ZOOM_REDIRECT_URL` to that exact string.

## Webhook

```
{API origin}/api/webhooks/zoom
```

Public POST, no session. Zoom signs the raw body. Set `ZOOM_WEBHOOK_SECRET` to the secret Zoom shows for this endpoint.

Subscribe to:

- `endpoint.url_validation`
- `app_deauthorized`
- `meeting.participant_joined`
- `meeting.participant_left`
- `meeting.ended`
- `webinar.participant_joined`
- `webinar.participant_left`
- `webinar.ended`
- `recording.completed`

This pass validates the URL challenge and deletes the host's connection on `app_deauthorized`. The other events are accepted and left for the attendance pass. Ending a Zoom session is done in Zoom; our status will move when `meeting.ended` or `webinar.ended` arrives.

## Scopes

User-managed names only. Do not add the `:admin` twin of any of these.

- `user:read:user`
- `meeting:write:meeting`
- `meeting:read:meeting`
- `meeting:update:meeting`
- `meeting:delete:meeting`
- `meeting:write:registrant`
- `meeting:read:list_registrants`
- `meeting:read:list_past_participants`
- `meeting:read:list_polls`
- `webinar:write:webinar`
- `webinar:read:webinar`
- `webinar:update:webinar`
- `webinar:delete:webinar`
- `webinar:write:registrant`
- `webinar:read:list_registrants`
- `webinar:read:list_panelists`
- `webinar:read:list_past_participants`
- `webinar:read:list_absentees`
- `webinar:read:list_polls`
- `webinar:read:past_qa`
- `cloud_recording:read:list_user_recordings`

Not requested: any `:admin` scope, report scopes, survey scopes, chat-message scopes, `webinar:write:panelist`, `user:write`.

## Environment

Set these on the API process. Leave them unset and Connect shows "Zoom is not configured" instead of crashing.

| Name | What it is |
| --- | --- |
| `ZOOM_CLIENT_ID` | OAuth client id |
| `ZOOM_CLIENT_SECRET` | OAuth client secret |
| `ZOOM_REDIRECT_URL` | The redirect URL above, exact |
| `ZOOM_TOKEN_KEY` | 32-byte key that encrypts refresh tokens |
| `ZOOM_WEBHOOK_SECRET` | Secret Zoom uses to sign webhook bodies |

Generate the token key with:

```
openssl rand -base64 32
```

Optional, for tests only: `ZOOM_API_URL`, `ZOOM_OAUTH_URL`.

## What a host sees

Meetings with registration need a paid Zoom license (Pro or above). Zoom Webinars need the Webinar add-on. A plan error leaves that webinar on This app and says why. Hosts who never pick Zoom need no Zoom license.

Go live on a Zoom-backed webinar opens Zoom's host `start_url` in a new tab. That link is short-lived, so it is fetched again from Zoom on each click and is not written to logs. Attendees follow their own `join_url`. Ending the session happens in Zoom.
