package zoom

import (
	"context"
	"errors"
	"net/http"
	"strings"
)

/* Object is the Zoom meeting or webinar already stored for one of our webinars. */
type Object struct {
	Venue    string
	ID       string
	StartURL string
}

/* Saved is what to persist after a schedule save. Notice is set when Zoom's
 * plan refused the choice and the webinar stays on this app. */
type Saved struct {
	Venue    string
	ZoomID   string
	StartURL string
	Notice   string
}

/* Connection is one host's Zoom grant. Refresh is ciphertext. */
type Connection struct {
	UserID     string
	ZoomUserID string
	AccountID  string
	Email      string
	Refresh    []byte
	Invalid    bool
}

/* Repo is the host's row and the registrant rows. Implementations must not log
 * Refresh, StartURL, or a join URL. */
type Repo interface {
	Connection(ctx context.Context, userID string) (Connection, error)
	SaveConnection(ctx context.Context, c Connection) error
	SaveRefresh(ctx context.Context, userID string, cipher []byte) error
	MarkInvalid(ctx context.Context, userID string) error
	DeleteConnection(ctx context.Context, userID string) error
	DeleteByZoomUser(ctx context.Context, zoomUserID string) error
	SaveRegistrant(ctx context.Context, regID, registrantID, joinURL, note string) error
	RegistrantJoin(ctx context.Context, regID string) (string, error)
	PushedCount(ctx context.Context, slug string) (int, error)
}

type Flow struct {
	Client *Client
	Repo   Repo
	Seal   func(plain string) ([]byte, error)
	Open   func(blob []byte) (string, error)
}

/* ConnectedEmail is the address on this host's card, or empty when they have
 * not connected. It never reads another host's row. */
func (f *Flow) ConnectedEmail(ctx context.Context, userID string) (string, bool, error) {
	c, err := f.Repo.Connection(ctx, userID)
	if errors.Is(err, ErrNotConnected) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return c.Email, true, nil
}

func (f *Flow) Disconnect(ctx context.Context, userID string) error {
	c, err := f.Repo.Connection(ctx, userID)
	if errors.Is(err, ErrNotConnected) {
		return nil
	}
	if err != nil {
		return err
	}
	if f.Open != nil && f.Client != nil && len(c.Refresh) > 0 {
		if refresh, err := f.Open(c.Refresh); err == nil {
			_ = f.Client.Revoke(ctx, refresh)
		}
	}
	return f.Repo.DeleteConnection(ctx, userID)
}

func (f *Flow) Deauthorize(ctx context.Context, zoomUserID string) error {
	if strings.TrimSpace(zoomUserID) == "" {
		return nil
	}
	return f.Repo.DeleteByZoomUser(ctx, zoomUserID)
}

/* Save creates, updates, or removes the Zoom object for a schedule save.
 *
 * A host with no connection cannot pick Zoom. A plan error leaves the webinar
 * on this app. Switching back deletes the Zoom object only when nobody has
 * been pushed; otherwise the object stays and new messages stop using it
 * because the venue is app.
 */
func (f *Flow) Save(ctx context.Context, hostID string, spec Spec, prev Object, pushed int) (Saved, error) {
	if !IsVenue(spec.Venue) {
		return f.leave(ctx, hostID, prev, pushed)
	}
	access, err := f.access(ctx, hostID)
	if err != nil {
		return Saved{}, err
	}
	if prev.ID != "" && prev.Venue == spec.Venue {
		if err := f.Client.Update(ctx, access, spec.Venue, prev.ID, spec); err != nil {
			if IsPlan(spec.Venue, err) {
				return Saved{Venue: VenueApp, Notice: PlanNotice(spec.Venue)}, nil
			}
			return Saved{}, err
		}
		start, err := f.Client.StartURL(ctx, access, spec.Venue, prev.ID)
		if err != nil {
			start = prev.StartURL
		}
		return Saved{Venue: spec.Venue, ZoomID: prev.ID, StartURL: start}, nil
	}
	if prev.ID != "" && prev.Venue != spec.Venue && IsVenue(prev.Venue) {
		if pushed > 0 {
			return Saved{}, ErrSwitch
		}
		if err := f.Client.Delete(ctx, access, prev.Venue, prev.ID); err != nil {
			return Saved{}, err
		}
	}
	created, err := f.Client.Create(ctx, access, spec.Venue, spec)
	if err != nil {
		if IsPlan(spec.Venue, err) {
			return Saved{Venue: VenueApp, Notice: PlanNotice(spec.Venue)}, nil
		}
		return Saved{}, err
	}
	return Saved{Venue: spec.Venue, ZoomID: created.ID, StartURL: created.StartURL}, nil
}

