package engage

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/internal/wa"
	"github.com/netkumar/webcast/api/types"
)

/* The template editor's rules: every shape and button WhatsApp offers that a coach can
 * use, checked here before anything reaches Meta so the coach reads the reason in plain
 * words instead of a Graph error code.
 *
 * Limits are Meta's (developers.facebook.com/docs/whatsapp/business-management-api/
 * message-templates, …/components, …/authentication-templates, …/limited-time-offer-
 * templates, …/media-card-carousel-templates):
 *
 *   body 1024 (600 on a limited-time offer), footer 60 with no variables,
 *   buttons: 10 in all, quick replies 10 and kept together, links 2, phone 1, copy-code 1;
 *   quick reply and link text 25, phone text 20 (this editor), coupon 15;
 *   offer line 16, MARKETING only, no footer, a copy-code or link button required;
 *   carousel 2–10 cards, MARKETING only, each an image or video, card text 160, up to
 *   two buttons, every card the same shape;
 *   authentication: no body text (Meta writes it), expiry 1–90 minutes, one copy-code
 *   button — one-tap and zero-tap need an Android app this product does not have.
 *
 * Not offered: Flows, catalogs, location headers, named {{name}} variables. */

// templateLanguages are the languages the editor offers, as Meta's codes.
var templateLanguages = []struct{ Code, Label string }{
	{"en", "English"}, {"hi", "Hindi"}, {"ta", "Tamil"}, {"te", "Telugu"},
	{"mr", "Marathi"}, {"bn", "Bengali"}, {"kn", "Kannada"}, {"ml", "Malayalam"},
	{"gu", "Gujarati"}, {"pa", "Punjabi"}, {"ur", "Urdu"}, {"en_US", "English (US)"},
}

func knownLanguage(code string) bool {
	for _, l := range templateLanguages {
		if l.Code == code {
			return true
		}
	}
	return false
}

const (
	maxTemplateButtons = 10
	maxQuickReplies    = 10
	maxURLButtons      = 2
	maxButtonText      = 25
	maxPhoneText       = 20
	maxCouponCode      = 15
	maxFooter          = 60
	maxOfferText       = 16
	maxOfferBody       = 600
	maxCardBody        = 160
	maxCardButtons     = 2
	minCards           = 2
	maxCards           = 10
	defaultFooter      = "Reply STOP to opt out"
)

var (
	phoneDigits = regexp.MustCompile(`^\+[1-9][0-9]{6,14}$`)
	couponChars = regexp.MustCompile(`^[A-Za-z0-9]+$`)
)

// wordingPlan is a request checked and turned into what Meta is sent, plus what is
// kept here (the coupon sent by default, the card pictures).
type wordingPlan struct {
	tmpl        wa.NewTemplate
	coupon      string
	cardFileIDs []string
	cardAspect  string
	// params is the field mapping saved with the template: one per blank, or none.
	params []types.CRMParam
}

type wordingError struct{ code, msg string }

func (e wordingError) Error() string { return e.msg }

func wrong(code, format string, args ...any) error {
	return wordingError{code: code, msg: fmt.Sprintf(format, args...)}
}

/* planWording checks a template written in the editor and builds what to submit. The
 * header and card files are resolved by the caller (they need the store and Meta);
 * everything else is decided here. base is this app's public origin, for the example
 * of a link button that carries the person's own join link. */
