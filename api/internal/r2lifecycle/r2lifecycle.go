// Package r2lifecycle builds the recordings bucket's lifecycle rules: recordings, clips,
// uploaded videos and database backups move to R2 Infrequent Access once they are a month old
// (cmd/r2lifecycle, docs/BACKUPS.md).
//
// Why Infrequent Access: R2 Standard is $0.015/GB-month, Infrequent Access $0.010 (checked
// 2026-10-26), with a 30-day minimum and $0.01/GB to read back. Egress stays free. A recording
// is watched most in its first days (replay mail, the host's Studio); after a month it is
// mostly kept, rarely played, so a third off its storage beats the occasional read fee.
//
// R2 filters lifecycle rules by key prefix only, and allows 1000 rules. Recording takes live at
// id[0:2]/id[2:4]/<uuid>.<ext> (beginRecording; the mix recorder uses the same key), so the 256
// two-hex prefixes "00/" … "ff/" match exactly them: no other prefix in the bucket is two
// lowercase hex characters and a slash. Plus uploads/, clips/ and db-backups/: 259 rules.
// covers/, avatars/, chat/ and wa/ are small and read often, and are left alone.
package r2lifecycle

import (
	"fmt"
	"sort"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// RulePrefix starts the ID of every rule this package writes. Rules without it (R2's default
// "abort incomplete multipart uploads" rule, or one added in the dashboard) are someone else's
// and are kept as they are, because PutBucketLifecycleConfiguration replaces the whole set.
const RulePrefix = "webinarliv-ia-"

// DefaultDays is how old an object is when it moves; R2 bills Infrequent Access for 30 days
// at least, so moving sooner would only add that minimum to short-lived files.
const DefaultDays = 30

// MaxRules is R2's limit on lifecycle rules per bucket.
const MaxRules = 1000

// Prefixes are the key prefixes that move: every recording-take fan-out directory, then the
// fixed ones. Sorted, so a config is the same every time it is built.
func Prefixes() []string {
	out := make([]string, 0, 259)
	for i := 0; i < 256; i++ {
		out = append(out, fmt.Sprintf("%02x/", i))
	}
	out = append(out, "clips/", "db-backups/", "uploads/")
	sort.Strings(out)
	return out
}

// Rules is one Transition rule per prefix.
func Rules(days int32) []types.LifecycleRule {
	ps := Prefixes()
	out := make([]types.LifecycleRule, 0, len(ps))
	for _, p := range ps {
		out = append(out, types.LifecycleRule{
			ID:     aws.String(RuleID(p)),
			Status: types.ExpirationStatusEnabled,
			Filter: &types.LifecycleRuleFilter{Prefix: aws.String(p)},
			Transitions: []types.Transition{{
				Days:         aws.Int32(days),
				StorageClass: types.TransitionStorageClassStandardIa,
			}},
		})
	}
	return out
}

// RuleID names the rule for a prefix: "webinarliv-ia-0a", "webinarliv-ia-uploads".
func RuleID(prefix string) string { return RulePrefix + strings.TrimSuffix(prefix, "/") }

// Ours reports whether a rule was written by this package.
func Ours(r types.LifecycleRule) bool { return strings.HasPrefix(aws.ToString(r.ID), RulePrefix) }

// Merge is the bucket's next rule set: every existing rule that is not ours, unchanged and in
// its order, then ours as built now. Running it twice gives the same set (idempotent), and a
// change of days replaces our old rules instead of adding a second copy.
func Merge(existing, ours []types.LifecycleRule) ([]types.LifecycleRule, error) {
	out := make([]types.LifecycleRule, 0, len(existing)+len(ours))
	for _, r := range existing {
		if !Ours(r) {
			out = append(out, r)
		}
	}
	out = append(out, ours...)
	if len(out) > MaxRules {
		return nil, fmt.Errorf("%d lifecycle rules is over R2's limit of %d", len(out), MaxRules)
	}
	return out, nil
}

// Summary is a rule as one line, for printing what is applied (no secrets in a rule).
func Summary(r types.LifecycleRule) string {
	prefix := ""
	if r.Filter != nil {
		prefix = aws.ToString(r.Filter.Prefix)
	}
	if prefix == "" {
		prefix = aws.ToString(r.Prefix) //nolint:staticcheck // R2 may echo the legacy field
	}
	var acts []string
	for _, t := range r.Transitions {
		acts = append(acts, fmt.Sprintf("to %s after %d days", t.StorageClass, aws.ToInt32(t.Days)))
	}
	if r.Expiration != nil && r.Expiration.Days != nil {
		acts = append(acts, fmt.Sprintf("delete after %d days", aws.ToInt32(r.Expiration.Days)))
	}
	if r.AbortIncompleteMultipartUpload != nil {
		acts = append(acts, fmt.Sprintf("abort uploads after %d days",
			aws.ToInt32(r.AbortIncompleteMultipartUpload.DaysAfterInitiation)))
	}
	if prefix == "" {
		prefix = "(whole bucket)"
	}
	return fmt.Sprintf("%-28s %-8s %-14s %s", aws.ToString(r.ID), r.Status, prefix, strings.Join(acts, "; "))
}