func (f *Flow) leave(ctx context.Context, hostID string, prev Object, pushed int) (Saved, error) {
	if prev.ID == "" || !IsVenue(prev.Venue) {
		return Saved{Venue: VenueApp}, nil
	}
	if pushed > 0 {
		return Saved{Venue: VenueApp, ZoomID: prev.ID, StartURL: prev.StartURL}, nil
	}
	access, err := f.access(ctx, hostID)
	if err != nil && !errors.Is(err, ErrNotConnected) {
		return Saved{}, err
	}
	if err == nil {
		if err := f.Client.Delete(ctx, access, prev.Venue, prev.ID); err != nil {
			return Saved{}, err
		}
	}
	return Saved{Venue: VenueApp}, nil
}

/* Push adds one registrant and stores their personal join URL.
 * A person with no email is not sent to Zoom.
 */
func (f *Flow) Push(ctx context.Context, hostID, venue, zoomID, regID, email, first, last string) error {
	if !IsVenue(venue) || zoomID == "" || regID == "" {
		return nil
	}
	if existing, err := f.Repo.RegistrantJoin(ctx, regID); err == nil && existing != "" {
		return nil
	}
	email = strings.TrimSpace(email)
	if email == "" {
		return f.Repo.SaveRegistrant(ctx, regID, "", "", "Zoom needs an email, so this person was not added in Zoom.")
	}
	access, err := f.access(ctx, hostID)
	if err != nil {
		note := "Zoom isn't connected, so this person has no Zoom link."
		if !errors.Is(err, ErrNotConnected) {
			note = "Zoom didn't accept this person. They have no Zoom link yet."
		}
		_ = f.Repo.SaveRegistrant(ctx, regID, "", "", note)
		return err
	}
	got, err := f.Client.AddRegistrant(ctx, access, venue, zoomID, Person{
		Email: email, FirstName: first, LastName: last,
	})
	if err != nil {
		note := "Zoom didn't accept this person. They have no Zoom link yet."
		var api *APIError
		if errors.As(err, &api) && api.Status == http.StatusTooManyRequests {
			note = "Zoom is limiting requests. This person has no Zoom link yet."
		}
		_ = f.Repo.SaveRegistrant(ctx, regID, "", "", note)
		return err
	}
	return f.Repo.SaveRegistrant(ctx, regID, got.ID, got.JoinURL, "")
}

/* GoLive fetches a fresh host start link. The stored one expires. */
func (f *Flow) GoLive(ctx context.Context, hostID, venue, zoomID string) (string, error) {
	if !IsVenue(venue) {
		return "", errors.New("not a zoom webinar")
	}
	if zoomID == "" {
		return "", errors.New("this webinar has no Zoom meeting yet")
	}
	access, err := f.access(ctx, hostID)
	if err != nil {
		return "", err
	}
	return f.Client.StartURL(ctx, access, venue, zoomID)
}

/* AttendeeJoin is this registration's personal join URL and nobody else's. */
func (f *Flow) AttendeeJoin(ctx context.Context, regID string) (string, error) {
	u, err := f.Repo.RegistrantJoin(ctx, regID)
	if err != nil {
		return "", err
	}
	if u == "" {
		return "", ErrNoJoinURL
	}
	return u, nil
}

func (f *Flow) access(ctx context.Context, hostID string) (string, error) {
	c, err := f.Repo.Connection(ctx, hostID)
	if err != nil {
		return "", err
	}
	if c.Invalid || len(c.Refresh) == 0 {
		return "", ErrNotConnected
	}
	refresh, err := f.Open(c.Refresh)
	if err != nil {
		_ = f.Repo.MarkInvalid(ctx, hostID)
		return "", ErrNotConnected
	}
	tok, err := f.Client.Refresh(ctx, refresh)
	if err != nil {
		var api *APIError
		if errors.As(err, &api) && (api.Status == 400 || api.Status == 401) {
			_ = f.Repo.MarkInvalid(ctx, hostID)
			return "", ErrNotConnected
		}
		return "", err
	}
	if tok.RefreshToken != "" && tok.RefreshToken != refresh && f.Seal != nil {
		if blob, err := f.Seal(tok.RefreshToken); err == nil {
			_ = f.Repo.SaveRefresh(ctx, hostID, blob)
		}
	}
	return tok.AccessToken, nil
}

/* StoreGrant seals the refresh token from an OAuth callback and replaces any
 * previous connection for this host. */
func (f *Flow) StoreGrant(ctx context.Context, userID string, account Account, tok Token) error {
	if tok.RefreshToken == "" {
		return errors.New("zoom did not return a refresh token")
	}
	blob, err := f.Seal(tok.RefreshToken)
	if err != nil {
		return err
	}
	return f.Repo.SaveConnection(ctx, Connection{
		UserID:     userID,
		ZoomUserID: account.ID,
		AccountID:  account.AccountID,
		Email:      account.Email,
		Refresh:    blob,
	})
}
