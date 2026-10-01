package wa

import (
	"testing"
	"time"
)

// A realistic delivery: one text message, the sender's profile, and a status for
// something the host sent earlier — all in one POST, which is how Meta batches.
const sampleDelivery = `{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "waba-1",
    "changes": [{
      "field": "messages",
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {"display_phone_number": "27820000000", "phone_number_id": "phone-1"},
        "contacts": [{"profile": {"name": "Thandi M"}, "wa_id": "27831112222"}],
        "messages": [{
          "from": "27831112222",
          "id": "wamid.IN1",
          "timestamp": "1700000000",
          "type": "text",
          "text": {"body": "Is the replay available?"}
        }],
        "statuses": [{
          "id": "wamid.OUT1",
          "status": "delivered",
          "timestamp": "1700000060",
          "recipient_id": "27831112222"
        }]
      }
    }]
  }]
}`

func TestParseWebhookReadsMessagesAndStatuses(t *testing.T) {
	d, err := ParseWebhook([]byte(sampleDelivery))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(d.Messages) != 1 || len(d.Statuses) != 1 {
		t.Fatalf("want 1 message and 1 status, got %d and %d", len(d.Messages), len(d.Statuses))
	}

	m := d.Messages[0]
	if m.PhoneNumberID != "phone-1" || m.WABAID != "waba-1" {
		t.Errorf("routing ids: %+v", m)
	}
	if m.From != "27831112222" || m.WAMID != "wamid.IN1" {
		t.Errorf("sender/id: %+v", m)
	}
	// The profile name is carried on a sibling list, not on the message, so a parse
	// that reads only the messages loses the only name this contact has.
	if m.ProfileName != "Thandi M" {
		t.Errorf("profile name = %q", m.ProfileName)
	}
	if m.Body != "Is the replay available?" {
		t.Errorf("body = %q", m.Body)
	}
	// Empty kind means "plain text, the body is the whole message".
	if m.Kind != "" {
		t.Errorf("kind = %q, want empty for text", m.Kind)
	}
	if want := time.Unix(1700000000, 0).UTC(); !m.At.Equal(want) {
		t.Errorf("timestamp = %v, want %v", m.At, want)
	}

	st := d.Statuses[0]
	if st.WAMID != "wamid.OUT1" || st.Status != "delivered" || st.PhoneNumberID != "phone-1" {
		t.Errorf("status: %+v", st)
	}
	if st.Error != "" {
		t.Errorf("no errors were sent, got %q", st.Error)
	}
}

func TestParseWebhookCarriesMetasFailureThrough(t *testing.T) {
	// The shape of a send to a WABA with no payment method on it: the host's
	// problem, and only fixable if we repeat what Meta said.
	const body = `{"entry":[{"id":"waba-1","changes":[{"field":"messages","value":{
	  "metadata":{"phone_number_id":"phone-1"},
	  "statuses":[{"id":"wamid.OUT2","status":"failed","timestamp":"1700000100","errors":[
	    {"code":131042,"title":"Business eligibility payment issue",
	     "message":"Message failed to send","details":"There is no payment method on this account."}
	  ]}]}}]}]}`
	d, err := ParseWebhook([]byte(body))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(d.Statuses) != 1 {
		t.Fatalf("want 1 status, got %d", len(d.Statuses))
	}
	if d.Statuses[0].Status != "failed" {
		t.Fatalf("status = %q", d.Statuses[0].Status)
	}
	// Code and the actionable sentence, not the category: "131042" is what Meta's
	// own documentation is indexed by, and the details are what the host has to do.
	want := "131042: There is no payment method on this account."
	if d.Statuses[0].Error != want {
		t.Errorf("error = %q, want %q", d.Statuses[0].Error, want)
	}
}

func TestParseWebhookKeepsNonTextKinds(t *testing.T) {
	const body = `{"entry":[{"id":"waba-1","changes":[{"field":"messages","value":{
	  "metadata":{"phone_number_id":"phone-1"},
	  "messages":[
	    {"from":"27831112222","id":"m1","type":"image","image":{"caption":"my ticket"}},
	    {"from":"27831112222","id":"m2","type":"audio","audio":{"voice":true}},
	    {"from":"27831112222","id":"m3","type":"interactive",
	     "interactive":{"button_reply":{"title":"Remind me"}}},
	    {"from":"27831112222","id":"m4","type":"sticker"}
	  ]}}]}]}`
	d, err := ParseWebhook([]byte(body))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(d.Messages) != 4 {
		t.Fatalf("want 4 messages, got %d", len(d.Messages))
	}
	want := []struct{ kind, body string }{
		{"image", "my ticket"},
		{"voice", ""},
		{"button", "Remind me"},
		// A type nobody has written a case for still arrives as a message, so the
		// thread can say something happened rather than skipping a beat in the
		// conversation.
		{"sticker", ""},
	}
	for i, w := range want {
		if d.Messages[i].Kind != w.kind || d.Messages[i].Body != w.body {
			t.Errorf("message %d = (%q, %q), want (%q, %q)",
				i, d.Messages[i].Kind, d.Messages[i].Body, w.kind, w.body)
		}
	}
}

