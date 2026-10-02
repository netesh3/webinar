package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/netkumar/webcast/api/internal/series"
	"github.com/netkumar/webcast/api/types"
)

// insertWebinar writes one webinar inside an open transaction.
//
// seriesID empty, occurrence 0, and exception false is a one-off: the series
// columns stay null. A series session passes its series id and a 1-based index.
func insertWebinar(
	ctx context.Context, tx pgx.Tx, hostID string, in types.WebinarInput, startsAt time.Time,
	seriesID string, occurrence int, exception bool, maxDuration int,
) (slug, id string, err error) {
	slug, err = uniqueSlug(ctx, tx, in.Topic)
	if err != nil {
		return "", "", err
	}
	webinarID, err := uniqueWebinarID(ctx, tx)
	if err != nil {
		return "", "", err
	}
	agenda, takeaways, options, err := marshalWebinarJSON(in)
	if err != nil {
		return "", "", err
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO webinars
			(slug, webinar_id, topic, summary, description, track,
			 starts_at, duration_min, time_zone, kind, status, host_id,
			 registration_required, approval, attendee_limit, passcode,
			 agenda, takeaways, options,
			 hide_attendees, mute_on_entry, allow_unmute, chat_enabled,
			 qa_enabled, raise_hand_enabled, reactions_enabled, locked,
			 chat_destination, polls_enabled, captions_enabled,
			 max_duration_min, simulive_recording_id,
			 series_id, occurrence_index, series_exception)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
		        $13,$14,$15,$16,$17,$18,$19,
		        $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31, NULLIF($32,'')::uuid,
		        NULLIF($33,'')::uuid, NULLIF($34, 0), $35)
		RETURNING id::text`,
		slug, webinarID, strings.TrimSpace(in.Topic), strings.TrimSpace(in.Summary),
		strings.TrimSpace(in.Descript), strings.TrimSpace(in.Track),
		startsAt, in.Duration, in.TimeZone, string(in.Kind), string(in.Status), hostID,
		in.RegistrationRequired, string(in.Approval), in.AttendeeLimit,
		strings.TrimSpace(in.Passcode), agenda, takeaways, options,
		in.Controls.HideAttendees, in.Controls.MuteOnEntry, in.Controls.AllowUnmute,
		in.Controls.ChatEnabled, in.Controls.QAEnabled, in.Controls.RaiseHandEnabled,
		in.Controls.ReactionsEnabled, in.Controls.Locked,
		string(in.Controls.ChatDestination.OrDefault()), in.Controls.PollsEnabled,
		in.Controls.CaptionsEnabled || in.Options.Captions,
		maxDuration, strings.TrimSpace(in.SimuliveRecordingID),
		seriesID, occurrence, exception,
	).Scan(&id)
	if isUniqueViolation(err) {
		return "", "", ErrConflict
	}
	if err != nil {
		return "", "", err
	}
	if err := replaceQuestions(ctx, tx, id, in.CustomQuestions); err != nil {
		return "", "", err
	}
	if err := replacePanelists(ctx, tx, id, hostID, in.PanelistEmails); err != nil {
		return "", "", err
	}
	return slug, id, nil
}

func hostMaxDuration(ctx context.Context, tx pgx.Tx, hostID string, fallback int) (int, error) {
	var userMax *int
	if err := tx.QueryRow(ctx, `SELECT max_duration_min FROM users WHERE id = $1`, hostID).Scan(&userMax); err != nil && !noRows(err) {
		return 0, err
	}
	maxDuration := fallback
	if maxDuration <= 0 {
		maxDuration = 180
	}
	if userMax != nil && *userMax > 0 {
		maxDuration = *userMax
	}
	return maxDuration, nil
}

// CreateWebinarSeries inserts the series and one webinar per occurrence.
// The returned webinar is the first session.
func (s *Store) CreateWebinarSeries(
	ctx context.Context, hostID string, in types.WebinarInput, plan series.Plan, defaultMaxDurationMin int,
) (types.Webinar, error) {
	if len(plan.Times) == 0 {
		return types.Webinar{}, fmt.Errorf("%w: series has no sessions", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return types.Webinar{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	seriesID, err := insertSeries(ctx, tx, hostID, plan)
	if err != nil {
		return types.Webinar{}, err
	}
	maxDuration, err := hostMaxDuration(ctx, tx, hostID, defaultMaxDurationMin)
	if err != nil {
		return types.Webinar{}, err
	}
	in.Kind = types.KindRecurring
	var firstSlug string
	for i, starts := range plan.Times {
		slug, _, err := insertWebinar(ctx, tx, hostID, in, starts, seriesID, i+1, false, maxDuration)
		if err != nil {
			return types.Webinar{}, err
		}
		if i == 0 {
			firstSlug = slug
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return types.Webinar{}, err
	}
	return s.WebinarBySlug(ctx, firstSlug)
}

// ConvertToSeries turns an existing one-off into occurrence 1 and adds the rest.
func (s *Store) ConvertToSeries(
	ctx context.Context, slug string, in types.WebinarInput, plan series.Plan, defaultMaxDurationMin int,
) (types.Webinar, error) {
	if len(plan.Times) == 0 {
		return types.Webinar{}, fmt.Errorf("%w: series has no sessions", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return types.Webinar{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var id, hostID string
	err = tx.QueryRow(ctx, `
		SELECT id::text, host_id::text FROM webinars
		 WHERE slug = $1 AND series_id IS NULL
		 FOR UPDATE`, slug).Scan(&id, &hostID)
	if noRows(err) {
		return types.Webinar{}, ErrNotFound
	}
	if err != nil {
		return types.Webinar{}, err
	}
	seriesID, err := insertSeries(ctx, tx, hostID, plan)
	if err != nil {
		return types.Webinar{}, err
	}
	in.Kind = types.KindRecurring
	if err := updateWebinarRow(ctx, tx, id, hostID, in, plan.Times[0], false); err != nil {
		return types.Webinar{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE webinars
		   SET series_id = $2::uuid, occurrence_index = 1, series_exception = false
		 WHERE id = $1`, id, seriesID); err != nil {
		return types.Webinar{}, err
	}
	maxDuration, err := hostMaxDuration(ctx, tx, hostID, defaultMaxDurationMin)
	if err != nil {
		return types.Webinar{}, err
	}
	for i, starts := range plan.Times {
		if i == 0 {
			continue
		}
		if _, _, err := insertWebinar(ctx, tx, hostID, in, starts, seriesID, i+1, false, maxDuration); err != nil {
			return types.Webinar{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return types.Webinar{}, err
	}
	return s.WebinarBySlug(ctx, slug)
}

// MarkSeriesException records that this session was edited on its own.
func (s *Store) MarkSeriesException(ctx context.Context, slug string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars SET series_exception = true, updated_at = now()
		 WHERE slug = $1 AND series_id IS NOT NULL`, slug)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return nil
	}
	return nil
}

type seriesOcc struct {
	ID         string
	Slug       string
	StartsAt   time.Time
	Status     string
	StartedAt  *time.Time
	Exception  bool
	Index      int
	Attendance bool
}

// UpdateSeriesFollowing applies a save to this session and later ones.
//
// Exceptions and sessions that already happened are left as they are. The
// end rule can add future sessions, up to 60, or remove future ones that
// have not gone live and have nobody in the room.
func (s *Store) UpdateSeriesFollowing(
	ctx context.Context, slug string, in types.WebinarInput, rule series.Rule, defaultMaxDurationMin int,
) (types.Webinar, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return types.Webinar{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var seriesID, hostID string
	err = tx.QueryRow(ctx, `
		SELECT series_id::text, host_id::text FROM webinars
		 WHERE slug = $1 AND series_id IS NOT NULL
		 FOR UPDATE`, slug).Scan(&seriesID, &hostID)
	if noRows(err) {
		return types.Webinar{}, ErrNotFound
	}
	if err != nil {
		return types.Webinar{}, err
	}
	if _, err := tx.Exec(ctx, `SELECT id FROM webinar_series WHERE id = $1::uuid FOR UPDATE`, seriesID); err != nil {
		return types.Webinar{}, err
	}

	occs, err := loadOccurrences(ctx, tx, seriesID)
	if err != nil {
		return types.Webinar{}, err
	}
	anchor := -1
	for i, o := range occs {
		if o.Slug == slug {
			anchor = i
			break
		}
	}
	if anchor < 0 {
		return types.Webinar{}, ErrNotFound
	}

	loc, err := time.LoadLocation(in.TimeZone)
	if err != nil || loc == nil {
		loc = time.UTC
	}
	newStart, err := time.Parse(time.RFC3339, in.StartsAt)
	if err != nil {
		return types.Webinar{}, fmt.Errorf("%w: startsAt must be RFC3339", ErrInvalid)
	}
	hour, min, sec := newStart.In(loc).Clock()
	origin := occs[0].StartsAt.In(loc)
	for _, o := range occs {
		if o.Index == 1 {
			origin = o.StartsAt.In(loc)
			break
		}
	}
	originAt := time.Date(origin.Year(), origin.Month(), origin.Day(), hour, min, sec, 0, loc)
	plan, err := series.Generate(originAt, loc, rule)
	plan.Zone = in.TimeZone
	if err != nil {
		if ie, ok := err.(*series.InputError); ok {
			return types.Webinar{}, fmt.Errorf("%w: %s", ErrInvalid, ie.Message)
		}
		return types.Webinar{}, err
	}

	in.Kind = types.KindRecurring
	now := time.Now()
	maxDuration, err := hostMaxDuration(ctx, tx, hostID, defaultMaxDurationMin)
	if err != nil {
		return types.Webinar{}, err
	}

	for i, o := range occs {
		inScope := i >= anchor
		editable := inScope && !o.Exception && !occProtected(o, now)
		if o.Slug == slug && !occProtected(o, now) {
			// The session being saved is updated even when it was an exception.
			editable = true
		}
		if i < len(plan.Times) && editable {
			if err := updateWebinarRow(ctx, tx, o.ID, hostID, in, plan.Times[i], false); err != nil {
				return types.Webinar{}, err
			}
			continue
		}
		if i >= len(plan.Times) && inScope && o.Slug != slug && !o.Exception && !occProtected(o, now) {
			if err := moveSeriesRegistrations(ctx, tx, o.ID, seriesID); err != nil {
				return types.Webinar{}, err
			}
			if _, err := tx.Exec(ctx, `DELETE FROM webinars WHERE id = $1`, o.ID); err != nil {
				return types.Webinar{}, err
			}
		}
	}
	for i := len(occs); i < len(plan.Times); i++ {
		if _, _, err := insertWebinar(ctx, tx, hostID, in, plan.Times[i], seriesID, i+1, false, maxDuration); err != nil {
			return types.Webinar{}, err
		}
	}
	if err := updateSeriesRow(ctx, tx, seriesID, plan); err != nil {
		return types.Webinar{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return types.Webinar{}, err
	}
	return s.WebinarBySlug(ctx, slug)
}

func occProtected(o seriesOcc, now time.Time) bool {
	if o.Status == string(types.StatusLive) || o.Status == string(types.StatusEnded) {
		return true
	}
	if o.StartedAt != nil {
		return true
	}
	if !o.StartsAt.After(now) {
		return true
	}
	return o.Attendance
}

func loadOccurrences(ctx context.Context, tx pgx.Tx, seriesID string) ([]seriesOcc, error) {
	rows, err := tx.Query(ctx, `
		SELECT w.id::text, w.slug, w.starts_at, w.status, w.started_at,
		       w.series_exception, coalesce(w.occurrence_index, 0),
		       EXISTS (SELECT 1 FROM attendance a WHERE a.webinar_id = w.id)
		    OR EXISTS (SELECT 1 FROM attendance_visits v WHERE v.webinar_id = w.id)
		  FROM webinars w
		 WHERE w.series_id = $1::uuid
		 ORDER BY w.starts_at ASC, w.occurrence_index ASC
		 FOR UPDATE`, seriesID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []seriesOcc
	for rows.Next() {
		var o seriesOcc
		if err := rows.Scan(&o.ID, &o.Slug, &o.StartsAt, &o.Status, &o.StartedAt, &o.Exception, &o.Index, &o.Attendance); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// SeriesDeleteSlugs lists sessions a delete of this scope may remove.
//
// "this" is the one session. "following" is that session and every later one.
// Past sessions, live sessions, and sessions somebody has entered are absent
// so the caller can refuse or skip them. A one-off returns ok=false.
func (s *Store) SeriesDeleteSlugs(ctx context.Context, slug, scope string) (slugs []string, inSeries bool, err error) {
	var seriesID string
	err = s.pool.QueryRow(ctx, `
		SELECT coalesce(series_id::text, '') FROM webinars WHERE slug = $1`, slug).Scan(&seriesID)
	if noRows(err) {
		return nil, false, ErrNotFound
	}
	if err != nil {
		return nil, false, err
	}
	if seriesID == "" {
		return nil, false, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT w.slug, w.starts_at, w.status, w.started_at,
		       EXISTS (SELECT 1 FROM attendance a WHERE a.webinar_id = w.id)
		    OR EXISTS (SELECT 1 FROM attendance_visits v WHERE v.webinar_id = w.id)
		  FROM webinars w
		 WHERE w.series_id = $1::uuid
		 ORDER BY w.starts_at ASC`, seriesID)
	if err != nil {
		return nil, true, err
	}
	defer rows.Close()
	now := time.Now()
	seenAnchor := false
	for rows.Next() {
		var (
			rowSlug    string
			starts     time.Time
			status     string
			started    *time.Time
			attendance bool
		)
		if err := rows.Scan(&rowSlug, &starts, &status, &started, &attendance); err != nil {
			return nil, true, err
		}
		if rowSlug == slug {
			seenAnchor = true
		}
		if scope == "following" && !seenAnchor {
			continue
		}
		if scope != "following" && rowSlug != slug {
			continue
		}
		o := seriesOcc{Slug: rowSlug, StartsAt: starts, Status: status, StartedAt: started, Attendance: attendance}
		if occProtected(o, now) {
			continue
		}
		slugs = append(slugs, rowSlug)
	}
	return slugs, true, rows.Err()
}

