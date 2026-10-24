package store

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/netkumar/webcast/api/types"
)

// webinarColumns is shared by every read so the scan order can't drift.
const webinarColumns = `
	w.slug, w.webinar_id, w.topic, w.summary, w.description, w.track,
	w.starts_at, w.duration_min, w.time_zone, w.kind, w.status,
	w.started_at, w.ended_at, w.max_duration_min,
	w.registration_required, w.approval, w.attendee_limit, w.price_cents,
	w.passcode, w.agenda, w.takeaways, w.options, w.report,
	w.hide_attendees, w.mute_on_entry, w.allow_unmute, w.chat_enabled,
	w.chat_destination,
	w.qa_enabled, w.raise_hand_enabled, w.reactions_enabled,
	w.polls_enabled, w.captions_enabled, (w.server_captions AND w.server_captions_live),
	(w.server_captions AND NOT w.server_captions_live),
	w.ai_enabled, ('ai' = ANY (effective_features(effective_plan(h.id), h.features, h.features_off))),
	w.ai_off_this_session,
	w.locked, w.audience_layout, w.sfu_project, w.image_key,
	w.simulive_recording_id::text, w.simulive_start_at, w.simulive_doors_open,
	w.simulive_live_at, w.simulive_host_gone_at,
	(w.simulive_recording_id IS NULL AND w.simulive_recording_deleted_at IS NOT NULL),
	w.stream_watch, w.stream_on, (w.stream_ingest <> ''),
	coalesce(w.venue, 'app'), coalesce(w.zoom_id, ''), w.delivery,
	h.id, h.name, h.title, h.org, h.initials, h.hue,
	(SELECT count(*) FROM registrations r
	   JOIN webinars rw ON rw.id = r.webinar_id
	  WHERE r.state <> 'declined'
	    AND (
	      (w.series_id IS NULL AND r.webinar_id = w.id)
	      OR (w.series_id IS NOT NULL AND rw.series_id = w.series_id)
	    )) AS registrant_count,
	coalesce(w.series_id::text, ''),
	coalesce(w.occurrence_index, 0),
	w.series_exception`

const webinarFrom = ` FROM webinars w JOIN users h ON h.id = w.host_id `

func scanWebinar(row scanner) (types.Webinar, string, error) {
	var (
		w           types.Webinar
		startsAt    time.Time
		startedAt   *time.Time
		endedAt     *time.Time
		priceCents  *int
		agenda      []byte
		takeaways   []byte
		options     []byte
		report      []byte
		hostID      string
		imageKey    string
		c           types.SessionControls
		simuliveID  *string
		simStartAt  *time.Time
		simLiveAt   *time.Time
		simGoneAt   *time.Time
		streamWatch string
		streamOn    bool
		streamSaved bool
		seriesID    string
		occIndex    int
		exception   bool
	)
	err := row.Scan(
		&w.ID, &w.WebinarID, &w.Topic, &w.Summary, &w.Descript, &w.Track,
		&startsAt, &w.Duration, &w.TimeZone, &w.Kind, &w.Status,
		&startedAt, &endedAt, &w.MaxDurationMin,
		&w.RegistrationRequired, &w.Approval, &w.AttendeeLimit, &priceCents,
		&w.Passcode, &agenda, &takeaways, &options, &report,
		&c.HideAttendees, &c.MuteOnEntry, &c.AllowUnmute, &c.ChatEnabled,
		&c.ChatDestination,
		&c.QAEnabled, &c.RaiseHandEnabled, &c.ReactionsEnabled,
		&c.PollsEnabled, &c.CaptionsEnabled, &c.ServerCaptions, &c.ServerCaptionsPending,
		&c.AIEnabled, &c.AIAvailable, &c.AIOffThisSession,
		&c.Locked, &c.AudienceLayout, &w.SFUProject, &imageKey,
		&simuliveID, &simStartAt, &w.SimuliveDoorsOpen,
		&simLiveAt, &simGoneAt,
		&w.SimuliveRecordingDeleted,
		&streamWatch, &streamOn, &streamSaved,
		&w.Venue, &w.ZoomID, &w.Delivery,
		&hostID, &w.Host.Name, &w.Host.Title, &w.Host.Org, &w.Host.Initials, &w.Host.Hue,
		&w.RegistrantCount,
		&seriesID, &occIndex, &exception,
	)
	if err != nil {
		return types.Webinar{}, "", err
	}
	w.Host.ID = hostID
	w.SeriesID = seriesID
	w.OccurrenceIndex = occIndex
	w.SeriesException = exception
	if simuliveID != nil && *simuliveID != "" {
		w.SimuliveRecordingID = *simuliveID
	}
	if simStartAt != nil {
		w.SimuliveStartAt = simStartAt.UTC().Format(time.RFC3339)
	}
	if simLiveAt != nil {
		w.SimuliveLiveAt = simLiveAt.UTC().Format(time.RFC3339)
	}
	if simGoneAt != nil {
		w.SimuliveHostGoneAt = simGoneAt.UTC().Format(time.RFC3339)
	}
	w.StreamWatchURL = streamWatch
	w.StreamConfigured = streamOn
	w.StreamKeySaved = streamSaved
	/* A path back to this API, not the image bytes — see ImageURL's doc comment.
	 *
	 * `v` is image_key, an opaque token that changes on every replace (see
	 * SetWebinarImage: a fresh one every upload, never a reused one). Without it
	 * the URL is the same before and after a host replaces their cover image, and
	 * a browser or a shared proxy that already cached the old bytes under that URL
	 * would go on serving them — `v` changing is what makes a replace produce a
	 * different URL and a genuine cache miss, which is what lets the response
	 * below be marked immutable instead of merely "please revalidate". */
	if imageKey != "" {
		w.ImageURL = "/api/webinars/" + w.ID + "/image?v=" + imageKey
	}
	w.StartsAt = startsAt.Format(time.RFC3339)
	// The session's switch counts only for an account that has AI at all.
	c.AIEnabled = c.AIEnabled && c.AIAvailable
	c.AudienceLayout = c.AudienceLayout.OrDefault()
	w.Controls = c
	if startedAt != nil {
		w.StartedAt = startedAt.Format(time.RFC3339)
	}
	if endedAt != nil {
		w.EndedAt = endedAt.Format(time.RFC3339)
	}
	/* A scheduled webinar that never went live is over once its scheduled end
	 * has passed. The database row stays scheduled: this is a read, and a job
	 * is not what makes the list right. EndedAt is left empty on purpose — a
	 * follow-up is for a session people could have attended. */
	markLapsed(&w, startsAt)
	if priceCents != nil {
		usd := *priceCents / 100
		w.PriceUsd = &usd
	}
	if err := json.Unmarshal(agenda, &w.Agenda); err != nil {
		return types.Webinar{}, "", fmt.Errorf("agenda: %w", err)
	}
	if err := json.Unmarshal(takeaways, &w.Takeaways); err != nil {
		return types.Webinar{}, "", fmt.Errorf("takeaways: %w", err)
	}
	if err := json.Unmarshal(options, &w.Options); err != nil {
		return types.Webinar{}, "", fmt.Errorf("options: %w", err)
	}
	// Existing webinars never stored this key; missing means on.
	if !bytes.Contains(options, []byte(`"emailReminders"`)) {
		w.Options.EmailReminders = true
	}
	// Nor this one; missing means the times every webinar had before it was a setting.
	// Present and empty is a host who removed them all, and stays empty.
	if !bytes.Contains(options, []byte(`"reminders"`)) || w.Options.Reminders == nil {
		w.Options.Reminders = append([]int(nil), types.DefaultReminders...)
	}
	if len(report) > 0 {
		var r types.WebinarReport
		if err := json.Unmarshal(report, &r); err == nil {
			w.Report = &r
		}
	}
	// Non-nil slices so the JSON is [] rather than null — the frontend maps
	// over these without guarding.
	if w.Agenda == nil {
		w.Agenda = []types.AgendaItem{}
	}
	if w.Takeaways == nil {
		w.Takeaways = []string{}
	}
	w.Panelists = []types.Person{}
	w.CustomQuestions = []types.CustomQuestion{}

	/* The guest door is finished in attachChildren, not here.
	 *
	 * It depends on the host's FeatureJoinWithoutRegistration as well as on this row, and
	 * the host's features are not in this scan. Left false until that pass, which is the
	 * restrictive answer if a caller ever forgot to attach. The passcode is still on the
	 * struct then: publicWebinar blanks it only after the store has returned.
	 */
	return w, hostID, nil
}

/* LapsedScheduledCond is the SQL form of markLapsed.
 *
 * starts_at is timestamptz, so adding the duration is an absolute instant.
 * The webinar's time zone only decides how that instant is shown; applying it
 * again here would move the end by a second offset. A live row is not matched,
 * so a session that is on the air is never filed as over. A draft is not
 * matched either. qual is the table qualifier ("w") or empty when webinars is
 * not aliased. */
func LapsedScheduledCond(qual string) string {
	if qual != "" {
		qual += "."
	}
	return "(" + qual + "status = 'scheduled' AND " + qual + "started_at IS NULL AND " +
		qual + "starts_at + make_interval(mins => " + qual + "duration_min) <= now())"
}

func markLapsed(w *types.Webinar, startsAt time.Time) {
	if w.Status != types.StatusScheduled || w.StartedAt != "" {
		return
	}
	end := startsAt.Add(time.Duration(w.Duration) * time.Minute)
	if end.After(time.Now()) {
		return
	}
	w.Status = types.StatusEnded
	w.DidntGoLive = true
}

func (s *Store) queryWebinars(ctx context.Context, where string, args ...any) ([]types.Webinar, error) {
	out, err := s.queryWebinarRows(ctx, where, args...)
	if err != nil {
		return nil, err
	}
	return s.attachChildren(ctx, out)
}

/* queryWebinarRows is queryWebinars without the child fetch.
 *
 * Split out for the paginated reads, which ask for one row more than they will
 * return in order to find out whether a next page exists. Attaching panelists
 * and custom questions to a row that is about to be discarded is two wasted
 * queries per page, so the caller trims first and attaches after.
 */
