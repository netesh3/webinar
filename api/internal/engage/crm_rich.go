package engage

import (
	"context"
	"strings"

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
	m crmstore.WhatsAppOutbound, webinars map[string]*types.Webinar) string {
	needsImage := tmpl.HeaderFormat == "IMAGE"
	dynamic := false
	for _, b := range tmpl.Buttons {
		dynamic = dynamic || b.Dynamic
	}
	if !needsImage && !dynamic {
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
	if needsImage {
		out.HeaderImage = s.coverURL(wb)
	}
	if dynamic {
		link := m.LinkURL
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
		for i, b := range tmpl.Buttons {
			if !b.Dynamic {
				continue
			}
			suffix, ok := wa.URLSuffix(b.URL, link)
			if !ok {
				return "template " + tmpl.Name + "'s " + b.Text + " button goes to " + b.URL +
					", which is not where this app's links are (" + s.publicBase() + ")"
			}
			out.URLButtons = append(out.URLButtons, wa.URLButtonParam{Index: i, Suffix: suffix})
		}
	}
	return ""
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
