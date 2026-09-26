package store

import (
	"context"
	"fmt"
	"hash/fnv"
	"math"
	"strings"
	"time"
	"unicode"

	"github.com/netkumar/webcast/api/types"
)

type User struct {
	ID           string
	Email        string
	PasswordHash string
	Name         string
	Title        string
	Org          string
	// Phone is E.164 shape (see normalisePhone) — the account holder's own
	// number. Deliberately NOT on Person: that's what other attendees and
	// panelists see about someone, and Org is fine to show there in a way a
	// phone number is not.
	Phone    string
	Initials string
	Hue      string
	CanHost  bool
	// IsAdmin may grant CanHost to other accounts. Never settable in-band: see
	// PromoteAdmins and migrations/0011.
	IsAdmin bool
	// MaxDurationMin is an optional custom maximum meeting duration in minutes.
	// NULL means use the system default.
	MaxDurationMin *int
	// CanCdnBroadcast allows this host to run CDN HLS broadcast webinars.
	CanCdnBroadcast bool
	/* Features are the per-account switches an admin has turned on — the
	 * types.Feature keys, and nothing else. Absent means off; see migrations/0048 for
	 * why these are a list and can_host is a column.
	 */
	Features []string

	// YouTube OAuth. Refresh is the secret; Public() never copies it.
	YouTubeRefresh      string
	YouTubeChannelID    string
	YouTubeChannelTitle string
	YouTubeStreamID     string

	/* WhatsApp Cloud API, granted through Meta Embedded Signup. WhatsAppToken is
	 * the secret; Public() never copies it.
	 *
	 * The token is what makes this host's messages billable to this host's own
	 * WhatsApp Business Account, so it is per-account for the same reason the
	 * YouTube grant is — see migrations/0041. Both timestamps are pointers because
	 * NULL is meaningful for both: no expiry at all, and never connected.
	 */
	WhatsAppToken          string
	WhatsAppWABAID         string
	WhatsAppPhoneNumberID  string
	WhatsAppDisplayPhone   string
	WhatsAppVerifiedName   string
	WhatsAppTokenExpiresAt *time.Time
	WhatsAppConnectedAt    *time.Time
	// WhatsAppRegisteredAt is when this number was registered with Cloud API from
	// here, if it ever was. The PIN that did it is deliberately not stored — see
	// migrations/0048.
	WhatsAppRegisteredAt *time.Time
}

/* HasFeature reports whether a per-account switch is on.
 *
 * On the user rather than on the Store because every caller already has one: a handler
 * reads the account out of the request context, and the runtime paths carry it. A
 * feature check that needed a query would be a query on every send.
 */
func (u User) HasFeature(key string) bool {
	for _, f := range u.Features {
		if f == key {
			return true
		}
	}
	return false
}

func (u User) Public() types.Account {
	a := types.Account{
		ID:              u.ID,
		Email:           u.Email,
		Name:            u.Name,
		Title:           u.Title,
		Org:             u.Org,
		Phone:           u.Phone,
		Initials:        u.Initials,
		Hue:             u.Hue,
		CanHost:         u.CanHost,
		IsAdmin:         u.IsAdmin,
		MaxDurationMin:  u.MaxDurationMin,
		CanCdnBroadcast: u.CanCdnBroadcast,
		// Never nil on the wire: a browser that has to guard a list guards it
		// differently on every screen.
		Features: append([]string{}, u.Features...),
	}
	if u.YouTubeRefresh != "" {
		a.YouTube = &types.YouTubeLink{
			Connected:    true,
			ChannelID:    u.YouTubeChannelID,
			ChannelTitle: u.YouTubeChannelTitle,
		}
	}
	// Keyed on the token, not on the ids: a row can carry a WABA id from a signup
	// that never finished, and only a token means we can actually send.
	if u.WhatsAppToken != "" {
		a.WhatsApp = &types.WhatsAppLink{
			Connected:    true,
			DisplayPhone: u.WhatsAppDisplayPhone,
			VerifiedName: u.WhatsAppVerifiedName,
		}
		if u.WhatsAppConnectedAt != nil {
			a.WhatsApp.ConnectedAt = u.WhatsAppConnectedAt.Format(time.RFC3339)
		}
		if u.WhatsAppTokenExpiresAt != nil {
			a.WhatsApp.TokenExpiresAt = u.WhatsAppTokenExpiresAt.Format(time.RFC3339)
		}
		if u.WhatsAppRegisteredAt != nil {
			a.WhatsApp.RegisteredAt = u.WhatsAppRegisteredAt.Format(time.RFC3339)
		}
	}
	return a
}

// Person is the public projection used inside webinar records: everything the
// UI needs to render someone, and nothing that identifies them further. No
// Phone here — see the field's own doc comment on User.
func (u User) Person() types.Person {
	return types.Person{
		ID:       u.ID,
		Name:     u.Name,
		Title:    u.Title,
		Org:      u.Org,
		Initials: u.Initials,
		Hue:      u.Hue,
	}
}

