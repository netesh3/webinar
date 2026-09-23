package wa

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

/* Sending, and the templates a send has to name.
 *
 * WhatsApp is not email: a business cannot write to somebody whenever it likes.
 * Two rules shape everything in this file and both are Meta's, not ours.
 *
 *  1. Outside a 24-hour window that only the CONTACT can open (by messaging the
 *     business), the only thing that may be sent is a template Meta has already
 *     approved, word for word, with variables filled in.
 *  2. Inside that window, free-form text is allowed.
 *
 * So SendTemplate is the path that always works and SendText is the one that
 * works when somebody is mid-conversation. The window itself is not tracked here
 * — it is a fact about the stored messages, and store.ServiceWindowOpen answers
 * it — because this package has no database and should not grow one.
 *
 * Every send is charged to the HOST's WABA by Meta. That is why the token is a
 * parameter rather than a field: one Client serves every host on the instance,
 * and mixing two hosts' tokens would mean billing the wrong business.
 */

/* ServiceWindow is how long a business may write free-form text after the
 * customer's last message.
 *
 * Meta's number, not a tuning knob: 24 hours from the last inbound message, and
 * a send a second past it is refused by Graph. It lives here with the rest of
 * Meta's rules so there is one place to change if Meta ever moves it — which they
 * have, for other conversation categories.
 */
const ServiceWindow = 24 * time.Hour

var (
	// ErrNoRecipient is a send with nothing to send to — an email-only contact,
	// which the caller should have filtered out.
	ErrNoRecipient = errors.New("that contact has no WhatsApp number")
	// ErrEmptyMessage is a free-form send with no text in it.
	ErrEmptyMessage = errors.New("there is no message to send")
	// ErrNoTemplate is a template send with no template named.
	ErrNoTemplate = errors.New("no WhatsApp template was chosen")
)

/* Template is one of the host's message templates as Meta describes it.
 *
 * Identity is (Name, Language) and not Name alone: the same template exists once
 * per translation, each approved separately, and a send names both.
 */
type Template struct {
	Name     string
	Language string
	// Status is Meta's: APPROVED, PENDING, REJECTED, PAUSED, DISABLED. Only an
	// APPROVED one can be sent, and the others are worth keeping so a host can
	// see why the template they submitted is not on offer yet.
	Status string
	// Category is MARKETING, UTILITY or AUTHENTICATION. It decides what consent a
	// send needs — see the opt-in rule in the API layer — and what Meta charges.
	Category string
	// Header and Footer are the fixed text around the body, for a preview. Empty
	// for a template with no header, or one whose header is an image or document.
	Header string
	Footer string
	// Body is the approved text, with `{{1}}`-style placeholders left in.
	Body string
	// Variables is how many placeholders the body has, which is exactly how many
	// values a send must supply: Meta rejects a mismatch rather than filling in
	// blanks.
	Variables int
	/* Unsupported says, in words a host can read, why this template cannot be
	 * sent from here — an image header, a variable in the header or a button,
	 * things this implementation does not fill in yet. Empty means sendable.
	 *
	 * Text rather than a bool because a greyed-out row with no reason is a support
	 * ticket. Computed at sync time from Meta's components, so a template that
	 * becomes sendable when this grows support for headers says so after the next
	 * refresh. */
	Unsupported string
}

// placeholder matches Meta's {{1}} / {{name}} variable syntax.
var placeholder = regexp.MustCompile(`\{\{\s*[^}]+\s*\}\}`)

/* Templates lists the host's message templates.
 *
 * Read from the WABA rather than the phone number: templates belong to the
 * business account, and every number on it can send them.
 *
 * Paged, because a busy host can have more than a hundred and a silently
 * truncated list is a template somebody cannot find. Capped at templatePages
 * anyway — a caller that needs thousands has outgrown a picker, and an unbounded
 * loop over somebody else's pagination is not a thing to ship.
 */
const (
	templatePageSize = 100
	templatePages    = 5
)

