// Command r2lifecycle applies the recordings bucket's lifecycle rules (internal/r2lifecycle):
// recordings, clips, uploaded videos and database backups move to R2 Infrequent Access after
// 30 days. Run by .github/workflows/r2-lifecycle.yml; see docs/BACKUPS.md.
//
//	r2lifecycle [-dry-run] [-days 30]
//
// It reads the bucket's current rules, keeps every rule it did not write (R2's default
// multipart-abort rule among them), replaces its own, PUTs the set and reads it back. Running
// it again changes nothing. -dry-run prints the set it would apply and writes nothing.
//
// Storage comes from RECORDINGS_S3_{BUCKET,ENDPOINT,REGION,ACCESS_KEY,SECRET_KEY}, the same
// variables the API uses. Credentials are never printed.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"

	"github.com/netkumar/webcast/api/internal/r2lifecycle"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "r2lifecycle:", err)
		os.Exit(1)
	}
}

func setting(name string) string { return strings.TrimSpace(os.Getenv("RECORDINGS_S3_" + name)) }

func run(args []string) error {
	fs := flag.NewFlagSet("r2lifecycle", flag.ContinueOnError)
	dry := fs.Bool("dry-run", false, "print the rules that would be applied, change nothing")
	days := fs.Int("days", r2lifecycle.DefaultDays, "age in days at which objects move to Infrequent Access")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *days < 30 {
		return fmt.Errorf("-days %d: R2 bills Infrequent Access for 30 days at least, so moving sooner only costs more", *days)
	}
	// Bounded here so the int32 the S3 API takes cannot overflow (gosec G115).
	if *days > 3650 {
		return fmt.Errorf("-days %d: more than ten years is not a lifecycle rule worth writing", *days)
	}

	bucket, endpoint := setting("BUCKET"), setting("ENDPOINT")
	key, secret := setting("ACCESS_KEY"), setting("SECRET_KEY")
	region := setting("REGION")
	if region == "" {
		region = "auto"
	}
	var missing []string
	for n, v := range map[string]string{"BUCKET": bucket, "ENDPOINT": endpoint, "ACCESS_KEY": key, "SECRET_KEY": secret} {
		if v == "" {
			missing = append(missing, "RECORDINGS_S3_"+n)
		}
	}
	ours := r2lifecycle.Rules(int32(*days)) // #nosec G115 -- 30..3650, checked above
	if len(missing) > 0 {
		if !*dry {
			sort.Strings(missing)
			return fmt.Errorf("storage is not configured: %s", strings.Join(missing, ", "))
		}
		// A dry run without credentials still shows the rules this would write.
		fmt.Printf("dry run, no bucket configured: %d rules of ours would be applied\n", len(ours))
		show(ours)
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	client := s3.New(s3.Options{
		Region:       region,
		BaseEndpoint: aws.String(endpoint),
		Credentials:  credentials.NewStaticCredentialsProvider(key, secret, ""),
		UsePathStyle: true,
	})

	existing, err := current(ctx, client, bucket)
	if err != nil {
		return fmt.Errorf("read the current rules: %w", err)
	}
	next, err := r2lifecycle.Merge(existing, ours)
	if err != nil {
		return err
	}
	kept := len(next) - len(ours)
	fmt.Printf("bucket has %d rules (%d ours); applying %d: %d kept as they are + %d ours, %d days\n",
		len(existing), countOurs(existing), len(next), kept, len(ours), *days)
	if *dry {
		show(next)
		fmt.Println("dry run: nothing written")
		return nil
	}

	if _, err := client.PutBucketLifecycleConfiguration(ctx, &s3.PutBucketLifecycleConfigurationInput{
		Bucket:                 aws.String(bucket),
		LifecycleConfiguration: &types.BucketLifecycleConfiguration{Rules: next},
	}); err != nil {
		return fmt.Errorf("apply the rules: %w", err)
	}

	applied, err := current(ctx, client, bucket)
	if err != nil {
		return fmt.Errorf("read the rules back: %w", err)
	}
	show(applied)
	if got := countOurs(applied); got != len(ours) {
		return fmt.Errorf("read back %d of our rules, applied %d", got, len(ours))
	}
	fmt.Printf("applied: %d rules on the bucket, %d of them ours\n", len(applied), countOurs(applied))
	return nil
}

// current is the bucket's rules; none at all is an empty list, not an error.
func current(ctx context.Context, c *s3.Client, bucket string) ([]types.LifecycleRule, error) {
	out, err := c.GetBucketLifecycleConfiguration(ctx, &s3.GetBucketLifecycleConfigurationInput{Bucket: aws.String(bucket)})
	if err != nil {
		var api smithy.APIError
		if errors.As(err, &api) && api.ErrorCode() == "NoSuchLifecycleConfiguration" {
			return nil, nil
		}
		return nil, err
	}
	return out.Rules, nil
}

func countOurs(rs []types.LifecycleRule) int {
	n := 0
	for _, r := range rs {
		if r2lifecycle.Ours(r) {
			n++
		}
	}
	return n
}

// show prints the rules not ours in full and ours by their first and last few: 259 lines of
// two-hex prefixes say nothing the count does not.
func show(rs []types.LifecycleRule) {
	var ours []types.LifecycleRule
	for _, r := range rs {
		if r2lifecycle.Ours(r) {
			ours = append(ours, r)
			continue
		}
		fmt.Println("  kept   ", r2lifecycle.Summary(r))
	}
	for i, r := range ours {
		if i < 3 || i >= len(ours)-3 {
			fmt.Println("  ours   ", r2lifecycle.Summary(r))
		} else if i == 3 {
			fmt.Printf("  ours    … %d more of the same …\n", len(ours)-6)
		}
	}
}
