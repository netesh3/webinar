/** WhatsApp setup — not in the nav; reached from Account settings. */
export const ENGAGE_HOME = "/host/crm";

/** Query value that opens the new-automation editor on the Automations tab. */
export const NEW_AUTOMATION_ID = "new";

/** Automations tab. With an id, also opens that recipe or the new-automation editor. */
export function automationsHref(automation?: string): string {
  const view = `${ENGAGE_HOME}?view=automations`;
  if (!automation) return view;
  return `${view}&automation=${encodeURIComponent(automation)}`;
}

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
