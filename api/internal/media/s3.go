package media

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

/* S3 stores recordings in an S3-compatible bucket — Backblaze B2 in practice,
 * which speaks the S3 API directly, so no B2-specific SDK is needed.
 *
 * The interface this satisfies was shaped for append-in-place (see Store's
 * own comment), which an S3-family object store does not offer: an object is
 * written once, whole, or not at all. So Append does not touch the bucket at
 * all — every chunk lands in a local staging file (via an embedded Disk,
 * reusing its already-proven fsync-per-chunk durability rather than
 * reimplementing it) and Finalize is what actually uploads, once, when the
 * recording is complete and every byte is known.
 *
 * That trade means a recording's full size sits on local disk for the
 * duration of the session before it ever reaches the bucket — this backend
 * does not stream to B2 as it records. For MAX_RECORDING_MB in the
 * neighbourhood of a few gigabytes on a host with room to spare, that is a
 * non-issue; run this on a memory-constrained container (Cloud Run's default
 * is 512Mi) and a long, high-bitrate recording can outgrow the instance
 * before Finalize ever runs. Widen the instance's memory/disk, or lower
 * MAX_RECORDING_MB to fit it, rather than assume this streams — it does not.
 *
 * Open and Delete check the local staging file first, and only fall back to
 * the bucket if it is gone — which Finalize only removes after a confirmed
 * upload. That single check is what keeps "a still-recording session can be
 * downloaded as far as it has gotten" (see handleDownloadRecording) true for
 * this backend exactly as it already is for Disk, with no separate
 * in-progress/finalized flag to keep in sync by hand.
 *
 * One gap, honestly stated rather than silently accepted: a recording whose
 * tab crashes or closes without ever reaching /complete is swept by
 * StartRecording's own stale-row cleanup (store/recordings.go, 90 seconds
 * without a chunk) — a pure database UPDATE that has no reference to this
 * package and so never calls Finalize. Under Disk that is harmless, because
 * every byte already landed on disk as it was appended. Under this backend
 * it means an abandoned recording's staged file stays local, unreachable
 * from the Recordings list's download link, until something re-runs
 * Finalize for that key by hand. Rare in practice — it needs a crash mid-
 * recording specifically, not just the host forgetting to press Stop, since
 * stop() itself still calls complete() — but real, and worth a periodic
 * "finalize anything still staged" sweep if it turns out to matter more
 * than that.
 */
type S3 struct {
	staging  *Disk
	client   *s3.Client
	bucket   string
	endpoint string
}

// NewS3 opens the local staging area (same write-probe Disk already does, so
// a misconfigured staging directory is a boot failure here too) and builds an
// S3 client pointed at a non-AWS endpoint with static credentials — there is
// no ambient AWS environment to inherit them from, and this must not
// accidentally pick one up on a machine that has one for something else.
func NewS3(stagingDir, endpoint, region, bucket, accessKeyID, secretAccessKey string) (*S3, error) {
	staging, err := NewDisk(stagingDir)
	if err != nil {
		return nil, fmt.Errorf("recording staging area: %w", err)
	}
	if strings.TrimSpace(bucket) == "" {
		return nil, errors.New("recordings bucket is empty")
	}
	if strings.TrimSpace(endpoint) == "" {
		return nil, errors.New("recordings S3 endpoint is empty")
	}

	client := s3.New(s3.Options{
		Region:       region,
		BaseEndpoint: aws.String(endpoint),
		Credentials: credentials.NewStaticCredentialsProvider(
			accessKeyID, secretAccessKey, "",
		),
		// B2's S3-compatible API is documented against path-style addressing
		// (bucket in the path, not a subdomain of the endpoint) — the safer
		// default for any non-AWS S3-compatible provider, which does not
		// necessarily have the DNS wired up for virtual-hosted-style buckets.
		UsePathStyle: true,
	})

	return &S3{staging: staging, client: client, bucket: bucket, endpoint: endpoint}, nil
}

func (o *S3) Describe() string { return "s3:" + o.bucket + " (" + o.endpoint + ")" }

// Append only ever writes to the local staging file — see the type's own
// comment for why an S3-family store cannot append to a bucket object.
func (o *S3) Append(ctx context.Context, key string, r io.Reader) (int64, error) {
	return o.staging.Append(ctx, key, r)
}

