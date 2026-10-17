package wa

import (
	"bytes"
	"context"
	"encoding/json"
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
	// HeaderFormat is TEXT, IMAGE, VIDEO or DOCUMENT, or empty for no header. An IMAGE
	// header is filled at send time with the webinar's cover.
	HeaderFormat string
	// Buttons are the template's buttons in order: quick replies (fixed text, the tap
	// comes back in the webhook) and links (a fixed URL, or one ending in a variable that
	// is filled with the person's own link).
	Buttons []TemplateButton
	// Offer is set on a limited-time offer template (MARKETING only).
	Offer *TemplateOffer
	// Cards is a carousel template's cards, in order. Empty for every other kind.
	Cards []TemplateCard
	// Auth is set on an AUTHENTICATION template: Meta writes its body itself.
	Auth *TemplateAuth
}

// TemplateOffer is the limited-time offer part of a template.
type TemplateOffer struct {
	Text          string
	HasExpiration bool
}

// TemplateCard is one card of a carousel template.
type TemplateCard struct {
	// HeaderFormat is IMAGE or VIDEO.
	HeaderFormat string
	Body         string
	Variables    int
	Buttons      []TemplateButton
}

// TemplateAuth is what an authentication template adds around Meta's fixed text.
type TemplateAuth struct {
	SecurityRecommendation bool
	ExpirationMinutes      int
}

// TemplateButton is one button on a template.
type TemplateButton struct {
	// Type is QUICK_REPLY, URL, PHONE_NUMBER, COPY_CODE or OTP (upper-case, as Meta
	// sends it).
	Type string
	Text string
	// URL is the approved link, with `{{1}}` left in for a dynamic one.
	URL string
	// Dynamic is a URL button whose last part is a variable.
	Dynamic bool
	// PhoneNumber is the number a PHONE_NUMBER button calls.
	PhoneNumber string
	// Example is a COPY_CODE button's sample code, as approved.
	Example string
	// OTPType is an OTP button's kind: COPY_CODE, ONE_TAP or ZERO_TAP.
	OTPType string
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

/* graphLanguage is Meta's language field.
 *
 * The list endpoint usually sends a code ("en_US"). Some responses send the
 * same code as an object ({"code":"en_US"}), which a plain string would reject
 * and which would drop the whole page of templates. */
type graphLanguage string

func (g *graphLanguage) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || string(data) == "null" {
		*g = ""
		return nil
	}
	if data[0] == '"' {
		var s string
		if err := json.Unmarshal(data, &s); err != nil {
			return err
		}
		*g = graphLanguage(s)
		return nil
	}
	var obj struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(data, &obj); err != nil {
		return err
	}
	*g = graphLanguage(obj.Code)
	return nil
}

type graphTemplate struct {
	Name       string           `json:"name"`
	Language   graphLanguage    `json:"language"`
	Status     string           `json:"status"`
	Category   string           `json:"category"`
	Components []graphComponent `json:"components"`
}

type graphComponent struct {
	Type   string `json:"type"`
	Format string `json:"format"`
	Text   string `json:"text"`
	// Buttons carry their own text and, for URL buttons, their own variable —
	// which is why a template with buttons is not blindly sendable.
	Buttons []graphButton `json:"buttons"`
	// Authentication templates: the options around Meta's fixed text.
	AddSecurityRecommendation bool `json:"add_security_recommendation"`
	CodeExpirationMinutes     int  `json:"code_expiration_minutes"`
	// LIMITED_TIME_OFFER.
	LimitedTimeOffer *struct {
		Text          string `json:"text"`
		HasExpiration bool   `json:"has_expiration"`
	} `json:"limited_time_offer"`
	// CAROUSEL.
	Cards []struct {
		Components []graphComponent `json:"components"`
	} `json:"cards"`
}

type graphButton struct {
	Type        string          `json:"type"`
	Text        string          `json:"text"`
	URL         string          `json:"url"`
	PhoneNumber string          `json:"phone_number"`
	OTPType     string          `json:"otp_type"`
	Example     json.RawMessage `json:"example"`
}

