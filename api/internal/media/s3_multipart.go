package media

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

/* Browser multipart uploads (MultipartUploader): the API starts the upload, signs each part
 * for the browser to PUT straight to the bucket, reads back what arrived, and completes it.
 * The bucket needs a CORS rule letting the web origin PUT (see video_upload.go). */

func (o *S3) CreateMultipart(ctx context.Context, key, contentType string) (string, error) {
	in := &s3.CreateMultipartUploadInput{Bucket: aws.String(o.bucket), Key: aws.String(key)}
	if contentType != "" {
		in.ContentType = aws.String(contentType)
	}
	out, err := o.client.CreateMultipartUpload(ctx, in)
	if err != nil {
		return "", fmt.Errorf("create multipart %s: %w", key, err)
	}
	return aws.ToString(out.UploadId), nil
}

func (o *S3) PresignUploadPart(ctx context.Context, key, uploadID string, part int32, expires time.Duration) (string, error) {
	req, err := s3.NewPresignClient(o.client).PresignUploadPart(ctx, &s3.UploadPartInput{
		Bucket:     aws.String(o.bucket),
		Key:        aws.String(key),
		UploadId:   aws.String(uploadID),
		PartNumber: aws.Int32(part),
	}, func(opts *s3.PresignOptions) { opts.Expires = expires })
	if err != nil {
		return "", fmt.Errorf("presign part %d of %s: %w", part, key, err)
	}
	return req.URL, nil
}

func (o *S3) ListUploadedParts(ctx context.Context, key, uploadID string) ([]UploadedPart, error) {
	var out []UploadedPart
	p := s3.NewListPartsPaginator(o.client, &s3.ListPartsInput{
		Bucket: aws.String(o.bucket), Key: aws.String(key), UploadId: aws.String(uploadID),
	})
	for p.HasMorePages() {
		page, err := p.NextPage(ctx)
		if err != nil {
			if isNotFound(err) || isNoSuchUpload(err) {
				return nil, ErrNotFound
			}
			return nil, err
		}
		for _, part := range page.Parts {
			out = append(out, UploadedPart{
				Number: aws.ToInt32(part.PartNumber), ETag: aws.ToString(part.ETag), Size: aws.ToInt64(part.Size),
			})
		}
	}
	return out, nil
}

func (o *S3) CompleteMultipart(ctx context.Context, key, uploadID string, parts []UploadedPart) error {
	done := make([]types.CompletedPart, 0, len(parts))
	for _, p := range parts {
		done = append(done, types.CompletedPart{PartNumber: aws.Int32(p.Number), ETag: aws.String(p.ETag)})
	}
	_, err := o.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket: aws.String(o.bucket), Key: aws.String(key), UploadId: aws.String(uploadID),
		MultipartUpload: &types.CompletedMultipartUpload{Parts: done},
	})
	return err
}

// AbortMultipart throws the parts away. An upload already gone is not an error.
func (o *S3) AbortMultipart(ctx context.Context, key, uploadID string) error {
	_, err := o.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
		Bucket: aws.String(o.bucket), Key: aws.String(key), UploadId: aws.String(uploadID),
	})
	if err != nil && (isNotFound(err) || isNoSuchUpload(err)) {
		return nil
	}
	return err
}

func isNoSuchUpload(err error) bool {
	var nsu *types.NoSuchUpload
	if errors.As(err, &nsu) {
		return true
	}
	var apiErr smithy.APIError
	return errors.As(err, &apiErr) && apiErr.ErrorCode() == "NoSuchUpload"
}