// Open serves the local staging file while it still exists — which covers
// both a recording still in progress and one that finished but has not been
// Finalized yet — and falls back to the bucket once Finalize has removed it.
func (o *S3) Open(ctx context.Context, key string) (io.ReadSeekCloser, int64, error) {
	if f, size, err := o.staging.Open(ctx, key); err == nil {
		return f, size, nil
	} else if !errors.Is(err, ErrNotFound) {
		return nil, 0, err
	}

	out, err := o.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(o.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		var nsk *types.NoSuchKey
		var nf *types.NotFound
		var apiErr smithy.APIError
		if errors.As(err, &nsk) || errors.As(err, &nf) ||
			(errors.As(err, &apiErr) && (apiErr.ErrorCode() == "NoSuchKey" || apiErr.ErrorCode() == "NotFound" || apiErr.ErrorCode() == "404" || apiErr.ErrorCode() == "ResourceNotFoundException")) {
			return nil, 0, ErrNotFound
		}
		return nil, 0, err
	}
	size := int64(0)
	if out.ContentLength != nil {
		size = *out.ContentLength
	}
	// GetObject's Body is a plain ReadCloser — no Seek, so a scrub (a range
	// request from the browser) cannot be served from it directly. Each
	// range request is its own GetObject call instead; see rangeReader.
	return &rangeReader{ctx: ctx, client: o.client, bucket: o.bucket, key: key, size: size, body: out.Body}, size, nil
}

/* Delete removes both possible copies — the staging file, if the recording
 * was never finalized (abandoned mid-session, or the ceiling in
 * handleRecordingChunk closed it early), and the bucket object, if it was.
 *
 * DeleteObject is not checked for "not found": S3's own semantics make it
 * idempotent — deleting a key that is not there succeeds rather than
 * erroring — which is exactly the behaviour wanted here and needs no
 * special-casing to get.
 */
func (o *S3) Delete(ctx context.Context, key string) error {
	if err := o.staging.Delete(ctx, key); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	_, err := o.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(o.bucket),
		Key:    aws.String(key),
	})
	return err
}

/* Finalize uploads the complete staged file in one call and only then removes
 * it — a failed upload leaves the local copy in place rather than losing the
 * recording, so a retried Finalize (or a manual one, later) still has bytes
 * to push. manager.Uploader picks a single PutObject or a multipart upload
 * based on size on its own; there is no hand-rolled part-buffering here to
 * get wrong.
 */
func (o *S3) Finalize(ctx context.Context, key string) error {
	f, _, err := o.staging.Open(ctx, key)
	if errors.Is(err, ErrNotFound) {
		// Nothing staged — already finalized, or never appended to at all.
		// Either way there is nothing this call needs to do.
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()

	uploader := manager.NewUploader(o.client)
	if _, err := uploader.Upload(ctx, &s3.PutObjectInput{
		Bucket: aws.String(o.bucket),
		Key:    aws.String(key),
		Body:   f,
	}); err != nil {
		return fmt.Errorf("upload %s: %w", key, err)
	}

	return o.staging.Delete(ctx, key)
}

/* rangeReader turns GetObject's plain ReadCloser into an io.ReadSeekCloser by
 * re-issuing GetObject with a Range header on every Seek — the same
 * capability http.ServeContent needs to let a browser scrub a video, which is
 * why Open has to return something seekable at all (see Disk's own Open for
 * the same requirement on the local backend). Each Seek costs a new request;
 * scrubbing a video is a handful of seeks, not hundreds, so this is the right
 * place to spend that cost rather than buffering the whole object in memory
 * first just to make it seekable.
 */
type rangeReader struct {
	ctx    context.Context
	client *s3.Client
	bucket string
	key    string
	size   int64
	pos    int64
	body   io.ReadCloser
}

func (r *rangeReader) Read(p []byte) (int, error) {
	if r.body == nil {
		if err := r.reopen(); err != nil {
			return 0, err
		}
	}
	n, err := r.body.Read(p)
	r.pos += int64(n)
	return n, err
}

func (r *rangeReader) Seek(offset int64, whence int) (int64, error) {
	var next int64
	switch whence {
	case io.SeekStart:
		next = offset
	case io.SeekCurrent:
		next = r.pos + offset
	case io.SeekEnd:
		next = r.size + offset
	default:
		return 0, errors.New("media: invalid whence")
	}
	if next < 0 {
		return 0, errors.New("media: negative seek position")
	}
	if next == r.pos && r.body != nil {
		return r.pos, nil
	}
	if r.body != nil {
		_ = r.body.Close()
		r.body = nil
	}
	r.pos = next
	return r.pos, nil
}

func (r *rangeReader) reopen() error {
	if r.pos >= r.size {
		r.body = io.NopCloser(strings.NewReader(""))
		return nil
	}
	out, err := r.client.GetObject(r.ctx, &s3.GetObjectInput{
		Bucket: aws.String(r.bucket),
		Key:    aws.String(r.key),
		Range:  aws.String(fmt.Sprintf("bytes=%d-", r.pos)),
	})
	if err != nil {
		return err
	}
	r.body = out.Body
	return nil
}

func (r *rangeReader) Close() error {
	if r.body == nil {
		return nil
	}
	return r.body.Close()
}
