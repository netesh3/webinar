# Engage — WhatsApp automation mockups

A walkable demo of 20 screens from the Stitch project **Webinar WhatsApp Automation
Engine**, plus the design systems they were generated against.

**Open [`index.html`](index.html)** — a contact sheet of every screen. From there the
sidebars navigate, tabs and filters filter, dropdowns are built from the sample data,
exports build a real CSV, a row's `⋮` pauses or duplicates that row, the composer sends,
the canvas takes a new step, the broadcast wizard walks all four of its steps, modals close,
and a switcher at the bottom right reaches the screens no sidebar item names.

These are **mockups, not shipped code.** Nothing here talks to the API, and none of it is
in the build. It is here to be argued about.

Fetched **24 Sep 2026**, after the designs were revised in Stitch: all fifteen screens on
the original list changed, one of them is new (*Settings — Integrations & Channels*), and
the previous revision's *Interactive Visual Journey & Branching Builder* (`364c6776…`) no
longer exists in the project, so it is no longer here either.

Five screens beyond that list were added, because buttons on the fifteen point at them and
otherwise had nowhere to go: the **WhatsApp hub** (*Manage Numbers & Templates in Hub*),
the **execution logs** (*View Activity Log*, *View Broadcast Logs*), and the **Flow
Builder** with the two other Flow Engine screens around it.

## What is in the folder

| Path | What it is |
| --- | --- |
| `index.html` | The contact sheet. Hand-written, plain CSS, works offline. |
| `screens/*.html` | The 20 Stitch exports, one file each. |
| `demo.js` | The behaviour layer — everything that is not a link. Hand-written. |
| `panels/*.html` | Panels a screen numbered and never drew, hand-written in that screen's own tokens. One file so far: the campaign wizard's steps 1, 3 and 4. |
| `shots/*.png` | A thumbnail per screen, rendered locally (see below). |
| `design-system.md` | *Precision Enterprise Comms*, verbatim — governs the Engage screens. |
| `design-system-webinarliv.md` | *Webinar Automation Engine*, verbatim — governs the rest. |
| `manifest.json` | Screen id, title and design dimensions per file. |
| `scripts/*` | `fetch.py`, `wire.py`, `render.mjs` — and `verify.mjs`, which clicks the result (see below). |

The screens load Tailwind and Inter from a CDN and their avatars from Google's CDN, so
**open them online**. `index.html` needs no network.

**The thumbnails are local renders, not Stitch's screenshots.** For this revision several
of Stitch's own captures came back with the main content area blank — Contacts and
Journeys arrived as an empty white table — while the markup itself is complete. Each
screen is instead rendered by headless Chrome at 1600px wide, which doubles as a check
that all twenty files display.

Each thumbnail is shot at the height its markup actually occupies, measured in the browser,
**not** at the design height in `manifest.json`. Those two disagree wildly — `exec-logs` is
drawn on a 2948px canvas and its markup renders 980px — so shooting at the design height
gave every screen a different slab of empty page below the content, which is what used to
make the contact sheet look ragged. Because every screen's root is `min-h-screen` a page can
never measure shorter than the window it is measured in, so `render.mjs` probes in a short
viewport first, then resizes to what it learned and shoots.

## What was changed, and what was not

The exports are downloaded whole and left alone, with three changes per file and a fourth on
one of them — three of the four fenced by comments so it is always obvious which markup is
Stitch's. Nothing Stitch drew is edited or deleted anywhere:

1. **The links were dead.** Every one was `href="#"`. Each sidebar item now points at the
   sibling file that *is* that screen, matched on the anchor's own label. Three in-page
   links are wired the same way: the dashboard's *View all* journeys, and *Go to Journeys*
   / *Journeys Canvas* in the campaigns-versus-journeys guidance card.
