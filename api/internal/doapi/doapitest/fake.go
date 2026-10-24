/* Package doapitest is an in-memory DigitalOcean API for tests: the endpoints doapi calls,
 * with droplets, snapshots, volumes and reserved IPs that behave closely enough (a volume
 * attaches to one droplet at a time, a new droplet is "new" until Activate, a delete frees the
 * volume) that the on-demand box manager can be driven through create, ready and destroy. */
package doapitest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/netkumar/webcast/api/internal/doapi"
)

// Fake is the server and its state. Lock Mu to read or change state from a test.
type Fake struct {
	Mu  sync.Mutex
	Srv *httptest.Server

	Droplets    map[int64]*doapi.Droplet
	Images      []doapi.Image
	Volumes     []*doapi.Volume
	ReservedIPs map[string]int64 // ip -> droplet id (0 unassigned)

	// Creates and Deletes count the calls that changed something.
	Creates int
	Deletes int
	// LastCreate is the body of the last create; Created is every create's, in order.
	LastCreate doapi.CreateDroplet
	Created    []doapi.CreateDroplet
	// FailCreates makes the next n creates answer 500.
	FailCreates int
	// AutoActivate makes a created droplet active on its first GET.
	AutoActivate bool
	/* StaleIPReads makes the next n reads of a reserved IP answer StaleIPDroplet, as
	 * DigitalOcean's read does for a moment after an assign. */
	StaleIPReads   int
	StaleIPDroplet int64
	// Assigns counts the assign actions that moved an IP.
	Assigns int

	nextID int64
}

// New starts a fake with one snapshot, the volume and the reserved IP the box uses.
func New(snapshotTag, volume, region, ip string) *Fake {
	f := &Fake{
		Droplets:    map[int64]*doapi.Droplet{},
		ReservedIPs: map[string]int64{ip: 0},
		nextID:      1000,
	}
	f.Images = []doapi.Image{
		{ID: 1, Name: "webinar-sfu-image-old", CreatedAt: "2026-10-01T00:00:00Z", Regions: []string{region}, Tags: []string{snapshotTag}, Status: "available"},
		{ID: 2, Name: "webinar-sfu-image-new", CreatedAt: "2026-10-20T00:00:00Z", Regions: []string{region}, Tags: []string{snapshotTag}, Status: "available"},
	}
	v := &doapi.Volume{ID: "vol-1", Name: volume}
	v.Region.Slug = region
	f.Volumes = []*doapi.Volume{v}
	f.Srv = httptest.NewServer(http.HandlerFunc(f.serve))
	return f
}

// Close stops the server.
func (f *Fake) Close() { f.Srv.Close() }

// Client is a doapi client for this fake.
func (f *Fake) Client() *doapi.Client {
	return &doapi.Client{Token: "test", BaseURL: f.Srv.URL, HTTP: f.Srv.Client()}
}

// Activate marks a droplet active.
func (f *Fake) Activate(id int64) {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	if d := f.Droplets[id]; d != nil {
		d.Status = "active"
	}
}

// Count is how many droplets exist.
func (f *Fake) Count() int {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	return len(f.Droplets)
}

// Only is the one droplet, or nil when there are none (or several).
func (f *Fake) Only() *doapi.Droplet {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	if len(f.Droplets) != 1 {
		return nil
	}
	for _, d := range f.Droplets {
		c := *d
		return &c
	}
	return nil
}

// Tagged is the ids of the droplets carrying tag.
func (f *Fake) Tagged(tag string) []int64 {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	var out []int64
	for id, d := range f.Droplets {
		if has(d.Tags, tag) {
			out = append(out, id)
		}
	}
	return out
}

// AddImage adds a snapshot (another image's, say the captions box's).
func (f *Fake) AddImage(im doapi.Image) {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	f.Images = append(f.Images, im)
}

