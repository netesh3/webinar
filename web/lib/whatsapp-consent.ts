/* Whether registering a signed-in person needs the phone + WhatsApp popup first.
 *
 * Consent is per coach and is asked again for every webinar where this coach may
 * not yet message them; a phone is needed either way, because registration
 * requires one. Only somebody already opted in with this coach, with a phone on
 * the account, registers in one click. */
export function needsConsentPrompt(
  consent: { optedIn: boolean } | null,
  accountPhone: string | null | undefined,
): boolean {
  if (!accountPhone?.trim()) return true;
  return !consent?.optedIn;
}