// exampleText is a button's example, which Graph returns as a string or a list.
func (b graphButton) exampleText() string {
	if len(b.Example) == 0 {
		return ""
	}
	var one string
	if json.Unmarshal(b.Example, &one) == nil {
		return one
	}
	var many []string
	if json.Unmarshal(b.Example, &many) == nil && len(many) > 0 {
		return many[0]
	}
	return ""
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
		Language: strings.TrimSpace(string(t.Language)),
		Status:   strings.ToUpper(strings.TrimSpace(t.Status)),
		Category: strings.ToUpper(strings.TrimSpace(t.Category)),
	}
	reasons := []string{}
	for _, comp := range t.Components {
		switch strings.ToUpper(comp.Type) {
		case "BODY":
			out.Body = comp.Text
			out.Variables = len(placeholder.FindAllString(comp.Text, -1))
			if out.Category == "AUTHENTICATION" {
				out.Auth = &TemplateAuth{SecurityRecommendation: comp.AddSecurityRecommendation}
			}
		case "FOOTER":
			out.Footer = comp.Text
			if comp.CodeExpirationMinutes > 0 {
				if out.Auth == nil {
					out.Auth = &TemplateAuth{}
				}
				out.Auth.ExpirationMinutes = comp.CodeExpirationMinutes
			}
		case "HEADER":
			format := strings.ToUpper(strings.TrimSpace(comp.Format))
			out.HeaderFormat = format
			if format == "IMAGE" || format == "VIDEO" || format == "DOCUMENT" {
				/* Filled at send time with the host's file for this template (or, for an
				 * image, the webinar's cover). Whether a video or document header has a
				 * file yet is the app's to know, not Meta's, so it is checked there. */
				continue
			}
			if format != "" && format != "TEXT" {
				// LOCATION and anything newer: nothing here can fill it.
				reasons = append(reasons, "its header is "+strings.ToLower(format))
				continue
			}
			out.Header = comp.Text
			if placeholder.MatchString(comp.Text) {
				reasons = append(reasons, "its header has a variable in it")
			}
		case "BUTTONS":
			buttons, why := readButtons(comp.Buttons)
			out.Buttons = append(out.Buttons, buttons...)
			reasons = append(reasons, why...)
		case "LIMITED_TIME_OFFER":
			if comp.LimitedTimeOffer != nil {
				out.Offer = &TemplateOffer{Text: comp.LimitedTimeOffer.Text, HasExpiration: comp.LimitedTimeOffer.HasExpiration}
			}
		case "CAROUSEL":
			for _, card := range comp.Cards {
				var c TemplateCard
				for _, cc := range card.Components {
					switch strings.ToUpper(cc.Type) {
					case "HEADER":
						c.HeaderFormat = strings.ToUpper(strings.TrimSpace(cc.Format))
					case "BODY":
						c.Body = cc.Text
						c.Variables = len(placeholder.FindAllString(cc.Text, -1))
					case "BUTTONS":
						buttons, why := readButtons(cc.Buttons)
						c.Buttons = buttons
						reasons = append(reasons, why...)
					}
				}
				if c.HeaderFormat != "IMAGE" && c.HeaderFormat != "VIDEO" {
					reasons = append(reasons, "a carousel card's header is "+strings.ToLower(c.HeaderFormat))
				}
				if c.Variables > 0 {
					reasons = append(reasons, "a carousel card's text has a variable in it")
				}
				out.Cards = append(out.Cards, c)
			}
		}
	}
	if out.Category == "AUTHENTICATION" && out.Auth == nil {
		out.Auth = &TemplateAuth{}
	}
	if out.Body == "" && out.Auth == nil {
		reasons = append(reasons, "it has no body text")
	}
	if len(reasons) > 0 {
		out.Unsupported = "Can't be sent from here yet because " + strings.Join(reasons, ", ") + "."
	}
	return out
}

