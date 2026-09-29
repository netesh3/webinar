package engage

import (
	"errors"
	"net/http"
	"slices"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* followupFaces is how many people a Follow up card shows. */
const followupFaces = 4

/* followupGroups are the Engagement tab's groups, in its order: the four score tiers and
 * the no-shows. Each is the segment a send resolves, so the card and the send agree. */
func followupGroups() []types.CRMFollowupGroup {
	tier := func(t types.EngagementTier) types.CRMFollowupGroup {
		return types.CRMFollowupGroup{ID: t, Segment: types.CRMSegment{
			Attendance: types.SegmentJoined, Tiers: []types.EngagementTier{t}}}
	}
	return []types.CRMFollowupGroup{
		tier(types.TierHigh), tier(types.TierEngaged), tier(types.TierPassive), tier(types.TierRisk),
		{ID: types.TierNoShow, Segment: types.CRMSegment{Attendance: types.SegmentNoShow}},
	}
}

/* sameFollowup is whether a broadcast went to exactly this group — not a wider segment
 * that happens to include it, which would say "sent" about people it may have missed. */
func sameFollowup(b types.CRMBroadcast, g types.CRMSegment) bool {
	if b.Audience != types.AudienceSegment || b.Segment == nil || b.Status == "cancelled" {
		return false
	}
	s := *b.Segment
	return s.Attendance == g.Attendance && s.MinWatchMin == 0 && s.MaxWatchMin == 0 &&
		!s.Replied && slices.Equal(s.Tiers, g.Tiers)
}

// handleCRMFollowups is the Engagement tab's Follow up section.
func (s *Module) handleCRMFollowups(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	slug := chi.URLParam(r, "slug")
	if !s.crmWebinarAllowed(w, r, user.ID, slug) {
		return
	}
	ctx := r.Context()
	out := types.CRMFollowupsResponse{
		WebinarID:         slug,
		WhatsAppConnected: user.WhatsAppToken != "" && user.WhatsAppPhoneNumberID != "",
		Groups:            followupGroups(),
	}
	var err error
	if out.Scored, err = s.store.WebinarScored(ctx, user.ID, slug); err != nil {
		s.fail(w, r, "crm followups: scored", err)
		return
	}
	sent, err := s.store.WebinarBroadcasts(ctx, user.ID, slug)
	if err != nil {
		s.fail(w, r, "crm followups: broadcasts", err)
		return
	}
	for i := range out.Groups {
		g := &out.Groups[i]
		a := crmstore.Audience{Kind: types.AudienceSegment, WebinarSlug: slug, Segment: &g.Segment}
		if g.Audience, err = s.store.AudienceCounts(ctx, user.ID, a); err != nil {
			s.fail(w, r, "crm followups: audience", err)
			return
		}
		g.Faces = []types.CRMAudienceSample{}
		if g.Audience.Recipients > 0 {
			people, err := s.store.AudienceContacts(ctx, user.ID, a, followupFaces)
			if err != nil && !errors.Is(err, store.ErrConflict) {
				s.fail(w, r, "crm followups: faces", err)
				return
			}
			for _, c := range people[:min(len(people), followupFaces)] {
				name := c.Name
				if name == "" {
					name = c.Phone
				}
				g.Faces = append(g.Faces, types.CRMAudienceSample{ContactID: c.ID, Name: name, Params: []string{}})
			}
		}
		// Newest first, so the first match is the latest follow-up to this group.
		for _, b := range sent {
			if sameFollowup(b, g.Segment) {
				b := b
				g.Broadcast = &b
				break
			}
		}
	}
	httpx.JSON(w, http.StatusOK, out)
}
