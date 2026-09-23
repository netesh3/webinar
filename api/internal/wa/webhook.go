package wa

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

/* Reading what Meta posts to the webhook.
 *
 * Here rather than in the API package because this is Meta's wire format, and this
 * package is where the rest of that format already lives. The handler's job is
 * deciding which host a delivery belongs to and what to write; working out what
 * Meta meant is this file's.
 *
 * The shape is defensive on purpose. One POST carries a list of entries, each with
 * a list of changes, each of which may hold several messages AND several delivery
 * statuses, for fields we never subscribed to, about accounts that are not ours,
 * in message types that did not exist when this was written. None of that is an
 * error — it is the documented behaviour of a webhook Meta adds to over time — so
 * everything unrecognised is skipped and everything understood is returned. A
 * parse that fails is only a parse of something that is not JSON at all.
 */

// Delivery is one webhook POST, flattened to the two things worth acting on.
type Delivery struct {
	Messages []Inbound
	Statuses []Status
}

// Inbound is one message a person sent to a host's WhatsApp number.
type Inbound struct {
	// Which of our hosts this is for, indirectly: the number it arrived on. The
	// only routing key in the payload.
	PhoneNumberID string
	WABAID        string
	// The sender's number as Meta writes it: digits, no plus. Normalising is the
	// store's job, since it has to match a registration's number the same way.
	From string
	// From the sender's WhatsApp profile. Often the only name a contact ever has,
	// for someone who messaged the business without registering for anything.
	ProfileName string
	// Meta's message id, and the idempotency key for the whole ingest.
	WAMID string
	/* Meta's type, kept only when it is NOT plain text.
	 *
	 * A thread that shows an empty bubble for a photo is worse than one that says
	 * "sent an image", and this is what lets the UI say it. Text is the common case
	 * and leaves this empty, so the absence means "Body is the whole message".
	 */
	Kind string
	// The readable content: the text, a button's label, a list selection's title.
	// Empty for the kinds that have no text at all, like an image with no caption.
	Body string
	/* The id of the button or list row that was tapped, for the kinds that have one.
	 *
	 * Separate from Body because they answer different questions. Body is what the
	 * person saw and is what gets written into the thread; this is the id the sender
	 * of the question chose, which is how a bot knows WHICH of its branches was taken
	 * without comparing labels a host may since have reworded. Empty for everything
	 * typed by hand, which is then matched on the text instead.
	 */
	ReplyID string
	// When the sender sent it, not when we read it. Zero if Meta omitted it.
	At time.Time
}

// Status is Meta reporting on a message the host sent.
type Status struct {
	PhoneNumberID string
	WAMID         string
	// sent / delivered / read / failed, matching crm_messages.status.
	Status string
	// Meta's own explanation when Status is "failed". Usually something only the
	// host can act on — an unapproved template, a WABA with no payment method —
	// so it is carried through verbatim rather than summarised.
	Error string
	At    time.Time
}

// The JSON, named to match Meta's field names rather than ours, so the two can be
// compared against the documentation without a translation step.
type webhookEnvelope struct {
	Object string `json:"object"`
	Entry  []struct {
		ID      string `json:"id"` // the WABA id
		Changes []struct {
			Field string `json:"field"`
			Value struct {
				MessagingProduct string `json:"messaging_product"`
				Metadata         struct {
					DisplayPhoneNumber string `json:"display_phone_number"`
					PhoneNumberID      string `json:"phone_number_id"`
				} `json:"metadata"`
				Contacts []struct {
					WAID    string `json:"wa_id"`
					Profile struct {
						Name string `json:"name"`
					} `json:"profile"`
				} `json:"contacts"`
				Messages []webhookMessage `json:"messages"`
				Statuses []struct {
					ID          string         `json:"id"`
					Status      string         `json:"status"`
					Timestamp   string         `json:"timestamp"`
					RecipientID string         `json:"recipient_id"`
					Errors      []webhookError `json:"errors"`
				} `json:"statuses"`
			} `json:"value"`
		} `json:"changes"`
	} `json:"entry"`
}

type webhookMessage struct {
	From      string `json:"from"`
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	Type      string `json:"type"`
	Text      struct {
		Body string `json:"body"`
	} `json:"text"`
	Button struct {
		Text string `json:"text"`
		// A template's quick reply carries the payload the template was approved
		// with, not an id we chose — kept anyway, since it is the only thing
		// distinguishing two buttons with the same label.
		Payload string `json:"payload"`
	} `json:"button"`
	Interactive struct {
		ButtonReply struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		} `json:"button_reply"`
		ListReply struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		} `json:"list_reply"`
	} `json:"interactive"`
	Image struct {
		Caption string `json:"caption"`
	} `json:"image"`
	Video struct {
		Caption string `json:"caption"`
	} `json:"video"`
	Audio struct {
		Voice bool `json:"voice"`
	} `json:"audio"`
	Document struct {
		Caption  string `json:"caption"`
		Filename string `json:"filename"`
	} `json:"document"`
}

type webhookError struct {
	Code    int    `json:"code"`
	Title   string `json:"title"`
	Message string `json:"message"`
	Details string `json:"details"`
}

