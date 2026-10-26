// Command dbbackup puts nightly database dumps in object storage and keeps them pruned
// (internal/dbbackup, docs/BACKUPS.md). It never runs pg_dump itself: the workflow does that
// in a Postgres client image of the server's version, and hands this the file.
//
//	dbbackup upload FILE      store FILE as db-backups/YYYY/MM/DD/webinarliv-<now>.dump
//	dbbackup prune [-dry-run] delete what the retention no longer keeps
//	dbbackup latest FILE      download the newest backup to FILE
//	dbbackup list             print every backup key, oldest first
//
// Storage comes from DB_BACKUP_S3_{BUCKET,ENDPOINT,REGION,ACCESS_KEY,SECRET_KEY}, each falling
// back to the matching RECORDINGS_S3_* (the recordings bucket, where db-backups/ is a prefix
// the recordings purge never matches). Only keys under db-backups/ are ever listed, read or
// deleted. Credentials are never printed.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/netkumar/webcast/api/internal/dbbackup"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "dbbackup:", err)
		os.Exit(1)
	}
}

func setting(name string) string {
	if v := strings.TrimSpace(os.Getenv("DB_BACKUP_S3_" + name)); v != "" {
		return v
	}
	return strings.TrimSpace(os.Getenv("RECORDINGS_S3_" + name))
}

type store struct {
	client *s3.Client
	bucket string
}

func newStore() (*store, error) {
	bucket, endpoint := setting("BUCKET"), setting("ENDPOINT")
	key, secret := setting("ACCESS_KEY"), setting("SECRET_KEY")
	region := setting("REGION")
	if region == "" {
		region = "auto"
	}
	var missing []string
	for n, v := range map[string]string{"BUCKET": bucket, "ENDPOINT": endpoint, "ACCESS_KEY": key, "SECRET_KEY": secret} {
		if v == "" {
			missing = append(missing, "DB_BACKUP_S3_"+n+" (or RECORDINGS_S3_"+n+")")
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return nil, fmt.Errorf("storage is not configured: %s", strings.Join(missing, ", "))
	}
	return &store{
		client: s3.New(s3.Options{
			Region:       region,
			BaseEndpoint: aws.String(endpoint),
			Credentials:  credentials.NewStaticCredentialsProvider(key, secret, ""),
			UsePathStyle: true,
		}),
		bucket: bucket,
	}, nil
}

// keys is every object under dbbackup.Prefix, and nothing outside it.
func (s *store) keys(ctx context.Context) ([]string, error) {
	var out []string
	p := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{
		Bucket: aws.String(s.bucket),
		Prefix: aws.String(dbbackup.Prefix),
	})
	for p.HasMorePages() {
		page, err := p.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, o := range page.Contents {
			if k := aws.ToString(o.Key); strings.HasPrefix(k, dbbackup.Prefix) {
				out = append(out, k)
			}
		}
	}
	sort.Strings(out)
	return out, nil
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: dbbackup upload FILE | prune [-dry-run] | latest FILE | list")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	st, err := newStore()
	if err != nil {
		return err
	}
	switch args[0] {
	case "upload":
		if len(args) != 2 {
			return errors.New("usage: dbbackup upload FILE")
		}
		return upload(ctx, st, args[1], time.Now())
	case "prune":
		fs := flag.NewFlagSet("prune", flag.ContinueOnError)
		dry := fs.Bool("dry-run", false, "print what would be deleted, delete nothing")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		return prune(ctx, st, time.Now(), *dry)
	case "latest":
		if len(args) != 2 {
			return errors.New("usage: dbbackup latest FILE")
		}
		return latest(ctx, st, args[1])
	case "list":
		keys, err := st.keys(ctx)
		if err != nil {
			return err
		}
		for _, k := range keys {
			fmt.Println(k)
		}
		return nil
	}
	return fmt.Errorf("unknown command %q", args[0])
}

func upload(ctx context.Context, st *store, path string, now time.Time) error {
	f, err := os.Open(filepath.Clean(path)) // #nosec G304 G703 -- the operator names the dump file on the command line
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	// pg_dump -Fc writes a header even for an empty database; anything this small is a failed dump.
	if info.Size() < 1024 {
		return fmt.Errorf("%s is only %d bytes: refusing to store it as a backup", path, info.Size())
	}
	key := dbbackup.KeyFor(now)
	_, err = manager.NewUploader(st.client).Upload(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(st.bucket),
		Key:         aws.String(key),
		Body:        f,
		ContentType: aws.String("application/octet-stream"),
	})
	if err != nil {
		return fmt.Errorf("upload %s: %w", key, err)
	}
	// Read it back: a backup that is not there is worse than an error.
	head, err := st.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(st.bucket), Key: aws.String(key)})
	if err != nil {
		return fmt.Errorf("uploaded %s but cannot read it back: %w", key, err)
	}
	if aws.ToInt64(head.ContentLength) != info.Size() {
		return fmt.Errorf("uploaded %s is %d bytes, the dump is %d", key, aws.ToInt64(head.ContentLength), info.Size())
	}
	fmt.Printf("stored %s (%d bytes)\n", key, info.Size())
	return nil
}

func prune(ctx context.Context, st *store, now time.Time, dry bool) error {
	keys, err := st.keys(ctx)
	if err != nil {
		return err
	}
	del := dbbackup.Prune(keys, now, dbbackup.DailyDays, dbbackup.MonthlyMonths)
	fmt.Printf("%d backups, %d past retention\n", len(keys), len(del))
	for _, k := range del {
		if !strings.HasPrefix(k, dbbackup.Prefix) { // belt and braces: Prune never returns these
			return fmt.Errorf("refusing to delete %q outside %s", k, dbbackup.Prefix)
		}
		if dry {
			fmt.Println("would delete", k)
			continue
		}
		if _, err := st.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(st.bucket), Key: aws.String(k)}); err != nil {
			return fmt.Errorf("delete %s: %w", k, err)
		}
		fmt.Println("deleted", k)
	}
	return nil
}

func latest(ctx context.Context, st *store, path string) error {
	keys, err := st.keys(ctx)
	if err != nil {
		return err
	}
	key, ok := dbbackup.Latest(keys)
	if !ok {
		return errors.New("no backups found under " + dbbackup.Prefix)
	}
	obj, err := st.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(st.bucket), Key: aws.String(key)})
	if err != nil {
		return fmt.Errorf("get %s: %w", key, err)
	}
	defer obj.Body.Close()
	out, err := os.Create(filepath.Clean(path)) // #nosec G304 G703 -- the operator names the output file on the command line
	if err != nil {
		return err
	}
	n, err := io.Copy(out, obj.Body)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	fmt.Printf("fetched %s (%d bytes) to %s\n", key, n, path)
	return nil
}
