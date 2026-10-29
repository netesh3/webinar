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
 * region is stored as NULL: unknown. (29 Oct 2026) The city (migration 0172) is the same: on
 * this write, NULL when empty, and only with a country. */
func (s *Store) SetAttendanceDevice(ctx context.Context, slug, identity string, d useragent.Device, loc Location) error {
	if identity == "" || !d.Counted() {
		return nil
	}
	region, city := loc.Region, loc.City
	if loc.Country == "" {
		region, city = "", ""
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE attendance a
		   SET device_class = $3, device_os = $4, device_browser = $5,
		       country = NULLIF($6, ''), region = NULLIF($7, ''), city = NULLIF($8, '')
		  FROM webinars w
		 WHERE a.webinar_id = w.id AND w.slug = $1 AND a.identity = $2
		   AND a.device_class IS NULL`,
		slug, identity, d.Class, d.OS, d.Browser, loc.Country, region, city)
	return err
}

/* Location is where Cloudflare places a join's network: an upper-case ISO 3166-1 alpha-2
 * country, the region inside it and the city, each "" when unknown. The caller has cleaned
 * them (api.joinLocation); the columns' checks are the backstop. */
type Location struct {
	Country string
	Region  string
	City    string
}

// TopCities is how many cities a location breakdown lists; the rest are CitiesOther.
const TopCities = 10

/* The audience, for these counts, is the same cut the attendance report makes: attendee
 * identities ("att_"), so the host and panelists on their own accounts are not in it. An
 * attendee the host brought on stage still is: they came in as audience. One person is one
 * row (attendance is one row per webinar and identity), so these are people, not page loads. */
const (
	webinarAudienceSQL = `
	WITH aud AS (
	  SELECT a.device_class, a.device_os, a.device_browser, a.country, a.region, a.city
	    FROM attendance a JOIN webinars w ON w.id = a.webinar_id
	   WHERE starts_with(a.identity, 'att_') AND w.slug = $1
	)`
	sinceAudienceSQL = `
	WITH aud AS (
	  SELECT a.device_class, a.device_os, a.device_browser, a.country, a.region, a.city
	    FROM attendance a
	   WHERE starts_with(a.identity, 'att_') AND a.first_joined_at >= $1
	)`
	deviceCountsSQL = `
	SELECT 'total', '', count(*) FROM aud
	UNION ALL SELECT 'class', device_class, count(*) FROM aud WHERE device_class IS NOT NULL GROUP BY device_class
	UNION ALL SELECT 'os', device_os, count(*) FROM aud WHERE device_class IS NOT NULL GROUP BY device_os
	UNION ALL SELECT 'browser', device_browser, count(*) FROM aud WHERE device_class IS NOT NULL GROUP BY device_browser`
	/* The states are India's only: that is most of the audience, and where hosts asked. A city
	 * is grouped with its country and region, so two places of one name stay two (29 Oct 2026).
	 * Rows are (kind, key, region, city, count): the key is the country for a city. */
	locationCountsSQL = `
	SELECT 'total', '', '', '', count(*) FROM aud
	UNION ALL SELECT 'country', country, '', '', count(*) FROM aud WHERE country IS NOT NULL GROUP BY country
	UNION ALL SELECT 'in_region', region, '', '', count(*) FROM aud WHERE country = 'IN' AND region IS NOT NULL GROUP BY region
	UNION ALL SELECT 'city', country, coalesce(region, ''), city, count(*) FROM aud
	           WHERE country IS NOT NULL AND city IS NOT NULL GROUP BY country, region, city`
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
		Cities:       []types.CityCount{},
	}
	rows, err := s.pool.Query(ctx, sql, arg)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	india, inRegions, inCities := 0, 0, 0
	for rows.Next() {
		var kind, key, region, city string
		var n int
		if err := rows.Scan(&kind, &key, &region, &city, &n); err != nil {
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
		case "city":
			inCities += n
			out.Cities = append(out.Cities, types.CityCount{Country: key, Region: region, City: city, Count: n})
		}
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	out.Unknown = out.Attendees - out.Recorded
	out.IndiaUnknown = india - inRegions
	sortLocations(out.Countries)
	sortLocations(out.IndiaRegions)
	// The top cities, and the rest summed; people with a country but no city are CitiesUnknown.
	sortCities(out.Cities)
	if len(out.Cities) > TopCities {
		for _, c := range out.Cities[TopCities:] {
			out.CitiesOther += c.Count
		}
		out.Cities = out.Cities[:TopCities]
	}
	out.CitiesUnknown = out.Recorded - inCities
	return out, nil
}

// sortCities is sortCounts for cities: largest first, then by country, region and city.
func sortCities(c []types.CityCount) {
	sort.Slice(c, func(i, j int) bool {
		a, b := c[i], c[j]
		if a.Count != b.Count {
			return a.Count > b.Count
		}
		if a.Country != b.Country {
			return a.Country < b.Country
		}
		if a.Region != b.Region {
			return a.Region < b.Region
		}
		return a.City < b.City
	})
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
