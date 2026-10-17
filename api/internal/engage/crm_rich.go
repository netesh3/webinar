package engage

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/internal/wa"
	"github.com/netkumar/webcast/api/types"
)

/* Rich templates: the parts of a send beyond the body. See migrations/0064.
 *
 * An IMAGE header is the webinar's cover (or the brand mark when it has none). A dynamic
 * link button is the person's own link — their join link before the webinar, the replay
 * after — cut to the part after the address Meta approved. Anything that cannot be filled
 * is a reason to skip the row, the same as a template that stopped being approved. */

// publicBase is where Meta can fetch this app's pages and images from.
func (s *Module) publicBase() string {
	return strings.TrimRight(s.cfg.WebBaseURL, "/")
}

// joinLink is one registrant's personal join link, or the webinar page without one.
// A Zoom session uses that person's Zoom join_url when we have one.
func (s *Module) joinLink(ctx context.Context, slug, registrationID string) string {
	if registrationID != "" {
		if u, err := s.store.RegistrationZoomJoin(ctx, registrationID); err == nil && u != "" {
			return u
		}
	}
	return s.roomLink(ctx, slug, registrationID)
}

func (s *Module) roomLink(ctx context.Context, slug, registrationID string) string {
	base := s.publicBase() + "/webinars/" + slug
	if registrationID == "" {
		return base
	}
	key, err := s.store.JoinKeyForRegistration(ctx, registrationID)
	if err != nil || key == "" {
		return base
	}
	return base + "/room?k=" + key
}

