package integrations

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

func TestCatalogue(t *testing.T) {
	reg := New(nil, true, nil)
	cards, err := reg.List(context.Background(), store.User{})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"whatsapp", "telegram", "youtube", "linkedin", "google-calendar", "instagram", "mailchimp", "zapier"}
	if len(cards) != len(want) {
		t.Fatalf("got %d cards, want %d", len(cards), len(want))
	}
	for i, id := range want {
		if cards[i].ID != id {
			t.Errorf("card %d = %s, want %s", i, cards[i].ID, id)
		}
	}

	by := map[string]types.IntegrationCard{}
	for _, c := range cards {
		by[c.ID] = c
	}
	if by["whatsapp"].Status != types.IntegrationStatusOff || by["whatsapp"].Category != types.IntegrationCategoryMessaging {
		t.Errorf("whatsapp = %+v", by["whatsapp"])
	}
	if by["telegram"].Status != types.IntegrationStatusSoon {
		t.Errorf("telegram status = %s", by["telegram"].Status)
	}
	if !strings.Contains(by["linkedin"].Detail, "stream key") || by["linkedin"].Status == types.IntegrationStatusSoon {
		t.Errorf("linkedin should say the stream key is how you connect, got %+v", by["linkedin"])
	}
	if by["youtube"].Actions[0].Kind != types.IntegrationActionRedirect {
		t.Errorf("youtube connect = %+v", by["youtube"].Actions)
	}
	if by["google-calendar"].Category != types.IntegrationCategorySoon {
		t.Errorf("calendar category = %s", by["google-calendar"].Category)
	}
}

func TestWhatsAppConnectedCard(t *testing.T) {
	exp := time.Now().Add(52*24*time.Hour + time.Hour)
	reg := New(nil, false, nil)
	cards, err := reg.List(context.Background(), store.User{
		WhatsAppToken:          "tok",
		WhatsAppDisplayPhone:   "+91 98200 11223",
		WhatsAppVerifiedName:   "Aarti Menon Coaching",
		WhatsAppTokenExpiresAt: &exp,
	})
	if err != nil {
		t.Fatal(err)
	}
	wa := cards[0]
	if wa.Status != types.IntegrationStatusConnected || wa.Who != "+91 98200 11223" {
		t.Fatalf("card = %+v", wa)
	}
	if wa.Warn != "Reconnect in 52 days" {
		t.Errorf("warn = %q", wa.Warn)
	}
	var manage, disconnect bool
	for _, a := range wa.Actions {
		if a.ID == "manage" && a.Href == "/host/crm" && !a.Menu {
			manage = true
		}
		if a.ID == "disconnect" && a.Href == "/api/host/whatsapp" && a.Menu {
			disconnect = true
		}
	}
	if !manage || !disconnect {
		t.Errorf("actions = %+v", wa.Actions)
	}
	if err := reg.Disconnect(context.Background(), store.User{}, "whatsapp"); err != ErrManagedByCRM {
		t.Errorf("disconnect = %v, want ErrManagedByCRM", err)
	}
}

func TestYouTubeWithoutOAuth(t *testing.T) {
	reg := New(nil, false, nil)
	cards, err := reg.List(context.Background(), store.User{})
	if err != nil {
		t.Fatal(err)
	}
	yt := cards[2]
	if yt.Actions[0].Kind != types.IntegrationActionInfo || !strings.Contains(yt.Detail, "stream key") {
		t.Errorf("youtube without oauth = %+v", yt)
	}
}

func TestInterestOnlyOnSoonNotify(t *testing.T) {
	reg := New(nil, true, nil)
	user := store.User{ID: "u"}
	if err := reg.RecordInterest(context.Background(), user, "youtube"); err != ErrUnavailable {
		t.Errorf("youtube interest = %v", err)
	}
	if err := reg.RecordInterest(context.Background(), user, "missing"); err != ErrNotFound {
		t.Errorf("missing = %v", err)
	}
}
