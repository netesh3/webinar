/* Package egresspool starts and stops the egress worker VMs of one LiveKit project.
 *
 * A worker (deploy/egress-worker) runs one Edge webinar's composite. Workers are kept
 * STOPPED and the API starts one when a host clicks Start, so a pool costs only disks
 * between webinars. The pool is whatever VMs carry the label egress-pool=<label> in the
 * zone: its size is changed by adding or deleting VMs (the "Egress pool: add workers"
 * workflow), not by configuration.
 *
 * Plain REST against the Compute Engine API with the runtime service account's token from
 * the metadata server, so there is no client library and no key file: on Cloud Run the
 * default service account already may start and stop instances in its project. */
package egresspool

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Worker is one VM in the pool.
type Worker struct {
	Name string
	// Status is Compute Engine's: PROVISIONING, STAGING, RUNNING, STOPPING, SUSPENDED,
	// TERMINATED (stopped), REPAIRING.
	Status string
}

// Busy is a worker that is up or on its way up: it counts against demand.
func (w Worker) Busy() bool {
	switch w.Status {
	case "PROVISIONING", "STAGING", "RUNNING", "REPAIRING":
		return true
	}
	return false
}

// Startable is a stopped worker.
func (w Worker) Startable() bool { return w.Status == "TERMINATED" || w.Status == "SUSPENDED" }

// Pool is one project's workers.
type Pool struct {
	GCPProject string
	Zone       string
	Label      string

	// Endpoint and Token are the Compute API base and the bearer token source; nil uses
	// the real API and the metadata server. Tests set both.
	Endpoint string
	Token    func(ctx context.Context) (string, error)
	HTTP     *http.Client
}

// ErrCapacity is GCP refusing to start a worker for lack of capacity or quota: the
// operators have to act (another zone, a quota raise), so it is alerted, not retried.
var ErrCapacity = errors.New("egress pool: no capacity to start a worker")

func (p *Pool) base() string {
	if p.Endpoint != "" {
		return strings.TrimRight(p.Endpoint, "/")
	}
	return "https://compute.googleapis.com/compute/v1"
}

func (p *Pool) client() *http.Client {
	if p.HTTP != nil {
		return p.HTTP
	}
	return &http.Client{Timeout: 20 * time.Second}
}

func (p *Pool) token(ctx context.Context) (string, error) {
	if p.Token != nil {
		return p.Token(ctx)
	}
	return metadataToken(ctx)
}

func (p *Pool) zoneURL() string {
	return fmt.Sprintf("%s/projects/%s/zones/%s", p.base(), url.PathEscape(p.GCPProject), url.PathEscape(p.Zone))
}

func (p *Pool) do(ctx context.Context, method, u string, out any) error {
	tok, err := p.token(ctx)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := p.client().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode/100 != 2 {
		if isCapacity(string(body)) {
			return fmt.Errorf("%w: %s", ErrCapacity, snippet(body))
		}
		return fmt.Errorf("egress pool: %s %s: %d %s", method, u, resp.StatusCode, snippet(body))
	}
	if out != nil {
		return json.Unmarshal(body, out)
	}
	return nil
}

// List is the pool's workers.
func (p *Pool) List(ctx context.Context) ([]Worker, error) {
	var out struct {
		Items []struct {
			Name   string `json:"name"`
			Status string `json:"status"`
		} `json:"items"`
	}
	u := p.zoneURL() + "/instances?filter=" + url.QueryEscape("labels.egress-pool="+p.Label)
	if err := p.do(ctx, http.MethodGet, u, &out); err != nil {
		return nil, err
	}
	ws := make([]Worker, 0, len(out.Items))
	for _, it := range out.Items {
		ws = append(ws, Worker{Name: it.Name, Status: it.Status})
	}
	return ws, nil
}

type operation struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Error  *struct {
		Errors []struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"errors"`
	} `json:"error"`
}

func (o operation) err() error {
	if o.Error == nil || len(o.Error.Errors) == 0 {
		return nil
	}
	var parts []string
	for _, e := range o.Error.Errors {
		parts = append(parts, e.Code+": "+e.Message)
	}
	msg := strings.Join(parts, "; ")
	if isCapacity(msg) {
		return fmt.Errorf("%w: %s", ErrCapacity, msg)
	}
	return errors.New("egress pool: " + msg)
}

// Status is one instance's Compute Engine status (RUNNING, TERMINATED, ...).
func (p *Pool) Status(ctx context.Context, name string) (string, error) {
	var out struct {
		Status string `json:"status"`
	}
	if err := p.do(ctx, http.MethodGet, p.zoneURL()+"/instances/"+url.PathEscape(name), &out); err != nil {
		return "", err
	}
	return out.Status, nil
}

// Start powers a stopped worker on and waits (up to the context) for GCP to accept or
// refuse it. Capacity and quota refusals come back as ErrCapacity.
func (p *Pool) Start(ctx context.Context, name string) error {
	return p.act(ctx, name, "start")
}

// Stop powers a worker off. A webinar it is encoding ends; callers only stop idle pools.
func (p *Pool) Stop(ctx context.Context, name string) error {
	return p.act(ctx, name, "stop")
}

func (p *Pool) act(ctx context.Context, name, verb string) error {
	var op operation
	if err := p.do(ctx, http.MethodPost, p.zoneURL()+"/instances/"+url.PathEscape(name)+"/"+verb, &op); err != nil {
		return err
	}
	for op.Status != "DONE" {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
		if err := p.do(ctx, http.MethodGet, p.zoneURL()+"/operations/"+url.PathEscape(op.Name), &op); err != nil {
			return err
		}
	}
	return op.err()
}

func isCapacity(s string) bool {
	for _, k := range []string{"ZONE_RESOURCE_POOL_EXHAUSTED", "QUOTA_EXCEEDED", "RESOURCE_EXHAUSTED",
		"does not have enough resources", "Quota "} {
		if strings.Contains(s, k) {
			return true
		}
	}
	return false
}

func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}

// metadataToken is the runtime service account's access token, cached until near expiry.
var (
	tokMu  sync.Mutex
	tokVal string
	tokExp time.Time
)

func metadataToken(ctx context.Context) (string, error) {
	tokMu.Lock()
	defer tokMu.Unlock()
	if tokVal != "" && time.Until(tokExp) > time.Minute {
		return tokVal, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Metadata-Flavor", "Google")
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("egress pool: metadata token: %w", err)
	}
	defer resp.Body.Close()
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.AccessToken == "" {
		return "", fmt.Errorf("egress pool: metadata token: status %d", resp.StatusCode)
	}
	tokVal, tokExp = out.AccessToken, time.Now().Add(time.Duration(out.ExpiresIn)*time.Second)
	return tokVal, nil
}

// MetadataProject is the GCP project the process runs in, from the metadata server.
func MetadataProject(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"http://metadata.google.internal/computeMetadata/v1/project/project-id", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Metadata-Flavor", "Google")
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("egress pool: metadata project: %w", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
	if resp.StatusCode != http.StatusOK || len(b) == 0 {
		return "", fmt.Errorf("egress pool: metadata project: status %d", resp.StatusCode)
	}
	return strings.TrimSpace(string(b)), nil
}