func (c *Client) Templates(ctx context.Context, token, wabaID string) ([]Template, error) {
	if strings.TrimSpace(token) == "" {
		return nil, ErrNotConnected
	}
	id := strings.TrimSpace(wabaID)
	if id == "" {
		return nil, errors.New("no WhatsApp Business Account id to read templates from")
	}

	out := []Template{}
	after := ""
	for page := 0; page < templatePages; page++ {
		q := url.Values{
			"fields": {"name,language,status,category,components"},
			"limit":  {fmt.Sprint(templatePageSize)},
		}
		if after != "" {
			q.Set("after", after)
		}
		var res templateList
		if err := c.get(ctx, token, "/"+url.PathEscape(id)+"/message_templates?"+q.Encode(), &res); err != nil {
			return nil, err
		}
		for _, t := range res.Data {
			out = append(out, readTemplate(t))
		}
		after = res.Paging.Cursors.After
		// Meta sends a cursor on the last page too; the absence of a `next` link is
		// what actually means "that was all of them".
		if after == "" || res.Paging.Next == "" || len(res.Data) == 0 {
			break
		}
	}
	return out, nil
}

type templateList struct {
	Data   []graphTemplate `json:"data"`
	Paging struct {
		Next    string `json:"next"`
		Cursors struct {
			After string `json:"after"`
		} `json:"cursors"`
	} `json:"paging"`
}

type graphTemplate struct {
	Name       string `json:"name"`
	Language   string `json:"language"`
	Status     string `json:"status"`
	Category   string `json:"category"`
	Components []struct {
		Type   string `json:"type"`
		Format string `json:"format"`
		Text   string `json:"text"`
		// Buttons carry their own text and, for URL buttons, their own variable —
		// which is why a template with buttons is not blindly sendable.
		Buttons []struct {
			Type string `json:"type"`
			Text string `json:"text"`
			URL  string `json:"url"`
		} `json:"buttons"`
	} `json:"components"`
}

/* readTemplate flattens Meta's component list into the shape a picker needs.
 *
 * The component vocabulary is open-ended and case-inconsistent across Graph
 * versions, so everything is matched upper-case and anything unrecognised is
 * ignored rather than treated as an error — a template with a component we have
 * never seen still has a name and a body worth showing.
 */
func readTemplate(t graphTemplate) Template {
	out := Template{
		Name:     strings.TrimSpace(t.Name),
		Language: strings.TrimSpace(t.Language),
		Status:   strings.ToUpper(strings.TrimSpace(t.Status)),
		Category: strings.ToUpper(strings.TrimSpace(t.Category)),
	}
	reasons := []string{}
	for _, comp := range t.Components {
		switch strings.ToUpper(comp.Type) {
		case "BODY":
			out.Body = comp.Text
			out.Variables = len(placeholder.FindAllString(comp.Text, -1))
		case "FOOTER":
			out.Footer = comp.Text
		case "HEADER":
			format := strings.ToUpper(strings.TrimSpace(comp.Format))
			if format != "" && format != "TEXT" {
				// An image, video or document header needs a media id or a link
				// uploaded before the send, which is not something a text compose box
				// can supply.
				reasons = append(reasons, "its header is "+strings.ToLower(format))
				continue
			}
			out.Header = comp.Text
			if placeholder.MatchString(comp.Text) {
				reasons = append(reasons, "its header has a variable in it")
			}
		case "BUTTONS":
			for _, b := range comp.Buttons {
				if placeholder.MatchString(b.URL) {
					reasons = append(reasons, "one of its buttons has a variable in it")
					break
				}
			}
		}
	}
	if out.Body == "" {
		reasons = append(reasons, "it has no body text")
	}
	if len(reasons) > 0 {
		out.Unsupported = "Can't be sent from here yet because " + strings.Join(reasons, ", ") + "."
	}
	return out
}

