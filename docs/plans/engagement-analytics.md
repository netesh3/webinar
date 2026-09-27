# Engagement analytics, attendee heatmaps, scoring and WhatsApp follow-up

**Status:** Phase 1 (MVP) implemented end to end — see §0. Phases 2–3 below are still plan.  
**Page:** `/host/[id]/engagement` (linked from the Report tab). Sample data: `/mock/engagement`.  
**Related:** `docs/WHATSAPP-CRM-PLAN.md`, `docs/engage/V1.md`, `docs/engage/features/analytics.md`

---

## 0. What Phase 1 built

### Architecture

```
 attendee browser ──POST /say (reaction|hand)──► say.go ──SendData──► LiveKit   (relay unchanged)
                                                   │ after the send, never blocks
                                                   ▼
                          capture.Recorder  (bounded chan 16k · per-sender limit · drop+count)
                                                   │ every 1s or 1,000 rows
                                                   ▼ COPY
 attendance_visits ─┐                       engagement_events (0059)
 chat_messages ─────┤                                 │
 session_questions ─┤  store.EngagementInput: ONE pipelined batch, read-only repeatable-read tx,
 question votes ────┤  every query bounded by webinar_id; events grouped per person/minute in SQL
 polls, poll_votes ─┘                                 │
                                                      ▼
                          engagement.Compute (pure, no I/O)  ◄── Formula registry (v1 …)
                                                      │            Components: watch, polls, quiz,
                                                      │            chat, qa, reactions, hands, survey
                                                      ▼
            store.SaveEngagement: advisory xact lock · skip if newer · upsert snapshot · COPY scores
                     │                                       │
      engagement_snapshots (0060, jsonb summary)   engagement_scores (0060, one row per attendee)
                     │                                       │            │
     GET /engagement (raw bytes)       GET /engagement/attendees (SQL sort/filter/page)
                                        GET /engagement/attendees/{identity} (+ timeline)
                                        GET /engagement.csv (streamed)
                                                             └──► CRM segment `tiers` (broadcasts)
```

When numbers are computed (`api/internal/engagement/service`):

- **On end** — `endWebinarSession` computes right after the attendance report, so the first
  host to open the page reads a stored snapshot.
- **Lazily** — any read checks freshness: an ended webinar's snapshot must be newer than
  `ended_at`; a live one's younger than 30 s. Stale or missing → recompute.
- **Single-flight** — concurrent requests for one webinar share one compute, which runs on its own
  context (a caller hanging up does not cancel it for the others). Across instances,
  `SaveEngagement` serialises on a per-webinar advisory lock and skips a write older than the stored one.
- **Formula bump** — snapshots are keyed by `formula_version`; a new version simply has no
  snapshot yet and is computed on first read. Old versions stay registered and readable.
- **Manual** — `POST /engagement/recompute` for late corrections.
- Before computing, the in-process capture buffer is flushed so the host's own last seconds are counted.

### Migrations

| # | Adds |
|---|---|
| `0059_engagement_events.sql` | Append-only `engagement_events` (reaction, hand_raise, hand_lower, stage_on, stage_off), payload ≤ 256 B, indexed `(webinar_id, occurred_at)`, `(webinar_id, identity, occurred_at)`, `(occurred_at)` for pruning. |
| `0060_engagement_scores.sql` | `engagement_snapshots` (PK webinar_id + formula_version, jsonb payload) and `engagement_scores` (one row per attendee: score, tier, watch, join timing, counts, components, presence/intensity arrays) with index-backed sorts (score, watch, join, name), tier filter and `registration_id` for CRM segments. |

The plan's `0060_surveys` / `0061_engagement_scores` numbering moved: scores are 0060; surveys will be the next free number.

### Endpoints (host + co-hosts only, `requireOwnership` group under `/api/host/webinars/{slug}`)

| Method | Path | Returns |
|---|---|---|
| GET | `/engagement` | `EngagementSummary` — KPIs, index, tiers, retention, join histogram, activity, markers, polls, reactions, chat, questions, callouts, weights, axis. `state` = `not_started` · `no_audience` · `ready`. |
| POST | `/engagement/recompute` | Same, freshly computed. |
| GET | `/engagement/attendees?sort=score\|name\|watch\|join&dir=&tier=a,b&q=&cursor=&limit=` | `EngagementAttendeePage` — rows, total, `nextCursor`, axis. Limit ≤ 200. |
| GET | `/engagement/attendees/{identity}` | `EngagementAttendeeDetail` — row, score breakdown, visits, timeline (≤ 400, newest kept), reactions, WhatsApp opt-in. Anonymous questions are never attributed. |
| GET | `/engagement.csv` | Streamed CSV, one row per registrant (no-shows included) and per scored guest; spreadsheet-formula cells escaped. |

Every read is keyed by the id resolved from the authorised slug. Only `att_` identities are
scored — hosts, panelists and co-hosts never appear. Raw events are pruned after 90 days
(sweeper, lease `engagement-retention`); snapshots and scores are kept like the report.

### Capture (`api/internal/engagement/capture`)

- `Record` is a non-blocking send into a 16,384-slot channel (~200 ns, 1 alloc). Full → dropped and counted.
- Per sender (webinar + identity), a token bucket of 30 reactions/min and 10 hand events/min;
  over the limit is counted as `limited`, and the relay still delivers it — only the copy is skipped.
