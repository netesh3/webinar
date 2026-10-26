package r2lifecycle

import (
	"regexp"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// The prefixes cover every recording take and nothing the bucket keeps hot.
func TestPrefixesMatchRecordingsAndNothingElse(t *testing.T) {
	ps := Prefixes()
	if len(ps) != 259 {
		t.Fatalf("got %d prefixes, want 259 (256 take fan-outs + clips/ db-backups/ uploads/)", len(ps))
	}
	matches := func(key string) bool {
		for _, p := range ps {
			if strings.HasPrefix(key, p) {
				return true
			}
		}
		return false
	}
	// beginRecording: id[0:2]/id[2:4]/<uuid>.<ext>, ids are lowercase hex UUIDs.
	for _, key := range []string{
		"00/1c/001c9a0e-0000-4000-8000-000000000000.mp4",
		"ff/ee/ffee0000-0000-4000-8000-000000000000.webm",
		"9a/3b/9a3b0000-0000-4000-8000-000000000000.mp4.manifest.json",
		"uploads/host-1/0d1f0000-0000-4000-8000-000000000000.mp4",
		"clips/ab/ab120000-0000-4000-8000-000000000000.mp4",
		"db-backups/2026/10/26/webinarliv-20261026T112742Z.dump",
	} {
		if !matches(key) {
			t.Errorf("%s does not move to Infrequent Access", key)
		}
	}
	for _, key := range []string{
		"covers/abc.jpg", "avatars/user-1.png", "chat/x/y.png", "wa/123/media.jpg", "wa/thumbs/1.jpg",
	} {
		if matches(key) {
			t.Errorf("%s would move to Infrequent Access; it is small and read often", key)
		}
	}
	hex := regexp.MustCompile(`^[0-9a-f]{2}/$`)
	n := 0
	for _, p := range ps {
		if hex.MatchString(p) {
			n++
		}
	}
	if n != 256 {
		t.Fatalf("%d two-hex prefixes, want 256", n)
	}
}

func TestRulesTransitionAfterDaysToInfrequentAccess(t *testing.T) {
	rs := Rules(DefaultDays)
	if len(rs) != len(Prefixes()) {
		t.Fatalf("%d rules for %d prefixes", len(rs), len(Prefixes()))
	}
	ids := map[string]bool{}
	for _, r := range rs {
		id := aws.ToString(r.ID)
		if ids[id] {
			t.Fatalf("duplicate rule id %s", id)
		}
		ids[id] = true
		if !Ours(r) || r.Status != types.ExpirationStatusEnabled {
			t.Fatalf("rule %s: ours=%v status=%s", id, Ours(r), r.Status)
		}
		if r.Filter == nil || aws.ToString(r.Filter.Prefix) == "" {
			t.Fatalf("rule %s has no prefix: it would apply to the whole bucket", id)
		}
		if len(r.Transitions) != 1 || aws.ToInt32(r.Transitions[0].Days) != 30 ||
			r.Transitions[0].StorageClass != types.TransitionStorageClassStandardIa {
			t.Fatalf("rule %s transitions: %+v", id, r.Transitions)
		}
		if r.Expiration != nil {
			t.Fatalf("rule %s deletes objects; this package only moves them", id)
		}
	}
	if !ids["webinarliv-ia-0a"] || !ids["webinarliv-ia-uploads"] || !ids["webinarliv-ia-db-backups"] {
		t.Fatalf("rule ids: %v", ids)
	}
}

// Someone else's rules survive; ours are replaced, not doubled; the limit is enforced.
func TestMergeKeepsOtherRulesAndIsIdempotent(t *testing.T) {
	abort := types.LifecycleRule{
		ID:     aws.String("Default Multipart Abort Rule"),
		Status: types.ExpirationStatusEnabled,
		Filter: &types.LifecycleRuleFilter{Prefix: aws.String("")},
		AbortIncompleteMultipartUpload: &types.AbortIncompleteMultipartUpload{
			DaysAfterInitiation: aws.Int32(7),
		},
	}
	first, err := Merge([]types.LifecycleRule{abort}, Rules(30))
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 260 || aws.ToString(first[0].ID) != "Default Multipart Abort Rule" {
		t.Fatalf("first apply: %d rules, first %q", len(first), aws.ToString(first[0].ID))
	}
	again, err := Merge(first, Rules(45))
	if err != nil {
		t.Fatal(err)
	}
	if len(again) != 260 {
		t.Fatalf("second apply: %d rules, want 260 (ours replaced, not added)", len(again))
	}
	for _, r := range again {
		if Ours(r) && aws.ToInt32(r.Transitions[0].Days) != 45 {
			t.Fatalf("old rule %s survived with %d days", aws.ToString(r.ID), aws.ToInt32(r.Transitions[0].Days))
		}
	}
	many := make([]types.LifecycleRule, 800)
	for i := range many {
		many[i] = types.LifecycleRule{ID: aws.String("other")}
	}
	if _, err := Merge(many, Rules(30)); err == nil {
		t.Fatal("1059 rules accepted; R2 allows 1000")
	}
}

func TestSummary(t *testing.T) {
	got := Summary(Rules(30)[0])
	if !strings.Contains(got, "webinarliv-ia-00") || !strings.Contains(got, "00/") ||
		!strings.Contains(got, "to STANDARD_IA after 30 days") {
		t.Fatalf("summary %q", got)
	}
}