func planWording(req types.CRMWordingRequest, base string) (wordingPlan, error) {
	category := strings.ToUpper(strings.TrimSpace(req.Category))
	if category == "" {
		category = "UTILITY"
	}
	switch category {
	case "UTILITY", "MARKETING", "AUTHENTICATION":
	default:
		return wordingPlan{}, wrong("invalid_category", "Choose Utility, Marketing or Authentication.")
	}
	lang := strings.TrimSpace(req.Language)
	if lang == "" {
		lang = "en"
	}
	if !knownLanguage(lang) {
		return wordingPlan{}, wrong("invalid_language", "Choose one of the listed languages.")
	}
	plan := wordingPlan{tmpl: wa.NewTemplate{Language: lang, Category: category}}

	if category == "AUTHENTICATION" || req.Auth != nil {
		if category != "AUTHENTICATION" {
			return wordingPlan{}, wrong("invalid_category", "A one-time code template is an Authentication template.")
		}
		if strings.TrimSpace(req.Body) != "" || req.Offer != nil || len(req.Cards) > 0 || len(req.Buttons) > 0 ||
			(req.Header != nil && !strings.EqualFold(req.Header.Format, "NONE") && req.Header.Format != "") {
			return wordingPlan{}, wrong("invalid_auth",
				"WhatsApp writes an authentication template's message itself: \"<code> is your verification code.\" Leave the text, header and buttons empty.")
		}
		a := types.CRMAuthInput{}
		if req.Auth != nil {
			a = *req.Auth
		}
		if a.ExpirationMinutes < 0 || a.ExpirationMinutes > 90 {
			return wordingPlan{}, wrong("invalid_auth", "The code can expire after 1 to 90 minutes, or leave it off.")
		}
		text := strings.TrimSpace(a.ButtonText)
		if utf8.RuneCountInString(text) > maxButtonText {
			return wordingPlan{}, wrong("invalid_auth", "Keep the button text to %d characters.", maxButtonText)
		}
		plan.tmpl.Auth = &wa.NewAuth{
			SecurityRecommendation: a.SecurityRecommendation,
			ExpirationMinutes:      a.ExpirationMinutes,
			ButtonText:             text,
		}
		return plan, nil
	}

	body := strings.TrimSpace(req.Body)
	bodyMax := 1024
	if req.Offer != nil {
		bodyMax = maxOfferBody
	}
	if body == "" || utf8.RuneCountInString(body) > bodyMax {
		return wordingPlan{}, wrong("invalid_body", "Write the message, up to %d characters.", bodyMax)
	}
	examples, err := bodyExamples(body)
	if err != nil {
		return wordingPlan{}, wrong("invalid_body", "%s", err.Error())
	}
	plan.params = wordingParams(body, len(examples), req.Params)
	for i, p := range plan.params {
		if ex := paramExample(p); ex != "" {
			examples[i] = ex
		}
	}
	plan.tmpl.Body, plan.tmpl.Examples = body, examples

	// Footer: absent keeps the opt-out line; "" removes it.
	footer := defaultFooter
	if req.Footer != nil {
		footer = strings.Join(strings.Fields(*req.Footer), " ")
	}
	if utf8.RuneCountInString(footer) > maxFooter || anyPlaceholder.MatchString(footer) {
		return wordingPlan{}, wrong("invalid_footer", "The footer is up to %d characters, with no {{1}} blanks.", maxFooter)
	}

	buttons, coupon, err := planButtons(req.Buttons, base)
	if err != nil {
		return wordingPlan{}, err
	}
	plan.coupon = coupon

	switch {
	case req.Offer != nil:
		if category != "MARKETING" {
			return wordingPlan{}, wrong("invalid_offer", "A limited-time offer is a Marketing template.")
		}
		if len(req.Cards) > 0 {
			return wordingPlan{}, wrong("invalid_offer", "A template is either an offer or a carousel, not both.")
		}
		text := strings.TrimSpace(req.Offer.Text)
		if text == "" || utf8.RuneCountInString(text) > maxOfferText {
			return wordingPlan{}, wrong("invalid_offer", "Write the offer line, up to %d characters — like \"20%% off\".", maxOfferText)
		}
		hasAction := false
		for _, b := range buttons {
			hasAction = hasAction || b.Type == "COPY_CODE" || b.Type == "URL"
		}
		if !hasAction {
			return wordingPlan{}, wrong("invalid_offer", "A limited-time offer needs a coupon (copy-code) button or a link button.")
		}
		if h := req.Header; h != nil {
			if f := strings.ToUpper(strings.TrimSpace(h.Format)); f != "" && f != "NONE" && f != "IMAGE" && f != "VIDEO" {
				return wordingPlan{}, wrong("invalid_header", "A limited-time offer's header is an image or a video.")
			}
		}
		plan.tmpl.Offer = &wa.NewOffer{Text: text, HasExpiration: req.Offer.HasExpiration}
		footer = "" // Meta: no footer on a limited-time offer.
	case len(req.Cards) > 0:
		if category != "MARKETING" {
			return wordingPlan{}, wrong("invalid_cards", "A carousel is a Marketing template.")
		}
		if len(req.Cards) < minCards || len(req.Cards) > maxCards {
			return wordingPlan{}, wrong("invalid_cards", "A carousel has %d to %d cards.", minCards, maxCards)
		}
		if len(buttons) > 0 {
			return wordingPlan{}, wrong("invalid_cards", "In a carousel the buttons go on the cards, not under the message.")
		}
		if h := req.Header; h != nil && h.Format != "" && !strings.EqualFold(h.Format, "NONE") {
			return wordingPlan{}, wrong("invalid_cards", "A carousel has no header above the message; each card has its own picture.")
		}
		aspect := strings.TrimSpace(req.CardAspect)
		if aspect != aspectSquare && aspect != aspectWide {
			return wordingPlan{}, wrong("invalid_cards", "Choose square or wide pictures for the cards.")
		}
		plan.cardAspect = aspect
		var shape string
		for i, c := range req.Cards {
			cb := strings.TrimSpace(c.Body)
			if cb == "" || utf8.RuneCountInString(cb) > maxCardBody {
				return wordingPlan{}, wrong("invalid_cards", "Card %d needs its text, up to %d characters.", i+1, maxCardBody)
			}
			if anyPlaceholder.MatchString(cb) {
				return wordingPlan{}, wrong("invalid_cards", "Card %d's text can't have {{1}} blanks.", i+1)
			}
			if strings.TrimSpace(c.FileID) == "" {
				return wordingPlan{}, wrong("invalid_cards", "Card %d needs its picture or video.", i+1)
			}
			if len(c.Buttons) > maxCardButtons {
				return wordingPlan{}, wrong("invalid_cards", "A card has up to %d buttons.", maxCardButtons)
			}
			cardButtons, _, err := planButtons(c.Buttons, base)
			if err != nil {
				return wordingPlan{}, err
			}
			kinds := []string{}
			for _, b := range cardButtons {
				if b.Type == "COPY_CODE" {
					return wordingPlan{}, wrong("invalid_cards", "Card buttons are quick replies, links or phone numbers.")
				}
				kinds = append(kinds, b.Type)
			}
			sig := strings.Join(kinds, ",")
			if i == 0 {
				shape = sig
			} else if sig != shape {
				return wordingPlan{}, wrong("invalid_cards",
					"Every card needs the same buttons in the same order — WhatsApp shows them as one set.")
			}
			plan.tmpl.Cards = append(plan.tmpl.Cards, wa.NewCard{Body: cb, Buttons: cardButtons})
			plan.cardFileIDs = append(plan.cardFileIDs, strings.TrimSpace(c.FileID))
		}
		footer = ""
	}
	plan.tmpl.Footer = footer
	plan.tmpl.Buttons = buttons
	return plan, nil
}

