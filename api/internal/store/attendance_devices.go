package store

import (
	"context"
	"sort"
	"time"

	"github.com/netkumar/webcast/api/internal/useragent"
	"github.com/netkumar/webcast/api/types"
)

/* SetAttendanceDevice notes the device a person joined on, once.
 *
 * Only on a row that has none yet: the first join's device is the one kept (migration 0166),
 * so a reconnect, a reload or a second tab never moves anybody between buckets. A bot or an
 * unreadable User-Agent writes nothing, which is what keeps our own mix, crawlers and the
 * load-test kit out of the counts. The attendance row has to exist (TouchAttendance first). */
func (s *Store) SetAttendanceDevice(ctx context.Context, slug, identity string, d useragent.Device) error {
	if identity == "" || !d.Counted() {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE attendance a
		   SET device_class = $3, device_os = $4, device_browser = $5
		  FROM webinars w
		 WHERE a.webinar_id = w.id AND w.slug = $1 AND a.identity = $2
		   AND a.device_class IS NULL`,
		slug, identity, d.Class, d.OS, d.Browser)
	return err
}

/* The audience, for these counts, is the same cut the attendance report makes: attendee
 * identities ("att_"), so the host and panelists on their own accounts are not in it. An
 * attendee the host brought on stage still is: they came in as audience. One person is one
 * row (attendance is one row per webinar and identity), so these are people, not page loads. */
const (
	webinarAudienceSQL = `
	WITH aud AS (
	  SELECT a.device_class, a.device_os, a.device_browser
	    FROM attendance a JOIN webinars w ON w.id = a.webinar_id
	   WHERE starts_with(a.identity, 'att_') AND w.slug = $1
	)` + deviceCountsSQL
	sinceAudienceSQL = `
	WITH aud AS (
	  SELECT a.device_class, a.device_os, a.device_browser
	    FROM attendance a
	   WHERE starts_with(a.identity, 'att_') AND a.first_joined_at >= $1
	)` + deviceCountsSQL
	deviceCountsSQL = `
	SELECT 'total', '', count(*) FROM aud
	UNION ALL SELECT 'class', device_class, count(*) FROM aud WHERE device_class IS NOT NULL GROUP BY device_class
	UNION ALL SELECT 'os', device_os, count(*) FROM aud WHERE device_class IS NOT NULL GROUP BY device_os
	UNION ALL SELECT 'browser', device_browser, count(*) FROM aud WHERE device_class IS NOT NULL GROUP BY device_browser`
)

// WebinarAudienceDevices is one webinar's audience by device.
func (s *Store) WebinarAudienceDevices(ctx context.Context, slug string) (types.AudienceDevices, error) {
	return s.audienceDevices(ctx, webinarAudienceSQL, slug)
}

// AudienceDevicesSince is every webinar's audience by device, for people who first joined
// since `since` — the admin's view.
func (s *Store) AudienceDevicesSince(ctx context.Context, since time.Time) (types.AudienceDevices, error) {
	return s.audienceDevices(ctx, sinceAudienceSQL, since)
}

func (s *Store) audienceDevices(ctx context.Context, sql string, arg any) (types.AudienceDevices, error) {
	out := types.AudienceDevices{
		Classes:  []types.DeviceCount{},
		OS:       []types.DeviceCount{},
		Browsers: []types.DeviceCount{},
	}
	rows, err := s.pool.Query(ctx, sql, arg)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var kind, key string
		var n int
		if err := rows.Scan(&kind, &key, &n); err != nil {
			return out, err
		}
		c := types.DeviceCount{Key: key, Count: n}
		switch kind {
		case "total":
			out.Attendees = n
		case "class":
			out.Recorded += n
			out.Classes = append(out.Classes, c)
		case "os":
			out.OS = append(out.OS, c)
		case "browser":
			out.Browsers = append(out.Browsers, c)
		}
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	sortCounts(out.Classes)
	sortCounts(out.OS)
	sortCounts(out.Browsers)
	return out, nil
}

// sortCounts orders a breakdown largest first, then by name, so the order is stable.
func sortCounts(c []types.DeviceCount) {
	sort.Slice(c, func(i, j int) bool {
		if c[i].Count != c[j].Count {
			return c[i].Count > c[j].Count
		}
		return c[i].Key < c[j].Key
	})
}
