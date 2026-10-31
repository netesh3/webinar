package config

import "testing"

/* The APNs VoIP key (31 Oct 2026): read from APNS_*, trimmed, and off when unset. */
func TestAPNsVoIPIsReadAndOffWhenUnset(t *testing.T) {
	setEnv(t, map[string]string{
		"APNS_KEY_P8": "", "APNS_KEY_ID": "", "APNS_TEAM_ID": "", "APNS_ENV": "",
	})
	c, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if c.APNsVoIP().Configured() {
		t.Fatal("VoIP configured with no APNS_* set")
	}

	setEnv(t, map[string]string{
		"APNS_KEY_P8":  " -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY----- ",
		"APNS_KEY_ID":  " ABC123DEFG ",
		"APNS_TEAM_ID": "GF5C6XT5S4",
		"APNS_ENV":     " sandbox",
	})
	c, err = Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	a := c.APNsVoIP()
	if !a.Configured() || a.KeyID != "ABC123DEFG" || a.TeamID != "GF5C6XT5S4" || a.Env != "sandbox" ||
		a.KeyP8 != "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" {
		t.Fatalf("APNsVoIP = %+v", a)
	}
}
