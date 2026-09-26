package api

import (
	"fmt"
	"slices"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* The mention permission matrix, as a pure function.
 *
 * The integration tests in say_test.go prove the relay calls this and persists the
 * result; these prove the rules themselves, one cell at a time, without a database —
 * so they run everywhere, including where TEST_DATABASE_URL is not set.
 */

var mentionRoom = map[string]types.Role{
	"user_host":  types.RoleHost,
	"user_panel": types.RolePanelist,
	"user_co":    types.RolePanelist,
	"att_ana":    types.RoleAttendee,
	"att_bo":     types.RoleAttendee,
}

var (
	fromHost     = wireSender{Identity: "user_host", Name: "Host", Role: types.RoleHost}
	fromPanelist = wireSender{Identity: "user_panel", Name: "Panel", Role: types.RolePanelist}
	fromAttendee = wireSender{Identity: "att_ana", Name: "Ana", Role: types.RoleAttendee}
)

func TestFilterMentionsMatrix(t *testing.T) {
	everyone := types.ChatToEveryone
	panelists := types.ChatToPanelists

	cases := []struct {
		name   string
		from   wireSender
		coHost bool
		hide   bool
		dest   types.ChatDestination
		ask    []string
		want   []string
	}{
		// The stage may mention anyone who can read the message.
		{"host mentions attendee", fromHost, false, false, everyone,
			[]string{"att_bo"}, []string{"att_bo"}},
		{"host mentions attendee while hidden", fromHost, false, true, everyone,
			[]string{"att_bo"}, []string{"att_bo"}},
		{"panelist mentions panelist and attendee", fromPanelist, false, true, everyone,
			[]string{"user_co", "att_bo"}, []string{"user_co", "att_bo"}},

		// The audience may always mention the stage.
		{"attendee mentions host", fromAttendee, false, true, everyone,
			[]string{"user_host"}, []string{"user_host"}},
		{"attendee mentions panelist", fromAttendee, false, false, everyone,
			[]string{"user_panel"}, []string{"user_panel"}},
		// ...and each other only when the audience is visible to itself.
		{"attendee mentions attendee, visible", fromAttendee, false, false, everyone,
			[]string{"att_bo"}, []string{"att_bo"}},
		{"attendee mentions attendee, hidden", fromAttendee, false, true, everyone,
			[]string{"att_bo", "user_host"}, []string{"user_host"}},

		// A panelists-only message can only tag people who will read it.
		{"stage-only message drops attendee", fromHost, false, false, panelists,
			[]string{"att_bo", "user_panel"}, []string{"user_panel"}},
		{"attendee to stage drops attendee", fromAttendee, false, false, panelists,
			[]string{"att_bo", "user_host"}, []string{"user_host"}},

		// @everyone is the host's and a co-host's, nobody else's.
		{"host @everyone", fromHost, false, false, everyone,
			[]string{types.MentionEveryone}, []string{types.MentionEveryone}},
		{"co-host @everyone", fromPanelist, true, false, everyone,
			[]string{types.MentionEveryone}, []string{types.MentionEveryone}},
		{"panelist @everyone dropped", fromPanelist, false, false, everyone,
			[]string{types.MentionEveryone}, nil},
		{"attendee @everyone dropped", fromAttendee, false, false, everyone,
			[]string{types.MentionEveryone}, nil},

		// Anything that is not a person in the room is dropped, not an error.
		{"unknown identity dropped", fromHost, false, false, everyone,
			[]string{"att_ghost", "user_panel"}, []string{"user_panel"}},
		{"self dropped", fromAttendee, false, false, everyone,
			[]string{"att_ana"}, nil},
		{"blanks and duplicates dropped", fromHost, false, false, everyone,
			[]string{"", "  ", "user_panel", "user_panel"}, []string{"user_panel"}},
		{"nothing asked", fromHost, false, false, everyone, nil, nil},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := filterMentions(tc.ask, tc.from, tc.coHost, mentionRoom, tc.hide, tc.dest)
			if !slices.Equal(got, tc.want) {
				t.Errorf("filterMentions(%v) = %v, want %v", tc.ask, got, tc.want)
			}
		})
	}
}

// The cap applies to what SURVIVES, in the order asked: ten invalid entries ahead of a
// valid one must not push the valid one out.
func TestFilterMentionsCap(t *testing.T) {
	people := map[string]types.Role{}
	var ask []string
	for i := range 15 {
		id := fmt.Sprintf("att_%02d", i)
		people[id] = types.RoleAttendee
		ask = append(ask, "att_nobody_"+id, id)
	}
	got := filterMentions(ask, fromHost, false, people, false, types.ChatToEveryone)
	if len(got) != maxMentions {
		t.Fatalf("kept %d mentions, want the cap of %d: %v", len(got), maxMentions, got)
	}
	if got[0] != "att_00" || got[maxMentions-1] != "att_09" {
		t.Errorf("order not preserved: %v", got)
	}
}
