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
	// Phone is E.164 shape (see normalisePhone) — the number the person typed
	// (signup, profile, host request, registration form). Deliberately NOT on
	// Person: that's what other attendees and panelists see about someone, and
	// Org is fine to show there in a way a phone number is not.
	Phone string
	// GooglePhone is the People API number from Continue with Google. Empty
	// when they did not grant the scope or Google returned none. Never copied
	// onto Phone, and Phone is never copied onto this. See migrations/0091.
	GooglePhone string
	Initials    string
	Hue         string
	CanHost     bool
	// IsAdmin may grant CanHost to other accounts. Never settable in-band: see
	// PromoteAdmins and migrations/0011.
	IsAdmin bool
	// MaxDurationMin is an optional custom maximum meeting duration in minutes.
	// NULL means use the system default.
	MaxDurationMin *int
	// Plan is the subscription's tier, empty with none (the launch default).
	Plan types.Plan
	// AccountKind is customer (signed up for the app) or audience (made by a
	// webinar registration). See types.AccountKind.
	AccountKind types.AccountKind
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
	// WhatsAppCoexistence: the number is on the WhatsApp Business app as well.
	WhatsAppCoexistence bool
	// WhatsAppTokenRejectedAt is when Meta last refused the stored token. Set means
	// the host has to reconnect; cleared by connecting again. See migrations/0054.
	WhatsAppTokenRejectedAt *time.Time

	// GooglePicture is the https profile photo URL from Google sign-in.
	// Empty for a password account, and for a Google account whose token
	// carried no usable picture. See migrations/0071.
	GooglePicture string
	// AvatarKey is the opaque cache-buster for an uploaded profile photo, and
	// the sentinel that one exists. Empty means no upload. The bytes are
	// AvatarData, loaded only when serving the image — not on every user read.
	AvatarKey  string
	AvatarMime string

	// EmailVerifiedAt is when the address was confirmed. Nil means the account
	// cannot sign in. See migrations/0074.
	EmailVerifiedAt *time.Time
	// HostRequestedAt is when this account asked to host. Nil means they have
	// not asked. It does not grant CanHost. See migrations/0080.
	HostRequestedAt *time.Time
	// PasswordChangedAt is when a reset link last set the password. Sessions issued
	// before it are refused. Nil means never reset. See migrations/0088.
	PasswordChangedAt *time.Time
}

// EmailVerified reports whether this account may sign in.
func (u User) EmailVerified() bool { return u.EmailVerifiedAt != nil }

/* SessionStale reports whether a session issued at `issued` predates the last password
 * reset, and so must be refused.
 *
 * Compared in whole seconds, because that is all a session token records. The session a
 * reset signs in is issued a moment after the change, often in the same second, and it
 * must stand. The price is that one issued a moment before the change, in that same
 * second, stands too.
 */
