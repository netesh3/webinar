package engage

import (
	"net/http"
	"time"

	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/types"
)

/* How far along a host is in making WhatsApp work.
 *
 * This endpoint exists because the feature has a setup path nobody can see. A host has
 * to connect their Meta account, register the number, get templates approved by Meta,
 * sync them here, choose one per automatic message, choose a merge field per {{n}}, and
 * then turn the switch on for each webinar — and three of those steps fail silently.
 * A missing template is skipped at queue time with no error anywhere; an unregistered
 * number fails on the first send; the per-webinar switch defaults to off. The result was
 * a host who had done most of the work, was sending nothing, and had no way to find out
 * which step was the one stopping it.
 *
 * So the server answers it in one place. Not because the browser could not add up four
 * other responses, but because "done" is a rule this side owns — a template Meta paused
 * yesterday stops being sendable, and a reminder pointing at it is neither set nor
 * unset — and because four requests can render a half-updated mix of each other.
 *
 * Nothing here is a write, and nothing here is a nag. It reports what is true and lets
 * the screen decide what to say about it.
 */
func (s *Module) handleCRMSetup(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())

	out := types.CRMSetup{
		Connected:    user.WhatsAppToken != "",
		DisplayPhone: user.WhatsAppDisplayPhone,
		VerifiedName: user.WhatsAppVerifiedName,
		/* Whether registering the number is this host's step at all, from the same
		 * per-account switch that decides whether the form is rendered — so the
		 * checklist cannot count a step the host has no button for. */
		RegisterStep:   user.HasFeature(types.FeatureWhatsAppRegister),
		RemindersTotal: len(types.WhatsAppReminderKinds),
	}
	if user.WhatsAppRegisteredAt != nil {
		out.RegisteredAt = user.WhatsAppRegisteredAt.Format(time.RFC3339)
	}

	/* Templates from the cache, never from Meta.
	 *
	 * handleCRMTemplates syncs when there is nothing cached; this deliberately does
	 * not. A checklist is read on arrival at the CRM, and making that arrival wait on a
	 * Graph round trip — one that Meta rate-limits per WABA — would slow down every
	 * visit to pre-empt a step the host is about to press a button for anyway.
	 */
	templates, syncedAt, err := s.store.Templates(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "crm setup: templates", err)
		return
	}
	sendable := map[string]bool{}
	for _, t := range templates {
		if t.Sendable {
			out.SendableTemplates++
			// Keyed by both halves of a template's identity: the same template is
			// approved once per translation and a send names both, so a reminder set to
			// a language Meta has not approved is as broken as one naming no template.
			sendable[t.Name+"\x00"+t.Language] = true
		}
	}
	out.Templates = len(templates)
	if !syncedAt.IsZero() {
		out.TemplatesSyncedAt = syncedAt.Format(time.RFC3339)
	}

	/* A reminder counts as set only if the template it names can still be sent.
	 *
	 * The two outcomes are reported separately on purpose. "Not configured" is work the
	 * host has not done; "configured against a template Meta no longer approves" is
	 * work they did that has since stopped working, and it is the state the product is
	 * worst at revealing — the send is skipped in silence, so from the host's side the
	 * setting looks finished and the message simply never arrives.
	 */
	reminders, err := s.store.ReminderTemplates(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "crm setup: reminders", err)
		return
	}
	for _, rem := range reminders {
		if rem.Template == "" {
			continue
		}
		if sendable[rem.Template+"\x00"+rem.Language] {
			out.RemindersSet++
			continue
		}
		out.RemindersBroken = append(out.RemindersBroken, rem.Kind)
	}

	withReminders, total, err := s.store.WebinarReminderCounts(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "crm setup: webinars", err)
		return
	}
	out.WebinarsWithReminders, out.WebinarsTotal = withReminders, total

	/* The one number that says whether any of the above can reach anybody, and it comes
	 * from AudienceCounts rather than a count of its own — the same query the host reads
	 * before spending their own money on a broadcast. Two ways of counting "who can be
	 * messaged" is how a checklist ends up disagreeing with the send screen. */
	audience, err := s.store.AudienceCounts(r.Context(), user.ID, types.AudienceOptedIn, "", "")
	if err != nil {
		s.fail(w, r, "crm setup: audience", err)
		return
	}
	out.OptedInContacts = audience.Recipients

	httpx.JSON(w, http.StatusOK, out)
}
