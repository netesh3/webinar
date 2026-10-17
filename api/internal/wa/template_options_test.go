package wa

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

/* Every template shape the editor offers, pinned against the payload Meta documents for
 * it: what message_templates is sent to create one, and what /messages is sent to send
 * one. A field Meta does not know is a refused template, and a field in the wrong place
 * is a send that fails for every recipient, so these compare whole components. */

// captured posts nt to a fake Graph and returns the components it received, as JSON.
func createComponents(t *testing.T, nt NewTemplate) []any {
	t.Helper()
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		writeJSON(w, map[string]any{"id": "1", "status": "PENDING"})
	}))
	defer srv.Close()
	if nt.Name == "" {
		nt.Name = "wl_own_x"
	}
	if _, err := newTestClient(srv.URL).CreateTemplate(context.Background(), "tok", "waba", nt); err != nil {
		t.Fatalf("CreateTemplate: %v", err)
	}
	if body["language"] != nt.Language || body["category"] != nt.Category {
		t.Errorf("language/category = %v/%v, want %s/%s", body["language"], body["category"], nt.Language, nt.Category)
	}
	comps, _ := body["components"].([]any)
	return comps
}

func sendComponents(t *testing.T, msg OutgoingTemplate) []any {
	t.Helper()
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		writeJSON(w, map[string]any{"messages": []map[string]string{{"id": "wamid.T"}}})
	}))
	defer srv.Close()
	if msg.To == "" {
		msg.To = "+27831112222"
	}
	if _, err := newTestClient(srv.URL).SendTemplate(context.Background(), "tok", "p1", msg); err != nil {
		t.Fatalf("SendTemplate: %v", err)
	}
	tmpl, _ := body["template"].(map[string]any)
	if lang, _ := tmpl["language"].(map[string]any); lang["code"] != msg.Language {
		t.Errorf("language = %v, want %s", tmpl["language"], msg.Language)
	}
	comps, _ := tmpl["components"].([]any)
	return comps
}

// same compares got with the JSON want, ignoring key order.
func same(t *testing.T, what string, got any, want string) {
	t.Helper()
	var w any
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatalf("%s: bad want: %v", what, err)
	}
	g, _ := json.Marshal(got)
	ww, _ := json.Marshal(w)
	if string(g) != string(ww) {
		t.Errorf("%s:\n got %s\nwant %s", what, g, ww)
	}
}

func TestCreateAuthenticationTemplate(t *testing.T) {
	comps := createComponents(t, NewTemplate{Language: "en", Category: "AUTHENTICATION",
		Auth: &NewAuth{SecurityRecommendation: true, ExpirationMinutes: 10, ButtonText: "Copy code"}})
	same(t, "auth", comps, `[
		{"type":"BODY","add_security_recommendation":true},
		{"type":"FOOTER","code_expiration_minutes":10},
		{"type":"BUTTONS","buttons":[{"type":"OTP","otp_type":"COPY_CODE","text":"Copy code"}]}]`)

	bare := createComponents(t, NewTemplate{Language: "hi", Category: "AUTHENTICATION", Auth: &NewAuth{}})
	same(t, "auth with no options", bare, `[
		{"type":"BODY"},
		{"type":"BUTTONS","buttons":[{"type":"OTP","otp_type":"COPY_CODE"}]}]`)
}

func TestCreateStandardWithPhoneCouponAndFooter(t *testing.T) {
	comps := createComponents(t, NewTemplate{Language: "ta", Category: "MARKETING",
		Body: "Hi {{1}}", Examples: []string{"Priya"}, Footer: "Reply STOP to opt out",
		Buttons: []NewButton{
			{Type: "QUICK_REPLY", Text: "Yes"},
			{Type: "QUICK_REPLY", Text: "No"},
			{Type: "PHONE_NUMBER", Text: "Call us", PhoneNumber: "+919876543210"},
			{Type: "COPY_CODE", Example: "SAVE20"},
			{Type: "URL", Text: "Open", URL: "https://x.com/{{1}}", Example: "https://x.com/a"},
		}})
	same(t, "standard", comps, `[
		{"type":"BODY","text":"Hi {{1}}","example":{"body_text":[["Priya"]]}},
		{"type":"FOOTER","text":"Reply STOP to opt out"},
		{"type":"BUTTONS","buttons":[
			{"type":"QUICK_REPLY","text":"Yes"},
			{"type":"QUICK_REPLY","text":"No"},
			{"type":"PHONE_NUMBER","text":"Call us","phone_number":"+919876543210"},
			{"type":"COPY_CODE","example":"SAVE20"},
			{"type":"URL","text":"Open","url":"https://x.com/{{1}}","example":["https://x.com/a"]}]}]`)
}