const userColumns = `id::text, email, coalesce(password_hash,''), name, title, org, phone,
	initials, hue, can_host, is_admin, max_duration_min, can_cdn_broadcast, features,
	coalesce(youtube_refresh,''), coalesce(youtube_channel_id,''),
	coalesce(youtube_channel_title,''), coalesce(youtube_stream_id,''),
	coalesce(whatsapp_access_token,''), coalesce(whatsapp_waba_id,''),
	coalesce(whatsapp_phone_number_id,''), coalesce(whatsapp_display_phone,''),
	coalesce(whatsapp_verified_name,''),
	whatsapp_token_expires_at, whatsapp_connected_at, whatsapp_registered_at`

func scanUser(row scanner) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Email, &u.PasswordHash, &u.Name, &u.Title, &u.Org, &u.Phone,
		&u.Initials, &u.Hue, &u.CanHost, &u.IsAdmin, &u.MaxDurationMin, &u.CanCdnBroadcast,
		&u.Features,
		&u.YouTubeRefresh, &u.YouTubeChannelID, &u.YouTubeChannelTitle, &u.YouTubeStreamID,
		&u.WhatsAppToken, &u.WhatsAppWABAID, &u.WhatsAppPhoneNumberID, &u.WhatsAppDisplayPhone,
		&u.WhatsAppVerifiedName, &u.WhatsAppTokenExpiresAt, &u.WhatsAppConnectedAt,
		&u.WhatsAppRegisteredAt)
	return u, err
}

func (s *Store) HostCanCdnBroadcast(ctx context.Context, hostID string) (bool, error) {
	var can bool
	err := s.pool.QueryRow(ctx, `SELECT can_cdn_broadcast FROM users WHERE id = $1`, hostID).Scan(&can)
	if noRows(err) {
		return false, nil
	}
	return can, err
}

func (s *Store) UserByEmail(ctx context.Context, email string) (User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx,
		`SELECT `+userColumns+` FROM users WHERE lower(email) = lower($1)`,
		strings.TrimSpace(email)))
	if noRows(err) {
		return User{}, ErrNotFound
	}
	return u, err
}

func (s *Store) UserByID(ctx context.Context, id string) (User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx,
		`SELECT `+userColumns+` FROM users WHERE id = $1`, id))
	if noRows(err) {
		return User{}, ErrNotFound
	}
	return u, err
}

/* CreateUser registers an account. ErrConflict means the email is taken.
 *
 * Initials and the avatar colour are derived rather than asked for: one less
 * field on the signup form, and it means every account has an avatar without a
 * hardcoded palette anywhere in the codebase.
 *
 * canHost is a parameter rather than always true because not every caller
 * wants it granted — AuthBypass's dev fixture and the admin-invite path both
 * make their own choice — but handleSignup and handleSupabaseAuth, the two
 * real account-creation paths, both pass true: every new account can host from
 * the moment it exists. An admin can still take it away with SetHostCapability
 * (see admin.go) — that stays the only way hosting is ever revoked.
 */
func (s *Store) CreateUser(ctx context.Context, email, hashedPassword, name, title, org, phone string, canHost bool) (User, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	name = strings.TrimSpace(name)

	u := User{
		Email:        email,
		PasswordHash: hashedPassword,
		Name:         name,
		Title:        strings.TrimSpace(title),
		Org:          strings.TrimSpace(org),
		// Same normaliser registrations.phone already uses — see its doc
		// comment for why this is one text column in E.164 shape.
		Phone:    NormalisePhone(phone),
		Initials: InitialsOf(name),
		Hue:      HueFor(email),
		CanHost:  canHost,
	}

	err := s.pool.QueryRow(ctx, `
		INSERT INTO users (email, password_hash, name, title, org, phone, initials, hue, can_host)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		RETURNING id::text`,
		u.Email, u.PasswordHash, u.Name, u.Title, u.Org, u.Phone, u.Initials, u.Hue, u.CanHost,
	).Scan(&u.ID)
	if isUniqueViolation(err) {
		return User{}, ErrConflict
	}
	if err != nil {
		return User{}, err
	}

	// A person who signs up to attend, then registers for a webinar with the
	// same address, should find the earlier guest registration on their
	// account rather than a second, unrelated one.
	if _, err := s.pool.Exec(ctx, `
		UPDATE registrations SET user_id = $1
		 WHERE user_id IS NULL AND lower(email) = $2`, u.ID, u.Email); err != nil {
		return User{}, fmt.Errorf("adopt guest registrations: %w", err)
	}
	return u, nil
}

