package api

import (
	"context"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* messageSlots asks the CRM for resolved slots.
 * A failure falls back to WebinarOptions: a slot read must not drop a confirmation.
 * NoEngage (a deployment without the CRM) also returns ok false. */
func (s *Server) messageSlots(ctx context.Context, webinarID string) ([]types.MessageSlot, bool) {
	if s.engage == nil {
		return nil, false
	}
	slots, ok, err := s.engage.MessageSlots(ctx, webinarID)
	if err != nil {
		s.log.Warn("message slots", "webinar", webinarID, "error", err)
		return nil, false
	}
	return slots, ok
}

func slotSends(slots []types.MessageSlot, kind, channel string) bool {
	sl, ok := types.FindSlot(slots, kind)
	return ok && sl.Sends(channel)
}

func webinarLocation(wb types.Webinar) *time.Location {
	if wb.TimeZone == "" {
		return time.UTC
	}
	loc, err := time.LoadLocation(wb.TimeZone)
	if err != nil {
		return time.UTC
	}
	return loc
}