2. **Demo chrome was injected** before `</body>`, fenced by `<!-- demo-chrome -->` so it is
   obvious which markup is Stitch's and which is the demo's: a switcher that reaches every
   screen — necessary, since two are canvas variants, three are modals and nine live in
   other shells — and `demo.js`, the behaviour layer.
3. **One line of CSS and one error recorder.** A `<!-- demo-guard -->` listener at the top of
   every `<head>`, so `demo.js` can tell whether the screen's own script survived, and a
   single `.sr-only` rule inside the demo chrome — see the fifth wrinkle below.
4. **The panels a screen numbered and never drew were written** and injected inside a
   `<!-- demo-panels -->` fence, from `panels/`. *New Broadcast Campaign* numbers four steps
   across the top and Stitch drew the second, so its own stepper and its own *Next* had
   nothing to move to — a picture of a wizard. Steps 1, 3 and 4 are hand-written in that
   screen's own `tailwind.config` tokens, and every number in them reconciles with the step
   Stitch did draw (290 registrants, 248 recipients, 12 opted out, 9 with no number). The
   panels go in **before** the export's own body, which is what lets `demo.js` find that body
   by position — so Stitch's markup carries no demo attributes and the authored markup carries
   all of them. `wire.py` fails loudly if the comment it anchors on ever disappears, because a
   stepper with three dead steps is the exact fault these were written to fix.

### What is clickable

Nine of the twenty exports ship their own inline behaviour script, and those handlers are
the designer's intent, so they win. `demo.js` works out which elements a screen already
owns — by resolving the selectors that appear in the screen's own script — and then leaves
them alone. Three refinements to that, each one forced by a screen rather than guessed at:

- **Naming a selector is not binding one.** `journeys.html` looks up `.journey-row` only to
  hide rows as you type in its search box, so treating that as ownership left every row's
  *Options* button dead. A selector is respected only when the script binds a listener to it.
- **A listening row does not own the buttons inside it.** `campaigns.html` says so in its own
  comment: `if (e.target.closest('button')) return; // ignore more_vert clicks`. An inline
  `onclick` ancestor is the exception — that one really does fire when the click bubbles.
- **A screen whose script threw has no bindings to respect.** `wire.py` puts a one-line error
  recorder at the top of every `<head>`, so `demo.js` can tell, and takes such a screen over.
  One export needs it; see the wrinkles below.

Everything else is handled generically, by shape rather than by screen, so there is no
per-screen special-casing to drift out of date:

