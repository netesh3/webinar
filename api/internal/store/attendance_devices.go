package store

import (
	"context"
	"sort"
	"time"

	"github.com/netkumar/webcast/api/internal/useragent"
	"github.com/netkumar/webcast/api/types"
)

/* SetAttendanceDevice notes the device a person joined on, and where from, once.
 *
 * Only on a row that has none yet: the first join's device is the one kept (migration 0166),
 * so a reconnect, a reload or a second tab never moves anybody between buckets. A bot or an
 * unreadable User-Agent writes nothing, which is what keeps our own mix, crawlers and the
 * load-test kit out of the counts. The attendance row has to exist (TouchAttendance first).
 *
 * The location (migration 0171) rides on the same write, so it is the first join's too and a
 * person who reconnects from another network stays where they arrived. An empty country or
 * region is stored as NULL: unknown. (29 Oct 2026) */
func (s *Store) SetAttendanceDevice(ctx context.Context, slug, identity string, d useragent.Device, loc Location) error {
	if identity == "" || !d.Counted() {
		return nil
	}
	region := loc.Region
	if loc.Country == "" {
		region = ""
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE attendance a
		   SET device_class = $3, device_os = $4, device_browser = $5,
		       country = NULLIF($6, ''), region = NULLIF($7, '')
		  FROM webinars w
		 WHERE a.webinar_id = w.id AND w.slug = $1 AND a.identity = $2
		   AND a.device_class IS NULL`,
		slug, identity, d.Class, d.OS, d.Browser, loc.Country, region)
	return err
}

/* Location is where Cloudflare places a join's network: an upper-case ISO 3166-1 alpha-2
 * country and the region inside it, each "" when unknown. The caller has cleaned both
 * (api.joinLocation); the columns' checks are the backstop. */
type Location struct {
	Country string
	Region  string
}

/* The audience, for these counts, is the same cut the attendance report makes: attendee
 * identities ("att_"), so the host and panelists on their own accounts are not in it. An
 * attendee the host brought on stage still is: they came in as audience. One person is one
 * row (attendance is one row per webinar and identity), so these are people, not page loads. */
const (
	webinarAudienceSQL = `
	WITH aud AS (
	  SELECT a.device_class, a.device_os, a.device_browser, a.country, a.region
	    FROM attendance a JOIN webinars w ON w.id = a.webinar_id
	   WHERE starts_with(a.identity, 'att_') AND w.slug = $1
	)`
	sinceAudienceSQL = `
	WITH aud AS (
	  SELECT a.device_class, a.device_os, a.device_browser, a.country, a.region
	    FROM attendance a
	   WHERE starts_with(a.identity, 'att_') AND a.first_joined_at >= $1
	)`
	deviceCountsSQL = `
	SELECT 'total', '', count(*) FROM aud
	UNION ALL SELECT 'class', device_class, count(*) FROM aud WHERE device_class IS NOT NULL GROUP BY device_class
	UNION ALL SELECT 'os', device_os, count(*) FROM aud WHERE device_class IS NOT NULL GROUP BY device_os
	UNION ALL SELECT 'browser', device_browser, count(*) FROM aud WHERE device_class IS NOT NULL GROUP BY device_browser`
	// The states are India's only: that is most of the audience, and where hosts asked.
	locationCountsSQL = `
	SELECT 'total', '', count(*) FROM aud
	UNION ALL SELECT 'country', country, count(*) FROM aud WHERE country IS NOT NULL GROUP BY country
	UNION ALL SELECT 'in_region', region, count(*) FROM aud WHERE country = 'IN' AND region IS NOT NULL GROUP BY region`
)

// WebinarAudienceDevices is one webinar's audience by device.
func (s *Store) WebinarAudienceDevices(ctx context.Context, slug string) (types.AudienceDevices, error) {
	return s.audienceDevices(ctx, webinarAudienceSQL+deviceCountsSQL, slug)
}

// AudienceDevicesSince is every webinar's audience by device, for people who first joined
// since `since` — the admin's view.
func (s *Store) AudienceDevicesSince(ctx context.Context, since time.Time) (types.AudienceDevices, error) {
	return s.audienceDevices(ctx, sinceAudienceSQL+deviceCountsSQL, since)
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

// WebinarAudienceLocations is one webinar's audience by location.
func (s *Store) WebinarAudienceLocations(ctx context.Context, slug string) (types.AudienceLocations, error) {
	return s.audienceLocations(ctx, webinarAudienceSQL+locationCountsSQL, slug)
}

// AudienceLocationsSince is every webinar's audience by location, for people who first
// joined since `since`: the admin's view, the same cut as AudienceDevicesSince.
func (s *Store) AudienceLocationsSince(ctx context.Context, since time.Time) (types.AudienceLocations, error) {
	return s.audienceLocations(ctx, sinceAudienceSQL+locationCountsSQL, since)
}

func (s *Store) audienceLocations(ctx context.Context, sql string, arg any) (types.AudienceLocations, error) {
	out := types.AudienceLocations{
		Countries:    []types.LocationCount{},
		IndiaRegions: []types.LocationCount{},
	}
	rows, err := s.pool.Query(ctx, sql, arg)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	india, inRegions := 0, 0
	for rows.Next() {
		var kind, key string
		var n int
		if err := rows.Scan(&kind, &key, &n); err != nil {
			return out, err
		}
		c := types.LocationCount{Key: key, Count: n}
		switch kind {
		case "total":
			out.Attendees = n
		case "country":
			out.Recorded += n
			out.Countries = append(out.Countries, c)
			if key == "IN" {
				india = n
			}
		case "in_region":
			inRegions += n
			out.IndiaRegions = append(out.IndiaRegions, c)
		}
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	out.Unknown = out.Attendees - out.Recorded
	out.IndiaUnknown = india - inRegions
	sortLocations(out.Countries)
	sortLocations(out.IndiaRegions)
	return out, nil
}

// sortLocations is sortCounts for a location breakdown.
func sortLocations(c []types.LocationCount) {
	sort.Slice(c, func(i, j int) bool {
		if c[i].Count != c[j].Count {
			return c[i].Count > c[j].Count
		}
		return c[i].Key < c[j].Key
	})
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
