package doapi_test

import (
	"context"
	"errors"
	"testing"

	"github.com/netkumar/webcast/api/internal/doapi"
	"github.com/netkumar/webcast/api/internal/doapi/doapitest"
)

func TestClientAgainstTheFake(t *testing.T) {
	f := doapitest.New("webinar-sfu-image", "sfu-data", "blr1", "152.42.156.192")
	defer f.Close()
	c := f.Client()
	ctx := context.Background()

	im, err := c.LatestSnapshot(ctx, "webinar-sfu-image", "webinar-sfu-image-", "blr1")
	if err != nil || im.ID != 2 {
		t.Fatalf("LatestSnapshot = %+v, %v; want the newer image 2", im, err)
	}
	// Untagged: found by name prefix.
	f.Mu.Lock()
	for i := range f.Images {
		f.Images[i].Tags = nil
	}
	f.Mu.Unlock()
	if im, err = c.LatestSnapshot(ctx, "webinar-sfu-image", "webinar-sfu-image-", "blr1"); err != nil || im.ID != 2 {
		t.Fatalf("by prefix = %+v, %v", im, err)
	}
	if _, err := c.LatestSnapshot(ctx, "nope", "nope-", "blr1"); !errors.Is(err, doapi.ErrNoSnapshot) {
		t.Fatalf("missing snapshot err = %v", err)
	}

	vol, err := c.VolumeByName(ctx, "sfu-data", "blr1")
	if err != nil || vol.ID != "vol-1" {
		t.Fatalf("VolumeByName = %+v, %v", vol, err)
	}
	if _, err := c.VolumeByName(ctx, "other", "blr1"); !errors.Is(err, doapi.ErrNoVolume) {
		t.Fatalf("missing volume err = %v", err)
	}

	d, err := c.CreateDroplet(ctx, doapi.CreateDroplet{Name: "sfu-blr-1", Region: "blr1", Size: "c-4", Image: im.ID,
		Tags: []string{"webinar-sfu", "webinar-sfu-ondemand"}, Volumes: []string{vol.ID}, UserData: "#!/bin/bash"})
	if err != nil || d.Status != "new" {
		t.Fatalf("CreateDroplet = %+v, %v", d, err)
	}
	// The volume is attached now: a second create with it is refused, like DigitalOcean.
	if _, err := c.CreateDroplet(ctx, doapi.CreateDroplet{Name: "x", Image: im.ID, Volumes: []string{vol.ID}}); err == nil {
		t.Fatal("second create with an attached volume succeeded")
	}
	list, err := c.DropletsByTag(ctx, "webinar-sfu-ondemand")
	if err != nil || len(list) != 1 || list[0].ID != d.ID {
		t.Fatalf("DropletsByTag = %+v, %v", list, err)
	}
	// Not active yet: the reserved IP refuses it.
	if err := c.AssignReservedIP(ctx, "152.42.156.192", d.ID); err == nil {
		t.Fatal("assigned to a droplet that is not active")
	}
	f.Activate(d.ID)
	if err := c.AssignReservedIP(ctx, "152.42.156.192", d.ID); err != nil {
		t.Fatal(err)
	}
	if got, err := c.ReservedIPDroplet(ctx, "152.42.156.192"); err != nil || got != d.ID {
		t.Fatalf("ReservedIPDroplet = %d, %v", got, err)
	}
	if err := c.DeleteDroplet(ctx, d.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Droplet(ctx, d.ID); !doapi.IsNotFound(err) {
		t.Fatalf("deleted droplet err = %v, want not found", err)
	}
	// Deleting again is fine; the IP and the volume are free.
	if err := c.DeleteDroplet(ctx, d.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := c.ReservedIPDroplet(ctx, "152.42.156.192"); got != 0 {
		t.Fatalf("reserved IP still on %d", got)
	}
	if v, _ := c.VolumeByName(ctx, "sfu-data", "blr1"); len(v.DropletIDs) != 0 {
		t.Fatalf("volume still attached to %v", v.DropletIDs)
	}

	bad := &doapi.Client{Token: "wrong", BaseURL: f.Srv.URL}
	var de *doapi.Error
	if _, err := bad.DropletsByTag(ctx, "x"); !errors.As(err, &de) || de.Status != 401 {
		t.Fatalf("bad token err = %v", err)
	}
}
