// Command lkstat prints who is in a LiveKit room and what they are publishing.
//
// Ops tool and test oracle: it asks the SFU directly rather than trusting the
// UI, which is the only way to prove an attendee really cannot publish.
//
//	go run ./cmd/lkstat webinar_scaling-webrtc-10k
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

type participant struct {
	Identity   string `json:"identity"`
	Name       string `json:"name"`
	State      string `json:"state"`
	Permission string `json:"permission"`
	CanPublish bool   `json:"canPublish"`
	// Hidden is the whole "attendees cannot see each other" guarantee, read back
	// out of the SFU. If this is false for an attendee on a webinar that hides
	// them, the feature is not working however the UI looks.
	Hidden   bool   `json:"hidden"`
	CanSpeak bool   `json:"canSpeak"`
	Role     string `json:"role"`
	// MutedByHost separates "not a speaker" from "a speaker the host silenced".
	// Both have canSpeak false, and only the second one is a mute that held.
	MutedByHost bool     `json:"mutedByHost"`
	AudioMuted  bool     `json:"audioMuted"`
	TrackKinds  []string `json:"publishing"`
	JoinedAtAgo string   `json:"joinedAgo"`
}

type report struct {
	Room            string        `json:"room"`
	NumParticipants int           `json:"numParticipants"`
	Publishers      int           `json:"publishers"`
	Hidden          int           `json:"hidden"`
	Participants    []participant `json:"participants"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: lkstat <room-name>")
		os.Exit(2)
	}
	room := os.Args[1]

	url := env("LIVEKIT_HTTP_URL", "http://localhost:7880")
	key := env("LIVEKIT_API_KEY", "devkey")
	secret := env("LIVEKIT_API_SECRET", "devsecretdevsecretdevsecretdevsecret")

	client := lksdk.NewRoomServiceClient(url, key, secret)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	res, err := client.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room})
	if err != nil {
		fmt.Fprintf(os.Stderr, "list participants: %v\n", err)
		os.Exit(1)
	}

	rep := report{Room: room, NumParticipants: len(res.Participants)}
	for _, p := range res.Participants {
		canPublish := p.Permission != nil && p.Permission.CanPublish
		hidden := p.Permission != nil && p.Permission.Hidden
		// Allowed to speak: publishing at all, and either unrestricted or with
		// the microphone named in the source list.
		canSpeak := canPublish && (len(p.Permission.CanPublishSources) == 0 ||
			slices.Contains(p.Permission.CanPublishSources, livekit.TrackSource_MICROPHONE))
		if hidden {
			rep.Hidden++
		}

		kinds := []string{}
		// Nothing published means nothing to hear, which is the same outcome as
		// muted for anyone listening.
		audioMuted := true
		for _, t := range p.Tracks {
			kinds = append(kinds, fmt.Sprintf("%s/%s", t.Type, t.Source))
			if t.Source == livekit.TrackSource_MICROPHONE {
				audioMuted = t.Muted
			}
		}
		if len(kinds) > 0 {
			rep.Publishers++
		}

		perm := "none"
		if p.Permission != nil {
			// An EMPTY source list means every source, so it is printed as "all"
			// rather than as nothing — the difference between a full stage grant
			// and an audio-only one is invisible otherwise.
			sources := "all"
			if len(p.Permission.CanPublishSources) > 0 {
				names := make([]string, 0, len(p.Permission.CanPublishSources))
				for _, src := range p.Permission.CanPublishSources {
					names = append(names, src.String())
				}
				sources = strings.Join(names, "+")
			}
			perm = fmt.Sprintf("publish=%v(%s) subscribe=%v data=%v hidden=%v",
				p.Permission.CanPublish, sources, p.Permission.CanSubscribe,
				p.Permission.CanPublishData, p.Permission.Hidden)
		}

		// The role we minted into the token, echoed back by the SFU verbatim.
		role := ""
		mutedByHost := false
		if p.Metadata != "" {
			var meta struct {
				Role        string `json:"role"`
				MutedByHost bool   `json:"mutedByHost"`
			}
			if err := json.Unmarshal([]byte(p.Metadata), &meta); err == nil {
				role = meta.Role
				mutedByHost = meta.MutedByHost
			}
		}

		rep.Participants = append(rep.Participants, participant{
			Identity:    p.Identity,
			Name:        p.Name,
			State:       p.State.String(),
			Permission:  perm,
			CanPublish:  canPublish,
			Hidden:      hidden,
			CanSpeak:    canSpeak,
			Role:        role,
			MutedByHost: mutedByHost,
			AudioMuted:  audioMuted,
			TrackKinds:  kinds,
			JoinedAtAgo: time.Since(time.Unix(p.JoinedAt, 0)).Truncate(time.Second).String(),
		})
	}

	out, _ := json.MarshalIndent(rep, "", "  ")
	fmt.Println(string(out))
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
