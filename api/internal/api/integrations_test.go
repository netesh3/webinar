package api_test

import (
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

func TestHostIntegrations(t *testing.T) {
	h := newHarness(t)
	res, raw := h.do(http.MethodGet, "/api/host/integrations", nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anon: status %d body %s", res.StatusCode, raw)
	}

	acct := h.signup("Aarti Menon", "integrations@test.dev", true)
	res, raw = h.do(http.MethodGet, "/api/host/integrations", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("list: status %d body %s", res.StatusCode, raw)
	}
	var body types.IntegrationsResponse
	h.decode(raw, &body)
	if len(body.Integrations) < 4 {
		t.Fatalf("got %d cards", len(body.Integrations))
	}
	got := map[string]types.IntegrationCard{}
	for _, c := range body.Integrations {
		got[c.ID] = c
	}
	for _, id := range []string{"whatsapp", "youtube", "linkedin", "telegram"} {
		if _, ok := got[id]; !ok {
			t.Errorf("missing %s", id)
		}
	}
	if got["telegram"].Status != types.IntegrationStatusSoon {
		t.Errorf("telegram = %+v", got["telegram"])
	}
	if got["linkedin"].Status != "off" {
		t.Errorf("linkedin status = %s", got["linkedin"].Status)
	}
	if got["whatsapp"].Status != types.IntegrationStatusOff {
		t.Errorf("whatsapp = %+v", got["whatsapp"])
	}

	if err := h.store.SetUserYouTube(t.Context(), acct.ID, "refresh-token", "UC1", "Aarti Menon Coaching", ""); err != nil {
		t.Fatal(err)
	}
	res, raw = h.do(http.MethodGet, "/api/host/integrations", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("after youtube: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &body)
	var yt types.IntegrationCard
	for _, c := range body.Integrations {
		if c.ID == "youtube" {
			yt = c
		}
	}
	if yt.Status != types.IntegrationStatusConnected || yt.Who != "Aarti Menon Coaching" {
		t.Fatalf("youtube card = %+v", yt)
	}

	res, raw = h.do(http.MethodDelete, "/api/host/integrations/youtube", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("disconnect youtube: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &body)
	for _, c := range body.Integrations {
		if c.ID == "youtube" && c.Status != types.IntegrationStatusOff {
			t.Errorf("youtube still %s after disconnect", c.Status)
		}
	}

	res, raw = h.do(http.MethodDelete, "/api/host/integrations/whatsapp", nil)
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "managed_elsewhere" {
		t.Fatalf("whatsapp disconnect: status %d body %s", res.StatusCode, raw)
	}

	res, raw = h.do(http.MethodPost, "/api/host/integrations/telegram/interest", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("interest: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &body)
	var tg types.IntegrationCard
	for _, c := range body.Integrations {
		if c.ID == "telegram" {
			tg = c
		}
	}
	if !tg.Interested {
		t.Fatalf("telegram interest not stored: %+v", tg)
	}
	res, raw = h.do(http.MethodPost, "/api/host/integrations/telegram/interest", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("interest again: status %d body %s", res.StatusCode, raw)
	}

	res, raw = h.do(http.MethodPost, "/api/host/integrations/linkedin/interest", nil)
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "not_available" {
		t.Fatalf("linkedin interest: status %d body %s", res.StatusCode, raw)
	}

	h.signup("Guest", "integrations-guest@test.dev", false)
	res, raw = h.do(http.MethodGet, "/api/host/integrations", nil)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-host: status %d body %s", res.StatusCode, raw)
	}
}
