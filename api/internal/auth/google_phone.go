package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// GoogleOAuthScopes is what the browser asks Google for on Continue with Google.
// openid, email, and profile stay; the People phone scope is extra and optional.
const GoogleOAuthScopes = "openid email profile https://www.googleapis.com/auth/user.phonenumbers.read"

// PeoplePhoneURL is the People API method that returns the signed-in person's
// phone numbers. Tests point it at an httptest server.
var PeoplePhoneURL = "https://people.googleapis.com/v1/people/me?personFields=phoneNumbers"

// PeopleHTTP calls that method. The timeout is short so a slow Google response
// cannot hold up sign-in: a missing number still creates the account.
var PeopleHTTP = &http.Client{Timeout: 4 * time.Second}

type peoplePhoneResponse struct {
	PhoneNumbers []struct {
		Value         string `json:"value"`
		CanonicalForm string `json:"canonicalForm"`
		Metadata      struct {
			Primary bool `json:"primary"`
		} `json:"metadata"`
	} `json:"phoneNumbers"`
}

/* GooglePhoneNumber reads one phone from the People API.
 *
 * An empty token, a refusal, or a body with no number returns "". The error
 * is only a status or a transport failure — it never includes the token or
 * the number. Callers log it and continue signup.
 */
func GooglePhoneNumber(ctx context.Context, accessToken string) (string, error) {
	accessToken = strings.TrimSpace(accessToken)
	if accessToken == "" {
		return "", nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, PeoplePhoneURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")

	res, err := PeopleHTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()

	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if res.StatusCode != http.StatusOK {
		// Status only. The body can echo the number, and the token is already
		// on the request; neither belongs in an error string.
		return "", fmt.Errorf("people api status %d", res.StatusCode)
	}

	var parsed peoplePhoneResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", err
	}
	return pickPeoplePhone(parsed), nil
}

func pickPeoplePhone(parsed peoplePhoneResponse) string {
	fallback := ""
	for _, number := range parsed.PhoneNumbers {
		candidate := strings.TrimSpace(number.CanonicalForm)
		if candidate == "" {
			candidate = strings.TrimSpace(number.Value)
		}
		if candidate == "" {
			continue
		}
		if number.Metadata.Primary {
			return candidate
		}
		if fallback == "" {
			fallback = candidate
		}
	}
	return fallback
}