- One writer goroutine flushes every 1 s or at 1,000 rows via `COPY`; webinar slugs are resolved to ids once per batch.
- `Close` drains on shutdown, after the HTTP server stops (main.go). Stats: accepted, limited, dropped, written, failed.
- Stage promote/demote is recorded as `stage_on`/`stage_off` (`webinar_stage_grants` has no end time).

### Performance (Apple M5 Pro, local Postgres 18)

Pure compute (`go test ./internal/engagement -bench Compute -benchmem`):

| Input | Time | Alloc | Summary JSON | Row JSON |
|---|---|---|---|---|
| 500 people, 10k events, 60 min | 1.3 ms | 1.3 MB | 11 KiB | 414 B |
| 5,000 people, 100k events, 90 min | 18 ms | 13 MB | 13 KiB | 463 B |
| 5,000 people, 100k events, 4 h | 16 ms | 14 MB | 17 KiB | 477 B |

Against the database (`TEST_DATABASE_URL=… go test ./internal/store -bench Engagement -benchtime 5x`),
5,000 attendees, 6,000 visits, 15,000 chat lines, ~16,500 votes, 100,000 events (worst case —
no two events share a person-minute, so 100k groups):

| Step | Time |
|---|---|
| Load (one pipelined batch) | 113 ms |
| Compute | 14 ms |
| Save (snapshot + COPY 5,000 scores) | 160 ms |
| Attendee page (offset 2,500, 2 tiers) | 10 ms |
| Attendee drawer | 0.4 ms |

So a full recompute at the target scale is ≈ 0.3 s, at most once per 30 s per live webinar,
and served from storage otherwise. The summary stays bounded because every series is
resampled: heatmap ≤ 36 columns (`niceStep`), activity ≤ 120, retention ≤ 360 points;
a test asserts the 5k summary is < 64 KiB. Heatmap rows are never sent in bulk — the table
pages 50 at a time.

### Extension points

- **A new score term (surveys, ratings, attendance streaks):** implement `engagement.Component`
  (`Key`, `Label`, `Weight`, `Applies(Usage)`, `Ratio(Signals)`), add it to a new `Formula`
  version and `Register` it. Its data arrives as `Input.Extra[identity][signal]` and its
  session usage as `Input.ExtraUsage[key]`, loaded by one more query in `EngagementInput`.
  Nothing in `Compute`, the store or the handlers changes. The v1 survey component already
  exists with weight 5 and `Applies` false until a source sets `ExtraUsage["survey"]`,
  so its weight is redistributed today (tested).
- **A new captured event kind:** add it to the `kind` CHECK (new migration), a `capture.Kind`,
  and a case in `collectEvents`/`Timeline`.
- **WhatsApp segments:** `CRMSegment.Tiers` (`high|engaged|passive|risk`) narrows a broadcast
  segment audience to registrations whose latest `engagement_scores.tier` matches — validated in
  the handler, written as a fixed literal list, labelled "Highly engaged or Engaged". No-shows
  stay `attendance: no_show`. The Follow-up panel still says "Coming soon"; nothing is sent from it.
- **Frontend data:** components read an `EngagementSource` (`web/lib/engagement/source.ts`):
  `apiSource(slug)` for real data, `fixtureSource()` for dev-bypass and `/mock/engagement`.
  A new backend field is one Go struct field → `make types` → used by a component.

### Frontend

- `web/app/host/(portal)/[id]/engagement` — a page, not a tab: it is wide, has its own drawer,
  paging and polling, and the Report tab is already dense. The Report tab links to it
  ("Open engagement dashboard") and is otherwise unchanged.
- `web/lib/engagement/*` — source adapters, hooks (summary polls every 30 s while live;
  attendee pages keyed by query, aborted on change), query/paging, score maths shared with Go
  through `score_cases.json`, chart maths. `web/components/engagement/*` — presentational
  pieces (hero, KPI grid, SVG charts, heatmap, detail tabs, drawer, follow-up, states).
- Loading, empty (`not_started`, `no_audience`), error and signed-out states; no new dependencies.
- `/mock/engagement` is kept: same components over `fixtureSource()`, for design review with no backend.

### Deferred / uncertain

- Offset cursors: fine for a webinar's bounded rows (they only change on recompute); keyset paging if pages must stay stable across a live recompute.
- The load's event query dominates at 100k events; if webinars grow well beyond that, group per person per heatmap column in SQL (the axis can be computed before the load).
- Capture is per instance; a crash (not a graceful stop) loses up to ~1 s of reactions. Acceptable for a soft signal.
- `stage_on/off` are captured but not yet scored or charted.
- Surveys/ratings (0061+), WhatsApp composer and scheduled follow-ups — Phases 2–3 below.

---

## 1. Why

A coach finishes a webinar and has three questions. The product answers each one only
partly today:

1. **How did it go?** The Report tab shows Registered / Attended / Avg watch, an attendance
   table and a list of questions. There is no single "was this good" number, no retention
   curve, and nothing about chat, polls, quizzes or reactions.
2. **Who actually took part?** You can see who was in the room and for how long. You can't see
   who chatted, voted, answered the quiz correctly or reacted, and there's no ranking.
3. **What should I do next?** Engage v1 can already send a WhatsApp broadcast to a *segment*
   (attended / no-show / watched ≥ N min / replied). Engagement isn't one of the segment
   inputs, so "send the offer to people who were really engaged" isn't possible yet.

This plan adds one **Engagement** page per webinar that combines everything, a transparent
**Engagement Score** per attendee, an **attendee heatmap**, post-event **surveys and
ratings**, and then (phase 2/3) lets engagement tiers feed the WhatsApp follow-up that
already exists.

### Personas

