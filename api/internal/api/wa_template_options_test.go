package api_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* The template editor's options end to end: what Meta is sent to create each shape,
 * what a broadcast sends for it, and how images are made acceptable on upload. */

func testJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := range img.Pix {
		img.Pix[i] = 180
	}
	img.Set(0, 0, color.RGBA{255, 0, 0, 255})
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func lastCreated(t *testing.T, g *fakeGraph) map[string]any {
	t.Helper()
	c := g.createdTemplates()
	if len(c) == 0 {
		t.Fatal("nothing submitted to Meta")
	}
	return c[len(c)-1]
}

func jsonOf(v any) string { b, _ := json.Marshal(v); return string(b) }

func sendComponentsOf(send map[string]any) []any {
	comps, _ := send["template"].(map[string]any)["components"].([]any)
	return comps
}

func componentTyped(comps []any, typ string) map[string]any {
	for _, c := range comps {
		if m := c.(map[string]any); m["type"] == typ {
			return m
		}
	}
	return nil
}

func TestTemplateImagesAreProcessedOnUpload(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)

	in := testJPEG(t, 3200, 1200)
	code, f, raw := uploadMedia(t, h, "image/jpeg", "Camera roll.jpeg", in)
	if code != http.StatusCreated || f.Kind != "image" || f.MimeType != "image/jpeg" ||
		f.Width != 1600 || f.Height != 600 || f.OriginalBytes != int64(len(in)) || f.Filename != "Camera roll.jpg" {
		t.Fatalf("upload: %d %+v %s", code, f, raw)
	}
	res, body := h.doRaw(http.MethodGet, publicPath(t, f.URL), "", nil, nil)
	if res.StatusCode != http.StatusOK || int64(len(body)) != f.Bytes {
		t.Fatalf("stored file: %d, %d bytes", res.StatusCode, len(body))
	}
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(body)); err != nil || cfg.Width != 1600 {
		t.Errorf("served image = %+v %v, want the processed 1600 wide", cfg, err)
	}

	// Card shapes.
	if _, sq, _ := uploadMedia(t, h, "image/jpeg", "a.jpg?", in); sq.Width == sq.Height {
		t.Errorf("no aspect asked, none applied: %dx%d", sq.Width, sq.Height)
	}
	res, raw = h.doRaw(http.MethodPost, "/api/host/crm/media?aspect=square&filename=a.jpg", "image/jpeg", in, nil)
	var sq types.CRMMediaFile
	h.decode(raw, &sq)
	if res.StatusCode != http.StatusCreated || sq.Width != sq.Height {
		t.Errorf("square card: %d %+v", res.StatusCode, sq)
	}
	if res, _ := h.doRaw(http.MethodPost, "/api/host/crm/media?aspect=tall", "image/jpeg", in, nil); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("unknown aspect: %d", res.StatusCode)
	}

	// HEIC is refused with how to avoid it; a video that is too big says what Meta takes.
	if code, _, raw := uploadMedia(t, h, "image/heic", "IMG_1.HEIC", []byte("....ftypheic")); code != http.StatusUnsupportedMediaType ||
		!strings.Contains(string(raw), "media_heic") {
		t.Errorf("heic: %d %s", code, raw)
	}
	video := append([]byte("\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"), bytes.Repeat([]byte{0}, 16<<20)...)
	if code, _, raw := uploadMedia(t, h, "video/mp4", "talk.mp4", video); code != http.StatusRequestEntityTooLarge ||
		!strings.Contains(string(raw), "MP4 (H.264 video, AAC audio) under 16 MB") {
		t.Errorf("big video: %d %s", code, raw)
	}
}

