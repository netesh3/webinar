package media

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

const minMultipartPartSize = 5 * 1024 * 1024

type s3Session struct {
	uploadID   string
	partNumber int32
	parts      []types.CompletedPart
	buf        []byte
	mu         sync.Mutex
}

type S3 struct {
	staging    *Disk
	client     *s3.Client
	bucket     string
	endpoint   string
	sessions   map[string]*s3Session
	sessionsMu sync.Mutex
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

	return &S3{
		staging:  staging,
		client:   client,
		bucket:   bucket,
		endpoint: endpoint,
		sessions: make(map[string]*s3Session),
	}, nil
}

func (o *S3) Describe() string { return "s3:" + o.bucket + " (" + o.endpoint + ")" }

// Append writes each incoming chunk to local staging (for fallback durability)
// and progressively uploads completed 5 MB parts to S3 multipart upload in real-time.
func (o *S3) Append(ctx context.Context, key string, r io.Reader) (int64, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return 0, err
	}

	size, err := o.staging.Append(ctx, key, bytes.NewReader(data))
	if err != nil {
		return 0, err
	}

	if o.client == nil {
		return size, nil
	}

	o.sessionsMu.Lock()
	sess, ok := o.sessions[key]
	if !ok {
		sess = &s3Session{}
		o.sessions[key] = sess
	}
	o.sessionsMu.Unlock()

	sess.mu.Lock()
	defer sess.mu.Unlock()

	if sess.uploadID == "" && len(sess.parts) == 0 {
		out, err := o.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
			Bucket:      aws.String(o.bucket),
			Key:         aws.String(key),
			ContentType: aws.String("video/webm"),
		})
		if err == nil && out.UploadId != nil {
			sess.uploadID = *out.UploadId
		}
	}

	sess.buf = append(sess.buf, data...)

	if sess.uploadID != "" {
		for len(sess.buf) >= minMultipartPartSize {
			partData := make([]byte, minMultipartPartSize)
			copy(partData, sess.buf[:minMultipartPartSize])
			sess.partNumber++
			partNum := sess.partNumber

			up, err := o.client.UploadPart(ctx, &s3.UploadPartInput{
				Bucket:     aws.String(o.bucket),
				Key:        aws.String(key),
				UploadId:   aws.String(sess.uploadID),
				PartNumber: aws.Int32(partNum),
				Body:       bytes.NewReader(partData),
			})
			if err != nil {
				_ = o.abortSession(ctx, key, sess)
				break
			}

			sess.parts = append(sess.parts, types.CompletedPart{
				PartNumber: aws.Int32(partNum),
				ETag:       up.ETag,
			})
			sess.buf = sess.buf[minMultipartPartSize:]
		}
	}

	return size, nil
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
	o.sessionsMu.Lock()
	if sess, ok := o.sessions[key]; ok {
		delete(o.sessions, key)
		_ = o.abortSession(ctx, key, sess)
	}
	o.sessionsMu.Unlock()

	if err := o.staging.Delete(ctx, key); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	_, err := o.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(o.bucket),
		Key:    aws.String(key),
	})
	return err
}

func (o *S3) abortSession(ctx context.Context, key string, sess *s3Session) error {
	if sess.uploadID == "" {
		return nil
	}
	uploadID := sess.uploadID
	sess.uploadID = ""
	sess.parts = nil
	sess.buf = nil
	_, err := o.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
		Bucket:   aws.String(o.bucket),
		Key:      aws.String(key),
		UploadId: aws.String(uploadID),
	})
	return err
}

// PresignedURL generates a direct S3 download URL valid for the given duration,
// allowing clients to stream directly from Backblaze B2/S3 without API proxying.
func (o *S3) PresignedURL(ctx context.Context, key string, expires time.Duration) (string, error) {
	if o.client == nil {
		return "", errors.New("s3 client is not initialized")
	}
	ps := s3.NewPresignClient(o.client)
	req, err := ps.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(o.bucket),
		Key:    aws.String(key),
	}, func(opts *s3.PresignOptions) {
		opts.Expires = expires
	})
	if err != nil {
		return "", fmt.Errorf("presign %s: %w", key, err)
	}
	return req.URL, nil
}

// Finalize uploads the complete staged file in one call and then removes it.
func (o *S3) Finalize(ctx context.Context, key string) error {
	return o.FinalizeWithProgress(ctx, key, nil)
}

type progressReader struct {
	r          io.Reader
	total      int64
	read       int64
	onProgress func(read, total int64)
}

func (p *progressReader) Read(buf []byte) (int, error) {
	n, err := p.r.Read(buf)
	p.read += int64(n)
	if p.onProgress != nil {
		p.onProgress(p.read, p.total)
	}
	return n, err
}

func (o *S3) FinalizeWithProgress(ctx context.Context, key string, onProgress func(percent int)) error {
	o.sessionsMu.Lock()
	sess, hasSession := o.sessions[key]
	delete(o.sessions, key)
	o.sessionsMu.Unlock()

	if hasSession && sess != nil {
		sess.mu.Lock()
		defer sess.mu.Unlock()

		if sess.uploadID != "" {
			if len(sess.buf) > 0 {
				sess.partNumber++
				partNum := sess.partNumber
				up, err := o.client.UploadPart(ctx, &s3.UploadPartInput{
					Bucket:     aws.String(o.bucket),
					Key:        aws.String(key),
					UploadId:   aws.String(sess.uploadID),
					PartNumber: aws.Int32(partNum),
					Body:       bytes.NewReader(sess.buf),
				})
				if err == nil {
					sess.parts = append(sess.parts, types.CompletedPart{
						PartNumber: aws.Int32(partNum),
						ETag:       up.ETag,
					})
					sess.buf = nil
				}
			}

			if len(sess.parts) > 0 {
				_, err := o.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
					Bucket:   aws.String(o.bucket),
					Key:      aws.String(key),
					UploadId: aws.String(sess.uploadID),
					MultipartUpload: &types.CompletedMultipartUpload{
						Parts: sess.parts,
					},
				})
				if err == nil {
					if onProgress != nil {
						onProgress(100)
					}
					return o.staging.Delete(ctx, key)
				}
				_ = o.abortSession(ctx, key, sess)
			}
		}
	}

	return o.finalizeFromStaging(ctx, key, onProgress)
}

func (o *S3) finalizeFromStaging(ctx context.Context, key string, onProgress func(percent int)) error {
	f, size, err := o.staging.Open(ctx, key)
	if errors.Is(err, ErrNotFound) {
		// Nothing staged — already finalized, or never appended to at all.
		if onProgress != nil {
			onProgress(100)
		}
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()

	var body io.Reader = f
	if size > 0 && onProgress != nil {
		lastPercent := -1
		body = &progressReader{
			r:     f,
			total: size,
			onProgress: func(read, total int64) {
				if total <= 0 {
					return
				}
				pct := int(float64(read) / float64(total) * 100)
				if pct > 99 {
					pct = 99
				}
				if pct != lastPercent && (pct%2 == 0 || pct == 99 || pct == 0) {
					lastPercent = pct
					onProgress(pct)
				}
			},
		}
	}

	uploader := manager.NewUploader(o.client, func(u *manager.Uploader) {
		u.PartSize = 16 * 1024 * 1024 // 16 MB parts
		u.Concurrency = 5
	})
	if _, err := uploader.Upload(ctx, &s3.PutObjectInput{
		Bucket: aws.String(o.bucket),
		Key:    aws.String(key),
		Body:   body,
	}); err != nil {
		return fmt.Errorf("upload %s: %w", key, err)
	}

	if onProgress != nil {
		onProgress(100)
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