func (s *Store) queryWebinarRows(ctx context.Context, where string, args ...any) ([]types.Webinar, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+webinarColumns+webinarFrom+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []types.Webinar{}
	for rows.Next() {
		w, _, err := scanWebinar(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

/* VisibleTo returns every webinar one account is entitled to see in a list.
 *
 * This replaced Browsable, which returned every scheduled or live webinar to anybody who
 * asked, signed in or not. That was a deliberate public catalogue and it is now a closed
 * one: an account sees what it hosts, what it has been assigned to present, and what it
 * has registered for. Nothing else.
 *
 * Three arms, and the third is the one that keeps registration working. Without it a
 * person who signs up for a webinar would immediately stop being able to see it, because
 * they neither host nor present it.
 *
 * Drafts and ended sessions are included on purpose, unlike the old catalogue. The status
 * filter existed to stop strangers seeing a half-written webinar; when the audience is
 * restricted to people already involved, hiding their own past sessions from them is not
 * privacy, it is just a missing history.
 *
 * Registration by join key alone — no account — is NOT covered here and cannot be: the
 * credential lives in the browser, not in a session. Those resolve through ByJoinKeys.
 */
func (s *Store) VisibleTo(ctx context.Context, userID string) ([]types.Webinar, error) {
	return s.queryWebinars(ctx, `
		 WHERE w.host_id = $1
		    OR EXISTS (SELECT 1 FROM webinar_panelists p
		                WHERE p.webinar_id = w.id AND p.user_id = $1)
		    OR EXISTS (SELECT 1 FROM registrations r
		                WHERE r.webinar_id = w.id AND r.user_id = $1)
		 ORDER BY w.starts_at ASC`, userID)
}

// ------------------------------------------------- a host's own list, by page

/* HostWebinarTab is one bucket of the host portal's list.
 *
 * Not the same axis as a lifecycle status, which is why it exists: "upcoming"
 * covers scheduled *and* live, because a host looking at what is coming up
 * counts the session currently running as one of them. The portal's tabs and
 * this type are deliberately the same three values, so a tab click is one
 * query parameter rather than a translation table on either side.
 */
type HostWebinarTab string

const (
	HostTabUpcoming HostWebinarTab = "upcoming"
	HostTabPast     HostWebinarTab = "past"
	HostTabDrafts   HostWebinarTab = "drafts"
)

/* statusWhere is the lifecycle states one tab holds, plus the read-time rule
 * that a scheduled webinar whose end has passed without going live is completed.
 *
 * An unrecognised tab reads as upcoming, matching the portal's own default, so
 * a missing parameter lands on the same page a host sees when they arrive. A
 * live webinar stays upcoming even after its scheduled end: only a session that
 * never started ages out of this tab.
 */
func (t HostWebinarTab) statusWhere() string {
	switch t {
	case HostTabPast:
		return "(w.status = 'ended' OR " + LapsedScheduledCond("w") + ")"
	case HostTabDrafts:
		return "w.status = 'draft'"
	default:
		return "((w.status = 'scheduled' OR w.status = 'live') AND NOT " + LapsedScheduledCond("w") + ")"
	}
}

/* order is the column and direction one tab sorts on. Upcoming runs ascending
 * by start — the next thing to happen is at the top. Completed runs descending
 * by start: the session that just ended, not the first one ever run. Drafts run
 * by last edit, newest first: the draft a host was just working on is the one
 * they came back for, and a draft's start date is often a placeholder. */
func (t HostWebinarTab) order() (col, dir string) {
	switch t {
	case HostTabPast:
		return "starts_at", "DESC"
	case HostTabDrafts:
		return "updated_at", "DESC"
	default:
		return "starts_at", "ASC"
	}
}

// Page size for a host's own list: enough to fill a screen, few enough that a
// host with hundreds of sessions is not made to download all of them to read
// the next one up. Max exists so a caller cannot ask for the whole table back
// by passing limit=100000 and undo the point of paging.
const (
	DefaultHostWebinarLimit = 10
	MaxHostWebinarLimit     = 100
)

/* HostWebinarFilter narrows and pages one host's own webinars. Every field is
 * optional: a zero filter is the first page of Upcoming, which is what the
 * portal asks for on arrival. */
type HostWebinarFilter struct {
	// Tab picks the bucket. Empty means upcoming.
	Tab HostWebinarTab
	// Search matches the topic, case-insensitively and anywhere within it. A
	// host searches for the two words they remember from a title, not a prefix.
	Search string
	// From/To bound starts_at inclusively. Zero on either end is unbounded in
	// that direction, so picking only one date still means something.
	From, To time.Time
	// Limit is rows per page, defaulting to DefaultHostWebinarLimit and capped
	// at MaxHostWebinarLimit.
	Limit int
	// Cursor resumes after a previous page's last row. Opaque — produced by
	// ByHostPage, never built by a caller.
	Cursor string
	// Kind splits the portal's two lists: HostKindMeeting is meetings only,
	// HostKindWebinar everything that is not a meeting, empty both. Applied to
	// the counts as well as the rows, so the Webinars tab badges never count a
	// meeting and the Meetings page pages through meetings alone.
	Kind HostWebinarKind
	// Recording narrows Completed to sessions with, or without, a playable
	// recording; empty is both. Only the Completed tab honours it — nothing
	// upcoming or drafted has been recorded — and only the Completed count
	// narrows with it, so that badge still agrees with the list under it while
	// the other two badges keep describing their own tabs.
	Recording HostRecordingFilter
}

// HostRecordingFilter is the Completed tab's recording narrowing.
type HostRecordingFilter string

const (
	HostRecordingWith    HostRecordingFilter = "with"
	HostRecordingWithout HostRecordingFilter = "without"
)

/* hasReadyRecording is true for a webinar with at least one recording a host
 * can play: ready, with bytes. A take still recording or processing, or one
 * that failed, is not a recording yet; retention deletes the row outright, so
 * an expired one is simply gone. Served by recordings_webinar_idx. */
const hasReadyRecording = `EXISTS (SELECT 1 FROM recordings r
	 WHERE r.webinar_id = w.id AND r.status = 'ready' AND r.size_bytes > 0)`

// sql is the condition this filter adds, or "" for no narrowing.
func (f HostRecordingFilter) sql() string {
	switch f {
	case HostRecordingWith:
		return " AND " + hasReadyRecording
	case HostRecordingWithout:
		return " AND NOT " + hasReadyRecording
	}
	return ""
}

// HostWebinarKind is which of the portal's lists a host page is for.
type HostWebinarKind string

const (
	HostKindWebinar HostWebinarKind = "webinar"
	HostKindMeeting HostWebinarKind = "meeting"
)

/* ByHostPage returns one page of the webinars owned by a host, with the tab
 * counts alongside.
 *
 * Keyset paging on (starts_at, slug), not OFFSET. A host's list changes under
 * them — a session goes live, a draft gets published, a scheduled one is
 * deleted — and OFFSET 10 after any of that either repeats a row or skips one.
 * A keyset says "after this exact session", which stays true regardless.
 *
 * The cursor carries only the slug; the anchor timestamp is resolved in SQL
 * from it. Two reasons: types.Webinar formats StartsAt to whole seconds, so a
 * cursor built from the row the client holds would compare short against a
 * stored microsecond value and hand back the anchor row a second time; and a
 * client that cannot see the ordering key cannot come to depend on it.
 *
 * Ordering is per tab; see HostWebinarTab.order. Drafts key on updated_at
 * rather than starts_at, and the cursor resolves that column from the anchor
 * row the same way.
 */
func (s *Store) ByHostPage(ctx context.Context, hostID string, f HostWebinarFilter) (types.HostWebinarPage, error) {
	limit := f.Limit
	if limit <= 0 {
		limit = DefaultHostWebinarLimit
	}
	if limit > MaxHostWebinarLimit {
		limit = MaxHostWebinarLimit
	}

	args := []any{hostID}
	arg := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}

	/* Search and dates narrow the counts as well as the rows, so a badge can
	 * never disagree with the list under it — and a host who searches is told
	 * which tab their matches are in rather than being shown three totals for
	 * a list they are not looking at. The tab and the cursor are page-only:
	 * counting a tab through its own filter would make every badge read 10. */
	narrow := ""
	if !f.From.IsZero() {
		narrow += " AND w.starts_at >= " + arg(f.From)
	}
	if !f.To.IsZero() {
		narrow += " AND w.starts_at <= " + arg(f.To)
	}
	if q := strings.TrimSpace(f.Search); q != "" {
		narrow += " AND w.topic ILIKE " + arg("%"+likeLiteral(q)+"%") + ` ESCAPE '\'`
	}
	switch f.Kind {
	case HostKindMeeting:
		narrow += " AND w.kind = 'meeting'"
	case HostKindWebinar:
		narrow += " AND w.kind <> 'meeting'"
	}
	countArgs := slices.Clone(args)

	where := " WHERE w.host_id = $1" + narrow +
		" AND " + f.Tab.statusWhere()
	pastOnly := ""
	if f.Tab == HostTabPast {
		pastOnly = f.Recording.sql()
		where += pastOnly
	}

	col, dir := f.Tab.order()
	if f.Cursor != "" {
		slug, err := decodeHostCursor(f.Cursor)
		if err != nil {
			return types.HostWebinarPage{}, err
		}
		// One bound parameter, used twice: as the anchor lookup and as the
		// tuple's own tiebreaker. Scoped to this host so a cursor cannot be
		// pointed at a row the caller is not allowed to read.
		p := arg(slug)
		cmp := ">"
		if dir == "DESC" {
			cmp = "<"
		}
		where += " AND (w." + col + ", w.slug) " + cmp +
			" ((SELECT " + col + " FROM webinars WHERE slug = " + p +
			" AND host_id = $1), " + p + "::text)"
	}

	// One row more than asked for: whether a next page exists is a fact about
	// the data, and reading it off an extra row costs nothing next to a second
	// COUNT query per page.
	where += " ORDER BY w." + col + " " + dir + ", w.slug " + dir +
		" LIMIT " + arg(limit+1)

	/* The page and the tab counts do not depend on each other. Panelists, custom
	 * questions and the join flag run together inside attachChildren, after the
	 * page is known, because they are about those rows. */
	var (
		rows   []types.Webinar
		counts types.HostWebinarCounts
	)
	if err := RunParallel(ctx,
		func(ctx context.Context) error {
			var err error
			rows, err = s.queryWebinarRows(ctx, where, args...)
			return err
		},
		func(ctx context.Context) error {
			var err error
			counts, err = s.hostWebinarCounts(ctx, narrow, pastOnly, countArgs...)
			return err
		},
	); err != nil {
		return types.HostWebinarPage{}, err
	}
	more := len(rows) > limit
	if more {
		rows = rows[:limit]
	}
	items, err := s.attachChildren(ctx, rows)
	if err != nil {
		return types.HostWebinarPage{}, err
	}

	// Only Completed rows carry a recording badge, so only that tab pays for it.
	var recs map[string]types.HostRecordingSummary
	if f.Tab == HostTabPast {
		if recs, err = s.readyRecordingSummaries(ctx, items); err != nil {
			return types.HostWebinarPage{}, err
		}
	}

	page := types.HostWebinarPage{Items: items, Counts: counts, Recordings: recs}
	switch f.Tab {
	case HostTabPast:
		page.Total = counts.Past
	case HostTabDrafts:
		page.Total = counts.Drafts
	default:
		page.Total = counts.Upcoming
	}
	if more && len(items) > 0 {
		page.NextCursor = encodeHostCursor(items[len(items)-1].ID)
	}
	return page, nil
}

// hostWebinarCounts tallies all three tabs in one pass under the same narrowing
// clause as the page. The buckets are HostWebinarTab.statusWhere, so a lapsed
// scheduled webinar is counted under Completed and not also under Upcoming.
// pastOnly narrows the Completed count alone (the recording filter).
func (s *Store) hostWebinarCounts(ctx context.Context, narrow, pastOnly string, args ...any) (types.HostWebinarCounts, error) {
	var out types.HostWebinarCounts
	err := s.pool.QueryRow(ctx, `
		SELECT
		  count(*) FILTER (WHERE `+HostTabUpcoming.statusWhere()+`),
		  count(*) FILTER (WHERE `+HostTabPast.statusWhere()+pastOnly+`),
		  count(*) FILTER (WHERE `+HostTabDrafts.statusWhere()+`)
		  FROM webinars w
		 WHERE w.host_id = $1`+narrow, args...).Scan(&out.Upcoming, &out.Past, &out.Drafts)
	return out, err
}

/* readyRecordingSummaries is the recording badge for each row on a page that
 * has one: playable recording sessions (a session is a first take and the takes
 * folded under it) and their combined length. Only ready parts with bytes
 * count, the same rule as the Completed filter. Rows with none are left out. */
func (s *Store) readyRecordingSummaries(ctx context.Context, list []types.Webinar) (map[string]types.HostRecordingSummary, error) {
	if len(list) == 0 {
		return nil, nil
	}
	slugs := make([]string, len(list))
	for i, w := range list {
		slugs[i] = w.ID
	}
	rows, err := s.pool.Query(ctx, `
		SELECT w.slug, count(DISTINCT COALESCE(r.parent_id, r.id)), COALESCE(sum(r.duration_ms), 0)::bigint
		  FROM webinars w
		  JOIN recordings r ON r.webinar_id = w.id
		 WHERE w.slug = ANY($1) AND r.status = 'ready' AND r.size_bytes > 0
		 GROUP BY w.slug`, slugs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out map[string]types.HostRecordingSummary
	for rows.Next() {
		var (
			slug string
			sum  types.HostRecordingSummary
		)
		if err := rows.Scan(&slug, &sum.Count, &sum.DurationMs); err != nil {
			return nil, err
		}
		if out == nil {
			out = map[string]types.HostRecordingSummary{}
		}
		out[slug] = sum
	}
	return out, rows.Err()
}

/* likeLiteral makes a host's search text mean itself inside an ILIKE pattern.
 * Unescaped, "50% off" would match any title starting "50" and "kick_off" would
 * match "kickoff" — wildcards the host did not type and cannot see. The
 * backslash is the escape character the query names explicitly, since the
 * default depends on standard_conforming_strings. */
func likeLiteral(q string) string {
	var b strings.Builder
	for _, r := range q {
		if r == '%' || r == '_' || r == '\\' {
			b.WriteRune('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// encodeHostCursor / decodeHostCursor keep the paging key opaque. Base64 is not
// security — it is a sign that the value is the server's to define, so nobody
// builds one by hand and depends on a format that is free to change.
func encodeHostCursor(slug string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(slug))
}

func decodeHostCursor(cursor string) (string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil || len(raw) == 0 {
		return "", fmt.Errorf("%w: cursor is not one this server issued", ErrInvalid)
	}
	return string(raw), nil
}

// AdminWebinarFilter narrows AdminWebinars. Every field is optional and zero
// means "no restriction" — an admin browsing everything passes an empty
// filter rather than the caller having to know a sentinel value per field.
type AdminWebinarFilter struct {
	// Status restricts to one lifecycle state ("scheduled", "live", "ended"),
	// or every state when empty. Unlike VisibleTo/ByHost, an admin explicitly
	// wants to separate "completed" from "upcoming" rather than seeing a
	// personal timeline, so this is a filter here in a way it isn't there.
	Status types.WebinarStatus
	// From/To bound starts_at on either side, inclusive. Zero time on either
	// end means unbounded in that direction, so a host picking only an end
	// date gets "everything up to here" rather than an empty result.
	From, To time.Time
	// Search matches the topic or the host's email, case-insensitively — the
	// two things an admin scanning hundreds of sessions remembers about one.
	Search string
	// Kind is AdminKindWebinar, AdminKindMeeting, AdminKindSimulive, or empty for all.
	Kind string
}

/* AdminWebinars lists every webinar on the instance regardless of host, for
 * the admin panel — VisibleTo and ByHost both scope to one account by design,
 * and an admin's whole reason for being here is to see across that boundary.
 *
 * Ordered starts_at DESC: an admin reviewing what happened wants the most
 * recent session first, the opposite of VisibleTo/ByHost's ASC "what's coming
 * up next" ordering for a host looking at their own schedule.
 */
func (s *Store) AdminWebinars(ctx context.Context, f AdminWebinarFilter) ([]types.Webinar, error) {
	where := " WHERE true"
	args := []any{}
	arg := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}

	switch f.Status {
	case types.StatusScheduled:
		where += " AND w.status = 'scheduled' AND NOT " + LapsedScheduledCond("w")
	case types.StatusEnded:
		where += " AND (w.status = 'ended' OR " + LapsedScheduledCond("w") + ")"
	case "":
	default:
		where += " AND w.status = " + arg(f.Status)
	}
	if !f.From.IsZero() {
		where += " AND w.starts_at >= " + arg(f.From)
	}
	if !f.To.IsZero() {
		where += " AND w.starts_at <= " + arg(f.To)
	}
	switch f.Kind {
	case AdminKindWebinar:
		where += " AND w.kind NOT IN ('meeting', 'simulive')"
	case AdminKindMeeting:
		where += " AND w.kind = 'meeting'"
	case AdminKindSimulive:
		where += " AND w.kind = 'simulive'"
	}
	if q := strings.TrimSpace(f.Search); q != "" {
		p := arg("%" + q + "%")
		where += " AND (w.topic ILIKE " + p + " OR h.email ILIKE " + p + ")"
	}
	where += " ORDER BY w.starts_at DESC"

	return s.queryWebinars(ctx, where, args...)
}

// The admin list's kind chips. A recurring session is a webinar here: the chip is about
// what kind of room it is, not how it repeats.
const (
	AdminKindWebinar  = "webinar"
	AdminKindMeeting  = "meeting"
	AdminKindSimulive = "simulive"
)

/* SetPlannedStatus moves a webinar between draft and scheduled, and only from the state
 * the caller saw: the update is guarded on status = from, so a session that went live (or
 * ended) between the admin's read and this write is left alone and ErrConflict comes back.
 * Clears the same per-run columns SetStatus does for these two states. */
func (s *Store) SetPlannedStatus(ctx context.Context, slug string, from, to types.WebinarStatus) (types.Webinar, error) {
	planned := func(st types.WebinarStatus) bool {
		return st == types.StatusDraft || st == types.StatusScheduled
	}
	if !planned(from) || !planned(to) {
		return types.Webinar{}, fmt.Errorf("%w: only draft and scheduled", ErrInvalid)
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars SET status = $3,
		       started_at = NULL, ended_at = NULL, empty_since = NULL,
		       simulive_start_at = NULL, simulive_doors_open = false,
		       simulive_live_at = NULL, simulive_host_gone_at = NULL,
		       updated_at = now()
		 WHERE slug = $1 AND status = $2`,
		slug, string(from), string(to))
	if err != nil {
		return types.Webinar{}, err
	}
	if tag.RowsAffected() == 0 {
		if _, err := s.HostIDFor(ctx, slug); err != nil {
			return types.Webinar{}, err
		}
		return types.Webinar{}, ErrConflict
	}
	return s.WebinarBySlug(ctx, slug)
}

// OnStageFor returns webinars where this account is a panelist rather than the
// host, so the host portal can show sessions they are expected to appear on.
func (s *Store) OnStageFor(ctx context.Context, userID string) ([]types.Webinar, error) {
	return s.queryWebinars(ctx, `
		 WHERE w.host_id <> $1
		   AND EXISTS (SELECT 1 FROM webinar_panelists p
		                WHERE p.webinar_id = w.id AND p.user_id = $1)
		 ORDER BY w.starts_at ASC`, userID)
}

func (s *Store) WebinarBySlug(ctx context.Context, slug string) (types.Webinar, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT `+webinarColumns+webinarFrom+` WHERE w.slug = $1`, slug)
	w, _, err := scanWebinar(row)
	if noRows(err) {
		return types.Webinar{}, ErrNotFound
	}
	if err != nil {
		return types.Webinar{}, err
	}
	list, err := s.attachChildren(ctx, []types.Webinar{w})
	if err != nil {
		return types.Webinar{}, err
	}
	return list[0], nil
}

// HostIDFor is used by authorization checks — cheaper than loading the webinar.
func (s *Store) HostIDFor(ctx context.Context, slug string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `SELECT host_id::text FROM webinars WHERE slug = $1`, slug).Scan(&id)
	if noRows(err) {
		return "", ErrNotFound
	}
	return id, err
}

/* HostWebinarTopic answers "is this webinar mine, and what is it called" in one query.
 *
 * For the callers that need to NAME a host's webinar rather than only to be allowed near
 * it — a heading that says which webinar a list was narrowed to. HostIDFor plus a second
 * read would be two round trips for one sentence, and a heading built from the slug
 * instead is a heading that shows the host a URL fragment.
 *
 * ErrNotFound covers both "no such slug" and "not yours", deliberately and in one branch.
 * Distinguishing them would mean telling the caller that somebody else's webinar exists,
 * and the caller has nothing it could honestly do with that.
 */
func (s *Store) HostWebinarTopic(ctx context.Context, hostID, slug string) (string, error) {
	var topic string
	err := s.pool.QueryRow(ctx,
		`SELECT topic FROM webinars WHERE slug = $1 AND host_id = $2::uuid`, slug, hostID).Scan(&topic)
	if noRows(err) {
		return "", ErrNotFound
	}
	return topic, err
}

// PanelistContact is who a panelist is and where to write to them.
type PanelistContact struct {
	UserID string
	Name   string
	Email  string
}

// PanelistContacts lists a webinar's scheduled panelists with their account email, in
// stage order. Only mail reads the address; the Webinar payload never carries it.
func (s *Store) PanelistContacts(ctx context.Context, slug string) ([]PanelistContact, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT u.id::text, u.name, u.email
		  FROM webinar_panelists p
		  JOIN webinars w ON w.id = p.webinar_id
		  JOIN users u ON u.id = p.user_id
		 WHERE w.slug = $1 AND u.email <> ''
		 ORDER BY p.position`, slug)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (PanelistContact, error) {
		var c PanelistContact
		err := row.Scan(&c.UserID, &c.Name, &c.Email)
		return c, err
	})
}

// PanelistIDs returns the user ids allowed to publish alongside the host.
func (s *Store) PanelistIDs(ctx context.Context, slug string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.user_id::text
		  FROM webinar_panelists p
		  JOIN webinars w ON w.id = p.webinar_id
		 WHERE w.slug = $1`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// HostTracks lists the topic tags this host has already used, for the
// schedule form's suggestions. Suggesting what exists means there is no
// hardcoded taxonomy to keep in sync with whatever an operator actually runs.
//
// Scoped to host_id: a coach's tags are that coach's own vocabulary, not a
// taxonomy shared by the whole server, and offering every host's tags as
// "your suggestions" is one coach's tag leaking into a stranger's dropdown.
func (s *Store) HostTracks(ctx context.Context, hostID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT track FROM webinars
		 WHERE host_id = $1 AND track <> '' ORDER BY track`, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ------------------------------------------------------------------- writes

// CreateWebinar inserts a webinar owned by hostID and returns the full record.
//
// The slug and the human-facing webinar id are generated here rather than asked
// for: both have to be unique, and a form that can fail on "that URL is taken"
// after a host filled in twelve fields is a form people abandon.
func (s *Store) CreateWebinar(ctx context.Context, hostID string, in types.WebinarInput, defaultMaxDurationMin int) (types.Webinar, error) {
	startsAt, err := time.Parse(time.RFC3339, in.StartsAt)
	if err != nil {
		return types.Webinar{}, fmt.Errorf("%w: startsAt must be RFC3339", ErrInvalid)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return types.Webinar{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	maxDuration, err := hostMaxDuration(ctx, tx, hostID, defaultMaxDurationMin)
	if err != nil {
		return types.Webinar{}, err
	}
	slug, _, err := insertWebinar(ctx, tx, hostID, in, startsAt, "", 0, false, maxDuration)
	if err != nil {
		return types.Webinar{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return types.Webinar{}, err
	}
	return s.WebinarBySlug(ctx, slug)
}

// UpdateWebinar replaces the editable fields of an existing webinar.
//
// Status is deliberately not settable here: moving between scheduled, live and
// ended has side effects at the SFU, so it goes through SetStatus. The only
// exception is publishing a draft, which is a pure database change.
func (s *Store) UpdateWebinar(ctx context.Context, slug string, in types.WebinarInput) (types.Webinar, error) {
	startsAt, err := time.Parse(time.RFC3339, in.StartsAt)
	if err != nil {
		return types.Webinar{}, fmt.Errorf("%w: startsAt must be RFC3339", ErrInvalid)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return types.Webinar{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	agenda, takeaways, options, err := marshalWebinarJSON(in)
	if err != nil {
		return types.Webinar{}, err
	}

	var (
		id      string
		hostID  string
		current string
	)
	err = tx.QueryRow(ctx,
		`SELECT id::text, host_id::text, status FROM webinars WHERE slug = $1 FOR UPDATE`,
		slug).Scan(&id, &hostID, &current)
	if noRows(err) {
		return types.Webinar{}, ErrNotFound
	}
	if err != nil {
		return types.Webinar{}, err
	}

	// Publishing a draft is allowed; anything else keeps the live status the
	// start/end endpoints own.
	status := current
	if current == string(types.StatusDraft) &&
		(in.Status == types.StatusScheduled || in.Status == types.StatusDraft) {
		status = string(in.Status)
	}

	if _, err := tx.Exec(ctx, `
		UPDATE webinars SET
			topic = $2, summary = $3, description = $4, track = $5,
			starts_at = $6, duration_min = $7, time_zone = $8, kind = $9,
			status = $10, registration_required = $11, approval = $12,
			attendee_limit = $13, passcode = $14,
			agenda = $15, takeaways = $16, options = $17,
			hide_attendees = $18, mute_on_entry = $19, allow_unmute = $20,
			chat_enabled = $21, qa_enabled = $22, raise_hand_enabled = $23,
			reactions_enabled = $24, locked = $25, chat_destination = $26,
			polls_enabled = $27, captions_enabled = $28,
			captions_shown_live = captions_shown_live OR (status = 'live' AND $28),
			simulive_recording_id = NULLIF($29,'')::uuid,
			updated_at = now()
		 WHERE id = $1`,
		id, strings.TrimSpace(in.Topic), strings.TrimSpace(in.Summary),
		strings.TrimSpace(in.Descript), strings.TrimSpace(in.Track),
		startsAt, in.Duration, in.TimeZone, string(in.Kind), status,
		in.RegistrationRequired, string(in.Approval), in.AttendeeLimit,
		strings.TrimSpace(in.Passcode), agenda, takeaways, options,
		in.Controls.HideAttendees, in.Controls.MuteOnEntry, in.Controls.AllowUnmute,
		in.Controls.ChatEnabled, in.Controls.QAEnabled, in.Controls.RaiseHandEnabled,
		in.Controls.ReactionsEnabled, in.Controls.Locked,
		string(in.Controls.ChatDestination.OrDefault()), in.Controls.PollsEnabled,
		// As sent, not OR-ed with Options.Captions: that kept a session once ticked captioned
		// for good. The edit handler sets it from "Live captions" when the save changes that.
		in.Controls.CaptionsEnabled,
		strings.TrimSpace(in.SimuliveRecordingID),
	); err != nil {
		return types.Webinar{}, err
	}

	if err := replaceQuestions(ctx, tx, id, in.CustomQuestions); err != nil {
		return types.Webinar{}, err
	}
	if err := replacePanelists(ctx, tx, id, hostID, in.PanelistEmails); err != nil {
		return types.Webinar{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return types.Webinar{}, err
	}
	return s.WebinarBySlug(ctx, slug)
}

// SetStatus moves a webinar between scheduled, live and ended, stamping the
// transition times. Returns the updated record so a handler can mirror the new
// state into room metadata in the same request.
func (s *Store) SetStatus(ctx context.Context, slug string, status types.WebinarStatus) (types.Webinar, error) {
	// Every transition clears empty_since: a room that is starting has not been
	// observed empty yet, and one that has ended is not being watched any more.
	// Leaving a stale value behind would let the empty-room sweeper close a
	// restarted session on a clock from the previous one.
	var col string
	switch status {
	case types.StatusLive:
		// A session going live with the switch off starts paused (afterWentLive below).
		col = `started_at = coalesce(started_at, now()), ended_at = NULL, empty_since = NULL,
		       simulive_start_at = NULL,
		       ai_off_this_session = NOT ai_enabled,
		       captions_shown_live = captions_shown_live OR captions_enabled`
	case types.StatusEnded:
		col = `ended_at = now(), empty_since = NULL`
	case types.StatusScheduled, types.StatusDraft:
		col = `started_at = NULL, ended_at = NULL, empty_since = NULL,
		       simulive_start_at = NULL, simulive_doors_open = false,
		       simulive_live_at = NULL, simulive_host_gone_at = NULL`
	default:
		return types.Webinar{}, fmt.Errorf("%w: unknown status %q", ErrInvalid, status)
	}

	tag, err := s.pool.Exec(ctx,
		`UPDATE webinars SET status = $2, `+col+`, updated_at = now() WHERE slug = $1`,
		slug, string(status))
	if err != nil {
		return types.Webinar{}, err
	}
	if tag.RowsAffected() == 0 {
		return types.Webinar{}, ErrNotFound
	}
	// The AI-off windows (ai_off.go): live with AI off opens one, any other move closes one.
	if status == types.StatusLive {
		err = s.afterWentLive(ctx, slug)
	} else {
		err = s.afterEnded(ctx, slug)
	}
	if err != nil {
		return types.Webinar{}, err
	}
	return s.WebinarBySlug(ctx, slug)
}

// UpdateControls applies a partial change to the in-session controls and
// returns the whole webinar, so the caller can push the new state to the SFU
// without a second read.
func (s *Store) UpdateControls(ctx context.Context, slug string, p types.ControlsPatch) (types.Webinar, error) {
	// Sent as *string rather than as *ChatDestination so the driver never has to
	// guess at a named type, matching how Kind and Status are written.
	var chatDestination *string
	if p.ChatDestination != nil {
		v := string(*p.ChatDestination)
		chatDestination = &v
	}
	var audienceLayout *string
	if p.AudienceLayout != nil {
		v := string(*p.AudienceLayout)
		audienceLayout = &v
	}

	// COALESCE against a nullable parameter is how a partial update stays one
	// statement: a nil pointer arrives as SQL NULL and the column keeps its
	// value, with no dynamically assembled SET clause to get wrong.
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars SET
			hide_attendees     = coalesce($2, hide_attendees),
			mute_on_entry      = coalesce($3, mute_on_entry),
			allow_unmute       = coalesce($4, allow_unmute),
			chat_enabled       = coalesce($5, chat_enabled),
			qa_enabled         = coalesce($6, qa_enabled),
			raise_hand_enabled = coalesce($7, raise_hand_enabled),
			reactions_enabled  = coalesce($8, reactions_enabled),
			locked             = coalesce($9, locked),
			chat_destination   = coalesce($10, chat_destination),
			polls_enabled      = coalesce($11, polls_enabled),
			captions_enabled   = coalesce($12, captions_enabled),
			captions_shown_live = captions_shown_live OR (status = 'live' AND coalesce($12, captions_enabled)),
			ai_enabled         = coalesce($13, ai_enabled),
			-- "Paused right now": only while live; the window itself is written below.
			ai_off_this_session = CASE WHEN status = 'live' AND $13::boolean IS NOT NULL
			                           THEN NOT $13::boolean ELSE ai_off_this_session END,
			audience_layout    = coalesce($14, audience_layout),
			updated_at         = now()
		 WHERE slug = $1`,
		slug, p.HideAttendees, p.MuteOnEntry, p.AllowUnmute, p.ChatEnabled,
		p.QAEnabled, p.RaiseHandEnabled, p.ReactionsEnabled, p.Locked,
		chatDestination, p.PollsEnabled, p.CaptionsEnabled, p.AIEnabled, audienceLayout)
	if err != nil {
		return types.Webinar{}, err
	}
	if tag.RowsAffected() == 0 {
		return types.Webinar{}, ErrNotFound
	}
	/* The AI switch while live pauses and resumes AI (ai_off.go): off opens a window, on
	 * closes it. Not live, it only sets the switch. */
	if p.AIEnabled != nil {
		q := resumeAIOffSQL
		if !*p.AIEnabled {
			q = openAIOffSQL
		}
		if _, err := s.pool.Exec(ctx, q, slug); err != nil {
			return types.Webinar{}, err
		}
	}
	return s.WebinarBySlug(ctx, slug)
}

/* Deleted reports what a delete actually removed.
 *
 * Returned rather than logged so the handler can log one line and the tests can assert on
 * numbers instead of on "no error". "Delete everything belonging to this webinar" is a claim
 * about seven tables and two kinds of file, and a delete that quietly missed one of them
 * returns nil just as cheerfully as one that worked.
 *
 * A cover image in the object store (migrations/0098) is collected with them; one still in
 * image_data goes with the row's own DELETE.
 */
type Deleted struct {
	Status        string
	Registrations int
	ChatMessages  int
	Polls         int
	PollVotes     int
	Recordings    int
	Panelists     int
	StageGrants   int
	Questions     int
	/* Object-storage keys that were pointed at by the rows above. The rows cascade; bytes do
	 * not, so these are the caller's to delete once the transaction has committed. Chat images
	 * and recording files both live here — a recording is by far the larger of the two and was
	 * being left behind entirely. */
	BlobKeys []string
	// FilesLeftBehind is set by the caller (not this function — DeleteWebinar
	// runs before any blob is actually deleted) to how many of BlobKeys could
	// not be removed from object storage, for the deletion log line.
	FilesLeftBehind int
}

/* DeleteWebinar removes a webinar and everything hanging off it.
 *
 * Allowed in ANY status, including live and ended. It used to refuse both, on the reasoning
 * that an ended webinar's registrations are the attendance record — a defensible policy, and
 * the wrong one for a host who wants their data gone. "Delete this webinar" now means what it
 * says, and the confirmation dialog is where the warning belongs.
 *
 * Two phases. First the high-volume tables nobody counts (webinarBulkChildren) are emptied for
 * this webinar in bounded batches, each its own short statement, so one delete never holds a
 * long lock or runs past the request deadline. Then one transaction counts what is left,
 * collects the storage keys and deletes the row.
 *
 * The counts are taken inside that transaction. Counting before the delete in a separate query
 * would report what was there a moment ago rather than what was removed, and a registration
 * arriving between the two would be silently uncounted while still being deleted. That is why
 * the counted tables are not in the batch list.
 *
 * The child rows are removed by ON DELETE CASCADE (see the migrations), not by DELETE
 * statements here. The batch phase is only an optimisation: whatever it does not reach,
 * including a table added later, the cascade still removes. If it fails part-way the webinar
 * is still there, minus some of its event history, and deleting again finishes the job.
 */
func (s *Store) DeleteWebinar(ctx context.Context, slug string) (Deleted, error) {
	return s.DeleteWebinarInBatches(ctx, slug, webinarPurgeBatch)
}

/* webinarBulkChildren are the tables a webinar fills fastest and nobody counts on delete:
 * the outbox (several rows per registrant), raw engagement events, caption segments and
 * join/leave visits. Each has an index leading with webinar_id. */
var webinarBulkChildren = []string{"notifications", "engagement_events", "session_captions", "attendance_visits"}

// webinarPurgeBatch is how many rows one purge statement removes.
const webinarPurgeBatch = 5000

// DeleteWebinarInBatches is DeleteWebinar with the purge batch size given, for tests.
func (s *Store) DeleteWebinarInBatches(ctx context.Context, slug string, batch int) (Deleted, error) {
	var id string
	err := s.pool.QueryRow(ctx, `SELECT id FROM webinars WHERE slug = $1`, slug).Scan(&id)
	if noRows(err) {
		return Deleted{}, ErrNotFound
	}
	if err != nil {
		return Deleted{}, err
	}
	// Outbox first: a reminder still pending for this webinar stops being sendable now.
	for _, table := range webinarBulkChildren {
		for {
			tag, err := s.pool.Exec(ctx, `
				DELETE FROM `+table+` WHERE id IN (
				  SELECT id FROM `+table+` WHERE webinar_id = $1 LIMIT $2)`, id, batch)
			if err != nil {
				return Deleted{}, err
			}
			if tag.RowsAffected() < int64(batch) {
				break
			}
			if err := ctx.Err(); err != nil {
				return Deleted{}, err
			}
		}
	}
	return s.deleteWebinarRow(ctx, slug)
}

func (s *Store) deleteWebinarRow(ctx context.Context, slug string) (Deleted, error) {
	var out Deleted

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var id string
	var seriesID *string
	err = tx.QueryRow(ctx, `SELECT id, status, series_id::text FROM webinars WHERE slug = $1`, slug).
		Scan(&id, &out.Status, &seriesID)
	if noRows(err) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}

	/* One round trip for every count, so the numbers are consistent with each other and with
	 * the delete below. `webinar_stage_grants` and `webinar_panelists` are included because a
	 * promotion and an invitation are also data about this webinar. */
	err = tx.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM registrations       WHERE webinar_id = $1),
		       (SELECT count(*) FROM chat_messages       WHERE webinar_id = $1),
		       (SELECT count(*) FROM polls               WHERE webinar_id = $1),
		       (SELECT count(*) FROM poll_votes v JOIN polls p ON p.id = v.poll_id
		                                          WHERE p.webinar_id = $1),
		       (SELECT count(*) FROM recordings         WHERE webinar_id = $1),
		       (SELECT count(*) FROM webinar_panelists   WHERE webinar_id = $1),
		       (SELECT count(*) FROM webinar_stage_grants WHERE webinar_id = $1),
		       (SELECT count(*) FROM custom_questions    WHERE webinar_id = $1)`, id).
		Scan(&out.Registrations, &out.ChatMessages, &out.Polls, &out.PollVotes,
			&out.Recordings, &out.Panelists, &out.StageGrants, &out.Questions)
	if err != nil {
		return out, err
	}

	/* Every key in object storage this webinar owns, in one query.
	 *
	 * Chat images and recording files, unioned rather than fetched separately, because the
	 * caller does the same thing with both and a second list is a second thing to forget. A
	 * recording with no storage key yet — a row created a moment ago whose first chunk has not
	 * arrived — is filtered out rather than handed over as an empty string. */
	rows, err := tx.Query(ctx, `
		SELECT media_key FROM chat_messages
		 WHERE webinar_id = $1 AND media_key IS NOT NULL AND media_key <> ''
		UNION ALL
		SELECT storage_key FROM recordings
		 WHERE webinar_id = $1 AND storage_key <> ''
		UNION ALL
		SELECT image_storage_key FROM webinars
		 WHERE id = $1 AND image_storage_key <> ''`, id)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return out, err
		}
		out.BlobKeys = append(out.BlobKeys, key)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}

	// A series registration lives on one session and covers the rest. Move it
	// onto a session that is staying before this row, and its join key, go away.
	if seriesID != nil && *seriesID != "" {
		if err := moveSeriesRegistrations(ctx, tx, id, *seriesID); err != nil {
			return out, err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM webinars WHERE id = $1`, id); err != nil {
		return out, err
	}
	if seriesID != nil && *seriesID != "" {
		if _, err := tx.Exec(ctx, `
			DELETE FROM webinar_series s
			 WHERE s.id = $1::uuid
			   AND NOT EXISTS (SELECT 1 FROM webinars w WHERE w.series_id = s.id)`, *seriesID); err != nil {
			return out, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return out, err
	}
	return out, nil
}

/* EmailsWithoutAccount returns the addresses in emails that no account has, lowercased,
 * de-duplicated and in the order given. A panelist needs an account (their stage token is
 * minted from a session), so the schedule form names these instead of dropping them. */
func (s *Store) EmailsWithoutAccount(ctx context.Context, emails []string) ([]string, error) {
	var want []string
	seen := map[string]bool{}
	for _, raw := range emails {
		e := strings.ToLower(strings.TrimSpace(raw))
		if e == "" || seen[e] {
			continue
		}
		seen[e] = true
		want = append(want, e)
	}
	if len(want) == 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx,
		`SELECT lower(email) FROM users WHERE lower(email) = ANY($1)`, want)
	if err != nil {
		return nil, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	known := make(map[string]bool, len(found))
	for _, e := range found {
		known[e] = true
	}
	var missing []string
	for _, e := range want {
		if !known[e] {
			missing = append(missing, e)
		}
	}
	return missing, nil
}

// AddPanelist grants an existing account a seat on the stage.
func (s *Store) AddPanelist(ctx context.Context, slug, email string) (types.Person, error) {
	u, err := s.UserByEmail(ctx, email)
	if err != nil {
		return types.Person{}, err
	}
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO webinar_panelists (webinar_id, user_id, position)
		SELECT w.id, $2, coalesce(
			(SELECT max(position) + 1 FROM webinar_panelists p WHERE p.webinar_id = w.id), 0)
		  FROM webinars w WHERE w.slug = $1
		ON CONFLICT DO NOTHING`, slug, u.ID)
	if err != nil {
		return types.Person{}, err
	}
	if tag.RowsAffected() == 0 {
		// Either the webinar is gone or they already have a seat. The second is
		// not an error worth surfacing to someone clicking "invite".
		if _, err := s.HostIDFor(ctx, slug); err != nil {
			return types.Person{}, err
		}
	}
	return u.Person(), nil
}

func (s *Store) RemovePanelist(ctx context.Context, slug, userID string) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM webinar_panelists p
		 USING webinars w
		 WHERE w.id = p.webinar_id AND w.slug = $1 AND p.user_id = $2`, slug, userID)
	return err
}

// TransferHost moves ownership from fromID to toID.
//
// The new owner is removed from the panelist list (they are the host now), and the
// previous owner is added as a panelist so leaving the room does not strand them
// off-stage if they rejoin. toID must already be a scheduled panelist — transferring
// to an audience identity is rejected here so the handler cannot paper over a bad
// LiveKit roster with a silent ownership change.
func (s *Store) TransferHost(ctx context.Context, slug, fromID, toID string) error {
	if fromID == "" || toID == "" || fromID == toID {
		return ErrInvalid
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var webinarID, hostID string
	err = tx.QueryRow(ctx, `
		SELECT id::text, host_id::text FROM webinars WHERE slug = $1 FOR UPDATE`, slug).
		Scan(&webinarID, &hostID)
	if noRows(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if hostID != fromID {
		return ErrInvalid
	}

	var isPanelist bool
	err = tx.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM webinar_panelists WHERE webinar_id = $1::uuid AND user_id = $2::uuid
		)`, webinarID, toID).Scan(&isPanelist)
	if err != nil {
		return err
	}
	if !isPanelist {
		return ErrInvalid
	}

	if _, err := tx.Exec(ctx, `
		UPDATE webinars SET host_id = $2::uuid WHERE id = $1::uuid`, webinarID, toID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM webinar_panelists WHERE webinar_id = $1::uuid AND user_id = $2::uuid`,
		webinarID, toID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO webinar_panelists (webinar_id, user_id, position)
		SELECT $1::uuid, $2::uuid, coalesce(
			(SELECT max(position) + 1 FROM webinar_panelists WHERE webinar_id = $1::uuid), 0)
		ON CONFLICT DO NOTHING`, webinarID, fromID); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

// --------------------------------------------------------------- stage grants

// GrantStage records that a host promoted an attendee, so the promotion
// survives that attendee reconnecting. Without it, a panelist who loses their
// wifi rejoins as audience and the host has to promote them again.
//
// audioOnly distinguishes "allowed to talk" from a full stage seat, and has to be
// stored too — coming back from a dropped connection with a camera the host never
// granted would be worse than losing the grant entirely.
// A fresh grant clears any host mute: bringing someone (back) on stage is the
// host saying they may speak.
func (s *Store) GrantStage(ctx context.Context, slug, identity, display string, audioOnly bool) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO webinar_stage_grants (webinar_id, identity, display, audio_only)
		SELECT w.id, $2, $3, $4 FROM webinars w WHERE w.slug = $1
		ON CONFLICT (webinar_id, identity) DO UPDATE
		   SET display = excluded.display, audio_only = excluded.audio_only,
		       muted_by_host = false`,
		slug, identity, display, audioOnly)
	return err
}

func (s *Store) RevokeStage(ctx context.Context, slug, identity string) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM webinar_stage_grants g
		 USING webinars w
		 WHERE w.id = g.webinar_id AND w.slug = $1 AND g.identity = $2`, slug, identity)
	return err
}

// StageGrant describes what a host granted one identity earlier in the session.
//
// A struct rather than a row of bools: `granted, audioOnly, mutedByHost, err :=`
// is a call site where transposing two values compiles cleanly and hands somebody
// a microphone the host took away.
type StageGrant struct {
	// Granted false means ordinary audience — the other fields are meaningless.
	Granted   bool
	AudioOnly bool
	// MutedByHost survives a reconnect on purpose: a reload must not be a way to
	// undo a host mute.
	MutedByHost bool
	// CoHost survives a reconnect for the same reason: a dropped wifi must not
	// be a way to lose (or, for anyone else, gain) full moderation rights.
	CoHost bool
}

func (s *Store) StageGrant(ctx context.Context, slug, identity string) (StageGrant, error) {
	var g StageGrant
	err := s.pool.QueryRow(ctx, `
		SELECT g.audio_only, g.muted_by_host, g.co_host FROM webinar_stage_grants g
		  JOIN webinars w ON w.id = g.webinar_id
		 WHERE w.slug = $1 AND g.identity = $2`, slug, identity).
		Scan(&g.AudioOnly, &g.MutedByHost, &g.CoHost)
	if noRows(err) {
		return StageGrant{}, nil
	}
	if err != nil {
		return StageGrant{}, err
	}
	g.Granted = true
	return g, nil
}

// SetGrantMuted latches or lifts a host mute for one identity.
//
// A scheduled panelist has no grant to hang it on — they speak by right, from the
// panelist list — so muting one inserts a row that records only the mute. Without
// that, reloading the page would be how a muted panelist starts talking again.
func (s *Store) SetGrantMuted(ctx context.Context, slug, identity string, muted bool) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinar_stage_grants g SET muted_by_host = $3
		  FROM webinars w
		 WHERE w.id = g.webinar_id AND w.slug = $1 AND g.identity = $2`,
		slug, identity, muted)
	if err != nil || tag.RowsAffected() > 0 {
		return err
	}
	// Nothing to lift a mute from, so there is nothing to record.
	if !muted {
		return nil
	}
	// audio_only true rather than false on this insert: the value is never read
	// for a panelist, and if it ever were read for somebody else it would hand
	// back the narrower grant rather than a camera nobody granted.
	_, err = s.pool.Exec(ctx, `
		INSERT INTO webinar_stage_grants (webinar_id, identity, display, audio_only, muted_by_host)
		SELECT w.id, $2, '', true, true FROM webinars w WHERE w.slug = $1
		ON CONFLICT (webinar_id, identity) DO UPDATE SET muted_by_host = true`,
		slug, identity)
	return err
}

