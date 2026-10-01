/** WhatsApp setup — not in the nav; reached from Account settings. */
export const ENGAGE_HOME = "/host/crm";

/** Audience, its own page. Old /host?tab=people links redirect here. */
export const PEOPLE_HREF = "/host/audience";

/** Audience narrowed to one webinar. */
export function audienceHref(webinar = ""): string {
  const id = webinar.trim();
  if (!id) return PEOPLE_HREF;
  return `${PEOPLE_HREF}?webinar=${encodeURIComponent(id)}`;
}

/** The standalone WhatsApp inbox. Not a tab on Your webinars — the top bar's
 *  chat icon opens it, and a back link returns to /host. */
export const MESSAGES_HREF = "/host/messages";

/** The inbox, optionally opened on one conversation. */
export function messagesHref(contactId = ""): string {
  if (!contactId) return MESSAGES_HREF;
  return `${MESSAGES_HREF}?contact=${encodeURIComponent(contactId)}`;
}
