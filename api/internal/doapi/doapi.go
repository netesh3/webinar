/* Package doapi is the few DigitalOcean API calls the on-demand video server needs
 * (api/internal/api/sfu_box.go): find the newest snapshot, find the data volume, create a
 * droplet from them, assign the reserved IP, look a droplet up, delete it.
 *
 * Plain REST with a bearer token (DO_API_TOKEN), no client library. Every call is one
 * request with the caller's context: the box manager runs inside the API's one-minute tick
 * and never waits on DigitalOcean beyond a single call. */
package doapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// DefaultBaseURL is DigitalOcean's API.
const DefaultBaseURL = "https://api.digitalocean.com"

// Client talks to the DigitalOcean API with one token.
type Client struct {
	Token string
	// BaseURL defaults to DefaultBaseURL. Tests point it at a fake (doapitest).
	BaseURL string
	HTTP    *http.Client
}

// New is a client for token against the real API.
func New(token string) *Client {
	return &Client{Token: token, BaseURL: DefaultBaseURL, HTTP: &http.Client{Timeout: 20 * time.Second}}
}

// Error is a non-2xx answer: DigitalOcean's {"id","message"} and the HTTP status.
type Error struct {
	Status  int
	ID      string
	Message string
}

func (e *Error) Error() string {
	return fmt.Sprintf("digitalocean: %d %s: %s", e.Status, e.ID, e.Message)
}

// IsNotFound is a 404: the droplet (or IP, image, volume) does not exist.
func IsNotFound(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == http.StatusNotFound
}

// Droplet is the part of a droplet the box manager reads.
type Droplet struct {
	ID        int64    `json:"id"`
	Name      string   `json:"name"`
	Status    string   `json:"status"` // new, active, off, archive
	CreatedAt string   `json:"created_at"`
	Tags      []string `json:"tags"`
	VolumeIDs []string `json:"volume_ids"`
	Networks  struct {
		V4 []struct {
			IPAddress string `json:"ip_address"`
			Type      string `json:"type"`
		} `json:"v4"`
	} `json:"networks"`
}

// Created is CreatedAt parsed; the zero time when DigitalOcean sent none.
func (d Droplet) Created() time.Time {
	t, _ := time.Parse(time.RFC3339, d.CreatedAt)
	return t
}

// PublicIPv4 is the droplet's own public address (not the reserved IP).
func (d Droplet) PublicIPv4() string {
	for _, n := range d.Networks.V4 {
		if n.Type == "public" {
			return n.IPAddress
		}
	}
	return ""
}

// Image is a snapshot (a private image).
type Image struct {
	ID          int64    `json:"id"`
	Name        string   `json:"name"`
	CreatedAt   string   `json:"created_at"`
	Regions     []string `json:"regions"`
	Tags        []string `json:"tags"`
	Status      string   `json:"status"`
	MinDiskSize int      `json:"min_disk_size"`
}

// Volume is a block storage volume.
type Volume struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	DropletIDs []int64 `json:"droplet_ids"`
	Region     struct {
		Slug string `json:"slug"`
	} `json:"region"`
}