/* readButtons reads one BUTTONS component, and says why any of them cannot be sent
 * from here. Quick replies, links, phone numbers, copy-code coupons and copy-code OTPs
 * can; one-tap and zero-tap OTPs need an Android app this product does not have, and
 * flows, catalogs and anything newer need a builder it does not have either. */
func readButtons(in []graphButton) ([]TemplateButton, []string) {
	var out []TemplateButton
	var why []string
	for _, b := range in {
		bt := TemplateButton{
			Type:        strings.ToUpper(strings.TrimSpace(b.Type)),
			Text:        b.Text,
			URL:         b.URL,
			PhoneNumber: b.PhoneNumber,
			OTPType:     strings.ToUpper(strings.TrimSpace(b.OTPType)),
		}
		if bt.Type == "COPY_CODE" {
			bt.Example = b.exampleText()
		}
		if bt.Type == "URL" && placeholder.MatchString(b.URL) {
			bt.Dynamic = true
			// Only a variable at the very end can be filled: it is the part of the link
			// Meta lets a send supply.
			if !strings.HasSuffix(strings.TrimSpace(b.URL), "}}") {
				why = append(why, "one of its link buttons has a variable in the middle")
			}
		}
		switch bt.Type {
		case "QUICK_REPLY", "URL", "PHONE_NUMBER", "COPY_CODE":
		case "OTP":
			if bt.OTPType != "" && bt.OTPType != "COPY_CODE" {
				why = append(why, "its code button is "+strings.ToLower(strings.ReplaceAll(bt.OTPType, "_", "-"))+
					", which needs an Android app")
			}
		default:
			why = append(why, "it has a "+strings.ToLower(bt.Type)+" button")
		}
		out = append(out, bt)
	}
	return out, why
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
	// HeaderMedia fills an IMAGE, VIDEO or DOCUMENT header. Meta fetches the link when
	// the message is sent.
	HeaderMedia *HeaderMedia
	// URLButtons fills dynamic link buttons: the button's index on the template, and
	// the text that replaces its `{{1}}`.
	URLButtons []URLButtonParam
	// Coupon fills a COPY_CODE button: its index and the code the person copies.
	Coupon *CouponParam
	// OfferExpiresAt fills a limited-time offer that has an expiry. Zero for none.
	OfferExpiresAt time.Time
	// Cards fills a carousel template's cards, one per approved card and in order.
	Cards []OutgoingCard
}

// CouponParam is the code a COPY_CODE button copies.
type CouponParam struct {
	Index int
	Code  string
}

// OutgoingCard is one carousel card's values for one send.
type OutgoingCard struct {
	HeaderMedia *HeaderMedia
	BodyParams  []string
	URLButtons  []URLButtonParam
	// QuickReplies is the payload for each quick-reply button on the card, by index.
	QuickReplies []QuickReplyParam
}

// QuickReplyParam is the payload a quick-reply button returns when tapped.
type QuickReplyParam struct {
	Index   int
	Payload string
}

/* AuthCodeTemplate is a send of an AUTHENTICATION template carrying one code. Meta
 * wants the code twice: as the body's one variable, and as the copy-code button's
 * parameter (sub_type url, index 0) — see copy-code-button-authentication-templates. */
func AuthCodeTemplate(to, name, language, code string) OutgoingTemplate {
	return OutgoingTemplate{
		To: to, Name: name, Language: language,
		BodyParams: []string{code},
		URLButtons: []URLButtonParam{{Index: 0, Suffix: code}},
	}
}

// HeaderMedia is the file in a template's media header for one send.
type HeaderMedia struct {
	// Type is image, video or document (lower-case, as the send API spells it).
	Type string
	// Link is a public https URL Meta can fetch.
	Link string
	// Filename is what a document is called on the recipient's phone. Documents only.
	Filename string
}