/* SetCoHost makes one identity the host's equal, or takes that back.
 *
 * Same insert-if-missing shape as SetGrantMuted, for the same reason: a
 * scheduled panelist has no grant row to hang this on until the host actually
 * uses it. display and audio_only on that insert are placeholders a panelist's
 * own grant never reads — their permission comes from the panelist list, not
 * from this table, except for the two flags (muted_by_host, co_host) a host
 * can lay on top of it.
 */
func (s *Store) SetCoHost(ctx context.Context, slug, identity, display string, coHost bool) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinar_stage_grants g SET co_host = $3
		  FROM webinars w
		 WHERE w.id = g.webinar_id AND w.slug = $1 AND g.identity = $2`,
		slug, identity, coHost)
	if err != nil || tag.RowsAffected() > 0 {
		return err
	}
	// Nothing to take co-host status away from, so there is nothing to record.
	if !coHost {
		return nil
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO webinar_stage_grants (webinar_id, identity, display, audio_only, co_host)
		SELECT w.id, $2, $3, true, true FROM webinars w WHERE w.slug = $1
		ON CONFLICT (webinar_id, identity) DO UPDATE SET co_host = true`,
		slug, identity, display)
	return err
}

/* IsCoHost reports whether an account is a co-host of one webinar, by either of the two
 * identities that account can be on its stage with.
 *
 * An invited panelist is "user_<id>" (hostIdentity), so their grant row is keyed by the
 * account directly. An attendee the host brought up on stage, or a meeting guest, is
 * "att_<joinKey>": their row is keyed by a registration, and the account behind it is that
 * registration's user_id (or knock_user_id, a meeting guest who knocked signed in — see
 * RegistrantAccount). Only registrations of THIS webinar count — a join key from another
 * session, even one of the same series or the same host, never lends its account co-host
 * rights here — and the row is the one SetCoHost wrote for that identity, so taking the
 * attendee back off the stage (RevokeStage deletes the row) takes co-host with it.
 */