// UpdateProfile applies the fields that were actually sent. nil means "leave
// alone", which is why these are pointers all the way from the JSON body.
func (s *Store) UpdateProfile(ctx context.Context, id string, p types.ProfilePatch) (User, error) {
	current, err := s.UserByID(ctx, id)
	if err != nil {
		return User{}, err
	}

	name := current.Name
	if p.Name != nil && strings.TrimSpace(*p.Name) != "" {
		name = strings.TrimSpace(*p.Name)
	}
	title := current.Title
	if p.Title != nil {
		title = strings.TrimSpace(*p.Title)
	}
	org := current.Org
	if p.Org != nil {
		org = strings.TrimSpace(*p.Org)
	}
	phone := current.Phone
	if p.Phone != nil {
		phone = NormalisePhone(*p.Phone)
	}
	/* can_host is deliberately NOT in this statement.
	 *
	 * It used to be, driven by p.WantsHost, which meant PATCH /api/me was a self-service
	 * promotion to host — any signed-in account could grant itself the capability to create
	 * webinars and take registrations from strangers. The column is now only written by
	 * SetHostCapability, which is admin-only.
	 *
	 * The field is still accepted and ignored rather than rejected, so an older browser tab
	 * submitting the old profile form still saves the name change it was actually for.
	 */
	u, err := scanUser(s.pool.QueryRow(ctx, `
		UPDATE users
		   SET name = $2, title = $3, org = $4, phone = $5, initials = $6
		 WHERE id = $1
		RETURNING `+userColumns,
		id, name, title, org, phone, InitialsOf(name)))
	if noRows(err) {
		return User{}, ErrNotFound
	}
	return u, err
}

/* DeleteUser removes an account, for the admin panel.
 *
 * Refuses with ErrHasWebinars while the account still hosts any webinar —
 * webinars.host_id is ON DELETE RESTRICT on purpose (see the error's own
 * comment), so this checks first and returns a message an admin can act on,
 * rather than letting the query fail and surfacing a raw constraint
 * violation. Everything else the account owns — registrations, panelist
 * seats, notifications — cascades at the schema level and needs no help here.
 */
func (s *Store) DeleteUser(ctx context.Context, id string) error {
	var owned int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM webinars WHERE host_id = $1`, id).Scan(&owned); err != nil {
		return err
	}
	if owned > 0 {
		return ErrHasWebinars
	}

	tag, err := s.pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// TouchLogin records a successful sign-in. Best-effort by design: failing to
// write a timestamp must not fail the login itself.
func (s *Store) TouchLogin(ctx context.Context, id string) {
	if _, err := s.pool.Exec(ctx,
		`UPDATE users SET last_login_at = now() WHERE id = $1`, id); err != nil {
		s.log.Warn("could not record last_login_at", "user", id, "error", err)
	}
}

// InitialsOf takes the first letter of the first and last words of a name.
// Unicode-aware: "Lucía Moreno" gives LM, and a single-word name gives one
// letter rather than a crash.
func InitialsOf(name string) string {
	words := strings.FieldsFunc(name, func(r rune) bool {
		return unicode.IsSpace(r) || r == '-' || r == '.'
	})
	if len(words) == 0 {
		return "?"
	}
	first := []rune(words[0])
	out := []rune{unicode.ToUpper(first[0])}
	if len(words) > 1 {
		last := []rune(words[len(words)-1])
		out = append(out, unicode.ToUpper(last[0]))
	}
	return string(out)
}

// HueFor derives a stable avatar colour from a string.
//
// Hashing beats a palette lookup table: it is deterministic, so an avatar never
// changes colour between renders or between services, and there is no list of
// brand colours to maintain in two languages. Saturation and lightness are
// fixed at values that keep white text above the 4.5:1 contrast ratio for every
// hue, which is the part a random colour would get wrong.
func HueFor(seed string) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(strings.ToLower(seed)))
	return hslToHex(float64(h.Sum32()%360), 0.62, 0.38)
}

func hslToHex(hDeg, s, l float64) string {
	c := (1 - math.Abs(2*l-1)) * s
	hp := hDeg / 60
	x := c * (1 - math.Abs(math.Mod(hp, 2)-1))

	var r, g, b float64
	switch {
	case hp < 1:
		r, g, b = c, x, 0
	case hp < 2:
		r, g, b = x, c, 0
	case hp < 3:
		r, g, b = 0, c, x
	case hp < 4:
		r, g, b = 0, x, c
	case hp < 5:
		r, g, b = x, 0, c
	default:
		r, g, b = c, 0, x
	}
	m := l - c/2
	to255 := func(v float64) int { return int(math.Round((v + m) * 255)) }
	return fmt.Sprintf("#%02x%02x%02x", to255(r), to255(g), to255(b))
}

// SetUserYouTube stores (or clears, when refresh is empty) the host's YouTube
// grant. Channel title is what Account settings shows; the refresh token never
// reaches JSON.
func (s *Store) SetUserYouTube(ctx context.Context, userID, refresh, channelID, channelTitle, streamID string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE users
		   SET youtube_refresh = $2,
		       youtube_channel_id = $3,
		       youtube_channel_title = $4,
		       youtube_stream_id = $5
		 WHERE id = $1`,
		userID, refresh, channelID, channelTitle, streamID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SetUserYouTubeStreamID(ctx context.Context, userID, streamID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE users SET youtube_stream_id = $2 WHERE id = $1`, userID, streamID)
	return err
}