func TestParseWebhookIgnoresWhatItDoesNotHandle(t *testing.T) {
	cases := map[string]string{
		// A field we never subscribed to. Meta adds these; they are not errors.
		"other field": `{"entry":[{"id":"w","changes":[{"field":"account_review_update",
		    "value":{"decision":"APPROVED"}}]}]}`,
		// A status vocabulary we do not have a column for.
		"unknown status": `{"entry":[{"id":"w","changes":[{"field":"messages","value":{
		    "metadata":{"phone_number_id":"p"},
		    "statuses":[{"id":"x","status":"deleted"}]}}]}]}`,
		"no entries":   `{"object":"whatsapp_business_account","entry":[]}`,
		"empty object": `{}`,
	}
	for name, body := range cases {
		d, err := ParseWebhook([]byte(body))
		if err != nil {
			t.Errorf("%s: parse: %v", name, err)
			continue
		}
		if len(d.Messages) != 0 || len(d.Statuses) != 0 {
			t.Errorf("%s: want nothing to act on, got %d messages and %d statuses",
				name, len(d.Messages), len(d.Statuses))
		}
	}
}

// The one thing that IS an error: bytes that are not JSON. Everything else is a
// payload to ignore, because the endpoint has to answer Meta 200 either way and a
// caller cannot tell the two apart without this.
func TestParseWebhookRefusesNonJSON(t *testing.T) {
	if _, err := ParseWebhook([]byte("not json at all")); err == nil {
		t.Fatal("want an error for a non-JSON body")
	}
}

