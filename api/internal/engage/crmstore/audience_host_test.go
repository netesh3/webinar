package crmstore

import (
	"testing"

	"github.com/netkumar/webcast/api/types"
)

func TestAdjustAudienceWebinarDropsTheHostSeat(t *testing.T) {
	score := 80
	joined := types.CRMAudienceWebinar{Registered: 3, Attended: 2, Index: 70}
	adjustAudienceWebinar(&joined, hostSeat{attended: true, score: &score})
	// 70*2 - 80 = 60, over the one remaining attendee.
	if joined.Registered != 2 || joined.Attended != 1 || joined.Index != 60 {
		t.Fatalf("joined host = %+v, want registered 2, attended 1, index 60", joined)
	}

	missed := types.CRMAudienceWebinar{Registered: 3, Attended: 1, Index: 40}
	adjustAudienceWebinar(&missed, hostSeat{})
	if missed.Registered != 2 || missed.Attended != 1 || missed.Index != 40 {
		t.Fatalf("no-show host = %+v, want registered 2, attended 1, index 40", missed)
	}
}
