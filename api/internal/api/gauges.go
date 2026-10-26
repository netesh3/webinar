package api

import (
	"context"

	"go.opentelemetry.io/otel/metric"

	"github.com/netkumar/webcast/api/internal/observe"
	"github.com/netkumar/webcast/api/types"
)

/* RegisterGauges puts the audience gauges (observe/gauges.go) on mp: edge viewers on this
 * instance from the event-stream hub, and the cluster-wide counts from the database. Also the
 * database's size (observe/dbsize.go), which the 300 MB alert watches against the Supabase
 * Free plan's 500 MB cap. Pass Telemetry.MeterProvider(); with telemetry off nothing is ever
 * read. */
func (s *Server) RegisterGauges(mp metric.MeterProvider) error {
	if err := observe.RegisterAudienceGauges(mp, audienceSource{s}); err != nil {
		return err
	}
	return observe.RegisterDBSizeGauge(mp, s.store.DatabaseSize)
}

type audienceSource struct{ s *Server }

// EdgeStreams is the edge event streams open on this process (handleEdgeEvents).
func (a audienceSource) EdgeStreams() int { return a.s.rt.Hub().Total() }

// Audience maps the store's snapshot onto the gauges' kinds: a recurring session is a webinar.
func (a audienceSource) Audience(ctx context.Context) (observe.Audience, error) {
	la, err := a.s.store.LiveAudience(ctx)
	if err != nil {
		return observe.Audience{}, err
	}
	out := observe.Audience{
		LiveSessions:       map[string]int{},
		EdgeViewers:        la.EdgeViewers,
		WebRTCParticipants: la.WebRTCParticipants,
	}
	for kind, n := range la.SessionsByKind {
		out.LiveSessions[sessionKind(types.WebinarKind(kind))] += n
	}
	return out, nil
}

func sessionKind(k types.WebinarKind) string {
	switch k {
	case types.KindMeeting:
		return observe.KindMeeting
	case types.KindSimulive:
		return observe.KindSimulive
	default:
		return observe.KindWebinar
	}
}