func (s *Store) IsCoHost(ctx context.Context, slug, userID string) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM webinar_stage_grants g
			  JOIN webinars w ON w.id = g.webinar_id
			 WHERE w.slug = $1 AND g.co_host
			   AND (g.identity = 'user_' || $2::text
			        OR g.identity IN (
			            SELECT 'att_' || r.join_key FROM registrations r
			             WHERE r.webinar_id = w.id
			               AND COALESCE(r.user_id, r.knock_user_id)::text = $2::text)))`,
		slug, userID).Scan(&ok)
	return ok, err
}

// MuteAllGrants latches the host mute across every grant in one session, so
// "mute everyone" also holds for the people the host had allowed to speak.
func (s *Store) MuteAllGrants(ctx context.Context, slug string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE webinar_stage_grants g SET muted_by_host = true
		  FROM webinars w
		 WHERE w.id = g.webinar_id AND w.slug = $1`, slug)
	return err
}

// ClearStageGrants runs when a webinar ends: promotions are scoped to one
// session, so the next one starts with only the scheduled panelists.
func (s *Store) ClearStageGrants(ctx context.Context, slug string) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM webinar_stage_grants g
		 USING webinars w WHERE w.id = g.webinar_id AND w.slug = $1`, slug)
	return err
}

// ------------------------------------------------------------------ helpers

func marshalWebinarJSON(in types.WebinarInput) (agenda, takeaways, options []byte, err error) {
	if in.Agenda == nil {
		in.Agenda = []types.AgendaItem{}
	}
	if in.Takeaways == nil {
		in.Takeaways = []string{}
	}
	if agenda, err = json.Marshal(in.Agenda); err != nil {
		return nil, nil, nil, err
	}
	if takeaways, err = json.Marshal(in.Takeaways); err != nil {
		return nil, nil, nil, err
	}
	if options, err = json.Marshal(in.Options); err != nil {
		return nil, nil, nil, err
	}
	return agenda, takeaways, options, nil
}

func replaceQuestions(ctx context.Context, tx pgx.Tx, webinarID string, qs []types.CustomQuestion) error {
	if _, err := tx.Exec(ctx,
		`DELETE FROM custom_questions WHERE webinar_id = $1`, webinarID); err != nil {
		return err
	}
	for i, q := range qs {
		key := strings.TrimSpace(q.ID)
		if key == "" {
			key = slugify(q.Label)
		}
		if key == "" {
			continue // a question with neither key nor label is not a question
		}
		kind := q.Type
		switch kind {
		case "short", "select", "checkbox":
		default:
			kind = "short"
		}
		opts, err := json.Marshal(orEmptyStrings(q.Options))
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO custom_questions
				(webinar_id, key, label, type, required, options, position)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT (webinar_id, key) DO UPDATE
			   SET label = excluded.label, type = excluded.type,
			       required = excluded.required, options = excluded.options,
			       position = excluded.position`,
			webinarID, key, strings.TrimSpace(q.Label), kind, q.Required, opts, i,
		); err != nil {
			return err
		}
	}
	return nil
}

