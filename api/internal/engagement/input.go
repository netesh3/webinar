// Package engagement turns one webinar's raw participation — visits, chat, Q&A, polls and
// captured reactions/hands — into the Engagement page's summary and per-attendee scores.
//
// Everything here is pure: the store loads an Input with a handful of set-based queries
// and Compute does the rest in memory, in one pass over each source.
package engagement

import (
	"strings"
	"time"
)

type Webinar struct {
	Slug      string
	Title     string
	HostName  string
	TimeZone  string
	Status    string
	StartedAt *time.Time
	EndedAt   *time.Time
}

type Person struct {
	Identity       string
	Name           string
	Email          string
	RegistrationID string
}

type Visit struct {
	Identity string
	Joined   time.Time
	// Left is nil while the person is still in the room.
	Left *time.Time
}

/* Chat is one message reduced to what scoring needs: who, when, how long and a hash of
 * the body, so duplicates can be spotted without shipping every message's text. */
type Chat struct {
	Identity string
	At       time.Time
	Length   int
	Hash     int64
}

type ChatLine struct {
	Name string
	At   time.Time
	Text string
}

type Question struct {
	ID        string
	Identity  string
	Name      string
	Text      string
	At        time.Time
	Anonymous bool
	Dismissed bool
	Answered  bool
	Upvotes   int
}

type Upvote struct {
	Identity string
	At       time.Time
}

type Poll struct {
	ID       string
	Kind     string
	Question string
	Options  []string
	Correct  *int
	OpenedAt time.Time
	ClosedAt *time.Time
}

type Vote struct {
	PollID   string
	Identity string
	Choice   int
	At       time.Time
}

/* EventCount is captured events already grouped by the database per person, kind, value
 * and minute, so 100k reactions arrive as a few thousand rows. */
type EventCount struct {
	Identity string
	Kind     string
	Value    string
	Minute   int
	Count    int
}

type Input struct {
	Now     time.Time
	Webinar Webinar
	// Registered is registrations that were not declined.
	Registered int
	People     []Person
	Visits     []Visit
	Chats      []Chat
	LatestChat []ChatLine
	Questions  []Question
	Upvotes    []Upvote
	Polls      []Poll
	Votes      []Vote
	Events     []EventCount
	// Extra and ExtraUsage are the plug-in channel for later sources (surveys, ratings):
	// per-identity named signals and which of those tools ran.
	Extra      map[string]map[string]float64
	ExtraUsage Usage
}

// IsAttendee is the audience/stage split every headline figure uses: attendees are
// "att_" identities, the stage is "user_".
func IsAttendee(identity string) bool { return strings.HasPrefix(identity, "att_") }
