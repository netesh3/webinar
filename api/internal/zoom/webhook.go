package zoom

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"
)

/* Zoom signs every webhook as hex(HMAC-SHA256(secret, "v0:{timestamp}:{body}"))
 * and sends it in x-zm-signature as "v0={hex}". The timestamp has to be recent.
 */
func VerifySignature(secret, timestamp, signature string, body []byte, now time.Time) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return errors.New("zoom webhook secret is not set")
	}
	ts := strings.TrimSpace(timestamp)
	sec, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return errors.New("zoom webhook timestamp is missing")
	}
	when := time.Unix(sec, 0)
	if now.Sub(when) > 5*time.Minute || when.Sub(now) > 5*time.Minute {
		return errors.New("zoom webhook timestamp is stale")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("v0:" + ts + ":"))
	mac.Write(body)
	want := "v0=" + hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(strings.TrimSpace(signature))) {
		return errors.New("zoom webhook signature does not match")
	}
	return nil
}

/* ValidationToken is Zoom's CRC reply: hex(HMAC-SHA256(secret, plainToken)). */
func ValidationToken(secret, plain string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(plain))
	return hex.EncodeToString(mac.Sum(nil))
}