func insertSeries(ctx context.Context, tx pgx.Tx, hostID string, plan series.Plan) (string, error) {
	rule := plan.Rule
	var id string
	var endDate any
	var endCount any
	if rule.End == series.EndByDate {
		endDate = rule.EndDate
	}
	if rule.End == series.EndAfterCount {
		endCount = rule.EndCount
	}
	var monthly any
	if rule.Pattern == series.Monthly {
		monthly = rule.MonthlyDay
	}
	days := make([]int32, len(rule.Weekdays))
	for i, d := range rule.Weekdays {
		days[i] = int32(d)
	}
	skipped := plan.Skipped
	if skipped == nil {
		skipped = []string{}
	}
	zone := plan.Zone
	if zone == "" {
		zone = "UTC"
	}
	err := tx.QueryRow(ctx, `
		INSERT INTO webinar_series
			(host_id, pattern, interval_n, weekdays, monthly_day, ends, end_date, end_count, time_zone, skipped_months)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id::text`,
		hostID, string(rule.Pattern), rule.Interval, days, monthly, string(rule.End),
		endDate, endCount, zone, skipped,
	).Scan(&id)
	return id, err
}

func updateSeriesRow(ctx context.Context, tx pgx.Tx, seriesID string, plan series.Plan) error {
	rule := plan.Rule
	var endDate any
	var endCount any
	if rule.End == series.EndByDate {
		endDate = rule.EndDate
	}
	if rule.End == series.EndAfterCount {
		endCount = rule.EndCount
	}
	var monthly any
	if rule.Pattern == series.Monthly {
		monthly = rule.MonthlyDay
	}
	days := make([]int32, len(rule.Weekdays))
	for i, d := range rule.Weekdays {
		days[i] = int32(d)
	}
	skipped := plan.Skipped
	if skipped == nil {
		skipped = []string{}
	}
	_, err := tx.Exec(ctx, `
		UPDATE webinar_series SET
			pattern = $2, interval_n = $3, weekdays = $4, monthly_day = $5,
			ends = $6, end_date = $7, end_count = $8, skipped_months = $9,
			time_zone = CASE WHEN $10 = '' THEN time_zone ELSE $10 END,
			updated_at = now()
		 WHERE id = $1::uuid`,
		seriesID, string(rule.Pattern), rule.Interval, days, monthly, string(rule.End),
		endDate, endCount, skipped, plan.Zone)
	return err
}

