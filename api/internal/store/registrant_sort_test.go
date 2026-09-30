package store

import (
	"errors"
	"strings"
	"testing"
)

func TestRegistrantOrderSQLWhitelist(t *testing.T) {
	join, order, err := RegistrantOrderSQL("", true)
	if err != nil || join != "" || order != "r.created_at DESC, r.id DESC" {
		t.Fatalf("default order = %q %q %v", join, order, err)
	}

	_, order, err = RegistrantOrderSQL("name", false)
	if err != nil || order != "NULLIF(lower(trim(r.first_name || ' ' || r.last_name)), '') ASC NULLS LAST, r.id ASC" {
		t.Fatalf("name asc = %q %v", order, err)
	}
	_, order, err = RegistrantOrderSQL("NAME", true)
	if err != nil || !strings.Contains(order, " DESC ") {
		t.Fatalf("name desc = %q %v", order, err)
	}

	join, order, err = RegistrantOrderSQL("watched", true)
	if err != nil || !strings.Contains(join, "attendance") || !strings.Contains(order, "wt.watch_min DESC") {
		t.Fatalf("watched = join %q order %q err %v", join, order, err)
	}
	if strings.Contains(join, "watched") {
		t.Fatalf("column key leaked into SQL: %s", join)
	}

	for _, column := range []string{"company", "status", "registered"} {
		if _, _, err := RegistrantOrderSQL(column, false); err != nil {
			t.Errorf("%s: %v", column, err)
		}
	}

	for _, column := range []string{"name; DROP TABLE registrations", "watched)", "id", "r.created_at"} {
		_, order, err := RegistrantOrderSQL(column, false)
		if !errors.Is(err, ErrInvalid) || order != "" {
			t.Errorf("%q: err=%v order=%q", column, err, order)
		}
	}
}