/* Render fills a template body in with the values a send supplied.
 *
 * Meta renders the real thing on their side; this is the copy kept in the thread,
 * so the inbox shows a host what the person actually read rather than
 * "Hi {{1}}, your {{2}} starts soon". Positional, in the order the placeholders
 * appear, which is the order Meta fills them in.
 *
 * A missing value leaves the placeholder alone rather than substituting a blank:
 * the count is checked before the send, so a gap here means the two sides
 * disagree, and showing that is more useful than hiding it.
 */
func Render(body string, params []string) string {
	i := 0
	return placeholder.ReplaceAllStringFunc(body, func(match string) string {
		if i >= len(params) {
			return match
		}
		v := params[i]
		i++
		return v
	})
}

// OutgoingTemplate is one template send: who, which template, and the values for
// its placeholders in the order they appear.
type OutgoingTemplate struct {
	To       string
	Name     string
	Language string
	// BodyParams fills `{{1}}`, `{{2}}` … in order. Meta rejects a send whose
	// count does not match the approved template, so the caller checks first —
	// see store.Template's Variables.
	BodyParams []string
}

/* SendTemplate sends an approved template and returns Meta's message id.
 *
 * The id is the whole reason this returns a string: every delivery status that
 * arrives later is keyed by it, so a send whose id is not stored is a message
 * that can never be shown as delivered, read or failed.
 */
func (c *Client) SendTemplate(ctx context.Context, token, phoneNumberID string, msg OutgoingTemplate) (string, error) {
	to := recipient(msg.To)
	if to == "" {
		return "", ErrNoRecipient
	}
	if strings.TrimSpace(msg.Name) == "" {
		return "", ErrNoTemplate
	}
	lang := strings.TrimSpace(msg.Language)
	if lang == "" {
		// Not a default worth inventing: a template exists per language, and
		// guessing sends somebody a message in a language they did not choose.
		return "", errors.New("that template has no language code")
	}

	type param struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	type component struct {
		Type       string  `json:"type"`
		Parameters []param `json:"parameters"`
	}
	tmpl := map[string]any{
		"name":     strings.TrimSpace(msg.Name),
		"language": map[string]string{"code": lang},
	}
	if len(msg.BodyParams) > 0 {
		params := make([]param, 0, len(msg.BodyParams))
		for _, v := range msg.BodyParams {
			params = append(params, param{Type: "text", Text: v})
		}
		tmpl["components"] = []component{{Type: "body", Parameters: params}}
	}
	return c.send(ctx, token, phoneNumberID, map[string]any{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                to,
		"type":              "template",
		"template":          tmpl,
	})
}

/* SendText sends free-form text, which Meta only allows inside the 24-hour
 * window the contact opened by writing to the business.
 *
 * Outside it Meta answers with an error rather than silently dropping the
 * message, so this cannot quietly fail — but the caller should still check the
 * window first, because a refusal a host sees before they type is better than one
 * they see after.
 *
 * preview_url is false: link previews are fetched by Meta from the URL, which
 * turns a join link — a bearer credential — into a request from Meta's crawlers.
 */
func (c *Client) SendText(ctx context.Context, token, phoneNumberID, to, body string) (string, error) {
	dest := recipient(to)
	if dest == "" {
		return "", ErrNoRecipient
	}
	text := strings.TrimSpace(body)
	if text == "" {
		return "", ErrEmptyMessage
	}
	return c.send(ctx, token, phoneNumberID, map[string]any{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                dest,
		"type":              "text",
		"text":              map[string]any{"preview_url": false, "body": text},
	})
}

/* Buttons and the limits on them.
 *
 * All three numbers are Meta's, and all three are refused by Graph rather than
 * truncated, so a caller that ignores them has written a message nobody receives.
 */
const (
	// MaxButtons is reply buttons per message. Four is an error, not a second row.
	MaxButtons = 3
	// MaxButtonTitle is characters on a button's label.
	MaxButtonTitle = 20
	// MaxInteractiveBody is the body of a message that has buttons on it — a quarter
	// of what plain text allows.
	MaxInteractiveBody = 1024
)

