package zoom

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseSessionEvent(t *testing.T) {
	ended := []byte(`{"event":"meeting.ended","event_ts":1759332600000,"payload":{"object":{"id":1001,"host_id":"zhost","start_time":"2026-10-01T13:25:00Z","end_time":"2026-10-01T13:30:00Z"}}}`)
	ev, ok := ParseSessionEvent(ended)
	if !ok || ev.Kind != "ended" || ev.Venue != VenueMeeting || ev.MeetingID != "1001" {
		t.Fatalf("ended = %+v ok %v", ev, ok)
	}
	if ev.Start.IsZero() || ev.End.IsZero() || ev.Person != nil {
		t.Fatalf("ended times/person = %+v", ev)
	}

	left := []byte(`{"event":"webinar.participant_left","payload":{"object":{"id":"2002","participant":{"user_name":"Ada","email":"ada@example.test","participant_user_id":"zu","user_id":"mu","registrant_id":"reg","join_time":"2026-10-01T13:25:00Z","leave_time":"2026-10-01T13:30:00Z"}}}}`)
	ev, ok = ParseSessionEvent(left)
	if !ok || ev.Kind != "left" || ev.Venue != VenueWebinar || ev.MeetingID != "2002" || ev.Person == nil {
		t.Fatalf("left = %+v ok %v", ev, ok)
	}
	if ev.Person.Email != "ada@example.test" || ev.Person.ZoomUserID != "zu" || ev.Person.Left.IsZero() {
		t.Fatalf("person = %+v", ev.Person)
	}

	if _, ok := ParseSessionEvent([]byte(`{"event":"recording.completed","payload":{}}`)); ok {
		t.Fatal("recording.completed is acknowledged, not a session event")
	}
}

func TestPastParticipantsPages(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path+"?"+r.URL.RawQuery)
		if r.Header.Get("Authorization") != "Bearer access" {
			t.Errorf("auth = %q", r.Header.Get("Authorization"))
		}
		if r.URL.Query().Get("next_page_token") == "" {
			_, _ = w.Write([]byte(`{"next_page_token":"p2","participants":[{"id":"zhost","user_id":"1","name":"Host","user_email":"h@example.test","join_time":"2026-10-01T13:25:00Z","leave_time":"2026-10-01T13:30:00Z"}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"participants":[{"user_id":"2","name":"Ada","user_email":"ada@example.test","registrant_id":"reg-1","join_time":"2026-10-01T13:26:00Z","leave_time":"2026-10-01T13:29:00Z"}]}`))
	}))
	defer srv.Close()

	c := New("id", "secret")
	c.API = srv.URL
	got, err := c.PastParticipants(context.Background(), "access", VenueWebinar, "2002")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ZoomUserID != "zhost" || got[1].Email != "ada@example.test" || got[1].RegistrantID != "reg-1" {
		t.Fatalf("participants = %+v", got)
	}
	if len(paths) != 2 || paths[0][:len("/past_webinars/2002/participants")] != "/past_webinars/2002/participants" {
		t.Fatalf("paths = %v", paths)
	}
}