| Persona | Needs | Doesn't want |
| --- | --- | --- |
| **Coach (host)**: non-technical, runs 1–8 webinars a month and sells a programme at the end | One number and one sentence; who to follow up with; a list to message | Analyst jargon, pivot tables, having to set things up |
| **Co-host / assistant**: handles follow-up and the inbox | Segments with counts, CSV export, the per-person timeline before replying on WhatsApp | Changing the webinar |
| *(later)* **Agency / team owner** | Compare webinars and trends over time | — |

### Questions the dashboard answers (top to bottom)

1. Was this session good? → **Engagement index** gauge + a one-line summary + three call-outs
   (best moment, biggest drop, topic that needs a recap).
2. How many came, and how many stayed? → KPIs, **retention curve**, join-time histogram.
3. When were people most active? → **activity heatmap** by minute and type, lined up with
   poll, quiz, Q&A and offer markers.
4. Who took part and who didn't? → **tiers** + **attendee heatmap** → per-person drawer.
5. What did they say or answer? → Chat, Q&A, Polls & quizzes, Reactions and Survey tabs.
6. Who should I message, and with what? → **Follow-up** panel → WhatsApp composer.

---

## 2. What is captured today (investigation)

Identity scheme: attendees are `att_<joinkey>`, stage people are `user_<uuid>`
(`api/internal/api/join.go`). Every table below is keyed on `(webinar_id, identity)`.

| Signal | Persisted? | Where | Notes |
| --- | --- | --- | --- |
| Registration | ✅ | `registrations` (0001), phone (0009) | `state` approved/pending; WhatsApp consent lives on `crm_contacts.whatsapp_opt_in_at/opt_out_at` (0042), set by `WhatsAppOptInCheckbox` in `web/components/register-form.tsx` |
| First join / last seen | ✅ | `attendance` (0031) | One row per person. `first_joined_at`, `last_seen_at`, `registration_id`, name (0034) |
| **Visits (join → leave, rejoins)** | ✅ | `attendance_visits` (0040) | One row per visit. Opened on LiveKit `participant_joined`, closed on `participant_left` / `room_finished` / host end (`store.OpenVisit`, `CloseVisit`, `CloseOpenVisits` in `api/internal/store/attendance.go`). A partial unique index allows only one open visit per person |
| Watch time | ✅ derived | `attendance.go` `SessionReport` / `attendanceRows` | Summed visit seconds **clipped to `webinars.started_at..ended_at`**, so lobby time isn't counted. Headline figures cover attendees only (`att_` prefix) |
| Drop / rejoin | ✅ derived | `attendance_visits` | Gaps between visits; `AttendanceRow.Visits[]` already goes to the browser |
| Per-minute presence | ⚠️ derivable | `attendance_visits` | No stored timeline, but it can be computed exactly from visit intervals with `generate_series`. **Nothing new needs capturing.** |
| Chat messages | ✅ | `chat_messages` (0008), mentions (0056) | Sender identity/role, `created_at`, text/image, destination. `ChatStats` exists (`store/chat.go`). Deletions are tracked (`chat_deleted.go`) |
| Q&A questions | ✅ | `session_questions` (0031) + `role` (0057) | Written from `/say` (`api/internal/api/say.go` → `UpsertSessionQuestion`). Has `answered`, `pinned`, `dismissed`, `upvotes`, `anonymous` |
| Question upvotes | ✅ | `session_question_votes` (0057) | One row per (question, voter), with `created_at`, so votes are attributable and timed |
| Polls & quizzes | ✅ | `polls`, `poll_votes` (0007) | `kind` poll/quiz, `correct_option`, `opened_at`/`closed_at`; one vote per person per poll with `voted_at`. **Correctness is derivable** (`choice = correct_option`) |
| **Reactions** | ❌ **realtime only** | `say.go` (`MsgReaction`) | Relayed over the LiveKit data channel and never stored. The comment in `say.go` says "questions, hands, reactions — are not persisted" (questions have since been persisted). The closed emoji set is 👏 👍 ❤️ 😂 🎉 😮 |
| **Raised hands** | ❌ realtime only | `say.go` | Same path as reactions |
| Stage time | ⚠️ partial | `webinar_stage_grants` (0002) | `granted_at` only, no revoke time. Visits for `user_` identities give time in room, not time on stage |
| Captions / transcript | ✅ | `session_captions` (0033), `AppendCaption` | Useful later for "what was said at minute 37" |
| Session summary | ✅ | `webinars.report` jsonb | `ComputeAndSaveReport` stores `{attended, avgWatchMin, questions}` when the webinar ends |
| Ratings / surveys / NPS | ❌ | — | Not present anywhere |
| Replay viewing | ⚠️ | `store/replay.go`, `watch.go` | Separate path, not unified with live attendance (out of scope for MVP) |

### Current Report tab

`ReportTab` in `web/components/host-webinar-tabs.tsx` (≈ line 608) calls
`api.sessionReport` → `GET /api/host/webinars/{slug}/report`. It shows three `Stat` tiles
(Registered, Attended + approved, Avg watch + poll voters), the `AttendanceTable` (per-person
visits and watch minutes) and a question list. CSV export
(`GET …/report.csv`, `handleExportReport`) and transcript are available. Dev bypass uses
`BYPASS_REPORT` / `BYPASS_ATTENDANCE` fixtures in the same file.

### Gaps

1. **Reactions and hand raises aren't stored.** This is the only true capture gap; everything
   else is aggregation.
2. No per-minute presence or retention series, peak concurrency or join-time distribution
   (all derivable).