// Button is one reply button: the id comes back in the webhook when it is tapped,
// the title is what the person reads.
type Button struct {
	ID    string
	Title string
}

// OutgoingButtons is a question with up to MaxButtons answers on it.
type OutgoingButtons struct {
	To      string
	Body    string
	Buttons []Button
}

/* SendButtons sends free-form text with reply buttons under it.
 *
 * Same 24-hour rule as SendText — an interactive message is not a template and Meta
 * refuses it outside the window — and the same reason for returning the message id.
 *
 * The limits are checked here and not just by the caller because this is the layer
 * that knows them, and because a send that Graph refuses costs a round trip and
 * produces an error about JSON rather than about buttons. Ids are required: without
 * one the webhook comes back with a title and nothing else, and matching a branch on
 * a label is exactly what the id exists to avoid.
 */
func (c *Client) SendButtons(ctx context.Context, token, phoneNumberID string, msg OutgoingButtons) (string, error) {
	dest := recipient(msg.To)
	if dest == "" {
		return "", ErrNoRecipient
	}
	text := strings.TrimSpace(msg.Body)
	if text == "" {
		return "", ErrEmptyMessage
	}
	if len([]rune(text)) > MaxInteractiveBody {
		return "", fmt.Errorf("a message with buttons can be at most %d characters", MaxInteractiveBody)
	}
	if len(msg.Buttons) == 0 {
		return "", errors.New("there are no buttons to send")
	}
	if len(msg.Buttons) > MaxButtons {
		return "", fmt.Errorf("whatsapp allows at most %d buttons on a message", MaxButtons)
	}

	type reply struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	type button struct {
		Type  string `json:"type"`
		Reply reply  `json:"reply"`
	}
	buttons := make([]button, 0, len(msg.Buttons))
	seen := make(map[string]bool, len(msg.Buttons))
	for _, b := range msg.Buttons {
		id := strings.TrimSpace(b.ID)
		title := strings.TrimSpace(b.Title)
		if id == "" || title == "" {
			return "", errors.New("every button needs an id and a label")
		}
		if len([]rune(title)) > MaxButtonTitle {
			return "", fmt.Errorf("a button's label can be at most %d characters", MaxButtonTitle)
		}
		// Meta refuses a repeated id, and a repeated one would also make the answer
		// ambiguous to whoever reads it back.
		if seen[id] {
			return "", errors.New("two buttons have the same id")
		}
		seen[id] = true
		buttons = append(buttons, button{Type: "reply", Reply: reply{ID: id, Title: title}})
	}

	return c.send(ctx, token, phoneNumberID, map[string]any{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                dest,
		"type":              "interactive",
		"interactive": map[string]any{
			"type": "button",
			"body": map[string]any{"text": text},
			"action": map[string]any{
				"buttons": buttons,
			},
		},
	})
}

func (c *Client) send(ctx context.Context, token, phoneNumberID string, body map[string]any) (string, error) {
	if strings.TrimSpace(token) == "" {
		return "", ErrNotConnected
	}
	id := strings.TrimSpace(phoneNumberID)
	if id == "" {
		return "", ErrNotConnected
	}
	var out struct {
		Messages []struct {
			ID string `json:"id"`
		} `json:"messages"`
	}
	if err := c.post(ctx, token, "/"+url.PathEscape(id)+"/messages", body, &out); err != nil {
		return "", err
	}
	if len(out.Messages) == 0 || out.Messages[0].ID == "" {
		// A 200 with no message id should not happen, and treating it as success
		// would file a message no status can ever reach.
		return "", errors.New("meta accepted the send but returned no message id")
	}
	return out.Messages[0].ID, nil
}

/* recipient is the number as Meta wants it: digits only.
 *
 * Contacts are stored E.164 ("+27831112222") because that is the only spelling
 * that is unambiguous to a human; Meta's `to` is the same number without the
 * plus. Anything else a host pasted — spaces, dashes, brackets — is dropped here
 * rather than rejected, because it is the same number.
 */
func recipient(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}
