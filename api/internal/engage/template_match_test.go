package engage

import (
	"errors"
	"testing"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

func TestPickTemplateMatchesHowMetaSpellsIt(t *testing.T) {
	list := []types.CRMTemplate{
		{Name: "webinar_reminder_1h", Language: "en_US"},
		{Name: "course_launch", Language: "en_US"},
		{Name: "course_launch", Language: "en_GB"},
	}
	got, err := pickTemplate(list, "Webinar_Reminder_1H", "en")
	if err != nil || got.Language != "en_US" {
		t.Fatalf("en against en_US = %+v %v", got, err)
	}
	got, err = pickTemplate(list, "webinar_reminder_1h", "en-us")
	if err != nil || got.Language != "en_US" {
		t.Fatalf("en-us = %+v %v", got, err)
	}
	got, err = pickTemplate(list, "webinar_reminder_1h", "")
	if err != nil || got.Language != "en_US" {
		t.Fatalf("blank language, one translation = %+v %v", got, err)
	}
	if _, err := pickTemplate(list, "course_launch", "en"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("en against en_US and en_GB err = %v, want not found", err)
	}
	if _, err := pickTemplate(list, "missing", "en_US"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing err = %v", err)
	}
}
