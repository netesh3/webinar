package types

/* The company's addresses at webinarliv.com. Every one of them reaches the team
 * inbox, and the team can reply from each, so they differ only in what they are
 * for. Defined once here; tygo copies them into web/lib/api-types.ts, which
 * web/lib/contact.ts reads, so the API and the web app cannot drift.
 *
 * Transactional mail is still sent From SMTP_FROM (noreply@webinarliv.com).
 * These are Reply-To and mailto: addresses only. (29 Oct 2026)
 */
const (
	// ContactSupport is product help: accounts, webinars, the app.
	ContactSupport = "support@webinarliv.com"
	// ContactHello is general enquiries, including sales.
	ContactHello = "hello@webinarliv.com"
	// ContactBilling is invoices, payments, refunds and GST.
	ContactBilling = "billing@webinarliv.com"
	// ContactInvite is the Reply-To on invitations and event mail sent on a host's behalf.
	ContactInvite = "invite@webinarliv.com"
	// ContactSecurity is vulnerability reports and account security alerts.
	ContactSecurity = "security@webinarliv.com"
	// ContactPrivacy is data access and deletion requests, and the DPDP/GDPR and grievance contact.
	ContactPrivacy = "privacy@webinarliv.com"
	// ContactLegal is terms, legal notices and takedowns.
	ContactLegal = "legal@webinarliv.com"
	// ContactAbuse is reports of spam or abusive webinars and hosts.
	ContactAbuse = "abuse@webinarliv.com"
	// ContactPartners is affiliates, resellers and integrations.
	ContactPartners = "partners@webinarliv.com"
)