func (u User) SessionStale(issued time.Time) bool {
	return u.PasswordChangedAt != nil && issued.Before(u.PasswordChangedAt.Truncate(time.Second))
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
		ID:             u.ID,
		Email:          u.Email,
		EmailVerified:  u.EmailVerified(),
		Name:           u.Name,
		Title:          u.Title,
		Org:            u.Org,
		Phone:          u.Phone,
		GooglePhone:    u.GooglePhone,
		Initials:       u.Initials,
		Hue:            u.Hue,
		AvatarURL:      u.AvatarURL(),
		CanHost:        u.CanHost,
		IsAdmin:        u.IsAdmin,
		MaxDurationMin: u.MaxDurationMin,
		Plan:           u.Plan,
		AttendeeCap:    types.PlanAttendeeCap(u.Plan),
		// Never nil on the wire: a browser that has to guard a list guards it
		// differently on every screen.
		Features: append([]string{}, u.Features...),
	}
	if u.HostRequestedAt != nil {
		a.HostRequestedAt = u.HostRequestedAt.UTC().Format(time.RFC3339)
	}
	a.HasPassword = u.PasswordHash != ""
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
		a.WhatsApp.Coexistence = u.WhatsAppCoexistence
		a.WhatsApp.NeedsReconnect = u.WhatsAppTokenRejectedAt != nil
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
	coalesce(google_phone,''),
	initials, hue, can_host, is_admin, max_duration_min,
	effective_features(effective_plan(users.id), features, features_off),
	coalesce(youtube_refresh,''), coalesce(youtube_channel_id,''),
	coalesce(youtube_channel_title,''), coalesce(youtube_stream_id,''),
	coalesce(whatsapp_access_token,''), coalesce(whatsapp_waba_id,''),
	coalesce(whatsapp_phone_number_id,''), coalesce(whatsapp_display_phone,''),
	coalesce(whatsapp_verified_name,''),
	whatsapp_token_expires_at, whatsapp_connected_at, whatsapp_registered_at,
	whatsapp_coexistence, whatsapp_token_rejected_at,
	coalesce(google_picture,''), coalesce(avatar_key,''), coalesce(avatar_mime,''),
	email_verified_at, host_requested_at, password_changed_at,
	effective_plan(users.id), account_kind`

func scanUser(row scanner) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Email, &u.PasswordHash, &u.Name, &u.Title, &u.Org, &u.Phone,
		&u.GooglePhone,
		&u.Initials, &u.Hue, &u.CanHost, &u.IsAdmin, &u.MaxDurationMin,
		&u.Features,
		&u.YouTubeRefresh, &u.YouTubeChannelID, &u.YouTubeChannelTitle, &u.YouTubeStreamID,
		&u.WhatsAppToken, &u.WhatsAppWABAID, &u.WhatsAppPhoneNumberID, &u.WhatsAppDisplayPhone,
		&u.WhatsAppVerifiedName, &u.WhatsAppTokenExpiresAt, &u.WhatsAppConnectedAt,
		&u.WhatsAppRegisteredAt, &u.WhatsAppCoexistence, &u.WhatsAppTokenRejectedAt,
		&u.GooglePicture, &u.AvatarKey, &u.AvatarMime, &u.EmailVerifiedAt,
		&u.HostRequestedAt, &u.PasswordChangedAt, &u.Plan, &u.AccountKind)
	return u, err
}

/* AvatarURL is the photo the client should render.
 *
 * Uploaded bytes win, then the Google profile photo, then nothing — the
 * client draws initials when this is empty. The upload URL points at this
 * API; the Google value is the https address stored at sign-in.
 */
func (u User) AvatarURL() string {
	if u.AvatarKey != "" {
		return "/api/auth/avatar?v=" + u.AvatarKey
	}
	return u.GooglePicture
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
 * real account-creation paths, both pass false: a new account attends, and
 * hosts only once an admin grants it with SetHostCapability (see admin.go).
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

/* SetPhoneIfEmpty stores a typed number only when the account does not have one.
 *
 * Used when a registration form (or similar) supplies a number the person
 * typed. A number already on phone — typed earlier, or left over from before
 * google_phone existed — is left alone. Google numbers go to SetGooglePhone.
 * An empty argument is a no-op. The number is not logged.
 */
func (s *Store) SetPhoneIfEmpty(ctx context.Context, id, phone string) (User, error) {
	phone = NormalisePhone(phone)
	if phone == "" {
		return s.UserByID(ctx, id)
	}
	u, err := scanUser(s.pool.QueryRow(ctx, `
		UPDATE users
		   SET phone = $2
		 WHERE id = $1
		   AND phone = ''
		RETURNING `+userColumns, id, phone))
	if noRows(err) {
		return s.UserByID(ctx, id)
	}
	return u, err
}

/* SetGooglePhone stores the People API number on google_phone.
 *
 * It never writes users.phone. A later Google login with a different People
 * number updates this column only. Empty is a no-op so a declined scope does
 * not wipe a number already saved.
 */
func (s *Store) SetGooglePhone(ctx context.Context, id, phone string) (User, error) {
	phone = NormalisePhone(phone)
	if phone == "" {
		return s.UserByID(ctx, id)
	}
	u, err := scanUser(s.pool.QueryRow(ctx, `
		UPDATE users
		   SET google_phone = $2
		 WHERE id = $1
		RETURNING `+userColumns, id, phone))
	if noRows(err) {
		return User{}, ErrNotFound
	}
	return u, err
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

/* RecordHostRequest stores one open request to host and, when the account
 * has no phone yet, the number that goes in the notification.
 *
 * The UPDATE is the lock: it only matches an account that cannot host and
 * has not already asked. A second call finds no row and returns
 * ErrHostRequested, so the caller does not send another email. An existing
 * phone is left as stored — the argument is used only to fill an empty one.
 * CanHost is never written here.
 */
func (s *Store) RecordHostRequest(ctx context.Context, id, phone string) (User, error) {
	current, err := s.UserByID(ctx, id)
	if err != nil {
		return User{}, err
	}
	if current.CanHost {
		return current, ErrAlreadyHost
	}
	if current.HostRequestedAt != nil {
		return current, ErrHostRequested
	}

	nextPhone := current.Phone
	if nextPhone == "" {
		nextPhone = NormalisePhone(phone)
		if nextPhone == "" {
			return current, ErrPhoneRequired
		}
	}

	u, err := scanUser(s.pool.QueryRow(ctx, `
		UPDATE users
		   SET phone = CASE WHEN phone = '' THEN $2 ELSE phone END,
		       host_requested_at = now()
		 WHERE id = $1
		   AND can_host = false
		   AND host_requested_at IS NULL
		RETURNING `+userColumns,
		id, nextPhone))
	if noRows(err) {
		again, err2 := s.UserByID(ctx, id)
		if err2 != nil {
			return User{}, err2
		}
		if again.CanHost {
			return again, ErrAlreadyHost
		}
		if again.HostRequestedAt != nil {
			return again, ErrHostRequested
		}
		return again, ErrNotFound
	}
	return u, err
}

// ClearHostRequest drops the open request so a failed send can be tried again.
// The phone, if one was just saved, stays.
func (s *Store) ClearHostRequest(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `UPDATE users SET host_requested_at = NULL WHERE id = $1`, id)
	return err
}

/* DeleteUser removes an account and returns its avatar's storage key, so the
 * caller can delete that file once the row is gone.
 *
 * Refuses with ErrHasWebinars while the account still hosts any webinar —
 * webinars.host_id is ON DELETE RESTRICT on purpose (see the error's own
 * comment), so this checks first and returns a message an admin can act on,
 * rather than letting the query fail and surfacing a raw constraint
 * violation. webinar_series.host_id is RESTRICT too; a series with no
 * webinars left is only a recurrence rule, so it goes with the account.
 * Everything else the account owns cascades at the schema level. Billing
 * orders are the exception that is kept: their user_id goes NULL (0104), since
 * invoices outlive the account for tax law.
 */
func (s *Store) DeleteUser(ctx context.Context, id string) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var owned int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM webinars WHERE host_id = $1`, id).Scan(&owned); err != nil {
		return "", err
	}
	if owned > 0 {
		return "", ErrHasWebinars
	}
	if _, err := tx.Exec(ctx, `DELETE FROM webinar_series WHERE host_id = $1`, id); err != nil {
		return "", err
	}
	var avatarKey string
	err = tx.QueryRow(ctx,
		`DELETE FROM users WHERE id = $1 RETURNING avatar_storage_key`, id).Scan(&avatarKey)
	if noRows(err) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return avatarKey, tx.Commit(ctx)
}