// replacePanelists resolves emails to accounts. Addresses with no account are
// skipped rather than rejected: a host pasting in a list should not have the
// whole save fail because one colleague has not signed up yet.
func replacePanelists(ctx context.Context, tx pgx.Tx, webinarID, hostID string, list *[]string) error {
	// Omitted: the panel stays as it is (types.WebinarInput.PanelistEmails).
	if list == nil {
		return nil
	}
	emails := *list
	if _, err := tx.Exec(ctx,
		`DELETE FROM webinar_panelists WHERE webinar_id = $1`, webinarID); err != nil {
		return err
	}
	seen := map[string]bool{hostID: true} // the host is already on the stage
	position := 0
	for _, raw := range emails {
		email := strings.ToLower(strings.TrimSpace(raw))
		if email == "" {
			continue
		}
		var userID string
		err := tx.QueryRow(ctx,
			`SELECT id::text FROM users WHERE lower(email) = $1`, email).Scan(&userID)
		if noRows(err) {
			continue
		}
		if err != nil {
			return err
		}
		if seen[userID] {
			continue
		}
		seen[userID] = true
		if _, err := tx.Exec(ctx, `
			INSERT INTO webinar_panelists (webinar_id, user_id, position)
			VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
			webinarID, userID, position); err != nil {
			return err
		}
		position++
	}
	return nil
}

// uniqueSlug turns a topic into a URL segment, adding a short suffix only when
// the plain form is taken.
func uniqueSlug(ctx context.Context, tx pgx.Tx, topic string) (string, error) {
	base := slugify(topic)
	if base == "" {
		base = "webinar"
	}
	if len(base) > 60 {
		base = strings.Trim(base[:60], "-")
	}
	for attempt := 0; attempt < 12; attempt++ {
		candidate := base
		if attempt > 0 {
			suffix, err := randomDigits(4)
			if err != nil {
				return "", err
			}
			candidate = base + "-" + suffix
		}
		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM webinars WHERE slug = $1)`, candidate).Scan(&exists); err != nil {
			return "", err
		}
		if !exists {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("could not allocate a unique slug for %q", topic)
}

// uniqueWebinarID mints the human-readable id a host reads out on a call,
// grouped like a phone number for the same reason phone numbers are.
func uniqueWebinarID(ctx context.Context, tx pgx.Tx) (string, error) {
	for attempt := 0; attempt < 12; attempt++ {
		a, err := randomDigits(3)
		if err != nil {
			return "", err
		}
		b, err := randomDigits(4)
		if err != nil {
			return "", err
		}
		c, err := randomDigits(4)
		if err != nil {
			return "", err
		}
		candidate := a + " " + b + " " + c

		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM webinars WHERE webinar_id = $1)`, candidate).Scan(&exists); err != nil {
			return "", err
		}
		if !exists {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("could not allocate a unique webinar id")
}

func randomDigits(n int) (string, error) {
	out := make([]byte, n)
	for i := range out {
		v, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			return "", err
		}
		out[i] = byte('0' + v.Int64()) // #nosec G115 -- a single digit 0-9
	}
	return string(out), nil
}

// slugify keeps ASCII letters and digits and collapses everything else into
// single hyphens.
func slugify(s string) string {
	var b strings.Builder
	lastHyphen := true // leading hyphens are suppressed
	for _, r := range strings.ToLower(s) {
		switch {
		case r < unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r)):
			b.WriteRune(r)
			lastHyphen = false
		case !lastHyphen:
			b.WriteByte('-')
			lastHyphen = true
		}
	}
	return strings.Trim(b.String(), "-")
}

// attachChildren fills panelists, custom questions and the name-only join flag
// for a batch of webinars. The three reads are independent, so they run together
// — two queries total used to be the point, and they still are two plus the
// join flag, just not one after another.
func (s *Store) attachChildren(ctx context.Context, list []types.Webinar) ([]types.Webinar, error) {
	if len(list) == 0 {
		return list, nil
	}
	slugs := make([]string, len(list))
	for i, w := range list {
		slugs[i] = w.ID
	}

	var (
		panelists map[string][]types.Person
		questions map[string][]types.CustomQuestion
		open      map[string]bool
	)
	var seriesInfo map[string]types.SeriesInfo
	if err := RunParallel(ctx,
		func(ctx context.Context) error {
			var err error
			panelists, err = s.panelistsBySlug(ctx, slugs)
			return err
		},
		func(ctx context.Context) error {
			var err error
			questions, err = s.questionsBySlug(ctx, slugs)
			return err
		},
		func(ctx context.Context) error {
			var err error
			open, err = s.openJoinFlags(ctx, list)
			return err
		},
		func(ctx context.Context) error {
			var err error
			seriesInfo, err = s.seriesByID(ctx, list)
			return err
		},
	); err != nil {
		return nil, err
	}
	for i := range list {
		if p := panelists[list[i].ID]; len(p) > 0 {
			list[i].Panelists = p
		}
		if q := questions[list[i].ID]; len(q) > 0 {
			list[i].CustomQuestions = q
		}
		list[i].GuestJoinAllowed = types.GuestJoinAllowedFor(list[i], open[list[i].Host.ID])
		if info, ok := seriesInfo[list[i].SeriesID]; ok && list[i].SeriesID != "" {
			copied := info
			list[i].Series = &copied
		}
	}
	return list, nil
}

func (s *Store) panelistsBySlug(ctx context.Context, slugs []string) (map[string][]types.Person, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT w.slug, u.id::text, u.name, u.title, u.org, u.initials, u.hue
		  FROM webinar_panelists p
		  JOIN webinars w ON w.id = p.webinar_id
		  JOIN users u    ON u.id = p.user_id
		 WHERE w.slug = ANY($1)
		 ORDER BY w.slug, p.position`, slugs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]types.Person{}
	for rows.Next() {
		var slug string
		var p types.Person
		if err := rows.Scan(&slug, &p.ID, &p.Name, &p.Title, &p.Org, &p.Initials, &p.Hue); err != nil {
			return nil, err
		}
		out[slug] = append(out[slug], p)
	}
	return out, rows.Err()
}

func (s *Store) questionsBySlug(ctx context.Context, slugs []string) (map[string][]types.CustomQuestion, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT w.slug, q.key, q.label, q.type, q.required, q.options
		  FROM custom_questions q
		  JOIN webinars w ON w.id = q.webinar_id
		 WHERE w.slug = ANY($1)
		 ORDER BY w.slug, q.position`, slugs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]types.CustomQuestion{}
	for rows.Next() {
		var slug string
		var q types.CustomQuestion
		var opts []byte
		if err := rows.Scan(&slug, &q.ID, &q.Label, &q.Type, &q.Required, &opts); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(opts, &q.Options); err != nil {
			return nil, err
		}
		out[slug] = append(out[slug], q)
	}
	return out, rows.Err()
}

/* openJoinFlags reports which of these hosts may open the name-only door.
 *
 * One query for the whole page. A host missing from the result is left out of
 * the map, and the caller treats that as off — the default (migrations/0073). */
func (s *Store) openJoinFlags(ctx context.Context, list []types.Webinar) (map[string]bool, error) {
	open := map[string]bool{}
	ids := make([]string, 0, len(list))
	seen := map[string]bool{}
	for _, w := range list {
		if w.Host.ID == "" || seen[w.Host.ID] {
			continue
		}
		seen[w.Host.ID] = true
		ids = append(ids, w.Host.ID)
	}
	if len(ids) == 0 {
		return open, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, $2 = ANY(COALESCE(features, '{}'))
		  FROM users
		 WHERE id::text = ANY($1)`, ids, types.FeatureJoinWithoutRegistration)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var allowed bool
		if err := rows.Scan(&id, &allowed); err != nil {
			return nil, err
		}
		open[id] = allowed
	}
	return open, rows.Err()
}