// CreateDroplet is POST /v2/droplets.
type CreateDroplet struct {
	Name       string   `json:"name"`
	Region     string   `json:"region"`
	Size       string   `json:"size"`
	Image      int64    `json:"image"`
	SSHKeys    []string `json:"ssh_keys,omitempty"`
	Monitoring bool     `json:"monitoring"`
	Tags       []string `json:"tags,omitempty"`
	UserData   string   `json:"user_data,omitempty"`
	Volumes    []string `json:"volumes,omitempty"`
	VPCUUID    string   `json:"vpc_uuid,omitempty"`
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	base := strings.TrimRight(c.BaseURL, "/")
	if base == "" {
		base = DefaultBaseURL
	}
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	res, err := hc.Do(req)
	if err != nil {
		return fmt.Errorf("digitalocean %s %s: %w", method, path, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		e := &Error{Status: res.StatusCode}
		var msg struct {
			ID      string `json:"id"`
			Message string `json:"message"`
		}
		if json.Unmarshal(raw, &msg) == nil {
			e.ID, e.Message = msg.ID, msg.Message
		}
		if e.Message == "" {
			e.Message = strings.TrimSpace(string(raw))
		}
		return e
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// DropletsByTag lists the droplets carrying tag.
func (c *Client) DropletsByTag(ctx context.Context, tag string) ([]Droplet, error) {
	var out struct {
		Droplets []Droplet `json:"droplets"`
	}
	err := c.do(ctx, http.MethodGet, "/v2/droplets?per_page=200&tag_name="+url.QueryEscape(tag), nil, &out)
	return out.Droplets, err
}

// DropletsByName lists the droplets named name.
func (c *Client) DropletsByName(ctx context.Context, name string) ([]Droplet, error) {
	var out struct {
		Droplets []Droplet `json:"droplets"`
	}
	err := c.do(ctx, http.MethodGet, "/v2/droplets?per_page=200&name="+url.QueryEscape(name), nil, &out)
	return out.Droplets, err
}

// Droplet is one droplet by id; IsNotFound when it is gone.
func (c *Client) Droplet(ctx context.Context, id int64) (Droplet, error) {
	var out struct {
		Droplet Droplet `json:"droplet"`
	}
	err := c.do(ctx, http.MethodGet, "/v2/droplets/"+strconv.FormatInt(id, 10), nil, &out)
	return out.Droplet, err
}

// CreateDroplet creates one droplet and returns it (status "new").
func (c *Client) CreateDroplet(ctx context.Context, req CreateDroplet) (Droplet, error) {
	var out struct {
		Droplet Droplet `json:"droplet"`
	}
	err := c.do(ctx, http.MethodPost, "/v2/droplets", req, &out)
	if err == nil && out.Droplet.ID == 0 {
		err = errors.New("digitalocean: create droplet answered without an id")
	}
	return out.Droplet, err
}

// DeleteDroplet deletes a droplet. Already gone is success.
func (c *Client) DeleteDroplet(ctx context.Context, id int64) error {
	err := c.do(ctx, http.MethodDelete, "/v2/droplets/"+strconv.FormatInt(id, 10), nil, nil)
	if IsNotFound(err) {
		return nil
	}
	return err
}

// ErrNoSnapshot is no snapshot with the tag (or name prefix) in the region.
var ErrNoSnapshot = errors.New("digitalocean: no snapshot found")

/* LatestSnapshot is the newest available private image tagged tag in region. When none
 * carries the tag, the newest whose name starts with namePrefix (the snapshot workflow names
 * them webinar-sfu-image-<date>-<sha>), so an untagged manual snapshot still works. */
func (c *Client) LatestSnapshot(ctx context.Context, tag, namePrefix, region string) (Image, error) {
	pick := func(imgs []Image, ok func(Image) bool) (Image, bool) {
		var cands []Image
		for _, im := range imgs {
			if im.Status != "" && im.Status != "available" {
				continue
			}
			if region != "" && len(im.Regions) > 0 && !contains(im.Regions, region) {
				continue
			}
			if ok(im) {
				cands = append(cands, im)
			}
		}
		if len(cands) == 0 {
			return Image{}, false
		}
		sort.Slice(cands, func(a, b int) bool { return cands[a].CreatedAt > cands[b].CreatedAt })
		return cands[0], true
	}
	if tag != "" {
		var out struct {
			Images []Image `json:"images"`
		}
		if err := c.do(ctx, http.MethodGet, "/v2/images?private=true&per_page=200&tag_name="+url.QueryEscape(tag), nil, &out); err != nil {
			return Image{}, err
		}
		if im, ok := pick(out.Images, func(im Image) bool { return contains(im.Tags, tag) }); ok {
			return im, nil
		}
	}
	if namePrefix != "" {
		var out struct {
			Images []Image `json:"images"`
		}
		if err := c.do(ctx, http.MethodGet, "/v2/images?private=true&per_page=200", nil, &out); err != nil {
			return Image{}, err
		}
		if im, ok := pick(out.Images, func(im Image) bool { return strings.HasPrefix(im.Name, namePrefix) }); ok {
			return im, nil
		}
	}
	return Image{}, ErrNoSnapshot
}

// ErrNoVolume is no volume of that name in the region.
var ErrNoVolume = errors.New("digitalocean: volume not found")

// VolumeByName is the volume named name in region.
func (c *Client) VolumeByName(ctx context.Context, name, region string) (Volume, error) {
	var out struct {
		Volumes []Volume `json:"volumes"`
	}
	q := "/v2/volumes?name=" + url.QueryEscape(name)
	if region != "" {
		q += "&region=" + url.QueryEscape(region)
	}
	if err := c.do(ctx, http.MethodGet, q, nil, &out); err != nil {
		return Volume{}, err
	}
	for _, v := range out.Volumes {
		if v.Name == name && (region == "" || v.Region.Slug == "" || v.Region.Slug == region) {
			return v, nil
		}
	}
	return Volume{}, ErrNoVolume
}

// ReservedIPDroplet is the droplet a reserved IP is assigned to, 0 for none.
func (c *Client) ReservedIPDroplet(ctx context.Context, ip string) (int64, error) {
	var out struct {
		ReservedIP struct {
			Droplet *struct {
				ID int64 `json:"id"`
			} `json:"droplet"`
		} `json:"reserved_ip"`
	}
	if err := c.do(ctx, http.MethodGet, "/v2/reserved_ips/"+url.PathEscape(ip), nil, &out); err != nil {
		return 0, err
	}
	if out.ReservedIP.Droplet == nil {
		return 0, nil
	}
	return out.ReservedIP.Droplet.ID, nil
}

// AssignReservedIP points ip at a droplet (moving it off whichever had it).
func (c *Client) AssignReservedIP(ctx context.Context, ip string, dropletID int64) error {
	body := map[string]any{"type": "assign", "droplet_id": dropletID}
	return c.do(ctx, http.MethodPost, "/v2/reserved_ips/"+url.PathEscape(ip)+"/actions", body, nil)
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
