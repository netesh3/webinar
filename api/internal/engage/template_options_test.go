package engage

import (
	"errors"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* The editor's rules, checked before Meta sees a template: each one is a template Meta
 * would refuse (or charge differently), so each is pinned with the code the editor shows. */

const testBase = "https://webinarliv.com"

func str(s string) *string { return &s }

func card(body string, buttons ...types.CRMButtonInput) types.CRMCardInput {
	return types.CRMCardInput{FileID: "f-" + body, Body: body, Buttons: buttons}
}

func qr(text string) types.CRMButtonInput {
	return types.CRMButtonInput{Type: "QUICK_REPLY", Text: text}
}

func TestPlanWordingAccepts(t *testing.T) {
	// Standard marketing: the opt-out footer is kept unless removed; language passes through.
	p, err := planWording(types.CRMWordingRequest{Body: "Hi {{1}}", Category: "marketing", Language: "ta"}, testBase)
	if err != nil || p.tmpl.Footer != defaultFooter || p.tmpl.Language != "ta" || p.tmpl.Category != "MARKETING" ||
		len(p.tmpl.Examples) != 1 {
		t.Fatalf("standard = %+v, %v", p.tmpl, err)
	}
	p, _ = planWording(types.CRMWordingRequest{Body: "Hi", Footer: str("")}, testBase)
	if p.tmpl.Footer != "" || p.tmpl.Language != "en" || p.tmpl.Category != "UTILITY" {
		t.Errorf("an emptied footer is removed; defaults en/UTILITY: %+v", p.tmpl)
	}

	// Authentication: Meta's own text, options only.
	p, err = planWording(types.CRMWordingRequest{Category: "AUTHENTICATION",
		Auth: &types.CRMAuthInput{SecurityRecommendation: true, ExpirationMinutes: 10}}, testBase)
	if err != nil || p.tmpl.Auth == nil || p.tmpl.Auth.ExpirationMinutes != 10 || p.tmpl.Body != "" {
		t.Fatalf("auth = %+v, %v", p.tmpl, err)
	}

	// Limited-time offer: footer dropped, coupon remembered.
	p, err = planWording(types.CRMWordingRequest{Category: "MARKETING", Body: "Seats",
		Offer:   &types.CRMOfferInput{Text: "20% off", HasExpiration: true},
		Buttons: []types.CRMButtonInput{{Type: "COPY_CODE", Code: "SAVE20"}}}, testBase)
	if err != nil || p.tmpl.Offer == nil || p.tmpl.Footer != "" || p.coupon != "SAVE20" ||
		p.tmpl.Buttons[0].Example != "SAVE20" {
		t.Fatalf("offer = %+v %q, %v", p.tmpl, p.coupon, err)
	}

	// Carousel.
	p, err = planWording(types.CRMWordingRequest{Category: "MARKETING", Body: "Pick", CardAspect: "wide",
		Cards: []types.CRMCardInput{card("A", qr("More")), card("B", qr("More"))}}, testBase)
	if err != nil || len(p.tmpl.Cards) != 2 || p.cardAspect != "wide" || len(p.cardFileIDs) != 2 || p.tmpl.Footer != "" {
		t.Fatalf("carousel = %+v, %v", p, err)
	}

	// Phone number is normalised; a dynamic link on this app gets a room-link example.
	p, err = planWording(types.CRMWordingRequest{Body: "Hi", Buttons: []types.CRMButtonInput{
		{Type: "PHONE_NUMBER", Text: "Call", PhoneNumber: "+91 98765-43210"},
		{Type: "URL", Text: "Join", URL: testBase + "/{{1}}"}}}, testBase)
	if err != nil || p.tmpl.Buttons[0].PhoneNumber != "+919876543210" ||
		!strings.HasPrefix(p.tmpl.Buttons[1].Example, testBase+"/webinars/") {
		t.Fatalf("buttons = %+v, %v", p.tmpl.Buttons, err)
	}
}

func TestPlanWordingRefuses(t *testing.T) {
	many := make([]types.CRMButtonInput, 11)
	for i := range many {
		many[i] = qr("x")
	}
	long := strings.Repeat("a", 601)
	cases := []struct {
		name string
		req  types.CRMWordingRequest
		code string
	}{
		{"unknown category", types.CRMWordingRequest{Body: "x", Category: "PROMO"}, "invalid_category"},
		{"unknown language", types.CRMWordingRequest{Body: "x", Language: "xx"}, "invalid_language"},
		{"auth with text", types.CRMWordingRequest{Category: "AUTHENTICATION", Body: "Your code"}, "invalid_auth"},
		{"auth expiry over 90", types.CRMWordingRequest{Category: "AUTHENTICATION", Auth: &types.CRMAuthInput{ExpirationMinutes: 91}}, "invalid_auth"},
		{"auth outside its category", types.CRMWordingRequest{Category: "UTILITY", Auth: &types.CRMAuthInput{}}, "invalid_category"},
		{"footer too long", types.CRMWordingRequest{Body: "x", Footer: str(strings.Repeat("f", 61))}, "invalid_footer"},
		{"footer with a blank", types.CRMWordingRequest{Body: "x", Footer: str("Hi {{1}}")}, "invalid_footer"},
		{"eleven buttons", types.CRMWordingRequest{Body: "x", Buttons: many}, "invalid_buttons"},
		{"quick replies split", types.CRMWordingRequest{Body: "x", Buttons: []types.CRMButtonInput{
			qr("a"), {Type: "URL", Text: "Go", URL: "https://a.com"}, qr("b")}}, "invalid_buttons"},
		{"two phones", types.CRMWordingRequest{Body: "x", Buttons: []types.CRMButtonInput{
			{Type: "PHONE_NUMBER", Text: "a", PhoneNumber: "+919876543210"},
			{Type: "PHONE_NUMBER", Text: "b", PhoneNumber: "+919876543211"}}}, "invalid_buttons"},
		{"phone without country code", types.CRMWordingRequest{Body: "x", Buttons: []types.CRMButtonInput{
			{Type: "PHONE_NUMBER", Text: "a", PhoneNumber: "98765 43210"}}}, "invalid_buttons"},
		{"phone text over 20", types.CRMWordingRequest{Body: "x", Buttons: []types.CRMButtonInput{
			{Type: "PHONE_NUMBER", Text: strings.Repeat("c", 21), PhoneNumber: "+919876543210"}}}, "invalid_buttons"},
		{"coupon with symbols", types.CRMWordingRequest{Body: "x", Buttons: []types.CRMButtonInput{
			{Type: "COPY_CODE", Code: "SAVE-20"}}}, "invalid_buttons"},
		{"three links", types.CRMWordingRequest{Body: "x", Buttons: []types.CRMButtonInput{
			{Type: "URL", Text: "a", URL: "https://a.com"}, {Type: "URL", Text: "b", URL: "https://b.com"},
			{Type: "URL", Text: "c", URL: "https://c.com"}}}, "invalid_buttons"},
		{"blank mid-link", types.CRMWordingRequest{Body: "x", Buttons: []types.CRMButtonInput{
			{Type: "URL", Text: "a", URL: "https://a.com/{{1}}/x"}}}, "invalid_buttons"},
		{"offer on utility", types.CRMWordingRequest{Body: "x", Category: "UTILITY",
			Offer: &types.CRMOfferInput{Text: "Off"}, Buttons: []types.CRMButtonInput{{Type: "COPY_CODE", Code: "A"}}}, "invalid_offer"},
		{"offer text over 16", types.CRMWordingRequest{Body: "x", Category: "MARKETING",
			Offer: &types.CRMOfferInput{Text: strings.Repeat("o", 17)}, Buttons: []types.CRMButtonInput{{Type: "COPY_CODE", Code: "A"}}}, "invalid_offer"},
		{"offer with no action", types.CRMWordingRequest{Body: "x", Category: "MARKETING",
			Offer: &types.CRMOfferInput{Text: "Off"}, Buttons: []types.CRMButtonInput{qr("ok")}}, "invalid_offer"},
		{"offer body over 600", types.CRMWordingRequest{Body: long, Category: "MARKETING",
			Offer: &types.CRMOfferInput{Text: "Off"}, Buttons: []types.CRMButtonInput{{Type: "COPY_CODE", Code: "A"}}}, "invalid_body"},
		{"offer document header", types.CRMWordingRequest{Body: "x", Category: "MARKETING",
			Header: &types.CRMTemplateHeaderInput{Format: "DOCUMENT"},
			Offer:  &types.CRMOfferInput{Text: "Off"}, Buttons: []types.CRMButtonInput{{Type: "COPY_CODE", Code: "A"}}}, "invalid_header"},
		{"one card", types.CRMWordingRequest{Body: "x", Category: "MARKETING", CardAspect: "square",
			Cards: []types.CRMCardInput{card("A")}}, "invalid_cards"},
		{"carousel on utility", types.CRMWordingRequest{Body: "x", CardAspect: "square",
			Cards: []types.CRMCardInput{card("A"), card("B")}}, "invalid_cards"},
		{"cards of different shapes", types.CRMWordingRequest{Body: "x", Category: "MARKETING", CardAspect: "square",
			Cards: []types.CRMCardInput{card("A", qr("More")), card("B")}}, "invalid_cards"},
		{"card text over 160", types.CRMWordingRequest{Body: "x", Category: "MARKETING", CardAspect: "square",
			Cards: []types.CRMCardInput{card(strings.Repeat("c", 161)), card("B")}}, "invalid_cards"},
		{"three card buttons", types.CRMWordingRequest{Body: "x", Category: "MARKETING", CardAspect: "square",
			Cards: []types.CRMCardInput{card("A", qr("1"), qr("2"), qr("3")), card("B", qr("1"), qr("2"), qr("3"))}}, "invalid_cards"},
		{"carousel with no shape", types.CRMWordingRequest{Body: "x", Category: "MARKETING",
			Cards: []types.CRMCardInput{card("A"), card("B")}}, "invalid_cards"},
		{"card without a picture", types.CRMWordingRequest{Body: "x", Category: "MARKETING", CardAspect: "square",
			Cards: []types.CRMCardInput{{Body: "A"}, card("B")}}, "invalid_cards"},
	}
	for _, c := range cases {
		_, err := planWording(c.req, testBase)
		var we wordingError
		if !errors.As(err, &we) || we.code != c.code {
			t.Errorf("%s: err = %v, want code %s", c.name, err, c.code)
		}
	}
}