| Control | What it does now |
| --- | --- |
| Sidebar and in-page links | Navigate, within the screen's own shell |
| Buttons that name a screen (*+ New Journey*, *Edit Step*, *View Broadcast Logs*, *Manage in WhatsApp Hub*…) | Go there |
| Tab strips (*Pending (2)*, *Failed*, *Marketing*…) | Select, and filter the list below |
| `Status: All ▾` filter buttons | Open a menu built from that column's own values, then filter |
| Search boxes, `<select>`s | Filter the rows as you type or choose |
| Toggles | Flip |
| Canvas *Zoom In* / *Zoom Out* / *Fit* | Scale the graph, and update the percentage readout |
| A branch step on the canvas | Opens the rules screen drawn for it; other steps select |
| Modals: *Cancel*, ×, backdrop, <kbd>Esc</kbd> | Leave for wherever you came from |
| A row's `⋮` | A menu built from that row: *Pause* / *Resume* flips its own status chip, *Duplicate* adds the row named *Copy of …*, *Remove* hides it |
| *Export* / *CSV Export* / *Download* | Builds a real CSV out of the headers and the **visible** rows and downloads it, named `<screen>-<label>.csv` |
| *Columns ▾* | Offers *Hide &lt;header&gt;* per column, and hiding one drops the `<th>` and every cell under it |
| *Copy* | Really copies, via `navigator.clipboard` — the code block, payload or field beside it |
| *Connect* / *Disconnect* | Flips the card's chip and leaves the button offering the opposite verb |
| *Resend* / *Retry* | Clones the attempt to the top of the log, marked *Queued* |
| *Add Keyword*, *+ Add tag* | Adds the chip; where the row has no input, the new chip **is** the input |
| `{{token}}` chips | Append the token to the message body, or to the bubble the preview draws when no field is editable |
| Quick-reply pills, the paperclip, *Send* | Fill the composer and append the reply to the thread as a new outgoing bubble |
| A wizard's *Next* / *Back*, and the numbered steps themselves | Move between the four steps: each shows its own panel, ticks off the ones behind it, and renames the footer — *Next: Schedule & Send*, and on the last step *Send broadcast* |
| Pagination | Moves the page highlight, and says how many of the rows were drawn |
| The bell, the `?` | A panel built from whatever the screen itself timestamps, jumping to the row it names; and a pointer to this file |
| The workspace name in the sidebar | A menu: the workspace, its settings, sign out |
| *Toggle Canvas Width* | Hides the shell and frees the column beside it; a second click restores exactly what it took |
| `+` on a connector, *Add Step* | Puts a step on the canvas in that gap |
| *Delete Step* | Removes the node — or, where the screen configures one step, leaves for the canvas it was on |
| Option cards (triggers, import methods) | Become the chosen one, borrowing the classes of whichever card the design draws as chosen |
| A card that a panel asks a follow-up question for (*A contact tag*, *At a set date and time*…) | Becomes the choice, and swaps the block beneath it for the one that choice needs — a tag picker, a date, a spread window |
| A sample recipient in the wizard's variable step | Renders the preview bubble with **that** contact's values, fallback included: pick the row with no first name and it reads *Hey there* |
| *Mark as Resolved* | Flips the *Needs Reply* chip on that chat's own card in the list beside the thread |
| A strip that names sections (*Trigger* / *Blueprint*, *Flow 1*…*Flow 4*) | Selects, and scrolls to the heading it names |
| *View Log* | Opens the execution log |
| Buttons drawn **inside** a message preview | Say whose buttons they are: the recipient's, not yours |
| Everything else whose label starts with a verb | Goes *busy → done → itself*, with a toast admitting nothing is stored |
| *Edit …* / *Configure …* | Say that the screen they would open was never drawn |

Two rules the rest follows from. **No click is silently dead** — a reviewer should never have
to wonder whether they mis-clicked or found a hole in the design. And, where a control could
do the thing for real in the browser, it does: 341 of the 363 buttons now change the screen
rather than only describing what the real app would have done. The remaining 22 are the
honest ones — a button whose screen was never drawn, a recipient's button inside a preview,
an icon with no name. What none of it has is data: the numbers are Stitch's sample text,
filtering only hides rows, and a *Save* saves nothing.

Two things that look like dead clicks and are not. A **disabled** button — *Previous* on the
first page of every list — refuses the click, which is the honest answer. And a control the
export owns can answer idempotently: clicking a contact's chevron re-selects the row that is
already selected, and rendering the same drawer again is correct. `scripts/verify.mjs` lists
both rather than counting them as holes.

Five honest wrinkles in the source material, left as drawn rather than patched — except the
last, which is one line of CSS:

- **`exec-logs.html` ships a broken script.** It binds `searchInput` where its own markup says
  `id="logSearchInput"`, so it throws at `exec-logs.html:590` and everything it would have
  wired after that line — the search box, the reset, the copy-payload button — is unbound.
  This is Stitch's bug, and patching the export would mean editing the designer's output, so
  instead `demo.js` notices the failure and takes the screen over. Its tab chips still work
  because `filterByTab` is a hoisted function declaration that survived, and the search box
  is filtered by `demo.js` instead. `verify.mjs` asserts all of that, and reports the fault
  as the export's own rather than failing the run.
- **The modals sit on their own version of the parent page.** The background behind *Add &
  Import Contacts* is a different Contacts screen from `contacts.html`, with different
  sample numbers (48,290 contacts against 24,892). Same for the campaign and journey
  modals. Only one of each pair can be the real design.