/* planButtons checks a row of buttons against Meta's counts and lengths, and returns
 * them for Meta plus the coupon a copy-code button is submitted with. */
func planButtons(in []types.CRMButtonInput, base string) ([]wa.NewButton, string, error) {
	if len(in) > maxTemplateButtons {
		return nil, "", wrong("invalid_buttons", "A template has up to %d buttons.", maxTemplateButtons)
	}
	var (
		out                          []wa.NewButton
		coupon                       string
		quick, links, phones, copies int
		quickClosed                  bool
	)
	for i, b := range in {
		t := strings.ToUpper(strings.TrimSpace(b.Type))
		text := strings.TrimSpace(b.Text)
		n := i + 1
		if t != "QUICK_REPLY" && quick > 0 {
			quickClosed = true
		}
		switch t {
		case "QUICK_REPLY":
			if quickClosed {
				return nil, "", wrong("invalid_buttons", "Keep the quick-reply buttons together, before or after the others.")
			}
			quick++
			if text == "" || utf8.RuneCountInString(text) > maxButtonText {
				return nil, "", wrong("invalid_buttons", "Button %d needs its text, up to %d characters.", n, maxButtonText)
			}
			out = append(out, wa.NewButton{Type: t, Text: text})
		case "URL":
			links++
			raw := strings.TrimSpace(b.URL)
			if text == "" || utf8.RuneCountInString(text) > maxButtonText {
				return nil, "", wrong("invalid_buttons", "Button %d needs its text, up to %d characters.", n, maxButtonText)
			}
			if !(strings.HasPrefix(raw, "https://") || strings.HasPrefix(raw, "http://")) || len(raw) > 2000 {
				return nil, "", wrong("invalid_buttons", "Button %d's link must start with https://.", n)
			}
			nb := wa.NewButton{Type: t, Text: text, URL: raw}
			if anyPlaceholder.MatchString(raw) {
				if !strings.HasSuffix(raw, "{{1}}") || strings.Count(raw, "{{") != 1 {
					return nil, "", wrong("invalid_buttons", "A link can end in {{1}} for the person's own link, and nowhere else.")
				}
				nb.Example = strings.TrimSuffix(raw, "{{1}}") + "example"
				if strings.HasPrefix(raw, base) {
					nb.Example = base + "/webinars/your-webinar/room?k=example"
				}
			}
			out = append(out, nb)
		case "PHONE_NUMBER":
			phones++
			num := strings.NewReplacer(" ", "", "-", "", "(", "", ")", "").Replace(strings.TrimSpace(b.PhoneNumber))
			if text == "" || utf8.RuneCountInString(text) > maxPhoneText {
				return nil, "", wrong("invalid_buttons", "Button %d needs its text, up to %d characters.", n, maxPhoneText)
			}
			if !phoneDigits.MatchString(num) {
				return nil, "", wrong("invalid_buttons", "Button %d's number needs its country code, like +91 98765 43210.", n)
			}
			out = append(out, wa.NewButton{Type: t, Text: text, PhoneNumber: num})
		case "COPY_CODE":
			copies++
			code := strings.TrimSpace(b.Code)
			if code == "" || len(code) > maxCouponCode || !couponChars.MatchString(code) {
				return nil, "", wrong("invalid_buttons", "The coupon is up to %d letters and numbers, like SAVE20.", maxCouponCode)
			}
			coupon = code
			out = append(out, wa.NewButton{Type: t, Example: code})
		default:
			return nil, "", wrong("invalid_buttons", "A button is a quick reply, a link, a phone number or a coupon.")
		}
	}
	switch {
	case quick > maxQuickReplies:
		return nil, "", wrong("invalid_buttons", "Up to %d quick replies.", maxQuickReplies)
	case links > maxURLButtons:
		return nil, "", wrong("invalid_buttons", "Up to %d link buttons.", maxURLButtons)
	case phones > 1:
		return nil, "", wrong("invalid_buttons", "One phone-number button.")
	case copies > 1:
		return nil, "", wrong("invalid_buttons", "One coupon button.")
	}
	return out, coupon, nil
}

// layoutOf is the parts of a synced template beyond header, body, footer and buttons.
func layoutOf(t wa.Template) crmstore.TemplateLayout {
	var l crmstore.TemplateLayout
	if t.Offer != nil {
		l.Offer = &types.CRMTemplateOffer{Text: t.Offer.Text, HasExpiration: t.Offer.HasExpiration}
	}
	for _, c := range t.Cards {
		l.Cards = append(l.Cards, types.CRMTemplateCard{
			HeaderFormat: c.HeaderFormat, Body: c.Body, Buttons: templateButtons(c.Buttons),
		})
	}
	if t.Auth != nil {
		l.Auth = &types.CRMTemplateAuth{SecurityRecommendation: t.Auth.SecurityRecommendation, ExpirationMinutes: t.Auth.ExpirationMinutes}
	}
	return l
}

/* authNotSendable is why an authentication template is not offered for broadcasts,
 * reminders or replies: it carries one person's one-time code, which only a sign-in
 * flow has. Webinar Liv sends its own for phone verification. */
const authNotSendable = "Authentication templates carry a one-time code for one person, so they can't go in broadcasts, reminders or replies."