3. No per-attendee interaction totals, score or tier.
4. No ratings, surveys or NPS.
5. No stage revoke time (minor).
6. The Report tab has no charts, and the only chart library use is recharts in
   `admin-dashboard.tsx`.

### Messaging infrastructure already in place (WhatsApp is mostly built)

The earlier plan assumed WhatsApp would be new work. It isn't. Engage v1 has already shipped:

| Piece | Where |
| --- | --- |
| Meta Embedded Signup; per-host WABA token, phone number id, coexistence with the Business app | migrations 0041, 0053; `api/internal/engage/whatsapp.go`, `api/internal/wa/` |
| Contacts with WhatsApp opt-in/opt-out timestamps; **STOP** keyword honoured | 0042; `engage/crmstore/crm.go`; `whatsapp.go` ≈ line 432 |
| Template cache synced from Meta (name + language) | 0043 `crm_templates` |
| **One outbox** (`notifications`) with `channel = whatsapp`, `due_at`, attempts, backoff and a consent re-check at send time | 0010, 0044 |
| Reminders (confirmation / 24h / 1h / replay) on host-chosen templates | 0044, 0049 |
| **Broadcasts** scheduled at `scheduled_at` to audience `opted_in / webinar / tag / segment / contacts` | 0045, 0049, 0053 |
| **Segments**: `CRMSegment{attendance, minWatchMin, maxWatchMin, replied}` | `api/types/types.go` ≈ line 1600; `crmstore/crm_broadcasts.go` `segmentPredicate` |
| **Drips** triggered by `registered / attended / no_show / ended / tag_added / manual` | 0046, 0049; `CRMDripTriggersOnTagAdded` test |
| Tags and notes | 0049 |
| Delivery / read status from Meta webhooks into `crm_messages.status` | 0042, 0045, 0053 |
| Sweeper with leases (`/internal/tick`) | `api/internal/api/tick.go`, 0051 |

What's **missing** for engagement-based follow-up: segment fields for tier and score
(and "answered quiz wrong", "asked a question", "no survey"), a delay-after-end schedule
relative to `ended_at`, quiet hours (nothing in `wa/send.go` or the broadcast path handles
them), and a send-rate throttle per WABA.

---

## 3. Metric definitions

"Live window" means `webinars.started_at .. COALESCE(ended_at, now())`, as in
`attendanceWindow`. `S` is the session length in minutes. Attendees are identities with the
`att_` prefix. Stage people are listed but excluded from every headline figure.

| Metric | Formula | Notes |
| --- | --- | --- |
| **Attendance rate** | `attended / registered` (approved registrations if approval is on) | `attended` = distinct `att_` identities with ≥ 1 visit. Show no-shows = `registered − attended` |
| **Watch time (per person)** | `Σ visits clip(left, joined, window)` in seconds, rounded once | Already implemented; lobby excluded |
| **Avg / median watch** | mean and median of per-person watch time | Median resists early leavers; show both |
| **Watch % of session** | `watch_min / S` per person; the session figure is the mean | Capped at 100% |
| **Join-time bucket** | `early` if first join < `started_at`; `on_time` if ≤ +5 min; `late` otherwise | The 5-min grace period is a setting (open question) |
| **Retention at minute m** | `count(att where ∃ visit covering m)` | `generate_series(started_at, ended_at, '1 min')` joined to visits. Lobby minutes (−10..0) are drawn but greyed |
| **Retention %** | `retention(m) / attended` | "72% stayed past halfway" = share with `last_leave > S/2` |
| **Peak concurrent** | `max_m retention(m)` and its minute | |
| **Biggest drop** | `max over m of retention(m) − retention(m+5)` | For the call-out |
| **Chat participation** | `distinct chatters / attended`; messages per chatter | Excludes deleted messages and stage senders |
| **Q&A** | asked, answered, unanswered, upvotes; `askers / attended` | Dismissed questions count as asked but get no score |
| **Poll response rate** | `Σ votes / Σ live_at_open(poll)` over polls | Denominator = people present when the poll opened, which is fairer than `attended` |
| **Quiz accuracy** | `correct votes / quiz votes`; per person `correct / quizzes launched` | |
| **Reactions** | count, per attendee, by emoji and by 5-min bucket | Needs the new capture |
| **Survey** | response rate = `responses / attended`; avg rating; **NPS** = `%promoters(9–10) − %detractors(0–6)` | |
| **Activity intensity (minute m, type t)** | count of events of type t in minute m | Types: chat, qa (ask / upvote / hand), poll (poll + quiz votes), reaction |

### 3.1 Engagement Score (per attendee, 0–100)

The score is a **transparent weighted sum of capped ratios**. Every component is shown in the
drawer ("Why 88?"). Caps stop spam from gaming it: 50 chat messages score the same as 5.

| Component | Weight | Ratio (0..1) | Cap / rule |
| --- | --- | --- | --- |
| Watch time | **40** | `watch_min / S` | — |
| Polls answered | **15** | `polls_answered / polls_launched_while_present` | 0 if no polls ran (weight redistributed, see below) |
| Quiz accuracy | **10** | `quiz_correct / quizzes_launched_while_present` | Unanswered counts as wrong |
| Chat | **10** | `min(msgs, 5) / 5` | Only messages ≥ 2 chars; duplicate bodies within 10 s count once |
| Q&A | **10** | `min(1, asked/2 + 0.5 · upvotes_given/5)` | Asking is worth more than upvoting |
| Reactions | **5** | `min(reactions, 10) / 10` | Server already rate-limits `/say` at 90/min |
| Raised hand | **5** | `min(hands, 1)` | |
| Survey completed | **5** | 1 if submitted | Arrives after the event, so the score is recomputed |

