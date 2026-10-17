package wa

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

/* UploadHeaderSample uploads a file through Meta's Resumable Upload API and returns
 * the file handle a template's media header names as its example
 * (`example.header_handle`). Meta reviews a media-header template against that
 * sample; it is not what is sent later, which goes by link at send time.
 *
 * Two requests, as documented at developers.facebook.com/docs/graph-api/guides/upload:
 *
 *  1. POST /{app-id}/uploads?file_name=…&file_length=…&file_type=… opens a session
 *     and answers {"id": "upload:<session>"}.
 *  2. POST /upload:<session> with the bytes as the body, `Authorization: OAuth <token>`
 *     (OAuth, not Bearer, per that page) and `file_offset: 0`, answers {"h": "<handle>"}.
 *
 * The token is the host's own (from Embedded Signup); the app is this deployment's
 * Meta app. One shot — no resume — because header samples are small (≤100 MB for a
 * document, usually far less) and a failed upload is simply retried by the host. */
func (c *Client) UploadHeaderSample(ctx context.Context, token, filename, mime string, data []byte) (string, error) {
	if c == nil {
		return "", ErrNotConfigured
	}
	if strings.TrimSpace(token) == "" {
		return "", ErrNotConnected
	}
	if c.AppID == "" {
		return "", ErrNotConfigured
	}
	if len(data) == 0 {
		return "", errors.New("the file is empty")
	}
	q := url.Values{
		"file_name":   {filename},
		"file_length": {fmt.Sprint(len(data))},
		"file_type":   {mime},
	}
	var session struct {
		ID string `json:"id"`
	}
	if err := c.post(ctx, token, "/"+url.PathEscape(c.AppID)+"/uploads?"+q.Encode(), nil, &session); err != nil {
		return "", err
	}
	if !strings.HasPrefix(session.ID, "upload:") {
		return "", errors.New("meta did not open an upload session")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base()+"/"+session.ID, bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "OAuth "+token)
	req.Header.Set("file_offset", "0")
	req.Header.Set("Content-Type", mime)
	res, err := c.http().Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if res.StatusCode >= 300 {
		return "", graphError(raw, res.StatusCode)
	}
	var out struct {
		H string `json:"h"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.H == "" {
		return "", errors.New("meta accepted the upload but returned no file handle")
	}
	return out.H, nil
}