// WebinarSlugsHostedBy lists every webinar an account hosts, for deleting the account.
func (s *Store) WebinarSlugsHostedBy(ctx context.Context, hostID string) (slugs []string, live bool, err error) {
	rows, err := s.pool.Query(ctx,
		`SELECT slug, status = 'live' FROM webinars WHERE host_id = $1 ORDER BY starts_at`, hostID)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	for rows.Next() {
		var slug string
		var isLive bool
		if err := rows.Scan(&slug, &isLive); err != nil {
			return nil, false, err
		}
		slugs = append(slugs, slug)
		live = live || isLive
	}
	return slugs, live, rows.Err()
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

// SetGooglePicture stores the profile photo URL from a Google sign-in.
// An empty picture is not written: a later token that omits it must not
// wipe a URL we already kept.
func (s *Store) SetGooglePicture(ctx context.Context, id, picture string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE users SET google_picture = $2 WHERE id = $1`, id, picture)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

/* SetUserAvatar replaces the uploaded profile photo, returning the storage key
 * of the one it replaced ("" if none) for the caller to delete. As with cover
 * images, storageKey names a file in the object store and data is nil, or there
 * is no store and the bytes go in avatar_data. The Google URL is left alone —
 * removing the upload falls back to it. newImageVersion is the same opaque
 * cache-buster cover images use.
 */
func (s *Store) SetUserAvatar(ctx context.Context, id, mime string, data []byte, storageKey string) (User, string, error) {
	if data == nil {
		data = []byte{}
	}
	old, err := s.avatarStorageKey(ctx, id)
	if err != nil {
		return User{}, "", err
	}
	u, err := scanUser(s.pool.QueryRow(ctx, `
		UPDATE users
		   SET avatar_key = $2, avatar_mime = $3, avatar_data = $4, avatar_storage_key = $5
		 WHERE id = $1
		RETURNING `+userColumns,
		id, newImageVersion(), mime, data, storageKey))
	if noRows(err) {
		return User{}, "", ErrNotFound
	}
	return u, old, err
}

// ClearUserAvatar removes the upload, returning the storage key it pointed at.
// The Google photo, if any, stays.
func (s *Store) ClearUserAvatar(ctx context.Context, id string) (User, string, error) {
	old, err := s.avatarStorageKey(ctx, id)
	if err != nil {
		return User{}, "", err
	}
	u, err := scanUser(s.pool.QueryRow(ctx, `
		UPDATE users
		   SET avatar_key = '', avatar_mime = '', avatar_data = '', avatar_storage_key = ''
		 WHERE id = $1
		RETURNING `+userColumns, id))
	if noRows(err) {
		return User{}, "", ErrNotFound
	}
	return u, old, err
}

func (s *Store) avatarStorageKey(ctx context.Context, id string) (string, error) {
	var key string
	err := s.pool.QueryRow(ctx, `SELECT avatar_storage_key FROM users WHERE id = $1`, id).Scan(&key)
	if noRows(err) {
		return "", ErrNotFound
	}
	return key, err
}

/* UserAvatarMedia returns the upload: its storage key when it is in the object
 * store, otherwise the bytes still in the row. ErrNotFound when the account has
 * no upload — a Google URL is not bytes we hold.
 */
func (s *Store) UserAvatarMedia(ctx context.Context, id string) (data []byte, mime, storageKey string, err error) {
	var key string
	err = s.pool.QueryRow(ctx,
		`SELECT avatar_key, avatar_mime, avatar_data, avatar_storage_key FROM users WHERE id = $1`, id).
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

func (s *Store) SetUserYouTubeStreamID(ctx context.Context, userID, streamID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE users SET youtube_stream_id = $2 WHERE id = $1`, userID, streamID)
	return err
}