// moveSeriesRegistrations keeps a series signup alive when one session is removed.
func moveSeriesRegistrations(ctx context.Context, tx pgx.Tx, fromID, seriesID string) error {
	var survivor string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM webinars
		 WHERE series_id = $1::uuid AND id <> $2::uuid
		 ORDER BY starts_at ASC
		 LIMIT 1`, seriesID, fromID).Scan(&survivor)
	if noRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		UPDATE registrations SET webinar_id = $1::uuid WHERE webinar_id = $2::uuid`,
		survivor, fromID)
	return err
}

func updateWebinarRow(ctx context.Context, tx pgx.Tx, id, hostID string, in types.WebinarInput, startsAt time.Time, exception bool) error {
	agenda, takeaways, options, err := marshalWebinarJSON(in)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE webinars SET
			topic = $2, summary = $3, description = $4, track = $5,
			starts_at = $6, duration_min = $7, time_zone = $8, kind = $9,
			registration_required = $10, approval = $11,
			attendee_limit = $12, passcode = $13,
			agenda = $14, takeaways = $15, options = $16,
			hide_attendees = $17, mute_on_entry = $18, allow_unmute = $19,
			chat_enabled = $20, qa_enabled = $21, raise_hand_enabled = $22,
			reactions_enabled = $23, locked = $24, chat_destination = $25,
			polls_enabled = $26, captions_enabled = $27,
			simulive_recording_id = NULLIF($28,'')::uuid,
			series_exception = $29,
			status = CASE WHEN status = 'draft' AND $30 = 'scheduled' THEN 'scheduled' ELSE status END,
			updated_at = now()
		 WHERE id = $1`,
		id, strings.TrimSpace(in.Topic), strings.TrimSpace(in.Summary), strings.TrimSpace(in.Descript), strings.TrimSpace(in.Track),
		startsAt, in.Duration, in.TimeZone, string(in.Kind),
		in.RegistrationRequired, string(in.Approval), in.AttendeeLimit, strings.TrimSpace(in.Passcode),
		agenda, takeaways, options,
		in.Controls.HideAttendees, in.Controls.MuteOnEntry, in.Controls.AllowUnmute,
		in.Controls.ChatEnabled, in.Controls.QAEnabled, in.Controls.RaiseHandEnabled,
		in.Controls.ReactionsEnabled, in.Controls.Locked,
		string(in.Controls.ChatDestination.OrDefault()), in.Controls.PollsEnabled,
		in.Controls.CaptionsEnabled || in.Options.Captions,
		strings.TrimSpace(in.SimuliveRecordingID), exception, string(in.Status),
	); err != nil {
		return err
	}
	if err := replaceQuestions(ctx, tx, id, in.CustomQuestions); err != nil {
		return err
	}
	return replacePanelists(ctx, tx, id, hostID, in.PanelistEmails)
}

func (s *Store) seriesByID(ctx context.Context, list []types.Webinar) (map[string]types.SeriesInfo, error) {
	ids := []string{}
	seen := map[string]bool{}
	for _, w := range list {
		if w.SeriesID != "" && !seen[w.SeriesID] {
			seen[w.SeriesID] = true
			ids = append(ids, w.SeriesID)
		}
	}
	out := map[string]types.SeriesInfo{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT s.id::text, s.pattern, s.interval_n, s.weekdays, s.monthly_day,
		       s.ends, s.end_date, s.end_count, s.time_zone, s.skipped_months,
		       (SELECT count(*) FROM webinars w WHERE w.series_id = s.id)
		  FROM webinar_series s
		 WHERE s.id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			info     types.SeriesInfo
			days     []int32
			monthly  *int16
			endDate  *time.Time
			endCount *int32
			skipped  []string
		)
		if err := rows.Scan(
			&info.ID, &info.Pattern, &info.Interval, &days, &monthly,
			&info.End, &endDate, &endCount, &info.TimeZone, &skipped,
			&info.OccurrenceCount,
		); err != nil {
			return nil, err
		}
		for _, d := range days {
			info.Weekdays = append(info.Weekdays, int(d))
		}
		if monthly != nil {
			info.MonthlyDay = int(*monthly)
		}
		if endDate != nil {
			info.EndDate = endDate.Format("2006-01-02")
		}
		if endCount != nil {
			info.EndCount = int(*endCount)
		}
		info.SkippedMonths = skipped
		info.Summary = seriesSummary(info)
		out[info.ID] = info
	}
	return out, rows.Err()
}

func seriesSummary(info types.SeriesInfo) string {
	rule := series.Rule{
		Pattern:    series.Pattern(info.Pattern),
		Interval:   info.Interval,
		MonthlyDay: info.MonthlyDay,
		End:        series.End(info.End),
		EndCount:   info.EndCount,
	}
	for _, d := range info.Weekdays {
		rule.Weekdays = append(rule.Weekdays, time.Weekday(d))
	}
	if info.EndDate != "" {
		if t, err := time.Parse("2006-01-02", info.EndDate); err == nil {
			rule.EndDate = t
		}
	}
	return series.Summary(rule, info.OccurrenceCount, info.SkippedMonths)
}

// SameSeries reports whether two slugs are sessions of one series.
func (s *Store) SameSeries(ctx context.Context, slugA, slugB string) (bool, error) {
	var same bool
	err := s.pool.QueryRow(ctx, `
		SELECT a.series_id IS NOT NULL AND a.series_id = b.series_id
		  FROM webinars a, webinars b
		 WHERE a.slug = $1 AND b.slug = $2`, slugA, slugB).Scan(&same)
	if noRows(err) {
		return false, nil
	}
	return same, err
}