// ParseWebhook flattens one delivery. An error means the body was not JSON;
// everything else — an unknown object, a field we did not subscribe to, a message
// type with no text in it — comes back as an empty or partial Delivery, because
// that is a payload to ignore rather than a failure to report to Meta.
func ParseWebhook(raw []byte) (Delivery, error) {
	var env webhookEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return Delivery{}, err
	}
	var out Delivery
	for _, entry := range env.Entry {
		for _, ch := range entry.Changes {
			v := ch.Value
			// Names are per-change, and separate from the messages: Meta sends the
			// sender's profile once even when they sent three messages.
			names := make(map[string]string, len(v.Contacts))
			for _, c := range v.Contacts {
				if n := strings.TrimSpace(c.Profile.Name); n != "" {
					names[c.WAID] = n
				}
			}
			for _, m := range v.Messages {
				kind, body := readMessageBody(m)
				out.Messages = append(out.Messages, Inbound{
					PhoneNumberID: v.Metadata.PhoneNumberID,
					WABAID:        entry.ID,
					From:          strings.TrimSpace(m.From),
					ProfileName:   names[strings.TrimSpace(m.From)],
					WAMID:         strings.TrimSpace(m.ID),
					Kind:          kind,
					Body:          body,
					ReplyID:       readReplyID(m),
					At:            unixSeconds(m.Timestamp),
				})
			}
			for _, st := range v.Statuses {
				s := strings.TrimSpace(strings.ToLower(st.Status))
				// Meta has more statuses than crm_messages does — "deleted", and
				// whatever is added next. Anything not in our vocabulary is dropped
				// here rather than written and then not understood by the UI.
				switch s {
				case "sent", "delivered", "read", "failed":
				default:
					continue
				}
				out.Statuses = append(out.Statuses, Status{
					PhoneNumberID: v.Metadata.PhoneNumberID,
					WAMID:         strings.TrimSpace(st.ID),
					Status:        s,
					Error:         firstError(st.Errors),
					At:            unixSeconds(st.Timestamp),
				})
			}
		}
	}
	return out, nil
}

/* readMessageBody turns one message into (kind, body).
 *
 * Text is the case worth getting right, and it comes back with an empty kind so
 * the thread renders it as what somebody said. Everything else keeps its Meta type
 * and contributes whatever text it has: a photo's caption, the label of the button
 * that was tapped, the filename of a document. A kind with no text is not a
 * failure — the UI has the type and can say "sent a voice note" without inventing
 * words the sender did not use.
 */
func readMessageBody(m webhookMessage) (string, string) {
	switch strings.TrimSpace(strings.ToLower(m.Type)) {
	case "text", "":
		return "", m.Text.Body
	// A template's quick-reply button, tapped. The label is the reply, and a bot
	// matches on it when there is no id to match on.
	case "button":
		return "button", m.Button.Text
	case "interactive":
		if t := m.Interactive.ButtonReply.Title; t != "" {
			return "button", t
		}
		return "interactive", m.Interactive.ListReply.Title
	case "image":
		return "image", m.Image.Caption
	case "video":
		return "video", m.Video.Caption
	case "audio":
		// A voice note and an audio file are the same message type with a flag, and
		// they read completely differently in a thread.
		if m.Audio.Voice {
			return "voice", ""
		}
		return "audio", ""
	case "document":
		if m.Document.Caption != "" {
			return "document", m.Document.Caption
		}
		return "document", m.Document.Filename
	default:
		return strings.TrimSpace(strings.ToLower(m.Type)), ""
	}
}

/* readReplyID is the id of whatever was tapped, or "" if nothing was.
 *
 * Meta echoes back the id the sender of the interactive message chose, which for our
 * own bots is a node key: matching on it is exact, survives the host rewording the
 * button afterwards, and distinguishes two branches that happen to both say "More".
 * A template's quick reply has a payload instead — approved at Meta, not chosen here
 * — and it is returned as well on the grounds that a caller wanting an exact match is
 * better served by Meta's string than by ours.
 */
func readReplyID(m webhookMessage) string {
	switch strings.TrimSpace(strings.ToLower(m.Type)) {
	case "interactive":
		if id := strings.TrimSpace(m.Interactive.ButtonReply.ID); id != "" {
			return id
		}
		return strings.TrimSpace(m.Interactive.ListReply.ID)
	case "button":
		return strings.TrimSpace(m.Button.Payload)
	default:
		return ""
	}
}

func firstError(errs []webhookError) string {
	for _, e := range errs {
		// Details is the sentence that says what to do about it; Title is the
		// category. Preferred in that order, with the code kept because it is what
		// Meta's own documentation is indexed by.
		text := strings.TrimSpace(e.Details)
		if text == "" {
			text = strings.TrimSpace(e.Message)
		}
		if text == "" {
			text = strings.TrimSpace(e.Title)
		}
		if text == "" {
			continue
		}
		if e.Code != 0 {
			return strconv.Itoa(e.Code) + ": " + text
		}
		return text
	}
	return ""
}

// unixSeconds reads Meta's timestamps, which are seconds as a JSON string. A zero
// time means "Meta did not say", which the caller reads as "use arrival time"
// rather than as the epoch.
func unixSeconds(s string) time.Time {
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil || n <= 0 {
		return time.Time{}
	}
	return time.Unix(n, 0).UTC()
}
