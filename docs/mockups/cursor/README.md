# Engage — WhatsApp automation & CRM mockups

Seventeen screens for the WhatsApp module inside Webinar Liv, rebuilt onto a
single design system. Open `index.html` for the contact sheet, or
`screens/dashboard.html` to start walking the demo.

Everything opens straight off disk. There is no build step, no CDN and no
network request of any kind.

## Why this exists

These fifteen screens were first generated in Stitch, one at a time. Each
generation invented its own design, so the set did not hold together:

| | What the Stitch exports did |
| --- | --- |
| Sidebar | Two entirely different ones — a `forum`/Engage/Acme rail on ten screens, an `E`/Engage/`PRO` rail on five |
| Product name | “Engage” on thirteen screens, “WebinarLiv” on two |
| Audience size | 12,842 · 24,892 · 48,290 — same workspace, three numbers |
| Messaging tier | Tier 1 · Tier 3 · Tier 4 unlimited |
| Cloud API | v19.0 on some screens, v21.0 on others |
| Icons | Material Symbols by ligature name, pulled from a CDN |
| Styling | A separate Tailwind config compiled at runtime, per screen |

The last two are not just cosmetic: with no network the Stitch screens render as
a column of unstyled text and icon names. These do not.

The originals are kept under `source/` so any claim here can be checked against
them.

## Layout

```
index.html          Contact sheet, design system reference, canonical dataset
assets/app.css      Every token and every component — the only stylesheet
assets/shell.js     Icon set, sidebar/topbar injection, demo interactions
screens/*.html      Seventeen screens; each file holds only its own <main>
thumbs/             Local renders, used by the contact sheet
flow/               The broadcast wizard's five layers, rendered one per step
scripts/render.py   Rebuild thumbs/ and flow/
scripts/check.py    Unknown icons, broken links, undefined classes
source/             The Stitch exports, their text digests, and the fetch URLs
shots/              Stitch's own screenshots, as downloaded
```

## How a screen is built

A screen file contains its content and nothing else:

```html
<body data-screen="journeys" data-crumb="Platform / Journeys">
  <main class="page">…</main>
  <script src="../assets/shell.js"></script>
</body>
```

`shell.js` reads those two attributes, builds the sidebar, topbar, breadcrumb
and screen switcher around the page, and hydrates every
`<svg data-icon="users">` from an inline path table. That is what keeps the
chrome identical: adding a nav item changes one array, not fifteen files.

A handful of attributes do the rest of the work:

- `data-layout="wide"` drops the page padding, for the two builder canvases.
- `data-toast="…"` on any control explains what it would do, instead of the
  control dead-ending on `href="#"`. Controls with no handler fall back to a
  generic toast, so nothing is silently inert.
- `data-tabs` on a container, with `data-panel` on the buttons and
  `data-tabpanel` on the sections, makes tabs actually switch.
- `data-reveal="some-id"` on a button shows and hides `#some-id`, for reference
  material that would otherwise pad a page out. Integrations uses it for the
  eight-row Webinar Liv field mapping, which is not something to read on the
  way past.

A `.overlay` anywhere in a screen is lifted to the end of `<body>`, which is how
the three dialog screens sit over a real page rather than a screenshot of one.

## The inbox

The first fifteen screens were all outbound: journeys, broadcasts, templates,
reports. Nothing in them was a place where a person talks to a customer, which
is the difference between a WhatsApp automation tool and a WhatsApp CRM — and
it showed, because Contacts advertised a session timer and a *Send WhatsApp
message* button that went nowhere.

`inbox.html` is the shared queue: conversation list with unread counts and
owners, the thread, the composer, and a contact context panel. Automated sends
appear in the thread attributed to the journey or broadcast that sent them, so
a human can see what the system already said before replying.

The whole surface is organised around the constraint every WhatsApp product is
organised around — the **24-hour service window**. A contact's reply opens it,
and for 24 hours replies are free-form and free of charge. After that only an
approved template can reopen it, and Meta bills that as a business-initiated
conversation.

