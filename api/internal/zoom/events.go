package zoom

import (
	"encoding/json"
	"strings"
	"time"
)

/* Participant is one person Zoom reported in a meeting or webinar.
 *
 * Email and the display name are attendance data. Callers must not log them.
 * ZoomUserID is the person's Zoom account id when they are signed in.
 * MeetingUserID is Zoom's id for this stay and is only stable inside it.
 */
type Participant struct {
	Name          string
	Email         string
	RegistrantID  string
	ZoomUserID    string
	MeetingUserID string
	Joined        time.Time
	Left          time.Time
}

/* SessionEvent is a join, a leave, or the end of a Zoom meeting or webinar.
 *
 * Person is set for join and leave. An end has no person; the attendance
 * list is a separate read of Zoom's past-participant API.
 */
type SessionEvent struct {
	Kind         string
	Venue        string
	MeetingID    string
	HostZoomUser string
	Start        time.Time
	End          time.Time
	Person       *Participant
}

/* ParseSessionEvent reports whether this body is a session event we act on.
 *
 * recording.completed, the URL check, and deauthorization are not session
 * events. A body that is not JSON is not one either.
 */
func ParseSessionEvent(body []byte) (SessionEvent, bool) {
	var env struct {
		Event   string `json:"event"`
		EventTS int64  `json:"event_ts"`
		Payload struct {
			Object struct {
				ID          zoomID `json:"id"`
				HostID      string `json:"host_id"`
				StartTime   string `json:"start_time"`
				EndTime     string `json:"end_time"`
				Participant *struct {
					UserID            string `json:"user_id"`
					UserName          string `json:"user_name"`
					ParticipantUserID string `json:"participant_user_id"`
					Email             string `json:"email"`
					RegistrantID      string `json:"registrant_id"`
					JoinTime          string `json:"join_time"`
					LeaveTime         string `json:"leave_time"`
				} `json:"participant"`
			} `json:"object"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return SessionEvent{}, false
	}
	kind, venue, ok := sessionKind(env.Event)
	if !ok {
		return SessionEvent{}, false
	}
	ev := SessionEvent{
		Kind:         kind,
		Venue:        venue,
		MeetingID:    strings.TrimSpace(env.Payload.Object.ID.String()),
		HostZoomUser: strings.TrimSpace(env.Payload.Object.HostID),
		Start:        parseZoomTime(env.Payload.Object.StartTime),
		End:          parseZoomTime(env.Payload.Object.EndTime),
	}
	if ev.End.IsZero() && env.EventTS > 0 {
		ev.End = time.UnixMilli(env.EventTS).UTC()
	}
	p := env.Payload.Object.Participant
	if p == nil || kind == "ended" {
		return ev, true
	}
	person := Participant{
		Name:          strings.TrimSpace(p.UserName),
		Email:         strings.TrimSpace(p.Email),
		RegistrantID:  strings.TrimSpace(p.RegistrantID),
		ZoomUserID:    strings.TrimSpace(p.ParticipantUserID),
		MeetingUserID: strings.TrimSpace(p.UserID),
		Joined:        parseZoomTime(p.JoinTime),
		Left:          parseZoomTime(p.LeaveTime),
	}
	if kind == "left" && person.Left.IsZero() {
		person.Left = ev.End
	}
	ev.Person = &person
	return ev, true
}

func sessionKind(event string) (kind, venue string, ok bool) {
	switch event {
	case "meeting.participant_joined":
		return "joined", VenueMeeting, true
	case "meeting.participant_left":
		return "left", VenueMeeting, true
	case "meeting.ended":
		return "ended", VenueMeeting, true
	case "webinar.participant_joined":
		return "joined", VenueWebinar, true
	case "webinar.participant_left":
		return "left", VenueWebinar, true
	case "webinar.ended":
		return "ended", VenueWebinar, true
	default:
		return "", "", false
	}
}

func parseZoomTime(raw string) time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t.UTC()
	}
	if t, err := time.Parse("2006-01-02T15:04:05Z", raw); err == nil {
		return t.UTC()
	}
	return time.Time{}
}