func TestCreateLimitedTimeOffer(t *testing.T) {
	comps := createComponents(t, NewTemplate{Language: "en", Category: "MARKETING",
		Header: &NewHeader{Format: "IMAGE", Handle: "h:1"},
		Body:   "Last seats for the masterclass.", Footer: "ignored on an offer",
		Offer:   &NewOffer{Text: "20% off", HasExpiration: true},
		Buttons: []NewButton{{Type: "COPY_CODE", Example: "SAVE20"}, {Type: "URL", Text: "Book", URL: "https://x.com/b"}}})
	same(t, "offer", comps, `[
		{"type":"HEADER","format":"IMAGE","example":{"header_handle":["h:1"]}},
		{"type":"LIMITED_TIME_OFFER","limited_time_offer":{"text":"20% off","has_expiration":true}},
		{"type":"BODY","text":"Last seats for the masterclass."},
		{"type":"BUTTONS","buttons":[
			{"type":"COPY_CODE","example":"SAVE20"},
			{"type":"URL","text":"Book","url":"https://x.com/b"}]}]`)
}

func TestCreateCarousel(t *testing.T) {
	card := func(h, body string) NewCard {
		return NewCard{HeaderFormat: "IMAGE", Handle: h, Body: body, Buttons: []NewButton{
			{Type: "QUICK_REPLY", Text: "Tell me more"}, {Type: "URL", Text: "Book", URL: "https://x.com/b"}}}
	}
	comps := createComponents(t, NewTemplate{Language: "en", Category: "MARKETING",
		Body: "Three courses for {{1}}", Examples: []string{"Priya"}, Footer: "dropped",
		Cards: []NewCard{card("h:1", "Yoga"), card("h:2", "Breath")}})
	cardJSON := func(h, body string) string {
		return `{"components":[
			{"type":"HEADER","format":"IMAGE","example":{"header_handle":["` + h + `"]}},
			{"type":"BODY","text":"` + body + `"},
			{"type":"BUTTONS","buttons":[{"type":"QUICK_REPLY","text":"Tell me more"},{"type":"URL","text":"Book","url":"https://x.com/b"}]}]}`
	}
	same(t, "carousel", comps, `[
		{"type":"BODY","text":"Three courses for {{1}}","example":{"body_text":[["Priya"]]}},
		{"type":"CAROUSEL","cards":[`+cardJSON("h:1", "Yoga")+`,`+cardJSON("h:2", "Breath")+`]}]`)

	if _, err := (NewTemplate{Body: "x", Cards: []NewCard{{HeaderFormat: "IMAGE"}}}).components(); err == nil {
		t.Errorf("a card with no sample handle must not reach Meta")
	}
}

func TestSendAuthCode(t *testing.T) {
	comps := sendComponents(t, AuthCodeTemplate("+27831112222", "wl_otp", "en", "482913"))
	same(t, "auth send", comps, `[
		{"type":"body","parameters":[{"type":"text","text":"482913"}]},
		{"type":"button","sub_type":"url","index":"0","parameters":[{"type":"text","text":"482913"}]}]`)
}

