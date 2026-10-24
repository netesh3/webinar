package api

import "testing"

// purgeableKey is the line between a recording's file and everything else in the bucket.
func TestPurgeableKeyIsOnlyRecordingPrefixes(t *testing.T) {
	const id = "0f3c9a2e-5b1d-4c7e-9a8b-112233445566"
	for _, c := range []struct {
		key    string
		ok     bool
		wantID string
	}{
		{"0f/3c/" + id + ".mp4", true, id},
		{"0f/3c/" + id + ".webm", true, id},
		{"0f/3c/" + id + ".mp4.json", true, id},
		{"uploads/host-1/" + id + ".mp4", true, id},
		{"clips/0f/" + id + ".mp4", true, id},
		{"0f/3c/manifest.txt", true, ""},
		{"avatars/u/" + id + ".png", false, ""},
		{"covers/w/" + id + ".jpg", false, ""},
		{"chat/slug/" + id + ".png", false, ""},
		{"wa/host/files/" + id, false, ""},
		{"wa/host/" + id, false, ""},
		{"zz/3c/" + id + ".mp4", false, ""},
		{"0f/3c/x/" + id + ".mp4", false, ""},
		{"uploads/" + id + ".mp4", false, ""},
		{"clips/0f/x/" + id + ".mp4", false, ""},
		{".writable", false, ""},
	} {
		ok, got := purgeableKey(c.key)
		if ok != c.ok || got != c.wantID {
			t.Errorf("purgeableKey(%q) = %v %q, want %v %q", c.key, ok, got, c.ok, c.wantID)
		}
	}
}
