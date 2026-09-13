package api

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/types"
)

/* A temporary telemetry sink for one performance-test window.
 *
 * Everywhere else on this server, structured logs go through s.log (slog),
 * which emits a "level" field ("WARN") — the Go standard library's own
 * convention, not Cloud Logging's. Cloud Logging's automatic severity
 * detection specifically looks for a field named "severity" with values like
 * "WARNING" (not "WARN"), so slog's own JSON output would not actually get
 * colour-coded or filterable by severity there. Rather than reconfigure the
 * app-wide logger — every other log line on this server would change shape,
 * for something meant to exist for one test window — this writes its own
 * JSON lines directly to stdout in the shape Cloud Logging expects. Cloud
 * Run already captures and parses stdout as JSON; nothing to configure there.
 *
 * Public and unauthenticated on purpose: an attendee mid-join or mid-drop is
 * exactly the caller with no session to lose, and a "join_attempt" event is
 * meant to be sent before there is anything to authenticate. Rate-limited
 * instead — see telemetryLimit in api.go.
 */

const maxTelemetryEventsPerBatch = 200

func (s *Server) handleTelemetry(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.TelemetryEnabled {
		httpx.Error(w, http.StatusNotFound, "not_found", "Not found.")
		return
	}

	var batch []types.TelemetryEvent
	if err := httpx.DecodeJSON(w, r, &batch); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if len(batch) > maxTelemetryEventsPerBatch {
		httpx.Error(w, http.StatusUnprocessableEntity, "too_many_events",
			"That batch is too large.")
		return
	}

	for _, ev := range batch {
		logTelemetryEvent(ev)
	}
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
}

// logTelemetryEvent writes one Cloud-Logging-structured JSON line. Never
// fails the caller over a malformed field — a metrics pipeline that 500s on
// its own logging is worse than a dropped data point.
func logTelemetryEvent(ev types.TelemetryEvent) {
	entry := map[string]any{
		"severity":   severityFor(ev),
		"message":    "telemetry: " + ev.Event,
		"event":      ev.Event,
		"clientTs":   ev.Timestamp,
		"receivedAt": time.Now().UTC().Format(time.RFC3339Nano),
	}
	if id, ok := stringField(ev.Payload, "userId"); ok {
		entry["userId"] = id
	}
	if room, ok := stringField(ev.Payload, "roomName"); ok {
		entry["roomName"] = room
	}
	if len(ev.Payload) > 0 {
		entry["metrics"] = ev.Payload
	}

	raw, err := json.Marshal(entry)
	if err != nil {
		// The one failure mode worth a fallback: still say something happened,
		// even if the metrics themselves could not be serialised.
		raw, _ = json.Marshal(map[string]any{
			"severity": "WARNING",
			"message":  "telemetry: could not marshal event",
			"event":    ev.Event,
			"error":    err.Error(),
		})
	}
	// Direct to stdout, not s.log: see the file comment for why this needs its
	// own "severity" field rather than slog's "level".
	os.Stdout.Write(append(raw, '\n'))
}

/* severityFor decides WARNING/ERROR the same way regardless of which client
 * sent the event, so two different pages instrumented slightly differently
 * cannot disagree about what counts as a problem.
 *
 * Thresholds match the task this was built for: jitter over 30ms or packet
 * loss over 2% is a WARNING; anything the client itself is calling a failure
 * is an ERROR. Everything else is INFO.
 */
func severityFor(ev types.TelemetryEvent) string {
	lower := strings.ToLower(ev.Event)
	if strings.Contains(lower, "fail") || strings.Contains(lower, "error") {
		return "ERROR"
	}
	if strings.Contains(lower, "reconnect") {
		return "WARNING"
	}
	if jitterMs, ok := numberField(ev.Payload, "jitter"); ok && jitterMs > 30 {
		return "WARNING"
	}
	if lost, lok := numberField(ev.Payload, "packetsLost"); lok {
		if received, rok := numberField(ev.Payload, "packetsReceived"); rok && lost+received > 0 {
			if lossPercent := lost / (lost + received) * 100; lossPercent > 2 {
				return "WARNING"
			}
		}
	}
	return "INFO"
}

// numberField reads a numeric field out of a decoded JSON payload.
// encoding/json decodes every JSON number into a Go float64 when the
// destination is map[string]any, so that is the only type asserted here.
func numberField(payload map[string]any, key string) (float64, bool) {
	v, ok := payload[key].(float64)
	return v, ok
}

func stringField(payload map[string]any, key string) (string, bool) {
	v, ok := payload[key].(string)
	return v, ok
}
