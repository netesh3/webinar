package lk

import (
	"errors"
	"fmt"
	"time"

	"github.com/netkumar/webcast/api/internal/config"
)

/* The pool: one client per configured LiveKit project, and the rule for choosing between them.
 *
 * A room lives on exactly ONE project. Its participants all connect to that project's URL with
 * tokens signed by that project's secret, so sending half an audience to a second project does
 * not spread the load — it creates a second, separate room where nobody can see or hear the
 * first. Everything here exists to make that impossible:
 *
 *   - Candidates() offers the projects a NEW room may go on, and the caller immediately
 *     records which one it used so every later join resolves to the same place.
 *   - Get() looks a recorded choice back up, and reports honestly when the project is gone
 *     rather than substituting another.
 *
 * The pool is immutable after construction and holds no mutable state, so it needs no locking
 * and can be shared by every request.
 */

// ErrNoProject is returned when nothing can take a new room: every project is disabled.
var ErrNoProject = errors.New("no enabled LiveKit project")

// ErrUnknownProject is returned by Get for an id that is not configured. It is the state a
// webinar is in after its project is removed from the configuration.
var ErrUnknownProject = errors.New("unknown LiveKit project")

type Pool struct {
	// byID holds every project, including the disabled ones: a disabled project must still
	// serve the rooms already pinned to it, or disabling one would end sessions in progress.
	byID map[string]*Client
	// order is the enabled ids in configuration order, which is the priority order
	// Candidates walks. Enabled-only, so a retired project is never chosen for anything new.
	order []string
	// all is every id in configuration order, for logs and diagnostics.
	all []string
}

// NewPool builds a client per project. The list is expected to be validated already —
// config.validateLiveKitProjects has refused an empty or malformed one — so this cannot fail.
func NewPool(projects []config.LiveKitProject, tokenTTL time.Duration) *Pool {
	p := &Pool{byID: make(map[string]*Client, len(projects))}
	for _, proj := range projects {
		p.byID[proj.ID] = New(proj.URL, proj.HTTPURL, proj.Key, proj.Secret, tokenTTL)
		p.all = append(p.all, proj.ID)
		if proj.Enabled() {
			p.order = append(p.order, proj.ID)
		}
	}
	return p
}

/* Get returns the client for a recorded project id.
 *
 * ErrUnknownProject rather than a fallback, deliberately. The caller has a webinar whose room
 * is on this project and quietly handing back a different one would move the room: a host
 * already presenting on the old project, new attendees arriving on the new one, and no
 * indication that anything happened. The decision about what to do instead belongs to the
 * caller, which is the only place that knows whether the session has started — see
 * Server.sfuFor.
 */
func (p *Pool) Get(id string) (*Client, error) {
	if c, ok := p.byID[id]; ok {
		return c, nil
	}
	return nil, fmt.Errorf("%w %q (configured: %v)", ErrUnknownProject, id, p.all)
}

/* Candidates is the priority order a NEW room may be placed in: enabled projects, in
 * configuration order.
 *
 * First-enabled-wins rather than least-loaded or round-robin, because the reason there is more
 * than one project is an exhausted allowance, not capacity. An operator who has topped up
 * project A and left B configured as a spare wants A used until it runs out again — spreading
 * rooms evenly would burn both allowances at once and halve the useful life of the arrangement.
 *
 * A list rather than a single answer so the caller can try the next one when the first refuses,
 * which is how an exhausted allowance becomes survivable without anybody being paged. That is
 * only ever safe BEFORE a room has anyone in it: once a webinar is pinned and somebody has
 * joined, moving it would split the audience. Server.sfuFor uses this at pin time and nowhere
 * else.
 *
 * Empty means every project is disabled. Config validation refuses to boot in that state, so
 * it is reachable only if the list is built by hand.
 */
func (p *Pool) Candidates() []string {
	out := make([]string, len(p.order))
	copy(out, p.order)
	return out
}

// IDs is every configured project, enabled or not, in configuration order.
func (p *Pool) IDs() []string {
	out := make([]string, len(p.all))
	copy(out, p.all)
	return out
}
