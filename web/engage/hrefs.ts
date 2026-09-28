/** WhatsApp setup — not in the nav; reached from Account settings. */
export const ENGAGE_HOME = "/host/crm";

/** Audience is a tab on Your webinars. */
export const PEOPLE_HREF = "/host?tab=people";

/** The standalone WhatsApp inbox. Not a tab on Your webinars — the top bar's
 *  chat icon opens it, and a back link returns to /host. */
export const MESSAGES_HREF = "/host/messages";

/** The inbox, optionally opened on one conversation. */
export function messagesHref(contactId = ""): string {
  if (!contactId) return MESSAGES_HREF;
  return `${MESSAGES_HREF}?contact=${encodeURIComponent(contactId)}`;
}