func (s *Module) fillRich(ctx context.Context, out *wa.OutgoingTemplate, tmpl types.CRMTemplate,
	hostID string, m crmstore.WhatsAppOutbound, webinars map[string]*types.Webinar) string {
	if tmpl.Auth != nil {
		return authNotSendable
	}
	needsMedia := tmpl.HeaderFormat == "IMAGE" || tmpl.HeaderFormat == "VIDEO" || tmpl.HeaderFormat == "DOCUMENT"
	dynamic, coupon := false, -1
	for i, b := range tmpl.Buttons {
		dynamic = dynamic || b.Dynamic
		if b.Type == "COPY_CODE" {
			coupon = i
		}
	}
	for _, c := range tmpl.Cards {
		for _, b := range c.Buttons {
			dynamic = dynamic || b.Dynamic
		}
	}
	offer := tmpl.Offer != nil && tmpl.Offer.HasExpiration
	if !needsMedia && !dynamic && coupon < 0 && !offer && len(tmpl.Cards) == 0 {
		return ""
	}
	var wb *types.Webinar
	if m.WebinarSlug != "" {
		if cached, ok := webinars[m.WebinarSlug]; ok {
			wb = cached
		} else if loaded, err := s.store.WebinarBySlug(ctx, m.WebinarSlug); err == nil {
			wb = &loaded
			webinars[m.WebinarSlug] = wb
		}
	}
	// A broadcast's own choices: coupon, offer end, card pictures.
	var own crmstore.BroadcastHeader
	if m.BroadcastID != "" && (coupon >= 0 || offer || len(tmpl.Cards) > 0) {
		h, err := s.store.BroadcastHeaderFor(ctx, m.BroadcastID)
		if err != nil {
			s.log.Warn("whatsapp send: broadcast choices", "broadcast", m.BroadcastID, "error", err)
		}
		own = h
	}
	if needsMedia {
		media, reason := s.headerFor(ctx, tmpl, hostID, m, wb)
		if reason != "" {
			return reason
		}
		out.HeaderMedia = media
	}
	if offer {
		if own.OfferExpiresAt == nil {
			return "template " + tmpl.Name + " is a limited-time offer and needs an end date — send it as a broadcast"
		}
		if !own.OfferExpiresAt.After(time.Now()) {
			return "the offer in " + tmpl.Name + " has already ended"
		}
		out.OfferExpiresAt = *own.OfferExpiresAt
	}
	if coupon >= 0 {
		code := own.Coupon
		if code == "" {
			code = tmpl.CouponCode
		}
		if code == "" {
			code = tmpl.Buttons[coupon].Example
		}
		if code == "" {
			return "template " + tmpl.Name + " has a coupon button and no coupon — set one on the broadcast"
		}
		out.Coupon = &wa.CouponParam{Index: coupon, Code: code}
	}
	link := ""
	if dynamic {
		link = m.LinkURL
		/* A Zoom join_url is not on this app's domain, and a WhatsApp button
		 * can only extend the template's own URL. The room route redirects
		 * this registrant to that same personal link. */
		if link != "" && m.WebinarSlug != "" && !strings.HasPrefix(link, s.publicBase()) {
			link = s.roomLink(ctx, m.WebinarSlug, m.RegistrationID)
		}
		if link == "" {
			if wb == nil {
				return "template " + tmpl.Name + " has a link button and this message is not about a webinar"
			}
			link = s.publicBase() + "/webinars/" + wb.ID
		}
		params, reason := linkParams(tmpl.Name, tmpl.Buttons, link, s.publicBase())
		if reason != "" {
			return reason
		}
		out.URLButtons = params
	}
	if len(tmpl.Cards) > 0 {
		files := own.CardFiles
		if len(files) == 0 {
			full, err := s.store.TemplateWithFile(ctx, hostID, tmpl.Name, tmpl.Language)
			if err != nil {
				return "template " + tmpl.Name + "'s card pictures could not be read"
			}
			files = full.CardFiles
		}
		if len(files) != len(tmpl.Cards) {
			return "template " + tmpl.Name + " needs a picture for each of its " + fmt.Sprint(len(tmpl.Cards)) + " cards"
		}
		for i, c := range tmpl.Cards {
			kind := strings.ToLower(c.HeaderFormat)
			if headerMediaTypes[files[i].Mime].kind != kind {
				return "card " + fmt.Sprint(i+1) + " of " + tmpl.Name + " needs a " + kind
			}
			card := wa.OutgoingCard{HeaderMedia: &wa.HeaderMedia{Type: kind, Link: s.fileURL(files[i])}}
			for j, b := range c.Buttons {
				if b.Type == "QUICK_REPLY" {
					card.QuickReplies = append(card.QuickReplies, wa.QuickReplyParam{Index: j, Payload: b.Text})
				}
			}
			if link != "" {
				params, reason := linkParams(tmpl.Name, c.Buttons, link, s.publicBase())
				if reason != "" {
					return reason
				}
				card.URLButtons = params
			}
			out.Cards = append(out.Cards, card)
		}
	}
	return ""
}

/* linkParams is the person's own link for each dynamic link button, cut to the part
 * after the address Meta approved. */
func linkParams(name string, buttons []types.CRMTemplateButton, link, base string) ([]wa.URLButtonParam, string) {
	var out []wa.URLButtonParam
	for i, b := range buttons {
		if !b.Dynamic {
			continue
		}
		suffix, ok := wa.URLSuffix(b.URL, link)
		if !ok {
			return nil, "template " + name + "'s " + b.Text + " button goes to " + b.URL +
				", which is not where this app's links are (" + base + ")"
		}
		out = append(out, wa.URLButtonParam{Index: i, Suffix: suffix})
	}
	return out, ""
}

// coverURL is the webinar's cover image as a public link, or the brand mark.
func (s *Module) coverURL(wb *types.Webinar) string {
	if wb != nil && wb.ImageURL != "" {
		if strings.HasPrefix(wb.ImageURL, "http") {
			return wb.ImageURL
		}
		return s.publicBase() + wb.ImageURL
	}
	return s.publicBase() + "/brand/mark.png"
}

// latestWebinarSlug is the host's newest webinar, for a send that names none.
func (s *Module) latestWebinarSlug(ctx context.Context, hostID string) string {
	slug, _, err := s.store.LatestWebinar(ctx, hostID)
	if err != nil {
		return ""
	}
	return slug
}