- **There are three app shells here, not one.** *Engage* (Dashboard / Contacts / Journeys /
  Campaigns / Templates / Analytics / Integrations / Settings), *WebinarLiv* (Dashboard /
  Webinars / Templates / WhatsApp / Analytics / Settings — where WhatsApp is one
  integration among video destinations and calendars), and the *Flow Engine*'s **Core
  Modules** (Flow Builder / Template Library / Audience & Segmentation / Attendance &
  Engagement / Execution & Delivery Logs / Database & Webhooks). Each screen is wired with
  its **own** shell's sidebar only. Two Engage buttons deliberately cross over, because
  their destination is only drawn in another shell: *Manage Numbers & Templates in Hub* and
  *View Activity Log* / *View Broadcast Logs*. The switcher groups screens by shell, so it
  is always visible which product you are looking at.
- **Six nav items lead nowhere, because no screen was drawn for them**: WebinarLiv's
  Dashboard, Webinars, Templates and Analytics, and the Flow Engine's Template Library and
  Audience & Segmentation. They are tagged `data-demo-undrawn` and say so when clicked.
- **One `.sr-only` label made `campaigns.html` scroll 347px sideways at every window width.**
  Tailwind's `.sr-only` is `position:absolute` with no inset, so it keeps its static position —
  and campaigns puts one (*Actions*, the last `<th>`) inside a horizontally scrolling table
  whose containing block is the positioned `<main>` **outside** that scroller. The scroller
  therefore does not clip it, the invisible 1px label lands at x=1946, and the page grows to
  reach it. The demo chrome pins such a label to its containing block's origin, which cannot
  move anything visible: it is 1px square and clipped. Inputs are left alone, because the
  toggles are driven by `sr-only peer` checkboxes. This is the only change to how an export
  renders, and `render.mjs` reports any screen that still scrolls sideways.

## Provenance

Stitch project `15634464602460218258`, screens pulled through the Stitch MCP server
(`https://stitch.googleapis.com/mcp`):

| File | Screen id |
| --- | --- |
| `dashboard` | `c400350eb3d34671b4cbcf752ecc93b5` |
| `campaigns` | `e25cea4eca3b4db4a7fd33fd9d11fbb7` |
| `templates` | `4eaad0a1e5684ff0b7431d98d0e71260` |
| `contacts` | `bf6fb95f044f40c39ecea0c464ae4764` |
| `journeys` | `dadc6d6d3865474f8535f37f71b6f491` |
| `analytics` | `e1c1c74ad49342c9879966a2927d520a` |
| `settings-channels` | `7ab4567066354bd8a0d66766cc531da2` |
| `integrations` | `103af104fee941159670bb06927e703b` |
| `journey-builder` | `2a35ba581efc4e369e3d9f1c8ec34805` |
| `settings` | `43c2c6c61b3a4f6aa99417a10cbc5aa6` |
| `modal-create-journey` | `e3ed98420c2e4e189093be00f151b88d` |
| `modal-create-campaign` | `18bda2c9bbac417eaaa706036fdd6236` |
| `modal-import-contacts` | `beeb12f4d6d24947b335a1a591b74e16` |
| `journey-builder-spacious` | `2b4f6065988c4b5a8cd22bf3f3754855` |
| `step-branch-rules` | `f09bf71f1678456181040da77eb38269` |
| `whatsapp-hub` | `9d5a6c3d31494ccd8ce4b32fb7a7c0e0` |
| `flow-builder` | `f314e5f2172947a09d54fbf5d3f7e2a5` |
| `exec-logs` | `53d46fc4f7994bc5a3863d27e7069f25` |
| `attendance` | `1df87d735bba4a4c882145ab11763467` |
| `database-webhooks` | `de4e3c581b124d39a549a6c7199a7a80` |