// URLButtonParam is the variable part of one dynamic link button.
type URLButtonParam struct {
	Index  int
	Suffix string
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

	tmpl := map[string]any{
		"name":     strings.TrimSpace(msg.Name),
		"language": map[string]string{"code": lang},
	}
	if comps := templateComponents(msg); len(comps) > 0 {
		tmpl["components"] = comps
	}
	return c.send(ctx, token, phoneNumberID, map[string]any{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                to,
		"type":              "template",
		"template":          tmpl,
	})
}

/* templateComponents is the parameters a send supplies: the header file, the body's
 * values, a limited-time offer's expiry, the dynamic part of each link button, a
 * coupon, and a carousel's cards — in the shape Graph expects. */
func templateComponents(msg OutgoingTemplate) []map[string]any {
	var out []map[string]any
	if h := headerParam(msg.HeaderMedia); h != nil {
		out = append(out, h)
	}
	if b := bodyParam(msg.BodyParams); b != nil {
		out = append(out, b)
	}
	if !msg.OfferExpiresAt.IsZero() {
		out = append(out, map[string]any{
			"type": "limited_time_offer",
			"parameters": []map[string]any{{
				"type":               "limited_time_offer",
				"limited_time_offer": map[string]any{"expiration_time_ms": msg.OfferExpiresAt.UnixMilli()},
			}},
		})
	}
	out = append(out, urlButtonParams(msg.URLButtons)...)
	if c := msg.Coupon; c != nil && strings.TrimSpace(c.Code) != "" {
		out = append(out, map[string]any{
			"type":     "button",
			"sub_type": "copy_code",
			"index":    c.Index,
			"parameters": []map[string]any{{
				"type": "coupon_code", "coupon_code": strings.TrimSpace(c.Code),
			}},
		})
	}
	if len(msg.Cards) > 0 {
		cards := make([]map[string]any, 0, len(msg.Cards))
		for i, card := range msg.Cards {
			comps := []map[string]any{}
			if h := headerParam(card.HeaderMedia); h != nil {
				comps = append(comps, h)
			}
			if b := bodyParam(card.BodyParams); b != nil {
				comps = append(comps, b)
			}
			for _, q := range card.QuickReplies {
				comps = append(comps, map[string]any{
					"type": "button", "sub_type": "quick_reply", "index": q.Index,
					"parameters": []map[string]any{{"type": "payload", "payload": q.Payload}},
				})
			}
			comps = append(comps, urlButtonParams(card.URLButtons)...)
			cards = append(cards, map[string]any{"card_index": i, "components": comps})
		}
		out = append(out, map[string]any{"type": "carousel", "cards": cards})
	}
	return out
}

func headerParam(h *HeaderMedia) map[string]any {
	if h == nil || strings.TrimSpace(h.Link) == "" {
		return nil
	}
	kind := strings.ToLower(strings.TrimSpace(h.Type))
	media := map[string]string{"link": strings.TrimSpace(h.Link)}
	if kind == "document" && strings.TrimSpace(h.Filename) != "" {
		media["filename"] = strings.TrimSpace(h.Filename)
	}
	return map[string]any{
		"type":       "header",
		"parameters": []map[string]any{{"type": kind, kind: media}},
	}
}

func bodyParam(values []string) map[string]any {
	if len(values) == 0 {
		return nil
	}
	params := make([]map[string]any, 0, len(values))
	for _, v := range values {
		params = append(params, map[string]any{"type": "text", "text": v})
	}
	return map[string]any{"type": "body", "parameters": params}
}

func urlButtonParams(buttons []URLButtonParam) []map[string]any {
	out := make([]map[string]any, 0, len(buttons))
	for _, b := range buttons {
		out = append(out, map[string]any{
			"type":     "button",
			"sub_type": "url",
			"index":    fmt.Sprint(b.Index),
			"parameters": []map[string]any{{
				"type": "text", "text": b.Suffix,
			}},
		})
	}
	return out
}

/* URLSuffix is the part of link that fills a dynamic button approved as buttonURL: what
 * follows the fixed part before `{{1}}`. False when link does not start with it — the
 * button can only send people somewhere under the address Meta approved. */