/* ClaimSFUProject records which LiveKit project a webinar's room lives on, and reports what was
 * already recorded if somebody got there first.
 *
 * FOR UPDATE, and therefore a transaction. Read-then-write without the lock would let two
 * attendees arriving in the same millisecond each see an empty pin, each write their own choice,
 * and end up in two separate rooms on two different projects — the exact split this column
 * exists to prevent. The lock serialises them: the second one reads the first one's answer and
 * uses it. Same reasoning, and the same shape, as the capacity check in RegisterGuest.
 *
 * `fresh` says the pin was created by THIS call. It is the caller's licence to try a different
 * project when the first one refuses the room, because a pin that did not exist a moment ago
 * cannot have anybody connected to it yet. See Server.sfuFor.
 */
func (s *Store) ClaimSFUProject(
	ctx context.Context, slug, projectID string,
) (effective string, fresh bool, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var current string
	err = tx.QueryRow(ctx,
		`SELECT sfu_project FROM webinars WHERE slug = $1 FOR UPDATE`, slug).Scan(&current)
	if noRows(err) {
		return "", false, ErrNotFound
	}
	if err != nil {
		return "", false, err
	}
	if current != "" {
		// Somebody already chose. Committing an empty transaction is cheaper to reason
		// about than a second exit path that skips the commit.
		return current, false, tx.Commit(ctx)
	}

	if _, err := tx.Exec(ctx,
		`UPDATE webinars SET sfu_project = $2 WHERE slug = $1`, slug, projectID); err != nil {
		return "", false, err
	}
	return projectID, true, tx.Commit(ctx)
}

