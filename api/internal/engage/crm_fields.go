package engage

import (
	"context"
	"strings"

	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/types"
)

/* fieldsFor is mergeFields with each Example taken from the host's own data — their
 * newest contact, their next webinar, their name — so every preview (the WhatsApp
 * page, the schedule form, the send dialog, the builders) reads like a message they
 * would really send. A host with none of those keeps the generic example for it;
 * "in 1 hour" and "58 minutes" are true to any reminder and stay as they are.
 *
 * Best effort: a failed read is logged and the generic examples are served, because a
 * preview is never worth failing the page for. */
func (s *Module) fieldsFor(ctx context.Context, hostID string) []types.CRMMergeField {
	out := make([]types.CRMMergeField, len(mergeFields))
	copy(out, mergeFields)
	f, err := s.store.PreviewFacts(ctx, hostID)
	if err != nil {
		s.log.Warn("merge field examples", "host", hostID, "err", err)
		return out
	}
	for i := range out {
		if v := exampleValue(out[i].Token, f, s.publicBase()); v != "" {
			out[i].Example = v
		}
	}
	return out
}

func exampleValue(token string, f crmstore.PreviewFacts, base string) string {
	switch token {
	case "name":
		return strings.Join(strings.Fields(f.ContactName), " ")
	case "first_name":
		if w := strings.Fields(f.ContactName); len(w) > 0 {
			return w[0]
		}
	case "topic":
		return f.Topic
	case "when":
		if !f.StartsAt.IsZero() {
			return notify.LocalTime(f.StartsAt, f.TimeZone)
		}
	case "host":
		return f.HostName
	case "replay":
		if f.Slug != "" {
			return base + "/w/" + f.Slug + "/recording/…"
		}
	}
	return ""
}
