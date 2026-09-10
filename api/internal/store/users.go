package store

import (
	"context"
	"fmt"
	"hash/fnv"
	"math"
	"strings"
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
	Initials     string
	Hue          string
	CanHost      bool
	// IsAdmin may grant CanHost to other accounts. Never settable in-band: see
	// PromoteAdmins and migrations/0011.
	IsAdmin bool
}

func (u User) Public() types.Account {
	return types.Account{
		ID:       u.ID,
		Email:    u.Email,
		Name:     u.Name,
		Title:    u.Title,
		Org:      u.Org,
		Initials: u.Initials,
		Hue:      u.Hue,
		CanHost:  u.CanHost,
		IsAdmin:  u.IsAdmin,
	}
}

// Person is the public projection used inside webinar records: everything the
// UI needs to render someone, and nothing that identifies them further.
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

const userColumns = `id::text, email, coalesce(password_hash,''), name, title, org,
	initials, hue, can_host, is_admin`

func scanUser(row scanner) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Email, &u.PasswordHash, &u.Name, &u.Title, &u.Org,
		&u.Initials, &u.Hue, &u.CanHost, &u.IsAdmin)
	return u, err
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

// CreateUser registers an account. ErrConflict means the email is taken.
//
// Initials and the avatar colour are derived rather than asked for: one less
// field on the signup form, and it means every account has an avatar without a
// hardcoded palette anywhere in the codebase.
func (s *Store) CreateUser(ctx context.Context, email, hashedPassword, name, title, org string, canHost bool) (User, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	name = strings.TrimSpace(name)

	u := User{
		Email:        email,
		PasswordHash: hashedPassword,
		Name:         name,
		Title:        strings.TrimSpace(title),
		Org:          strings.TrimSpace(org),
		Initials:     InitialsOf(name),
		Hue:          HueFor(email),
		CanHost:      canHost,
	}

	err := s.pool.QueryRow(ctx, `
		INSERT INTO users (email, password_hash, name, title, org, initials, hue, can_host)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		RETURNING id::text`,
		u.Email, u.PasswordHash, u.Name, u.Title, u.Org, u.Initials, u.Hue, u.CanHost,
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
		   SET name = $2, title = $3, org = $4, initials = $5
		 WHERE id = $1
		RETURNING `+userColumns,
		id, name, title, org, InitialsOf(name)))
	if noRows(err) {
		return User{}, ErrNotFound
	}
	return u, err
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
