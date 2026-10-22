package config

import "testing"

// Who bills for each project, as the admin cost report reads it.
func TestCostProvider(t *testing.T) {
	for _, c := range []struct {
		p    LiveKitProject
		want string
	}{
		{LiveKitProject{ID: "default"}, "hetzner"},
		{LiveKitProject{ID: "do-blr", Label: "Bangalore (DigitalOcean test)"}, "do"},
		{LiveKitProject{ID: "edge2", Label: "Bangalore (DigitalOcean)"}, "do"},
		{LiveKitProject{ID: "india"}, "gcp"},
		{LiveKitProject{ID: "box", SfuVM: &SfuVM{Name: "sfu-india"}}, "gcp"},
		{LiveKitProject{ID: "pool", EgressPool: &EgressPool{Label: "x"}}, "gcp"},
		// "door" is not DigitalOcean: whole words only.
		{LiveKitProject{ID: "door"}, "hetzner"},
		{LiveKitProject{ID: "india", Provider: "DO"}, "do"},
		{LiveKitProject{ID: "india", Provider: "aws"}, "gcp"},
	} {
		if got := c.p.CostProvider(); got != c.want {
			t.Errorf("%+v: %q, want %q", c.p, got, c.want)
		}
	}
}