func TestParseWebhookReadsPricing(t *testing.T) {
	const body = `{"entry":[{"id":"waba-1","changes":[{"field":"messages","value":{
	  "metadata":{"phone_number_id":"phone-1"},
	  "statuses":[
	    {"id":"wamid.A","status":"delivered","timestamp":"1700000100","recipient_id":"919800011122",
	     "pricing":{"billable":true,"pricing_model":"PMP","category":"utility"}},
	    {"id":"wamid.B","status":"sent","timestamp":"1700000100","recipient_id":"14155550100",
	     "pricing":{"billable":true,"category":"marketing","amount":0.78}},
	    {"id":"wamid.C","status":"delivered","timestamp":"1700000100",
	     "conversation":{"origin":{"type":"service"}}}
	  ]}}]}]}`
	d, err := ParseWebhook([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Statuses) != 3 {
		t.Fatalf("statuses = %d", len(d.Statuses))
	}
	a := d.Statuses[0]
	if a.RecipientID != "919800011122" || a.Pricing == nil || a.Pricing.Category != "utility" || a.Pricing.HasAmount {
		t.Fatalf("category without amount: %+v", a.Pricing)
	}
	if a.Pricing.Billable == nil || !*a.Pricing.Billable {
		t.Fatal("billable should be true")
	}
	b := d.Statuses[1]
	if b.Pricing == nil || !b.Pricing.HasAmount || b.Pricing.Micros != 780_000 {
		t.Fatalf("amount: %+v", b.Pricing)
	}
	c := d.Statuses[2]
	if c.Pricing == nil || c.Pricing.Category != "service" || c.Pricing.HasAmount {
		t.Fatalf("origin fallback: %+v", c.Pricing)
	}
}

func TestParseWebhookReadsMediaPayloads(t *testing.T) {
	const body = `{"entry":[{"id":"waba-1","changes":[{"field":"messages","value":{
	  "metadata":{"phone_number_id":"phone-1"},
	  "messages":[
	    {"from":"917795802154","id":"wamid.IMG","timestamp":"1700000000","type":"image",
	     "image":{"caption":"the ticket","mime_type":"image/jpeg","sha256":"abc","id":"1001"}},
	    {"from":"917795802154","id":"wamid.VOICE","timestamp":"1700000001","type":"audio",
	     "audio":{"mime_type":"audio/ogg; codecs=opus","sha256":"abc","id":"1002","voice":true}},
	    {"from":"917795802154","id":"wamid.DOC","timestamp":"1700000002","type":"document",
	     "document":{"caption":"please see","filename":"invoice.pdf","mime_type":"application/pdf","sha256":"abc","id":"1003"}},
	    {"from":"917795802154","id":"wamid.STICK","timestamp":"1700000003","type":"sticker",
	     "sticker":{"mime_type":"image/webp","sha256":"abc","id":"1004","animated":false}},
	    {"from":"917795802154","id":"wamid.LOC","timestamp":"1700000004","type":"location",
	     "location":{"latitude":12.9716,"longitude":77.5946,"name":"Cubbon Park","address":"Bengaluru"}},
	    {"from":"917795802154","id":"wamid.REACT","timestamp":"1700000005","type":"reaction",
	     "reaction":{"message_id":"wamid.TARGET","emoji":"👍"}},
	    {"from":"917795802154","id":"wamid.LIST","timestamp":"1700000006","type":"interactive",
	     "interactive":{"type":"list_reply","list_reply":{"id":"row1","title":"Price for the course","description":"Flow testing"}}},
	    {"from":"917795802154","id":"wamid.BTN","timestamp":"1700000007","type":"interactive",
	     "interactive":{"type":"button_reply","button_reply":{"id":"btn1","title":"Remind me"}}},
	    {"from":"917795802154","id":"wamid.UNSUP","timestamp":"1700000008","type":"unsupported",
	     "errors":[{"code":131051,"title":"Message type unknown","message":"Message type unknown",
	       "error_data":{"details":"Message type is currently not supported."}}]},
	    {"from":"917795802154","id":"wamid.ORDER","timestamp":"1700000009","type":"order",
	     "order":{"catalog_id":"c1","text":"2 items"}}
	  ]}}]}]}`
	d, err := ParseWebhook([]byte(body))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(d.Messages) != 10 {
		t.Fatalf("want 10 messages, got %d", len(d.Messages))
	}

	img := d.Messages[0]
	if img.Kind != "image" || img.Body != "the ticket" || img.Media.ID != "1001" || img.Media.MimeType != "image/jpeg" {
		t.Fatalf("image: kind=%q body=%q media=%+v", img.Kind, img.Body, img.Media)
	}
	voice := d.Messages[1]
	if voice.Kind != "voice" || voice.Body != "" || voice.Media.ID != "1002" || voice.Media.MimeType != "audio/ogg; codecs=opus" {
		t.Fatalf("voice: kind=%q body=%q media=%+v", voice.Kind, voice.Body, voice.Media)
	}
	doc := d.Messages[2]
	if doc.Kind != "document" || doc.Body != "please see" || doc.Media.Filename != "invoice.pdf" || doc.Media.ID != "1003" {
		t.Fatalf("document: kind=%q body=%q media=%+v", doc.Kind, doc.Body, doc.Media)
	}
	stick := d.Messages[3]
	if stick.Kind != "sticker" || stick.Media.ID != "1004" || stick.Media.MimeType != "image/webp" {
		t.Fatalf("sticker: %+v media=%+v", stick.Kind, stick.Media)
	}
	loc := d.Messages[4]
	if loc.Kind != "location" || !loc.Media.HasLocation || loc.Media.Name != "Cubbon Park" || loc.Media.Latitude != 12.9716 || loc.Media.Longitude != 77.5946 {
		t.Fatalf("location: %+v", loc.Media)
	}
	react := d.Messages[5]
	if react.Kind != "reaction" || react.Media.Emoji != "👍" || react.Media.Target != "wamid.TARGET" {
		t.Fatalf("reaction: %+v", react.Media)
	}
	list := d.Messages[6]
	if list.Kind != "interactive" || list.Body != "Price for the course" || list.ReplyID != "row1" {
		t.Fatalf("list reply: kind=%q body=%q reply=%q", list.Kind, list.Body, list.ReplyID)
	}
	btn := d.Messages[7]
	if btn.Kind != "button" || btn.Body != "Remind me" || btn.ReplyID != "btn1" {
		t.Fatalf("button reply: kind=%q body=%q reply=%q", btn.Kind, btn.Body, btn.ReplyID)
	}
	unsup := d.Messages[8]
	if unsup.Kind != "unsupported" || unsup.Body != "" || unsup.Media.ErrorCode != 131051 || unsup.Media.ErrorTitle != "Message type unknown" {
		t.Fatalf("unsupported: kind=%q body=%q media=%+v", unsup.Kind, unsup.Body, unsup.Media)
	}
	if unsup.Media.ErrorDetail != "Message type is currently not supported." {
		t.Fatalf("unsupported detail = %q", unsup.Media.ErrorDetail)
	}
	// A type this code has no case for stays that type. It is not rewritten to
	// "unsupported", which is a type Meta sends, not a label we invent.
	order := d.Messages[9]
	if order.Kind != "order" {
		t.Fatalf("order kind = %q, want order (not unsupported)", order.Kind)
	}
}

func TestUnixSecondsTreatsNonsenseAsAbsent(t *testing.T) {
	for _, in := range []string{"", "0", "-1", "not-a-number"} {
		if got := unixSeconds(in); !got.IsZero() {
			t.Errorf("unixSeconds(%q) = %v, want the zero time", in, got)
		}
	}
	if got := unixSeconds(" 1700000000 "); !got.Equal(time.Unix(1700000000, 0).UTC()) {
		t.Errorf("unixSeconds with padding = %v", got)
	}
}