`score = round( Σ weight_i · ratio_i )`

**Redistribution.** If a tool wasn't used in a session (no quiz, surveys off, reactions
disabled), its weight is spread across the remaining components in proportion, so a
chat-only session isn't capped at 75. The drawer then shows only the components that applied.
(The mock uses fixed weights because every tool ran.)

**"While present".** A poll launched while someone was out of the room doesn't count against
them. The denominator is polls whose `[opened_at, closed_at]` overlaps a visit.

**Tiers**

| Tier | Score | Coach-facing meaning | Default follow-up |
| --- | --- | --- | --- |
| Highly engaged | ≥ 75 | Stayed and took part throughout | Offer / call booking |
| Engaged | 50–74 | Stayed and took part a little | Thanks + replay + offer |
| Passive | 25–49 | Mostly watched, little interaction | Replay with the key-moment timestamp |
| At risk | < 25 | Left early or barely joined | "Here's what you missed" + replay |
| *No-show* | — | Registered, never joined | "We missed you" + replay |

Thresholds are constants for the MVP and a per-account setting later.

**Session engagement index** = mean attendee score, shown as a 0–100 gauge with a band:
Excellent ≥ 70, Strong ≥ 55, Good ≥ 40, Needs attention < 40. The one-line summary is
generated from a template, not an LLM (for example `"{band} session — {stayedPastHalf}% stayed
past the halfway mark, and {chatPct}% joined the conversation."`).

**Versioning.** Store `score_version` with each score so a later formula change doesn't
silently rewrite history. Old webinars keep their original number until someone explicitly
recomputes.

---

## 4. Heatmaps

### 4.1 Attendee heatmap (people × time)

* Rows are attendees, sortable by score (default), name, watch time or join time, filterable
  by tier, with name search.
* Columns are 5-minute buckets (1-minute buckets available in the drawer). The lobby
  column(s) are separated by a small gap.
* Cell colour: grey = not present; pale blue = present with no interaction (lighter if present
  < 60% of the bucket); three stronger blues = 1, 2–3 and 4+ interactions.
* Clicking a row (or pressing Enter / Space) opens the **attendee drawer**: KPIs, a presence
  bar with drops and rejoins, the score breakdown, reactions, a full timeline (join, chat,
  question, upvote, poll answer, quiz answer ✓/✗, hand, leave), survey answers and WhatsApp
  consent state.
* API: `presence[]` and `intensity[]` arrays per attendee, so a 500-person webinar sends
  500 × 14 small ints.

### 4.2 Session activity heatmap (type × minute)

* Four rows (Chat, Q&A, Polls & quizzes, Reactions) × S one-minute columns. Opacity is
  normalised per row so a quiet type still shows its peaks.
* Markers above the grid: poll and quiz opens (`polls.opened_at`), Q&A open (new
  `session_markers` entry, see §6), offer and CTA moments, rating prompt.
* The same markers appear on the retention curve so "people left right after the pitch" can
  be seen at a glance.

---

## 5. Interactive tools to add or extend

| Tool | State | Change | Score impact |
| --- | --- | --- | --- |
| Polls | ✅ | Add a `closed_at`-based "live at launch" denominator; optional multi-select later | Polls answered (15) |
| Quizzes | ✅ | Add optional per-quiz explanation shown after close | Quiz accuracy (10) |
| Votes (Q&A upvotes) | ✅ | — | Q&A (10) |
| **Reactions** | realtime only | **Persist** (§6) | Reactions (5) |
| **Raised hand** | realtime only | **Persist** | Hand (5) |
| **In-session rating** | ❌ | New poll `kind = 'rating'` (1–5 stars) the host launches like a poll. Reuses the polls UI, vote path and "one vote per person" PK | Counts as a poll answered; the average shows in the Survey tab |
| **Post-event survey** | ❌ | Survey builder per webinar with a default template: overall rating (1–5), NPS (0–10), "What was most useful?", "What should I improve?", optional multiple choice. Shown **in the room when the host ends** (end screen) and **by email / WhatsApp link** after `ended_at` + delay, with a tokenised link and no login | Survey completed (5); rating and NPS go to the Survey tab |
| Ratings on replay | later | Same survey, `source = 'replay'` | Not in the live score |

Survey builder UX: one screen, the default questions ticked, "Add question", "Send after end:
immediately / 1 h / next morning", "Also ask on the end screen". Coaches shouldn't have to
build anything to get NPS.

---

## 6. Data model changes

Numbers continue from 0058. Every change is additive, and existing reports keep working.

### 0059_engagement_events.sql — append-only interaction log (the capture gap)

```sql
CREATE TABLE engagement_events (
    id         bigserial PRIMARY KEY,
    webinar_id uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    identity   text NOT NULL,
    kind       text NOT NULL CHECK (kind IN ('reaction','hand_raise','hand_lower','cta_click','marker')),
    value      text NOT NULL DEFAULT '',   -- emoji, marker label, CTA id
    at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX engagement_events_webinar_idx ON engagement_events (webinar_id, at);
```

* Written from `handleSay` for `MsgReaction` / hand kinds **after** relaying, fire-and-forget
  (a failed insert must never delay a reaction on screen). At 500 people × 90 msgs/min
  worst case, batch inserts from an in-process buffer flushed every 2 s or 200 rows.