func URLSuffix(buttonURL, link string) (string, bool) {
	loc := placeholder.FindStringIndex(buttonURL)
	if loc == nil {
		return "", false
	}
	prefix := buttonURL[:loc[0]]
	if !strings.HasPrefix(link, prefix) || len(link) == len(prefix) {
		return "", false
	}
	return link[len(prefix):], true
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

/* NewTemplate is one message template to submit to Meta for approval: the starter set
 * a host can create from here instead of writing each one in WhatsApp Manager, and the
 * host's own wording.
 *
 * Four shapes, all from developers.facebook.com/docs/whatsapp/business-management-api/
 * message-templates: a standard template (header, body, footer, buttons); a limited-time
 * offer (Offer set, MARKETING, no footer); a media card carousel (Cards set,
 * MARKETING, body above the cards); and an authentication template (Auth set,
 * AUTHENTICATION, no body text — Meta writes it). */
type NewTemplate struct {
	Name     string
	Language string
	// Category is UTILITY, MARKETING or AUTHENTICATION.
	Category string
	// Body with `{{1}}`-style variables, and one example value for each — Meta requires
	// them to review the template. Ignored for an authentication template.
	Body     string
	Examples []string
	Footer   string
	Buttons  []NewButton
	// Header is optional: fixed text, or a media header with a sample file's handle.
	Header *NewHeader
	// Offer makes this a limited-time offer template.
	Offer *NewOffer
	// Cards makes this a carousel: 2 to 10 cards of the same shape.
	Cards []NewCard
	// Auth makes this an authentication template.
	Auth *NewAuth
}

// NewHeader is a template header to submit.
type NewHeader struct {
	// Format is TEXT, IMAGE, VIDEO or DOCUMENT.
	Format string
	// Text for a TEXT header.
	Text string
	// Handle for a media header: from UploadHeaderSample, the sample Meta reviews.
	Handle string
}

// NewButton is one button on a template to submit.
type NewButton struct {
	// QUICK_REPLY, URL, PHONE_NUMBER or COPY_CODE.
	Type string
	Text string
	// For URL: the address (ending in `{{1}}` for a dynamic one), and an example of the
	// full link. For COPY_CODE: an example code, up to 15 characters.
	URL     string
	Example string
	// For PHONE_NUMBER: the number to call, with its country code.
	PhoneNumber string
}

// NewOffer is the limited-time offer part of a template.
type NewOffer struct {
	// Text is up to 16 characters, shown with the countdown.
	Text          string
	HasExpiration bool
}

// NewCard is one carousel card to submit.
type NewCard struct {
	// HeaderFormat is IMAGE or VIDEO, with a sample file's handle.
	HeaderFormat string
	Handle       string
	Body         string
	Buttons      []NewButton
}

// NewAuth is what an authentication template adds to Meta's fixed text.
type NewAuth struct {
	// SecurityRecommendation adds "For your security, do not share this code."
	SecurityRecommendation bool
	// ExpirationMinutes adds an expiry footer, 1 to 90. Zero for none.
	ExpirationMinutes int
	// ButtonText labels the copy-code button; Meta's own default when empty.
	ButtonText string
}

/* components is the template's components in the shape message_templates takes. */
func (t NewTemplate) components() ([]map[string]any, error) {
	if a := t.Auth; a != nil {
		body := map[string]any{"type": "BODY"}
		if a.SecurityRecommendation {
			body["add_security_recommendation"] = true
		}
		comps := []map[string]any{body}
		if a.ExpirationMinutes > 0 {
			comps = append(comps, map[string]any{"type": "FOOTER", "code_expiration_minutes": a.ExpirationMinutes})
		}
		btn := map[string]any{"type": "OTP", "otp_type": "COPY_CODE"}
		if strings.TrimSpace(a.ButtonText) != "" {
			btn["text"] = strings.TrimSpace(a.ButtonText)
		}
		return append(comps, map[string]any{"type": "BUTTONS", "buttons": []map[string]any{btn}}), nil
	}
	comps := []map[string]any{}
	if h := t.Header; h != nil {
		switch format := strings.ToUpper(strings.TrimSpace(h.Format)); format {
		case "TEXT":
			comps = append(comps, map[string]any{"type": "HEADER", "format": "TEXT", "text": h.Text})
		case "IMAGE", "VIDEO", "DOCUMENT":
			if h.Handle == "" {
				return nil, errors.New("a media header needs a sample file")
			}
			comps = append(comps, map[string]any{
				"type": "HEADER", "format": format,
				"example": map[string]any{"header_handle": []string{h.Handle}},
			})
		}
	}
	if o := t.Offer; o != nil {
		comps = append(comps, map[string]any{
			"type":               "LIMITED_TIME_OFFER",
			"limited_time_offer": map[string]any{"text": o.Text, "has_expiration": o.HasExpiration},
		})
	}
	body := map[string]any{"type": "BODY", "text": t.Body}
	if len(t.Examples) > 0 {
		body["example"] = map[string]any{"body_text": [][]string{t.Examples}}
	}
	comps = append(comps, body)
	if t.Footer != "" && t.Offer == nil && len(t.Cards) == 0 {
		comps = append(comps, map[string]any{"type": "FOOTER", "text": t.Footer})
	}
	if len(t.Buttons) > 0 {
		comps = append(comps, map[string]any{"type": "BUTTONS", "buttons": buttonsJSON(t.Buttons)})
	}
	if len(t.Cards) > 0 {
		cards := make([]map[string]any, 0, len(t.Cards))
		for _, c := range t.Cards {
			if c.Handle == "" {
				return nil, errors.New("every carousel card needs its image or video")
			}
			cc := []map[string]any{
				{"type": "HEADER", "format": strings.ToUpper(c.HeaderFormat),
					"example": map[string]any{"header_handle": []string{c.Handle}}},
				{"type": "BODY", "text": c.Body},
			}
			if len(c.Buttons) > 0 {
				cc = append(cc, map[string]any{"type": "BUTTONS", "buttons": buttonsJSON(c.Buttons)})
			}
			cards = append(cards, map[string]any{"components": cc})
		}
		comps = append(comps, map[string]any{"type": "CAROUSEL", "cards": cards})
	}
	return comps, nil
}

func buttonsJSON(in []NewButton) []map[string]any {
	btns := make([]map[string]any, 0, len(in))
	for _, b := range in {
		m := map[string]any{"type": b.Type}
		switch b.Type {
		case "URL":
			m["text"] = b.Text
			m["url"] = b.URL
			if b.Example != "" {
				m["example"] = []string{b.Example}
			}
		case "PHONE_NUMBER":
			m["text"] = b.Text
			m["phone_number"] = b.PhoneNumber
		case "COPY_CODE":
			// No text: WhatsApp labels it "Copy offer code" itself.
			m["example"] = b.Example
		default:
			m["text"] = b.Text
		}
		btns = append(btns, m)
	}
	return btns
}

/* CreateTemplate submits a template for approval on the host's WhatsApp Business
 * Account and returns Meta's status for it (usually PENDING, sometimes APPROVED at once).
 * A name that already exists in that language comes back as Graph's own error. */
func (c *Client) CreateTemplate(ctx context.Context, token, wabaID string, t NewTemplate) (string, error) {
	if strings.TrimSpace(token) == "" {
		return "", ErrNotConnected
	}
	id := strings.TrimSpace(wabaID)
	if id == "" {
		return "", errors.New("no WhatsApp Business Account id to create the template on")
	}
	comps, err := t.components()
	if err != nil {
		return "", err
	}
	var res struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := c.post(ctx, token, "/"+url.PathEscape(id)+"/message_templates", map[string]any{
		"name":       t.Name,
		"language":   t.Language,
		"category":   t.Category,
		"components": comps,
	}, &res); err != nil {
		return "", err
	}
	return strings.ToUpper(res.Status), nil
}