The project also holds streamlined variants of two of these — *Attendance* and the
*WhatsApp hub* — which are not here: they are second takes on the same screen, and one of
each pair is enough to argue about.

The project holds three design systems, and Stitch's API does not record which one a given
screen used — but the exports say so themselves. Each screen inlines its palette in a
`tailwind.config`. The fourteen Engage screens carry `surface #f8f9ff` with a slate
`secondary #565e74`, which is *Precision Enterprise Comms*. The other six — both WebinarLiv
screens and all four Flow Engine screens — carry `surface #faf8ff` with an emerald
secondary and JetBrains Mono for `{{tokens}}`, which is *Webinar Automation Engine*. Both
are saved here verbatim. The third, *Fidelity Design System* (blue `#1275e2`, Inter, 8px
radii), is not used by any of these screens.

## How this relates to the real app

**The mockups are a different design system from `web/`.** They are indigo (`#3525cd`
solid, `#4f46e5` containers) on a docked sidebar in Plus Jakarta Sans with Material
Symbols icons; the app is `--color-brand #0b5cff` with its own `ui.tsx` / `controls.tsx`
primitives and no icon font. Pasting this markup into `web/` would produce a second visual
language inside one product, so treat the screens as a specification of *behaviour and
information*, not of markup.

Read against what is actually built, the screens split three ways.

**Already shipped, roughly as drawn** — the contacts CRM with consent state, who replied
and status filters; templates with the variable inspector and Meta approval state;
broadcasts to a tag or opt-in audience; drip sequences; bots; the automatic
confirmation / 24h / 1h / replay messages; the 24-hour session window that decides whether
a free-form reply is allowed; opt-out on inbound *STOP* (`internal/api/whatsapp.go:494`
also honours `UNSUBSCRIBE`, `STOP ALL`, `OPT OUT`, `OPTOUT`); and the setup checklist at
`/host/crm`. The WhatsApp hub's thread and reply exist too, per contact
(`GET /crm/contacts/{id}`, `POST /crm/contacts/{id}/send`) — what is missing there is the
hub's cross-contact *Needs Reply* queue, and the bot-handled / resolved split beside it.

**Drawn here, not built** — the visual journey builder canvas, its step palette and
per-step branch rules; journey blueprints; the attendance split after a webinar ends
(*attended / watched briefly / no-show*, each with its own follow-up — today the replay
goes to everyone registered); stop conditions and guardrails per journey; contact import
with CSV column mapping; the per-contact activity timeline; an execution / activity log;
WABA quality rating and per-contact delivery cost; the real-time activity feed;
show-up-by-channel comparison and the conversion funnels on Analytics; editable opt-out
keywords (the list is fixed in code) and outbound send throttling. Tags are the nearest
thing the app has to the mockup's segments; there is no import endpoint, no activity log
and no quality-rating field in the API today.

The five screens added from outside the original list are all in this second group, and
they are the most concrete statements of it:

- **`exec-logs`** is the activity log the Engage screens keep linking to — every attempt
  with its status and the payload sent. Today a queued message that finds no template is
  skipped in silence (`internal/api/crm_reminders.go:130`), which is exactly the case this
  screen would make visible.
- **`attendance`** turns the attendance split into cohorts with editable watch-time
  thresholds. The app records attendance but sends the replay to everyone registered.
- **`database-webhooks`** draws host-facing webhook endpoints and a payload simulator. The
  API has only *inbound* webhooks (Meta at `/api/webhooks/whatsapp`, LiveKit at
  `/api/webhooks/livekit`); nothing posts events out to a host's own systems.
- **`flow-builder`** is the same graph editor as the Engage journey canvas, drawn around
  four fixed production flows instead of a library of journeys — worth reading as two
  competing answers to the same question rather than two features.

**Drawn as one screen, split across several in the app** — the mockup's Settings holds
workspace, WABA, team, API keys and billing behind five tabs, while the app spreads the
equivalent across `/host/crm`'s Set up tab, each webinar's own settings, and `/account`.