* Chat, questions, upvotes and poll votes are **not** copied here. They already have tables
  with timestamps, and a second copy would be a second answer (the same reasoning as the
  0044 outbox comment). The aggregation reads all five sources.
* `marker` rows record host actions without a table of their own: "Q&A opened", "offer
  shown", "rating prompt". Poll and quiz markers come from `polls.opened_at`.
* Optional: `webinar_stage_grants.revoked_at timestamptz` for true stage time.

### 0060_surveys.sql

```sql
CREATE TABLE surveys (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    webinar_id   uuid NOT NULL UNIQUE REFERENCES webinars(id) ON DELETE CASCADE,
    enabled      boolean NOT NULL DEFAULT true,
    send_delay_minutes int NOT NULL DEFAULT 60,
    ask_on_end_screen boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE survey_questions (
    survey_id uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    position  int  NOT NULL,
    kind      text NOT NULL CHECK (kind IN ('rating5','nps','choice','text')),
    prompt    text NOT NULL,
    options   jsonb NOT NULL DEFAULT '[]',
    required  boolean NOT NULL DEFAULT false,
    PRIMARY KEY (survey_id, position)
);
CREATE TABLE survey_responses (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    survey_id    uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    identity     text NOT NULL,              -- att_… ; registration_id resolves the person
    registration_id uuid REFERENCES registrations(id) ON DELETE SET NULL,
    source       text NOT NULL CHECK (source IN ('end_screen','email','whatsapp','replay')),
    answers      jsonb NOT NULL,             -- [{position, value}]
    submitted_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (survey_id, identity)             -- one response each; re-submit = update
);
```

* The in-session rating reuses `polls` with `kind = 'rating'` (extend the CHECK and the
  `correct_option` constraint).
* Survey link token: an HMAC of `(survey_id, registration_id)`, like the existing join keys.
  No login is required.

### 0061_engagement_scores.sql — materialised per webinar

```sql
CREATE TABLE engagement_scores (
    webinar_id    uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    identity      text NOT NULL,
    registration_id uuid REFERENCES registrations(id) ON DELETE SET NULL,
    score         smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
    tier          text NOT NULL CHECK (tier IN ('high','engaged','passive','risk')),
    components    jsonb NOT NULL,        -- [{key, weight, ratio, points, detail}]
    counts        jsonb NOT NULL,        -- chats, questions, upvotes, polls, quiz_correct, reactions, hands, survey
    watch_seconds int NOT NULL,
    first_join    timestamptz,
    last_leave    timestamptz,
    presence      smallint[] NOT NULL,   -- per 5-min bucket, % present
    intensity     smallint[] NOT NULL,   -- per 5-min bucket, interactions
    score_version smallint NOT NULL DEFAULT 1,
    computed_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (webinar_id, identity)
);
CREATE INDEX engagement_scores_tier_idx ON engagement_scores (webinar_id, tier);
ALTER TABLE webinars ADD COLUMN engagement jsonb;  -- session summary: index, retention[], activity{}, KPIs
```

The session series (retention per minute, activity per minute per type) goes on
`webinars.engagement` next to the existing `webinars.report`. It's small (≈ 5 × S ints) and
read whole.

### Phase-2 WhatsApp additions (extend what exists; no parallel `whatsapp_*` stack)

* `CRMSegment` gains `tiers []string`, `minScore`, `maxScore`, `askedQuestion bool`,
  `quizWrong bool`, `surveyDone *bool`. `segmentPredicate` joins `engagement_scores` on
  `registration_id`. The broadcast row already stores the segment as jsonb, so it reads back
  as "Highly engaged · opted in".
* `crm_broadcasts.send_after_end_minutes int NULL`: when set and the webinar hasn't ended,
  `scheduled_at` is resolved when the webinar ends (the same hook that fires the
  `attended` / `no_show` drips).
* `users.whatsapp_quiet_start/quiet_end time`, `quiet_tz text` (default the webinar time
  zone). The outbox sweep defers `due_at` to the end of quiet hours.
* New drip triggers `engagement_tier` (with `trigger_tier`) and `survey_submitted`.
  Automatic follow-up is then "a drip on tier X", not a new engine.

### Retention, privacy, consent

* Engagement data is personal data about named people. It's visible only to the webinar
  owner and co-hosts (the existing `requireOwnership` check), and never to attendees.
* `engagement_events` rows are raw. Keep them for **90 days**, then delete them (the sweep
  already exists); `engagement_scores` and the session summary remain. Deleting a webinar
  cascades.
* A registrant deletion or GDPR request removes their `engagement_scores` and
  `survey_responses` rows, keyed by `registration_id`.
* Privacy policy (`web/app/privacy`): add a line saying the host sees participation
  (attendance, chat, answers, reactions) linked to your registration.
* Survey comments are free text. Show them only to the host and don't template them into
  messages.
* **WhatsApp consent** stays as it is: an explicit, unticked checkbox at registration with a
  phone number, `crm_contacts.whatsapp_opt_in_at`, re-checked at send time, and STOP
  honoured. Engagement segments *narrow* the opted-in set and never widen it.
* Anonymous Q&A stays anonymous in the dashboard: it isn't attributed in the drawer and
  doesn't count toward that person's score.

---

## 7. API and aggregation