/* RepinSFUProject moves a webinar to a different project, unconditionally.
 *
 * Used in exactly one situation: the project a webinar was pinned to is no longer in the
 * configuration, so nothing can mint a token for it and the room is unreachable. The caller
 * checks that the webinar is not live before calling — moving a live room puts the host on one
 * project and new arrivals on another, which is worse than the error it replaces.
 */
func (s *Store) RepinSFUProject(ctx context.Context, slug, projectID string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE webinars SET sfu_project = $2 WHERE slug = $1`, slug, projectID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SFUProjectOf is the project a webinar's room is pinned to, empty when it has none yet.
func (s *Store) SFUProjectOf(ctx context.Context, slug string) (string, error) {
	var project string
	err := s.pool.QueryRow(ctx, `SELECT sfu_project FROM webinars WHERE slug = $1`, slug).Scan(&project)
	if noRows(err) {
		return "", ErrNotFound
	}
	return project, err
}

/* WebinarsOnSFUProject answers "what is still running on the project I am about to retire".
 *
 * Live and scheduled only. An ended webinar keeps its pin as a record of where it happened, and
 * including those would bury the two sessions an operator actually has to worry about under
 * every session they have ever run.
 */
func (s *Store) WebinarsOnSFUProject(ctx context.Context, projectID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT slug FROM webinars
		 WHERE sfu_project = $1 AND status IN ('live', 'scheduled')
		 ORDER BY starts_at`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []string{}
	for rows.Next() {
		var slug string
		if err := rows.Scan(&slug); err != nil {
			return nil, err
		}
		out = append(out, slug)
	}
	return out, rows.Err()
}

// ------------------------------------------------------------------- image

/* SetWebinarImage replaces a webinar's cover image and mints a fresh opaque
 * version token, returning the storage key of the image it replaced ("" if none)
 * so the caller can delete that file.
 *
 * With an object store, storageKey names the uploaded file and data is nil; the
 * row keeps only the key (migrations/0098). Without one (recording storage off),
 * storageKey is "" and the bytes go into image_data as before (migrations/0016).
 */
func (s *Store) SetWebinarImage(ctx context.Context, slug, mime string, data []byte, storageKey string) (string, error) {
	if data == nil {
		data = []byte{}
	}
	var old string
	err := s.pool.QueryRow(ctx, `
		WITH old AS (SELECT id, image_storage_key FROM webinars WHERE slug = $1 FOR UPDATE)
		UPDATE webinars w
		   SET image_key = $2, image_mime = $3, image_data = $4, image_storage_key = $5, updated_at = now()
		  FROM old
		 WHERE w.id = old.id
		RETURNING old.image_storage_key`,
		slug, newImageVersion(), mime, data, storageKey,
	).Scan(&old)
	if noRows(err) {
		return "", ErrNotFound
	}
	return old, err
}

/* ClearWebinarImage removes a webinar's cover image, returning the storage key
 * it pointed at ("" if none) for the caller to delete.
 *
 * Not SetWebinarImage with empty values: that would still mint a fresh,
 * non-empty image_key, and "no image" has to mean image_key = '' specifically —
 * it is the sentinel both scanWebinar (for ImageURL) and WebinarImageMedia check
 * to tell "nothing uploaded" apart from "an image, empty by coincidence". */
