// Package httpx holds transport plumbing: JSON rendering, error mapping,
// middleware. Nothing domain-specific lives here.
package httpx

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/netkumar/webcast/api/types"
)

const maxBodyBytes = 1 << 20 // 1 MiB — no endpoint here needs more

// JSON writes v with the given status.
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(v); err != nil {
		// Headers are already sent, so all we can do is record it.
		slog.Error("encode response", "error", err)
	}
}

// Error writes a structured error. `code` is a stable machine-readable slug;
// `msg` is safe to show a user.
func Error(w http.ResponseWriter, status int, code, msg string) {
	JSON(w, status, types.APIError{Error: code, Message: msg})
}

// Fields writes a validation failure with per-field messages.
func Fields(w http.ResponseWriter, fields map[string]string) {
	JSON(w, http.StatusUnprocessableEntity, types.APIError{
		Error:   "validation_failed",
		Message: "Some fields need attention.",
		Fields:  fields,
	})
}

var ErrBodyTooLarge = errors.New("request body too large")

// DecodeJSON reads a JSON body with a size cap and rejects unknown fields, so a
// typo in a client payload surfaces as an error rather than being ignored.
func DecodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	// Exactly one JSON value per request.
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		return errors.New("body must contain a single JSON object")
	}
	return nil
}