### Endpoints (host-only, under `/api/host/webinars/{slug}`)

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/engagement` | Session summary: KPIs, index, band, summary sentence, retention[], joinHistogram[], activity{type:[]}, markers[], tier counts, polls[] with tallies, reactions by emoji and bucket, survey aggregates |
| GET | `/engagement/attendees?tier=&q=&sort=&cursor=` | Paged rows: identity, name, email, score, tier, watch, firstJoin, presence[], intensity[] |
| GET | `/engagement/attendees/{identity}` | Drawer: visits, full event timeline, components, survey answers, consent |
| GET | `/engagement.csv` | One row per registrant (no-shows included): name, email, phone-if-consented, join, leave, watch, rejoins, chats, questions, upvotes, polls, quiz correct, reactions, hands, survey rating, NPS, score, tier |
| POST | `/engagement/recompute` | Host-triggered recompute (idempotent) |
| GET/PUT | `/survey` | Builder |
| GET/POST | `/api/s/{token}` | Public survey form and submit |

Two GETs paint the page, matching the rule in `docs/engage/features/analytics.md`.

### When numbers are computed

1. **On webinar end.** Where `ComputeAndSaveReport` runs today, compute
   `engagement_scores` and `webinars.engagement` in one transaction. For 500 attendees this is
   a handful of grouped queries over indexed `(webinar_id, …)` tables, well under a second.
2. **Incrementally afterwards.** A survey response, a late-closed visit (the backstop in
   `recordings.go`) or a host recompute recomputes one person's score and patches the session
   summary. Cheap, because it's one identity.
3. **While live (later).** A "Live engagement" strip in the host room reads the same functions
   on demand (cached 15 s). This isn't needed for MVP.
4. The functions are **pure** (inputs → score), mirrored in `web/lib/engagement-score.ts`, with
   a shared test table so Go and TS agree.

---

## 8. WhatsApp scheduled follow-up (phase 2 / 3)

### Approach

Build on Engage v1 as it stands. That means the **official WhatsApp Business Platform
(Cloud API)** via the host's own WABA from Embedded Signup. The host is billed by Meta on
their own account (0041 comment), so no BSP is needed. A BSP (Twilio, Gupshup, 360dialog,
etc.) would only matter for hosts who can't complete Embedded Signup, and that's out of
scope.

### Constraints to design around (verify against current Meta docs before build)

* **Templates required for business-initiated messages.** Outside the 24-hour
  customer-service window that opens when the contact messages you, only **Meta-approved
  templates** can be sent. Post-webinar follow-ups are almost always outside that window. The
  composer therefore only offers approved templates from `crm_templates`, and free text is
  allowed only when the window is open (the inbox already handles this).
* **Template categories.** *Utility* (e.g. replay ready, survey link tied to the event they
  registered for) vs *Marketing* (offers and promotions). Meta decides the category and can
  re-categorise it. An "offer" template is Marketing.
* **Pricing** ⚠️: Meta moved from per-conversation to **per-message pricing for template
  messages from 1 July 2025**. Marketing costs more than Utility, and utility templates sent
  inside an open service window are free. Rates vary by recipient country. Show "N marketing
  messages, billed by Meta to your WABA" and don't hard-code prices. *Re-verify rates and
  rules at build time; this has changed repeatedly.*
* **Marketing limits** ⚠️: Meta applies per-user marketing message caps and may not
  deliver (error 131049) when a user has had many marketing messages recently. As of 2025
  Meta also paused marketing templates to +1 (US) numbers. Treat delivery failures as normal
  and surface them in stats. *Verify current status.*
* **Throughput and tiers.** New numbers start at a messaging limit of unique contacts per
  24 h (tiered, rising with quality). The sweep should throttle per WABA
  (≈ tens of msgs/sec is safe; Cloud API supports more) and respect `429` / error 130429 with
  backoff, which the outbox's attempts/backoff already provide.
* **Quality rating.** Blocks and reports lower number quality and can restrict sending. So:
  consent-only audiences, no CSV upload (already a rule in 0045), a frequency cap (default
  ≤ 1 marketing message per contact per 24 h from this product), and quiet hours.
* **Opt-out.** STOP is already handled. Also include a "Reply STOP to opt out" footer
  suggestion when creating marketing templates, and honour Meta's "Stop promotions" button
  events if the webhook delivers them (to confirm).
* **Status webhooks.** `sent → delivered → read / failed` already land in
  `crm_messages.status`. Broadcast stats already count them.

### Rules the coach configures (UI: Follow-up panel → composer)

| Segment | Suggested template | Default timing |
| --- | --- | --- |
| Highly engaged | `thanks_offer` (Marketing) | 30 min after end |
| Engaged | `thanks_offer` or `replay_ready` | 2 h after end |
| Passive | `replay_ready` (Utility) with the key-moment timestamp | Next morning, 10:00 local |
| At risk | `replay_ready` | Next morning |
| No-shows | `missed_you` / `wa_replay` (exists) | When the replay is shared (exists) |
| Asked a question that wasn't answered | `question_followup` | 1 h after end |
| No survey yet | `survey_link` (Utility) | 1 h after end, once |

Composer fields: **Who** (segment + live count + opted-in count; only opted-in contacts
receive it), **Template** (approved only, category shown), **Params** (merge tokens:
first_name, webinar_title, replay_link, offer_link, survey_link, key_moment), **When**
(after end + delay, or date/time), **Quiet hours** toggle, **Preview** as a WhatsApp bubble
for a real recipient, **Estimated messages**, then **Schedule**. It creates a
`crm_broadcasts` row with `audience = 'segment'`, the same outbox and the same stats page.
Saving it "for every webinar" creates a drip with trigger `engagement_tier`.

Dedup: one message per contact per broadcast (the existing unique index), plus a check that
refuses a second broadcast to the same segment of the same webinar within 24 h unless the
coach confirms.

---

## 9. Roadmap

| Phase | Scope | Rough effort |
| --- | --- | --- |
| **MVP (analytics, read-only)** | 0059 events (reactions + hands capture); scoring functions in Go + TS with a shared test table; compute on end → 0061; `/engagement`, `/engagement/attendees`, drawer endpoint, CSV; Engagement page at `/host/[id]/engagement` (move the mock component, swap fixtures for API); link from the Report tab; dev-bypass fixture = `engagement-mock.ts` | **~1.5–2.5 weeks**, 1 full-stack dev |
| **v2 (surveys + ratings + segments)** | 0060 surveys, builder, end-screen prompt, tokenised link by email; `rating` poll kind; score includes survey; `CRMSegment` tiers/score → broadcasts; composer goes live; quiet hours; frequency cap | **~2–3 weeks** |
| **v3 (automation + trends)** | `engagement_tier` / `survey_submitted` drip triggers and after-end scheduling; survey link via WhatsApp; live engagement strip in the host room; cross-webinar trends (index over time, repeat attendees); per-account thresholds and weights; replay engagement | **~3–4 weeks** |

### Risks

* **Write load from reactions** at 500 × 90/min. Mitigated by batched async inserts and a
  per-person rate limit that already exists.
* **Score perceived as unfair.** Mitigated by the transparent breakdown, caps, the
  "while present" denominator, redistribution and `score_version`.
* **Meta policy and pricing drift.** Mitigated by reading categories and status from Meta,
  not hard-coding prices, and surfacing failures.
* **Consent mistakes** get a WABA banned. Mitigated by keeping the existing consent-only
  audiences and adding no new import paths.
* **Timezone and DST** for quiet hours and "next morning". Use the webinar time zone,
  overridable per contact later.
* **Identity joins.** Guests without registration (`guest-join`) have no
  `registration_id`, so they're scored but can't be messaged.

### Open questions for you

1. **Weights and tiers.** Are the defaults above (40 watch / 15 polls / 10 quiz / 10 chat /
   10 Q&A / 5 reactions / 5 hand / 5 survey; tiers 75/50/25) right for coaches, or should
   watch time weigh less?
2. **"On time" grace.** Is it 5 minutes?
3. Should the **offer / CTA click** (if we add a CTA button in the room) be a score
   component? It's a strong buying signal.
4. **Survey delivery.** Email only in v2, or WhatsApp in v2 too (needs a Utility
   `survey_link` template per host)?
5. Should **co-hosts** see individual scores, or only tiers?
6. Should the Engagement page **replace** the Report tab or sit beside it? (The mock assumes
   beside it, as a richer view.)
7. **Retention** for raw events: is 90 days acceptable?
8. Do coaches want **cross-webinar** comparisons in v2, or is per-webinar enough for now?

---

## 10. UI/UX

### Information architecture

```
Host portal
└─ Webinar (host/[id])
   ├─ Overview · Registrations · Recordings · Messages · Report
   └─ Engagement  ← new (host/[id]/engagement; mock at /mock/engagement)
       1. Header        breadcrumb · Sample-data badge (mock) · Export CSV · Schedule follow-up
       2. Hero          title/date/duration/host · summary sentence · 3 call-outs · Engagement index gauge
                        "How is this calculated?" → formula strip
       3. KPI grid      Registered · Attended · Avg watch · Peak live · Chat · Questions ·
                        Poll response · Quiz avg · Reactions · Survey rating   (5 × 2, → 3 × 4, → 2 × 5)
       4. Who stayed    retention curve with markers + hover tooltip | When people joined
       5. When people took part   activity heatmap (type × minute) + markers
       6. Engagement levels (tier bar + 4 cards)  | Follow up (segments → Schedule → composer)
       7. Attendee heatmap  search · tier chips · sortable columns · scrollable, sticky header → drawer
       8. Interaction details  tabs: Chat · Q&A · Polls & quizzes · Reactions · Survey