func TestSendCouponOfferAndCarousel(t *testing.T) {
	ends := time.Date(2026, 11, 1, 18, 30, 0, 0, time.UTC)
	comps := sendComponents(t, OutgoingTemplate{Name: "wl_own_a", Language: "hi",
		HeaderMedia:    &HeaderMedia{Type: "image", Link: "https://a.com/i.jpg"},
		OfferExpiresAt: ends,
		Coupon:         &CouponParam{Index: 0, Code: "SAVE20"},
		URLButtons:     []URLButtonParam{{Index: 1, Suffix: "r/1"}},
	})
	same(t, "offer send", comps, `[
		{"type":"header","parameters":[{"type":"image","image":{"link":"https://a.com/i.jpg"}}]},
		{"type":"limited_time_offer","parameters":[{"type":"limited_time_offer","limited_time_offer":{"expiration_time_ms":`+
		jsonInt(ends.UnixMilli())+`}}]},
		{"type":"button","sub_type":"url","index":"1","parameters":[{"type":"text","text":"r/1"}]},
		{"type":"button","sub_type":"copy_code","index":0,"parameters":[{"type":"coupon_code","coupon_code":"SAVE20"}]}]`)

	cards := sendComponents(t, OutgoingTemplate{Name: "wl_own_c", Language: "en", BodyParams: []string{"Priya"},
		Cards: []OutgoingCard{
			{HeaderMedia: &HeaderMedia{Type: "image", Link: "https://a.com/1.jpg"},
				QuickReplies: []QuickReplyParam{{Index: 0, Payload: "Tell me more"}}},
			{HeaderMedia: &HeaderMedia{Type: "image", Link: "https://a.com/2.jpg"},
				QuickReplies: []QuickReplyParam{{Index: 0, Payload: "Tell me more"}}},
		}})
	card := func(i, link string) string {
		return `{"card_index":` + i + `,"components":[
			{"type":"header","parameters":[{"type":"image","image":{"link":"` + link + `"}}]},
			{"type":"button","sub_type":"quick_reply","index":0,"parameters":[{"type":"payload","payload":"Tell me more"}]}]}`
	}
	same(t, "carousel send", cards, `[
		{"type":"body","parameters":[{"type":"text","text":"Priya"}]},
		{"type":"carousel","cards":[`+card("0", "https://a.com/1.jpg")+`,`+card("1", "https://a.com/2.jpg")+`]}]`)
}

func jsonInt(n int64) string { b, _ := json.Marshal(n); return string(b) }

func TestReadTemplateOptions(t *testing.T) {
	auth := readTemplate(graphTemplateFromJSON(t, `{"name":"wl_otp","language":"en","status":"APPROVED","category":"AUTHENTICATION",
		"components":[{"type":"BODY","text":"{{1}} is your verification code.","add_security_recommendation":true},
			{"type":"FOOTER","text":"This code expires in 10 minutes.","code_expiration_minutes":10},
			{"type":"BUTTONS","buttons":[{"type":"OTP","otp_type":"COPY_CODE","text":"Copy code"}]}]}`))
	if auth.Auth == nil || !auth.Auth.SecurityRecommendation || auth.Auth.ExpirationMinutes != 10 || auth.Unsupported != "" {
		t.Errorf("auth = %+v", auth)
	}
	oneTap := readTemplate(graphTemplateFromJSON(t, `{"name":"x","language":"en","status":"APPROVED","category":"AUTHENTICATION",
		"components":[{"type":"BODY"},{"type":"BUTTONS","buttons":[{"type":"OTP","otp_type":"ONE_TAP"}]}]}`))
	if oneTap.Unsupported == "" {
		t.Errorf("one-tap needs an Android app and must be unsupported")
	}

	lto := readTemplate(graphTemplateFromJSON(t, `{"name":"o","language":"en","status":"APPROVED","category":"MARKETING",
		"components":[{"type":"LIMITED_TIME_OFFER","limited_time_offer":{"text":"20% off","has_expiration":true}},
			{"type":"BODY","text":"Seats"},
			{"type":"BUTTONS","buttons":[{"type":"COPY_CODE","example":["SAVE20"]},{"type":"PHONE_NUMBER","text":"Call","phone_number":"+919876543210"}]}]}`))
	if lto.Unsupported != "" || lto.Offer == nil || lto.Offer.Text != "20% off" || !lto.Offer.HasExpiration ||
		len(lto.Buttons) != 2 || lto.Buttons[0].Example != "SAVE20" || lto.Buttons[1].PhoneNumber != "+919876543210" {
		t.Errorf("offer = %+v", lto)
	}

	car := readTemplate(graphTemplateFromJSON(t, `{"name":"c","language":"en","status":"APPROVED","category":"MARKETING",
		"components":[{"type":"BODY","text":"Pick one"},{"type":"CAROUSEL","cards":[
			{"components":[{"type":"HEADER","format":"VIDEO"},{"type":"BODY","text":"A"},{"type":"BUTTONS","buttons":[{"type":"QUICK_REPLY","text":"More"}]}]},
			{"components":[{"type":"HEADER","format":"VIDEO"},{"type":"BODY","text":"B"},{"type":"BUTTONS","buttons":[{"type":"QUICK_REPLY","text":"More"}]}]}]}]}`))
	if car.Unsupported != "" || len(car.Cards) != 2 || car.Cards[1].HeaderFormat != "VIDEO" || car.Cards[1].Body != "B" ||
		len(car.Cards[0].Buttons) != 1 {
		t.Errorf("carousel = %+v", car)
	}
}
