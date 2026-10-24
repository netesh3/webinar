package media

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

/* Listing: what is in the bucket, as opposed to what the database says is in it. Only the
 * admin's "Delete all recordings" (api/recording_purge.go) uses it, to find files no row
 * points at any more. Both are optional capabilities, like Stater. */

// ObjectInfo is one object in the store.
type ObjectInfo struct {
	Key  string
	Size int64
}

// Lister pages through every object in the store in key order: up to limit keys after
// `after` ("" is the start). Fewer than limit means that was the last page.
type Lister interface {
	ListObjects(ctx context.Context, after string, limit int) ([]ObjectInfo, error)
}

// PendingUpload is a multipart upload the bucket has started and nobody has completed or
// aborted: its parts are stored (and billed) but are not an object yet.
type PendingUpload struct {
	Key       string
	UploadID  string
	Initiated time.Time
}

// MultipartLister lists every unfinished multipart upload in the bucket.
type MultipartLister interface {
	ListMultipartUploads(ctx context.Context) ([]PendingUpload, error)
}

// ListObjects walks the root. Fine for the disk backend, which is development-sized.
func (d *Disk) ListObjects(_ context.Context, after string, limit int) ([]ObjectInfo, error) {
	var all []ObjectInfo
	err := filepath.WalkDir(d.root, func(p string, e fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if e.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(d.root, p)
		if err != nil {
			return err
		}
		key := filepath.ToSlash(rel)
		if key <= after {
			return nil
		}
		info, err := e.Info()
		if err != nil {
			return nil
		}
		all = append(all, ObjectInfo{Key: key, Size: info.Size()})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(all, func(i, j int) bool { return all[i].Key < all[j].Key })
	if limit > 0 && len(all) > limit {
		all = all[:limit]
	}
	return all, nil
}

// ListObjects is one ListObjectsV2 page of the bucket (not the local staging area).
func (o *S3) ListObjects(ctx context.Context, after string, limit int) ([]ObjectInfo, error) {
	if limit <= 0 || limit > 1000 {
		limit = 1000
	}
	in := &s3.ListObjectsV2Input{
		Bucket:  aws.String(o.bucket),
		MaxKeys: aws.Int32(int32(limit)), // #nosec G115 -- limit is clamped to 1..1000 above
	}
	if after != "" {
		in.StartAfter = aws.String(after)
	}
	page, err := o.client.ListObjectsV2(ctx, in)
	if err != nil {
		return nil, err
	}
	out := make([]ObjectInfo, 0, len(page.Contents))
	for _, obj := range page.Contents {
		key := aws.ToString(obj.Key)
		if key == "" || strings.HasSuffix(key, "/") {
			continue
		}
		out = append(out, ObjectInfo{Key: key, Size: aws.ToInt64(obj.Size)})
	}
	// A truncated page shorter than limit (folder markers skipped) must not read as the end.
	if aws.ToBool(page.IsTruncated) && len(out) < limit && len(page.Contents) > 0 {
		last := aws.ToString(page.Contents[len(page.Contents)-1].Key)
		more, err := o.ListObjects(ctx, last, limit-len(out))
		if err != nil {
			return nil, err
		}
		out = append(out, more...)
	}
	return out, nil
}

// ListMultipartUploads is every unfinished multipart upload in the bucket.
func (o *S3) ListMultipartUploads(ctx context.Context) ([]PendingUpload, error) {
	var out []PendingUpload
	p := s3.NewListMultipartUploadsPaginator(o.client, &s3.ListMultipartUploadsInput{Bucket: aws.String(o.bucket)})
	for p.HasMorePages() {
		page, err := p.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, u := range page.Uploads {
			out = append(out, PendingUpload{
				Key: aws.ToString(u.Key), UploadID: aws.ToString(u.UploadId),
				Initiated: aws.ToTime(u.Initiated),
			})
		}
	}
	return out, nil
}