```

### Wireframe notes

* **Light portal theme** (`--color-page` / `surface` / `brand` tokens in `globals.css`), the
  same `Card`, `Button` and `Modal` primitives as the other host screens. The dark
  `.room-dark` theme is for the live room only.
* **Plain language**: "Who stayed", "When people took part", "Why 88?". No "cohort",
  "DAU" or "p50".
* **Colour meaning is consistent**: green = good/highly engaged, blue = engaged / brand,
  amber = passive / polls, red = at risk / drops. Every chart also has text labels, so nothing
  relies on colour alone.
* **Drawer** from the right (full-screen sheet on a phone): Escape closes it, focus moves in
  and is restored, and rows are keyboard-activatable (Enter / Space).
* **Tabs** use `role=tablist` with arrow-key navigation. Tier filters are `aria-pressed`
  toggles. Sortable headers set `aria-sort`.
* **Responsive**: two-column rows collapse at `lg`, KPI grid 5 → 3 → 2, wide heatmaps
  scroll horizontally inside their card, and grid columns are `minmax(0,1fr)` so the page
  never scrolls sideways.
* **Empty and loading states** (for the real page): "No one joined this webinar" with a
  share-replay CTA; "Engagement is calculated when the webinar ends" for a live or scheduled
  webinar; skeleton cards while loading; per-tab empty text ("No polls were run").
* **Follow-up** is a first-class panel, not buried in CRM. In the mock, every Schedule button
  opens the composer with the segment preselected, the final action is disabled, and the
  panel is labelled "Coming soon".