`inbox-session-closed.html` is that second state. The composer is replaced
rather than disabled, because the way back into the conversation is a different
action, not the same one greyed out: pick a template, fill its variables, see
the preview, send. It is the one screen that makes the Templates screen make
sense.

## The broadcast wizard

`modal-create-campaign.html` is the one screen that is a flow rather than a
page, so it is built as five real layers instead of one frozen step:

| | |
| --- | --- |
| 1 · Audience | Segment, and the opt-in funnel from 312 matched to 248 eligible |
| 2 · Template | Approved templates only, with the body exactly as Meta cleared it |
| 3 · Variables & preview | Token mapping, fallbacks, a test send, device preview |
| 4 · Schedule & send | Timing, throttle, quiet hours, and the final review |
| 5 · Queued | What was queued, when it releases, what happens without you |

`shell.js` builds the rail from the panels, so the steps are named once. Each
panel carries its own footer in a `<template data-foot>`, which is why the
primary action always names what that step does rather than saying “Next”.
Buttons marked `data-wiz="next|back|restart"` move between layers, the rail
navigates to any step already walked, and `?step=4` opens one directly — which
is also how `render.py` captures them without a browser that can click.

The rendered message deliberately appears in only two places: Templates, which
owns authoring, and step 3, which shows it with this send's values. Campaigns
shows the delivery funnel of the last send instead, because after a broadcast
goes out the useful question is what happened to it.

## The canonical dataset

Every figure was reconciled to one set of values and applied across all
screens. The full table is on the contact sheet; the short version:

- **Workspace** — Acme Growth Co, production, `ws_acme_89104`
- **User** — Ganesh S P, Owner / Admin
- **Team** — Ganesh (inbox), Priya Iyer (inbox agent), Sarah Lin (growth), Dev team
- **WABA** — +1 555-0192, Acme Growth Official, quality High, Tier 1
  (1,000 business-initiated messages/day), Cloud API v21.0
- **Contacts** — 24,892 total, 96.8% opted in, 8,412 currently in a journey
- **Stages** — Lead · Registered · Attended · Customer · Churned
- **Inbox, now** — 7 open, 4 unassigned, 5-minute first-reply SLA, 96.4% hit
- **Conversations, 30 days** — 1,842 opened, 1,791 resolved, median first reply 2.1 min
- **Messages, 30 days** — 18,420 sent, 97.5% delivered, 84.6% read
- **Journeys** — 8 built: 6 active, 1 paused, 1 draft
- **Campaigns** — 18: 12 sent, 3 scheduled, 3 drafts
- **Templates** — 14: 11 approved, 2 pending, 1 rejected
- **The webinar** — AI Marketing Masterclass, Sep 25 2026 7:00 PM IST,
  248 registered, 142 attended
- **Plan** — Engage Growth Pro, $149/month

One deliberate product point runs through the Settings and Channels screens:
the WhatsApp number belongs to the customer, connected through Meta Embedded
Signup, so Meta bills per-conversation charges to their own business account and
the $149 covers Engage only.

## Regenerating

```sh
python3 scripts/render.py   # rebuild thumbs/ and flow/ with headless Chrome
python3 scripts/check.py    # unknown icons, broken links, undefined classes
```

`check.py` exits non-zero on any finding. Both scripts assume Chrome at the
standard macOS path.

To re-pull the Stitch originals, `source/urls.tsv` holds a
`slug → html URL → screenshot URL` row per screen:

```sh
cd source
while IFS=$'\t' read -r slug html shot; do
  curl -sfL "$html" -o "$slug.html"
  curl -sfL "$shot" -o "../shots/$slug.png"
done < urls.tsv
python3 digest.py           # flatten the exports to readable text
```

Those URLs are signed and will expire; re-list the project through the Stitch
MCP server to get fresh ones. The project is **Webinar WhatsApp Automation
Engine**, id `15634464602460218258`.

## What is not here

These are mockups, not a prototype. Filters do not filter, pagination does not
paginate, and the charts are hand-plotted SVG rather than data. Where a control
could only ever be faked it says so in a toast, which is the honest version of a
dead link.
