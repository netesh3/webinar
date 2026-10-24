package api

import (
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/config"
)

func TestDecideBox(t *testing.T) {
	now := time.Date(2026, 10, 23, 18, 0, 0, 0, time.UTC)
	ago := func(d time.Duration) *time.Time { v := now.Add(-d); return &v }
	grace := 40 * time.Minute
	for _, tc := range []struct {
		name   string
		in     boxInputs
		want   string
		needed bool
	}{
		{"nothing at all", boxInputs{}, "down", false},
		{"always on (the rollback)", boxInputs{AlwaysOn: true}, "up", true},
		{"a live session", boxInputs{Live: 1}, "up", true},
		{"finalizing the transcript", boxInputs{Finalizing: 1}, "up", true},
		{"a recording uploading", boxInputs{Recordings: 1}, "up", true},
		{"scheduled within the warm lead", boxInputs{Soon: 2}, "up", true},
		{"a join or admin instant session asked", boxInputs{Requested: true}, "up", true},
		{"people in a room on LiveKit", boxInputs{RoomsBusy: true}, "up", true},
		{"inside the idle grace", boxInputs{LastNeeded: ago(39 * time.Minute)}, "up", false},
		{"grace over", boxInputs{LastNeeded: ago(41 * time.Minute)}, "down", false},
		{"grace over but live again", boxInputs{LastNeeded: ago(3 * time.Hour), Live: 1}, "up", true},
		{"a clip being made (or rushed by an admin)", boxInputs{Clips: 1}, "up", true},
	} {
		in := tc.in
		in.Now, in.IdleGrace = now, grace
		got := decideBox(in)
		if got.Desired != tc.want || got.Needed != tc.needed {
			t.Errorf("%s: decideBox = %+v, want %s needed=%v", tc.name, got, tc.want, tc.needed)
		}
		if got.Reason == "" {
			t.Errorf("%s: no reason", tc.name)
		}
	}
}

/* Clips keep the box up while they are made, and never start the idle grace: once the queue is
 * made the box goes as soon as nothing else needs it. With a session as well, it is the
 * session that decides. */
func TestDecideBoxClipsOnly(t *testing.T) {
	now := time.Date(2026, 10, 23, 18, 0, 0, 0, time.UTC)
	if d := decideBox(boxInputs{Now: now, Clips: 2}); !d.ClipsOnly || !d.Needed {
		t.Fatalf("clips alone: %+v", d)
	}
	if d := decideBox(boxInputs{Now: now, Clips: 2, Live: 1}); d.ClipsOnly || !d.Needed {
		t.Fatalf("clips and a session: %+v", d)
	}
	if d := decideBox(boxInputs{Now: now, Live: 1}); d.ClipsOnly {
		t.Fatalf("a session alone: %+v", d)
	}
}

func TestBoxBackoff(t *testing.T) {
	want := []time.Duration{30 * time.Second, 30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute, 5 * time.Minute, 5 * time.Minute}
	for n, w := range want {
		if got := boxBackoff(n); got != w {
			t.Errorf("boxBackoff(%d) = %s, want %s", n, got, w)
		}
	}
}

func TestBoxUserData(t *testing.T) {
	c := config.SFUBox{Repo: "netesh3/webinar", Ref: "main", Volume: "sfu-data"}
	ud, err := boxUserData(c)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"#!/bin/bash", "SFU_VOLUME_NAME=sfu-data", "SFU_REPO=netesh3/webinar", "SFU_REF=main",
		"deploy/digitalocean/sfu-boot.sh", "/usr/local/sbin/webinarliv-sfu-boot.sh"} {
		if !strings.Contains(ud, want) {
			t.Errorf("user data lacks %q:\n%s", want, ud)
		}
	}
	// Nothing from config reaches the shell unquoted unless it is a plain name.
	c.Ref = "main; rm -rf /"
	if _, err := boxUserData(c); err == nil {
		t.Error("a ref with shell in it was accepted")
	}
}
