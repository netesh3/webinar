package lk

import (
	"context"

	"github.com/livekit/protocol/livekit"
)

/* Activity is what is running on a LiveKit server right now, for the on-demand box's drain
 * check (api/internal/api/sfu_box.go): never delete a server with people in a room or an
 * egress (a mix, a recording, a stream) still going. */
type Activity struct {
	Rooms        int
	Participants int
	Egresses     int
}

// Busy is anything at all running.
func (a Activity) Busy() bool { return a.Participants > 0 || a.Egresses > 0 }

// Activity asks the server. An error means it could not say, which a caller must treat as busy.
func (c *Client) Activity(ctx context.Context) (Activity, error) {
	var a Activity
	rooms, err := c.rooms.ListRooms(ctx, &livekit.ListRoomsRequest{})
	if err != nil {
		return a, err
	}
	for _, r := range rooms.GetRooms() {
		a.Rooms++
		a.Participants += int(r.GetNumParticipants())
	}
	if c.egress != nil {
		res, err := c.egress.ListEgress(ctx, &livekit.ListEgressRequest{Active: true})
		if err != nil {
			return a, err
		}
		for _, e := range res.GetItems() {
			switch e.GetStatus() {
			case livekit.EgressStatus_EGRESS_STARTING, livekit.EgressStatus_EGRESS_ACTIVE, livekit.EgressStatus_EGRESS_ENDING:
				a.Egresses++
			}
		}
	}
	return a, nil
}