func (s *Store) ClearWebinarImage(ctx context.Context, slug string) (string, error) {
	var old string
	err := s.pool.QueryRow(ctx, `
		WITH old AS (SELECT id, image_storage_key FROM webinars WHERE slug = $1 FOR UPDATE)
		UPDATE webinars w
		   SET image_key = '', image_mime = '', image_data = '', image_storage_key = '', updated_at = now()
		  FROM old
		 WHERE w.id = old.id
		RETURNING old.image_storage_key`, slug).Scan(&old)
	if noRows(err) {
		return "", ErrNotFound
	}
	return old, err
}

/* WebinarImageMedia returns a webinar's cover image: the storage key when the
 * file is in the object store, otherwise the bytes still held in the row (an
 * upload from before 0098 the backfill has not moved yet, or a deployment with
 * no object store).
 *
 * Public, deliberately: unlike a chat image, a cover image is meant to be seen by
 * anyone who can reach the registration or browse page, signed in or not — the
 * handler that calls this does not check who is asking, only that the webinar
 * (and the image) exist.
 */
func (s *Store) WebinarImageMedia(ctx context.Context, slug string) (data []byte, mime, storageKey string, err error) {
	var key string
	err = s.pool.QueryRow(ctx,
		`SELECT image_key, image_mime, image_data, image_storage_key FROM webinars WHERE slug = $1`, slug).
		Scan(&key, &mime, &data, &storageKey)
	if noRows(err) {
		return nil, "", "", ErrNotFound
	}
	if err != nil {
		return nil, "", "", err
	}
	if key == "" {
		return nil, "", "", ErrNotFound
	}
	return data, mime, storageKey, nil
}

// ImageToMove is one image still held as bytes in its row, for the backfill.
type ImageToMove struct {
	ID      string
	Version string
	Mime    string
	Data    []byte
}

// WebinarImagesToMove lists cover images still stored in image_data.
func (s *Store) WebinarImagesToMove(ctx context.Context, limit int) ([]ImageToMove, error) {
	return s.imagesToMove(ctx, `
		SELECT id::text, image_key, image_mime, image_data FROM webinars
		 WHERE image_key <> '' AND image_storage_key = '' AND octet_length(image_data) > 0
		 LIMIT $1`, limit)
}

// UserAvatarsToMove lists profile photos still stored in avatar_data.
func (s *Store) UserAvatarsToMove(ctx context.Context, limit int) ([]ImageToMove, error) {
	return s.imagesToMove(ctx, `
		SELECT id::text, avatar_key, avatar_mime, avatar_data FROM users
		 WHERE avatar_key <> '' AND avatar_storage_key = '' AND octet_length(avatar_data) > 0
		 LIMIT $1`, limit)
}

func (s *Store) imagesToMove(ctx context.Context, query string, limit int) ([]ImageToMove, error) {
	rows, err := s.pool.Query(ctx, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ImageToMove
	for rows.Next() {
		var m ImageToMove
		if err := rows.Scan(&m.ID, &m.Version, &m.Mime, &m.Data); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

/* MarkWebinarImageMoved points a row at its moved file and drops the bytes, only
 * if the image is still the version that was read. False means it was replaced
 * or removed meanwhile, and the caller deletes the file it just wrote. */
func (s *Store) MarkWebinarImageMoved(ctx context.Context, id, version, storageKey string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars SET image_storage_key = $3, image_data = ''
		 WHERE id = $1::uuid AND image_key = $2 AND image_storage_key = ''`, id, version, storageKey)
	return tag.RowsAffected() == 1, err
}

// MarkUserAvatarMoved is MarkWebinarImageMoved for a profile photo.
func (s *Store) MarkUserAvatarMoved(ctx context.Context, id, version, storageKey string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE users SET avatar_storage_key = $3, avatar_data = ''
		 WHERE id = $1::uuid AND avatar_key = $2 AND avatar_storage_key = ''`, id, version, storageKey)
	return tag.RowsAffected() == 1, err
}

// newImageVersion is the opaque `?v=` cache-buster on a cover image's URL — see
// ImageURL's doc comment. Just needs to differ from the last one; a UUID is the
// simplest way to guarantee that without tracking any state.
func newImageVersion() string {
	return uuid.NewString()
}

// ExpiredLiveWebinars returns the slugs of webinars currently marked live that have
// reached or exceeded their max_duration_min.
// LiveWebinarsPastStart lists live webinars whose scheduled start has passed —
// the candidates for the empty-room sweep. A host who opens the room early and
// waits for an audience is deliberately not one of them.
/* SFUDemand is what keeps a project's SFU VM up: webinars live on it, and scheduled ones
 * starting within `within` that will land on it — pinned to it, or unpinned with a host
 * assigned to it, or (isDefault) unpinned with a host assigned nowhere. Scheduled webinars
 * whose start passed more than six hours ago without starting are not counted. */
func (s *Store) SFUDemand(ctx context.Context, project string, within time.Duration, isDefault bool) (live, soon int, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT
		  (SELECT count(*) FROM webinars WHERE status = 'live' AND sfu_project = $1),
		  (SELECT count(*) FROM webinars w JOIN users u ON u.id = w.host_id
		    WHERE w.status = 'scheduled'
		      AND w.starts_at <= now() + make_interval(secs => $2)
		      AND w.starts_at >= now() - interval '6 hours'
		      AND (w.sfu_project = $1
		           OR (w.sfu_project = '' AND (coalesce(u.sfu_project, '') = $1
		                                       OR ($3 AND coalesce(u.sfu_project, '') = '')))))`,
		project, within.Seconds(), isDefault).Scan(&live, &soon)
	return live, soon, err
}

/* LiveEdgeWebinarsOn is the live Edge-delivery webinars pinned to a LiveKit project: how
 * many egress workers that project's pool needs up. */
func (s *Store) LiveEdgeWebinarsOn(ctx context.Context, project string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT slug
		  FROM webinars
		 WHERE status = 'live'
		   AND delivery = 'edge'
		   AND sfu_project = $1`, project)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var slugs []string
	for rows.Next() {
		var slug string
		if err := rows.Scan(&slug); err != nil {
			return nil, err
		}
		slugs = append(slugs, slug)
	}
	return slugs, rows.Err()
}

/* HostLiveSession is a session hostID has on the air other than exceptSlug, if any:
 * a host runs one webinar or meeting at a time (handleStartWebinar). Simulives are left
 * out: they go live on their own schedule, and a host may run a live session while one
 * replays. ErrNotFound means none. */
func (s *Store) HostLiveSession(ctx context.Context, hostID, exceptSlug string) (slug, topic string, kind types.WebinarKind, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT slug, topic, kind
		  FROM webinars
		 WHERE host_id = $1
		   AND status = 'live'
		   AND kind <> 'simulive'
		   AND slug <> $2
		 ORDER BY starts_at DESC
		 LIMIT 1`, hostID, exceptSlug).Scan(&slug, &topic, &kind)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return slug, topic, kind, err
}

func (s *Store) LiveWebinarsPastStart(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT slug
		  FROM webinars
		 WHERE status = 'live'
		   AND starts_at <= now()`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var slugs []string
	for rows.Next() {
		var slug string
		if err := rows.Scan(&slug); err != nil {
			return nil, err
		}
		slugs = append(slugs, slug)
	}
	return slugs, rows.Err()
}

// MarkWebinarEmptiness records what the SFU just reported and returns how long
// the room has been empty. An occupied room clears the clock and reports zero,
// so a brief gap between two participants does not accumulate towards a close.
func (s *Store) MarkWebinarEmptiness(ctx context.Context, slug string, empty bool) (time.Duration, error) {
	if !empty {
		_, err := s.pool.Exec(ctx, `
			UPDATE webinars SET empty_since = NULL
			 WHERE (slug = $1 OR id::text = $1) AND empty_since IS NOT NULL`, slug)
		return 0, err
	}

	var seconds float64
	err := s.pool.QueryRow(ctx, `
		UPDATE webinars
		   SET empty_since = COALESCE(empty_since, now())
		 WHERE (slug = $1 OR id::text = $1)
		 RETURNING EXTRACT(EPOCH FROM (now() - empty_since))::float8`, slug).Scan(&seconds)
	if noRows(err) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	return time.Duration(seconds * float64(time.Second)), nil
}

func (s *Store) ExpiredLiveWebinars(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT slug
		  FROM webinars
		 WHERE status = 'live'
		   AND started_at IS NOT NULL
		   AND now() - started_at >= interval '1 minute' * max_duration_min`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var slugs []string
	for rows.Next() {
		var slug string
		if err := rows.Scan(&slug); err != nil {
			return nil, err
		}
		slugs = append(slugs, slug)
	}
	return slugs, rows.Err()
}

/* WebinarStreamIngest is the RTMP(S) URL including the stream key, and whether
 * the encoder should currently be pushing to it. Not on the Webinar JSON type —
 * the key must not reach a browser.
 *
 * The two are independent: a stopped stream keeps its ingest so the host can go
 * live again without digging the key out of YouTube Studio a second time. Read
 * `on` to decide what to push; read `ingest` to decide what is already saved. */
func (s *Store) WebinarStreamIngest(ctx context.Context, slug string) (ingest string, on bool, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT stream_ingest, stream_on FROM webinars WHERE slug = $1 OR id::text = $1`,
		slug).Scan(&ingest, &on)
	if noRows(err) {
		return "", false, ErrNotFound
	}
	return ingest, on, err
}

// SetWebinarStream saves the encoder destination and the watch URL the
// recordings tab will show, and starts pushing to it.
func (s *Store) SetWebinarStream(ctx context.Context, slug, ingest, watch, broadcastID string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars
		   SET stream_ingest = $2, stream_watch = $3, youtube_broadcast_id = $4,
		       stream_on = true
		 WHERE slug = $1 OR id::text = $1`, slug, ingest, watch, broadcastID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

/* StopWebinarStream stops the RTMP push without forgetting where it pointed.
 *
 * The stream key stays so the host can go live again from the same dialog, and
 * the watch URL stays because that link is the whole reason the recordings tab
 * mentions YouTube at all. dropWatch is for turning the option off on the
 * schedule form, where the host is saying they want no YouTube on this webinar.
 *
 * The broadcast id is always cleared: that one belongs to the live we just
 * ended, and the next one gets a new id. */
func (s *Store) StopWebinarStream(ctx context.Context, slug string, dropWatch bool) error {
	watchSQL := `stream_watch`
	if dropWatch {
		watchSQL = `''`
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars
		   SET stream_on = false,
		       youtube_broadcast_id = '',
		       stream_ingest = CASE WHEN $2 THEN '' ELSE stream_ingest END,
		       stream_watch = `+watchSQL+`
		 WHERE slug = $1 OR id::text = $1`, slug, dropWatch)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) WebinarYouTubeBroadcast(ctx context.Context, slug string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `
		SELECT youtube_broadcast_id FROM webinars WHERE slug = $1 OR id::text = $1`, slug).Scan(&id)
	if noRows(err) {
		return "", ErrNotFound
	}
	return id, err
}