None of the "not built" list is a small job; the journey builder in particular is a graph
editor with an execution model behind it. The value of these screens is that they say what
the finished shape looks like, so each piece can be argued for or dropped on its own.

## Re-fetching

Three scripts under `scripts/`:

```bash
STITCH_API_KEY=... python3 scripts/fetch.py   # list the project, curl -L every export
python3 scripts/wire.py                       # rewire links, inject the switcher + demo.js
node   scripts/render.mjs                     # thumbnails, headless Chrome at 1600px
```

Only the first two have an order between them. `render.mjs` used to have to run *before*
`wire.py` so the switcher stayed out of the shots; it now removes the switcher itself before
measuring, because an ordering rule that is only documented is an ordering rule that gets
broken. It also drives one browser over CDP rather than spawning Chrome per screen, which a
measure-then-shoot pass cannot afford to do twice.

`fetch.py` reads the key from the environment on purpose: it is an account credential and
has no business in a tracked file. It also names any file whose screen has left the list,
so nothing stale survives a revision. Re-running is safe — `fetch.py` overwrites each
export with a clean copy, and `wire.py` strips the `<!-- demo-chrome -->`,
`<!-- demo-guard -->` and `<!-- demo-panels -->` blocks before adding them back. The authored
panels live in `panels/`, not in the exports, so a re-fetch cannot lose them.

To add a screen that is in the project but not here, put its id and a file name in
`fetch.py`'s `WANT` and its shell in `wire.py`'s `SHELLS`; the sidebar, the switcher and
the thumbnails follow from those two lines.

A fourth script checks the result rather than trusting it:

```bash
node scripts/verify.mjs      # ~90s, 81 assertions then a sweep of all 363 buttons
TALK=1 node scripts/verify.mjs   # the same, naming the clicks that answer in words only
```

It drives Chrome over CDP with no dependencies — Node's own `WebSocket` against the
DevTools protocol — and asserts against `window.__demo`, the demo's own idea of a row and of
what a screen owns, so the checks cannot drift from the code by re-implementing it. Eighty-one
assertions cover the specific behaviours, and each one checks the *effect* rather than the
announcement: the bytes of the CSV an export actually built, a column gone from every row, the
wizard's step 3 panel shown while the export's own is hidden, a bubble added to a thread, the
sidebar's padding class put back. Then every button on every screen is clicked in turn — and
every screen is read for whether it prints the demo's own plumbing as prose, because a nested
`<!--` inside an authored panel's header comment ends that comment early and spills the
explanation across the top of the modal. It did, once.

That sweep is how *no click is silently dead* is enforced rather than hoped for. Its oracle
is a `MutationObserver` — a tab swap can be length-neutral, so diffing the markup missed it —
plus the toast deck, any menu, and counters patched onto `scrollIntoView`, `scrollTo` and
`createObjectURL`, because three of `database-webhooks`' buttons are genuinely wired to a
smooth scroll and a Blob download and touch no markup at all. Field values are snapshotted
too, because `value` is a property and not an attribute: a click that fills the composer is
invisible to a `MutationObserver`. Navigation is read from Chrome's own `Page` events, since
`location.pathname` still reads as the old page in the moment after a click that navigates.

The same oracle answers the second question — not *did it respond* but *did anything happen*.
A mutation inside the demo's own furniture (the toast deck and the menus are the only fixed
`z-index:10000` children of `<body>`) is not the screen answering, so a click that only toasts
is counted apart from one that moves something, and the run reports the split and holds it:

```
  ok   sweep: no screen prints the demo's own plumbing as prose
  ok   sweep: 363 clicks raised no error inside demo.js
  ok   sweep: every button gave some response
  ok   sweep: 341 of 363 clicks change the screen, not just talk about it
```

`TALK=1` names the other 20 per screen, which is the point of counting them: each one is a
judgement about whether a toast is the honest answer for that control.
