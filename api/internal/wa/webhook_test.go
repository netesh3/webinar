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
