package crmstore

import (
	"errors"
	"strings"
	"testing"
)

func TestPeopleOrderSQLWhitelist(t *testing.T) {
	got, err := PeopleOrderSQL("", "asc; drop table crm_contacts", false)
	if err != nil || got != "coalesce(c.last_seen_at, c.created_at) DESC, c.id DESC" {
		t.Fatalf("default = %q %v", got, err)
	}

	got, err = PeopleOrderSQL("name", "asc", false)
	if err != nil || got != "NULLIF(lower(trim(c.name)), '') ASC NULLS LAST, c.id ASC" {
		t.Fatalf("name = %q %v", got, err)
	}

	got, err = PeopleOrderSQL("attendance", "desc", false)
	if err != nil || !strings.Contains(got, "per.attended_webinars DESC") {
		t.Fatalf("attendance = %q %v", got, err)
	}
	got, err = PeopleOrderSQL("attendance", "desc", true)
	if err != nil || !strings.Contains(got, "per.attended DESC") || strings.Contains(got, "attended_webinars") {
		t.Fatalf("scoped attendance = %q %v", got, err)
	}

	for _, column := range []string{"engagement", "last"} {
		if _, err := PeopleOrderSQL(column, "DESC", false); err != nil {
			t.Errorf("%s: %v", column, err)
		}
	}

	for _, column := range []string{"name; DROP TABLE crm_contacts", "c.id", "last_seen_at"} {
		got, err := PeopleOrderSQL(column, "asc", false)
		if !errors.Is(err, ErrBadSort) || got != "" {
			t.Errorf("column %q: err=%v sql=%q", column, err, got)
		}
	}
	if _, err := PeopleOrderSQL("name", "desc; drop", false); !errors.Is(err, ErrBadSort) {
		t.Fatalf("bad order: %v", err)
	}
}