func TestTemplateOptionsAreSubmittedAsMetaDocuments(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)

	submit := func(req types.CRMWordingRequest) (int, string, []byte) {
		res, raw := h.do(http.MethodPost, "/api/host/crm/templates", req)
		var out struct{ Name, Language string }
		if res.StatusCode == http.StatusOK {
			h.decode(raw, &out)
		}
		return res.StatusCode, out.Name, raw
	}

	// Authentication.
	code, authName, raw := submit(types.CRMWordingRequest{Category: "AUTHENTICATION",
		Auth: &types.CRMAuthInput{SecurityRecommendation: true, ExpirationMinutes: 5}})
	if code != http.StatusOK {
		t.Fatalf("auth: %d %s", code, raw)
	}
	if got := jsonOf(lastCreated(t, g)["components"]); got != `[{"add_security_recommendation":true,"type":"BODY"},{"code_expiration_minutes":5,"type":"FOOTER"},{"buttons":[{"otp_type":"COPY_CODE","type":"OTP"}],"type":"BUTTONS"}]` {
		t.Errorf("auth components = %s", got)
	}
	if lastCreated(t, g)["category"] != "AUTHENTICATION" {
		t.Errorf("auth category = %v", lastCreated(t, g)["category"])
	}

	// Standard: footer, phone and coupon, in Hindi.
	code, stdName, raw := submit(types.CRMWordingRequest{Category: "MARKETING", Language: "hi",
		Body: "नमस्ते {{1}}", Footer: ptr("Reply STOP to opt out"),
		Buttons: []types.CRMButtonInput{
			{Type: "PHONE_NUMBER", Text: "Call", PhoneNumber: "+91 98765 43210"},
			{Type: "COPY_CODE", Code: "SAVE20"},
		}})
	if code != http.StatusOK {
		t.Fatalf("standard: %d %s", code, raw)
	}
	created := lastCreated(t, g)
	if created["language"] != "hi" || !strings.Contains(jsonOf(created["components"]),
		`{"buttons":[{"phone_number":"+919876543210","text":"Call","type":"PHONE_NUMBER"},{"example":"SAVE20","type":"COPY_CODE"}],"type":"BUTTONS"}`) ||
		!strings.Contains(jsonOf(created["components"]), `{"text":"Reply STOP to opt out","type":"FOOTER"}`) {
		t.Errorf("standard = %s", jsonOf(created))
	}

	// The same template in Tamil keeps its name.
	code, taName, raw := submit(types.CRMWordingRequest{Name: stdName, Category: "MARKETING", Language: "ta",
		Body: "வணக்கம் {{1}}", Buttons: []types.CRMButtonInput{
			{Type: "PHONE_NUMBER", Text: "Call", PhoneNumber: "+919876543210"}, {Type: "COPY_CODE", Code: "SAVE20"}}})
	if code != http.StatusOK || taName != stdName || lastCreated(t, g)["language"] != "ta" {
		t.Fatalf("translation: %d %q %s", code, taName, raw)
	}
	if code, _, raw := submit(types.CRMWordingRequest{Name: "promo_from_manager", Body: "x", Language: "ta"}); code != http.StatusUnprocessableEntity {
		t.Errorf("translation of a template not written here: %d %s", code, raw)
	}

	// Limited-time offer.
	code, _, raw = submit(types.CRMWordingRequest{Category: "MARKETING", Body: "Last seats.",
		Offer:   &types.CRMOfferInput{Text: "20% off", HasExpiration: true},
		Buttons: []types.CRMButtonInput{{Type: "COPY_CODE", Code: "SAVE20"}}})
	if code != http.StatusOK {
		t.Fatalf("offer: %d %s", code, raw)
	}
	if got := jsonOf(lastCreated(t, g)["components"]); got != `[{"limited_time_offer":{"has_expiration":true,"text":"20% off"},"type":"LIMITED_TIME_OFFER"},{"text":"Last seats.","type":"BODY"},{"buttons":[{"example":"SAVE20","type":"COPY_CODE"}],"type":"BUTTONS"}]` {
		t.Errorf("offer components = %s", got)
	}

	// Carousel: each card's picture is uploaded to Meta as its sample.
	before := len(g.uploaded())
	var ids []string
	for i := 0; i < 2; i++ {
		res, raw := h.doRaw(http.MethodPost, "/api/host/crm/media?aspect=square&filename=c.jpg", "image/jpeg", testJPEG(t, 800, 400), nil)
		var f types.CRMMediaFile
		h.decode(raw, &f)
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("card upload: %d %s", res.StatusCode, raw)
		}
		ids = append(ids, f.ID)
	}
	cardReq := func(body string, id string) types.CRMCardInput {
		return types.CRMCardInput{FileID: id, Body: body, Buttons: []types.CRMButtonInput{{Type: "QUICK_REPLY", Text: "Tell me more"}}}
	}
	code, carName, raw := submit(types.CRMWordingRequest{Category: "MARKETING", Body: "Pick a course", CardAspect: "square",
		Cards: []types.CRMCardInput{cardReq("Yoga", ids[0]), cardReq("Breath", ids[1])}})
	if code != http.StatusOK {
		t.Fatalf("carousel: %d %s", code, raw)
	}
	if n := len(g.uploaded()) - before; n != 2 {
		t.Errorf("card samples uploaded = %d, want 2", n)
	}
	comps := lastCreated(t, g)["components"].([]any)
	car := comps[len(comps)-1].(map[string]any)
	cards, _ := car["cards"].([]any)
	if car["type"] != "CAROUSEL" || len(cards) != 2 ||
		!strings.Contains(jsonOf(cards[1]), `"format":"IMAGE"`) || !strings.Contains(jsonOf(cards[1]), `"text":"Breath"`) ||
		!strings.Contains(jsonOf(cards[1]), `"header_handle":["4::handle-`) {
		t.Errorf("carousel = %s", jsonOf(comps))
	}

	// Refusals come back with the editor's reason before Meta sees anything.
	n := len(g.createdTemplates())
	if code, _, raw := submit(types.CRMWordingRequest{Category: "UTILITY", Body: "x",
		Offer: &types.CRMOfferInput{Text: "20% off"}, Buttons: []types.CRMButtonInput{{Type: "COPY_CODE", Code: "A"}}}); code != http.StatusUnprocessableEntity ||
		!strings.Contains(string(raw), "invalid_offer") {
		t.Errorf("offer on utility: %d %s", code, raw)
	}
	if len(g.createdTemplates()) != n {
		t.Errorf("a refused template reached Meta")
	}

	// The list: languages per name, layouts kept, card pictures remembered, auth not sendable.
	list := crmTemplates(t, h, "?refresh=1").Templates
	langs := map[string]bool{}
	for _, tp := range list {
		if tp.Name == stdName {
			langs[tp.Language] = true
		}
	}
	if !langs["hi"] || !langs["ta"] {
		t.Errorf("languages of %s = %v", stdName, langs)
	}
	if a := templateNamed(t, list, authName); a.Auth == nil || a.Auth.ExpirationMinutes != 5 || a.Unsupported == "" {
		t.Errorf("auth template = %+v", a)
	}
	c := templateNamed(t, list, carName)
	if len(c.Cards) != 2 || c.Cards[0].File == nil || c.Cards[0].File.ID != ids[0] || c.CardAspect != "square" {
		t.Errorf("carousel template = %+v", c)
	}
}