// AssignedTo is the droplet a reserved IP points at.
func (f *Fake) AssignedTo(ip string) int64 {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	return f.ReservedIPs[ip]
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func notFound(w http.ResponseWriter) {
	writeJSON(w, http.StatusNotFound, map[string]string{"id": "not_found", "message": "The resource you were accessing could not be found."})
}

func (f *Fake) serve(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer test" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"id": "unauthorized", "message": "Unable to authenticate you"})
		return
	}
	f.Mu.Lock()
	defer f.Mu.Unlock()
	p := r.URL.Path
	q := r.URL.Query()
	switch {
	case r.Method == http.MethodGet && p == "/v2/droplets":
		out := []doapi.Droplet{}
		for _, d := range f.Droplets {
			if t := q.Get("tag_name"); t != "" && !has(d.Tags, t) {
				continue
			}
			if n := q.Get("name"); n != "" && d.Name != n {
				continue
			}
			out = append(out, *d)
		}
		writeJSON(w, http.StatusOK, map[string]any{"droplets": out})
	case r.Method == http.MethodPost && p == "/v2/droplets":
		var req doapi.CreateDroplet
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"id": "bad_request", "message": err.Error()})
			return
		}
		if f.FailCreates > 0 {
			f.FailCreates--
			writeJSON(w, http.StatusInternalServerError, map[string]string{"id": "server_error", "message": "Server was unable to give you a response."})
			return
		}
		for _, vid := range req.Volumes {
			for _, v := range f.Volumes {
				if v.ID == vid && len(v.DropletIDs) > 0 {
					writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"id": "unprocessable_entity", "message": "volume is already attached"})
					return
				}
			}
		}
		f.nextID++
		d := &doapi.Droplet{ID: f.nextID, Name: req.Name, Status: "new", Tags: req.Tags,
			CreatedAt: time.Now().UTC().Format(time.RFC3339), VolumeIDs: req.Volumes}
		d.Networks.V4 = append(d.Networks.V4, struct {
			IPAddress string `json:"ip_address"`
			Type      string `json:"type"`
		}{"203.0.113." + strconv.FormatInt(f.nextID%250, 10), "public"})
		for _, vid := range req.Volumes {
			for _, v := range f.Volumes {
				if v.ID == vid {
					v.DropletIDs = []int64{d.ID}
				}
			}
		}
		f.Droplets[d.ID] = d
		f.Creates++
		f.LastCreate = req
		f.Created = append(f.Created, req)
		writeJSON(w, http.StatusAccepted, map[string]any{"droplet": d})
	case strings.HasPrefix(p, "/v2/droplets/"):
		id, _ := strconv.ParseInt(strings.TrimPrefix(p, "/v2/droplets/"), 10, 64)
		d := f.Droplets[id]
		if d == nil {
			notFound(w)
			return
		}
		switch r.Method {
		case http.MethodGet:
			if f.AutoActivate && d.Status == "new" {
				d.Status = "active"
			}
			writeJSON(w, http.StatusOK, map[string]any{"droplet": d})
		case http.MethodDelete:
			delete(f.Droplets, id)
			f.Deletes++
			for _, v := range f.Volumes {
				if len(v.DropletIDs) > 0 && v.DropletIDs[0] == id {
					v.DropletIDs = nil
				}
			}
			for ip, did := range f.ReservedIPs {
				if did == id {
					f.ReservedIPs[ip] = 0
				}
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	case r.Method == http.MethodGet && p == "/v2/images":
		out := []doapi.Image{}
		for _, im := range f.Images {
			if t := q.Get("tag_name"); t != "" && !has(im.Tags, t) {
				continue
			}
			out = append(out, im)
		}
		writeJSON(w, http.StatusOK, map[string]any{"images": out})
	case r.Method == http.MethodGet && p == "/v2/volumes":
		out := []doapi.Volume{}
		for _, v := range f.Volumes {
			if n := q.Get("name"); n != "" && v.Name != n {
				continue
			}
			out = append(out, *v)
		}
		writeJSON(w, http.StatusOK, map[string]any{"volumes": out})
	case strings.HasPrefix(p, "/v2/reserved_ips/"):
		rest := strings.TrimPrefix(p, "/v2/reserved_ips/")
		ip := strings.TrimSuffix(rest, "/actions")
		did, ok := f.ReservedIPs[ip]
		if !ok {
			notFound(w)
			return
		}
		if r.Method == http.MethodGet && !strings.HasSuffix(rest, "/actions") {
			if f.StaleIPReads > 0 {
				f.StaleIPReads--
				did = f.StaleIPDroplet
			}
			body := map[string]any{"ip": ip}
			if did != 0 {
				body["droplet"] = map[string]any{"id": did}
			} else {
				body["droplet"] = nil
			}
			writeJSON(w, http.StatusOK, map[string]any{"reserved_ip": body})
			return
		}
		if r.Method == http.MethodPost && strings.HasSuffix(rest, "/actions") {
			var req struct {
				Type      string `json:"type"`
				DropletID int64  `json:"droplet_id"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			d := f.Droplets[req.DropletID]
			if req.Type != "assign" || d == nil {
				writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"id": "unprocessable_entity", "message": "bad assign"})
				return
			}
			if d.Status != "active" {
				writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"id": "unprocessable_entity", "message": "Droplet is not active"})
				return
			}
			if f.ReservedIPs[ip] == req.DropletID {
				// What DigitalOcean answers for an assign the droplet already has.
				writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"id": "unprocessable_entity",
					"message": "Droplet is already assigned to another reserved IP. Please unassign it first."})
				return
			}
			f.ReservedIPs[ip] = req.DropletID
			f.Assigns++
			writeJSON(w, http.StatusCreated, map[string]any{"action": map[string]any{"id": 1, "status": "in-progress"}})
			return
		}
		w.WriteHeader(http.StatusMethodNotAllowed)
	default:
		notFound(w)
	}
}

func has(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
