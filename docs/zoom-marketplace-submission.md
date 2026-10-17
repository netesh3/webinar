# Zoom Marketplace submission pack

Everything to paste into the Zoom App Marketplace to submit Webinar Liv for review. Fill it in at
**marketplace.zoom.us → Develop → Manage → Webinar Liv**. The setup itself (redirect URL, webhook,
environment) is in [zoom-app-checklist.md](zoom-app-checklist.md) and is already live in production.

Facts below were checked against the code on main (`api/internal/zoom`, `api/internal/api/zoom.go`) on
17 Oct 2026. If the code changes what it calls, update the scope table.

## Before you submit

1. **Remove the unused scopes** (see [Scopes](#scopes)). Zoom rejects apps that request scopes they do
   not use, and the app currently has 8 extra ones.
2. **Remove the `recording.completed` event subscription.** The app acknowledges it and stores nothing,
   and keeping it means asking for a recording scope.
3. **Make a reviewer account on Webinar Liv** with Zoom available (see [Test account](#test-account)).
4. Check these pages load while signed out:
   - https://webinarliv.com/privacy (has a "Zoom (optional)" section)
   - https://webinarliv.com/terms
   - https://webinarliv.com/integrations/zoom (add, use and remove instructions)

## App listing

**App name:** Webinar Liv

**Short description** (Zoom caps this field; this one is under 100 characters):

> Registration, WhatsApp and email reminders, and attendance reports for your Zoom meetings and webinars.

**Long description:**

> Webinar Liv is a webinar platform for coaches, educators and small businesses. With the Zoom app,
> you can run a webinar on your own Zoom account while Webinar Liv handles everything around it.
>
> - Schedule once in Webinar Liv. The matching Zoom meeting or Zoom webinar is created, updated and
>   deleted for you.
> - Every registrant is added to the Zoom session and gets their own Zoom join link in their
>   confirmation and reminders, by email and WhatsApp.
> - Click Go live and Zoom opens with you as the host.
> - When the session ends, Webinar Liv shows who attended and for how long, so follow-up messages go
>   to the right people.
>
> Webinar Liv only works with the meetings and webinars you create from it. It does not read your
> other meetings, recordings, chat or contacts.

**Category:** Productivity (also choose "Marketing" if Zoom allows a second category)

**Industry:** Education, Professional services

**Pricing:** Free to install. A Webinar Liv plan that includes Zoom is needed, and so is a licensed
Zoom account (Pro or above; Zoom webinars need the Webinars add-on).

**Links:**

| Field | Value |
| --- | --- |
| Privacy policy | https://webinarliv.com/privacy |
| Terms of use | https://webinarliv.com/terms |
| Support | mailto:support@webinarliv.com |
| Documentation | https://webinarliv.com/integrations/zoom |
| Developer contact | support@webinarliv.com |

**Images Zoom asks for.** Check the current sizes on the form, since Zoom changes them.

- App icon: the square Webinar Liv logo (`web/app/icon.png` is a starting point; export at the size the
  form asks for).
- 3–5 screenshots:
  1. Settings → Integrations with the Zoom card and **Connect Zoom**.
  2. The Zoom card after connecting (shows the Zoom account email and **Disconnect**).
  3. Schedule a webinar → **Where it runs** with **Zoom meeting** selected.
  4. The host webinar page for a Zoom webinar, with **Go live** and "This session runs in Zoom".
  5. The attendance page after a Zoom session.

## Scopes

Keep exactly these 13. Each one is used by a call in `api/internal/zoom/client.go`.

| Scope | Why (paste into the scope description) |
| --- | --- |
| `user:read:user` | Read the connecting user's Zoom id and email (`GET /users/me`), to show which Zoom account is connected and to match Zoom's deauthorization notice. |
| `meeting:write:meeting` | Create the Zoom meeting when a host schedules a webinar to run on Zoom (`POST /users/me/meetings`). |
| `meeting:read:meeting` | Read the meeting's join link, and the host's start link when they click Go live (`GET /meetings/{id}`). |
| `meeting:update:meeting` | Keep the title, time and length in step when the host edits the webinar (`PATCH /meetings/{id}`). |
| `meeting:delete:meeting` | Delete the meeting when the host deletes the webinar or moves it off Zoom before anyone was sent a link (`DELETE /meetings/{id}`). |
| `meeting:write:registrant` | Add each person who registers on Webinar Liv, so they get a personal join link (`POST /meetings/{id}/registrants`). |
| `meeting:read:list_past_participants` | After the meeting ends, read who attended and for how long for the host's attendance report (`GET /past_meetings/{id}/participants`). |
| `webinar:write:webinar` | Same as the meeting scope above, for Zoom webinars (`POST /users/me/webinars`). |
| `webinar:read:webinar` | Same, for Zoom webinars (`GET /webinars/{id}`). |
| `webinar:update:webinar` | Same, for Zoom webinars (`PATCH /webinars/{id}`). |
| `webinar:delete:webinar` | Same, for Zoom webinars (`DELETE /webinars/{id}`). |
| `webinar:write:registrant` | Same, for Zoom webinars (`POST /webinars/{id}/registrants`). |
| `webinar:read:list_past_participants` | Same, for Zoom webinars (`GET /past_webinars/{id}/participants`). |

**Remove these 8.** Nothing in the code calls them:

- `meeting:read:list_registrants`
- `meeting:read:list_polls`
- `webinar:read:list_registrants`
- `webinar:read:list_panelists`
- `webinar:read:list_absentees`
- `webinar:read:list_polls`
- `webinar:read:past_qa`
- `cloud_recording:read:list_user_recordings`

Revoking the token on disconnect (`POST /oauth/revoke`) needs no scope.

**Event subscriptions** (Features → Event subscriptions, endpoint
`https://webinarliv.com/api/webhooks/zoom`): `meeting.participant_joined`, `meeting.participant_left`,
`meeting.ended`, `webinar.participant_joined`, `webinar.participant_left`, `webinar.ended`. The
deauthorization notice (`app_deauthorized`) and the URL validation challenge are handled too.

When you add an event, Zoom may ask for the scope that event needs. If it asks for one that isn't in
the table above, add it and use this as the reason: "Receive join, leave and end events for meetings
and webinars the host created from Webinar Liv, to build the host's attendance report."

## Test account

Zoom's reviewers need to sign in to Webinar Liv and connect their own Zoom test account.

1. Sign up a new Webinar Liv account, for example `zoom-review@webinarliv.com`, with a strong password.
2. In Admin → Accounts, give it a plan that includes Zoom, or turn the Zoom feature on for that account.
   Zoom is an entitlement, so without this the Zoom card says it isn't available.
3. Put the email and password in the submission form's test credentials field, never in git.
4. After the review is approved, delete the account or change its password.

**Instructions for reviewers** (paste into the form):

> 1. Go to https://webinarliv.com/login and sign in with the test credentials above.
> 2. Open Settings → Integrations. On the Zoom card, click **Connect Zoom** and approve with your
>    Zoom test account (Pro or above).
> 3. Click **Schedule a webinar**. Enter a title and a start time at least 15 minutes from now. Under
>    **Where it runs**, choose **Zoom meeting** and save. The meeting appears in your Zoom account.
> 4. Open the webinar's public page, register with any name and email, and check that the
>    confirmation shows a Zoom join link for that person.
> 5. On the webinar page, click **Go live**. Zoom opens with you as host. Join from another browser
>    with the registrant's link, then end the meeting in Zoom.
> 6. Within a minute the webinar shows as ended, and the attendance page lists both participants.
> 7. To remove: Settings → Integrations → Zoom → **Disconnect**, or remove the app in Zoom
>    Marketplace → Manage → Added Apps. Either one deletes our stored token.

## Security and data questions

Answers to the questions Zoom usually asks.

| Question | Answer |
| --- | --- |
| Where is it hosted? | API on Google Cloud Run (asia-south1), web app on Cloudflare Workers, Postgres on Supabase. |
| Encryption in transit | HTTPS/TLS everywhere. Calls to Zoom are made over HTTPS from the API only. |
| Encryption at rest | Zoom refresh tokens are encrypted with AES-256-GCM using a 32-byte key held as a deployment secret (`ZOOM_TOKEN_KEY`), on top of database encryption at rest. Access tokens are short-lived and not stored. |
| Webhook verification | Every webhook is checked against Zoom's `x-zm-signature` HMAC and timestamp before it is read, and the URL validation challenge is answered. |
| What Zoom data is stored? | The Zoom user and account id and the email; the encrypted refresh token; the id, join link and host start link of meetings and webinars created from Webinar Liv; and, for those sessions only, each attendee's name, email and join and leave times. |
| What is not accessed? | Other meetings, recordings, chat, contacts, and account settings. No `:admin` scopes. |
| Is Zoom data shared or sold? | No. It is used only to run the host's webinar and show their attendance. |
| Is the host's start link logged? | No. It is kept in the database (it is short-lived), fetched again from Zoom on each Go live click, and never written to logs. |
| Deauthorization | `app_deauthorized` deletes the stored connection for that Zoom user. Disconnect in Settings also revokes the token with Zoom (`/oauth/revoke`) and deletes it. |
| Data deletion | Hosts can delete a webinar (with its attendance) or their whole account in Settings. Requests to support@webinarliv.com are handled too. |
| Who can reach the data? | Only the host who owns the webinar, and Webinar Liv admins for support. |

## After approval

- Publish the app (listed or unlisted), then check that **Connect Zoom** works from an account outside
  your Zoom organisation.
- Look for successful `GET /api/host/zoom/callback` requests in the Cloud Run logs. Before approval,
  connect attempts from outside accounts never come back from Zoom.