/* Sends: a coupon in the copy-code button, the offer's end as expiration_time_ms, and a
 * carousel's cards — each from the broadcast, in the broadcast's language. */
func TestOfferCouponAndCarouselBroadcasts(t *testing.T) {
	g := newFakeGraph(t)
	g.addTemplate(map[string]any{
		"name": "seat_offer", "language": "hi", "status": "APPROVED", "category": "MARKETING",
		"components": []map[string]any{
			{"type": "LIMITED_TIME_OFFER", "limited_time_offer": map[string]any{"text": "20% off", "has_expiration": true}},
			{"type": "BODY", "text": "Hi {{1}}, last seats."},
			{"type": "BUTTONS", "buttons": []map[string]any{{"type": "COPY_CODE", "example": []string{"SAVE20"}}}},
		},
	})
	g.addTemplate(map[string]any{
		"name": "courses", "language": "en", "status": "APPROVED", "category": "MARKETING",
		"components": []map[string]any{
			{"type": "BODY", "text": "Pick one, {{1}}"},
			{"type": "CAROUSEL", "cards": []map[string]any{
				{"components": []map[string]any{{"type": "HEADER", "format": "IMAGE"}, {"type": "BODY", "text": "Yoga"},
					{"type": "BUTTONS", "buttons": []map[string]any{{"type": "QUICK_REPLY", "text": "Tell me more"}}}}},
				{"components": []map[string]any{{"type": "HEADER", "format": "IMAGE"}, {"type": "BODY", "text": "Breath"},
					{"type": "BUTTONS", "buttons": []map[string]any{{"type": "QUICK_REPLY", "text": "Tell me more"}}}}},
			}},
		},
	})
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	list := crmTemplates(t, h, "?refresh=1").Templates
	if o := templateNamed(t, list, "seat_offer"); !o.Sendable || o.Offer == nil || !o.Offer.HasExpiration {
		t.Fatalf("seat_offer = %+v", o)
	}
	if c := templateNamed(t, list, "courses"); c.Sendable || !c.NeedsCardFiles || len(c.Cards) != 2 {
		t.Fatalf("courses with no pictures = %+v, want not sendable for want of card pictures", c)
	}

	wb := autoWebinar(t, h, "Offers webinar")
	registerOptedIn(t, h, wb.ID)
	offer := types.CRMBroadcastRequest{
		Name: "offer", Template: "seat_offer", Language: "hi",
		Params:   []types.CRMParam{{Field: "first_name"}},
		Audience: types.AudienceWebinar, WebinarID: wb.ID,
	}
	refused := func(what string, req types.CRMBroadcastRequest, code string) {
		t.Helper()
		res, raw := h.do(http.MethodPost, "/api/host/crm/broadcasts", req)
		if res.StatusCode != http.StatusUnprocessableEntity || !strings.Contains(string(raw), code) {
			t.Errorf("%s: %d %s, want 422 %s", what, res.StatusCode, raw, code)
		}
	}
	refused("offer with no end", offer, "crm_offer_expiry")
	past := offer
	past.OfferExpiresAt = time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	refused("offer ending in the past", past, "crm_offer_expiry")
	badCoupon := offer
	badCoupon.OfferExpiresAt = time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339)
	badCoupon.CouponCode = "SAVE 20!"
	refused("coupon with symbols", badCoupon, "invalid_coupon")

	ends := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Second)
	offer.OfferExpiresAt = ends.Format(time.RFC3339)
	offer.CouponCode = "SEAT30"
	b := createBroadcast(t, h, offer)
	if b.CouponCode != "SEAT30" || b.OfferExpiresAt != offer.OfferExpiresAt {
		t.Errorf("broadcast reads back %q %q", b.CouponCode, b.OfferExpiresAt)
	}
	drainWhatsAppOutbox(t, h, wb.ID)
	sends := g.sent()
	if len(sends) == 0 {
		t.Fatal("nothing sent")
	}
	send := sends[len(sends)-1]
	if lang := send["template"].(map[string]any)["language"].(map[string]any)["code"]; lang != "hi" {
		t.Errorf("language = %v, want the broadcast's hi", lang)
	}
	comps := sendComponentsOf(send)
	lto := componentTyped(comps, "limited_time_offer")
	if lto == nil || jsonOf(lto["parameters"]) != `[{"limited_time_offer":{"expiration_time_ms":`+jsonOf(ends.UnixMilli())+`},"type":"limited_time_offer"}]` {
		t.Errorf("offer component = %v", lto)
	}
	if btn := componentTyped(comps, "button"); btn == nil || btn["sub_type"] != "copy_code" ||
		jsonOf(btn["parameters"]) != `[{"coupon_code":"SEAT30","type":"coupon_code"}]` {
		t.Errorf("coupon = %v", btn)
	}

	// Carousel: the broadcast brings a picture per card.
	var ids []string
	var links []string
	for i := 0; i < 2; i++ {
		res, raw := h.doRaw(http.MethodPost, "/api/host/crm/media?aspect=square&filename=c.jpg", "image/jpeg", testJPEG(t, 600, 600), nil)
		var f types.CRMMediaFile
		h.decode(raw, &f)
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("card upload: %d %s", res.StatusCode, raw)
		}
		ids, links = append(ids, f.ID), append(links, f.URL)
	}
	car := types.CRMBroadcastRequest{
		Name: "courses", Template: "courses", Language: "en",
		Params:   []types.CRMParam{{Field: "first_name"}},
		Audience: types.AudienceWebinar, WebinarID: wb.ID,
	}
	refused("carousel with no pictures", car, "")
	one := car
	one.CardFileIDs = ids[:1]
	refused("one picture for two cards", one, "invalid_cards")
	car.CardFileIDs = ids
	if b := createBroadcast(t, h, car); len(b.CardFiles) != 2 {
		t.Errorf("broadcast card files = %+v", b.CardFiles)
	}
	drainWhatsAppOutbox(t, h, wb.ID)
	sends = g.sent()
	carousel := componentTyped(sendComponentsOf(sends[len(sends)-1]), "carousel")
	if carousel == nil {
		t.Fatalf("no carousel in %v", sends[len(sends)-1])
	}
	cards := carousel["cards"].([]any)
	if len(cards) != 2 {
		t.Fatalf("cards = %v", cards)
	}
	for i, c := range cards {
		got := jsonOf(c)
		want := `{"card_index":` + jsonOf(i) + `,"components":[{"parameters":[{"image":{"link":"` + links[i] +
			`"},"type":"image"}],"type":"header"},{"index":0,"parameters":[{"payload":"Tell me more","type":"payload"}],"sub_type":"quick_reply","type":"button"}]}`
		if got != want {
			t.Errorf("card %d:\n got %s\nwant %s", i, got, want)
		}
	}
}
