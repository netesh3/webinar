import type { RegisterRequest } from "./api-types";

/* Gmail on the public webinar form goes to Google. Every other domain stays
 * on the email verification link. Same rule as api.gmailAddress. */
export function isGmailAddress(email: string): boolean {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return false;
  return trimmed.slice(at + 1) === "gmail.com";
}

const PENDING_KEY = "webinar.pendingRegister";

/* The form, held across the Google redirect.
 *
 * sessionStorage is same-tab, which is the OAuth round trip. A private-mode
 * refusal is ignored: the callback still returns to the webinar page, and a
 * signed-in account with no extra questions registers from there.
 */
export function savePendingWebinarRegister(
  slug: string,
  body: RegisterRequest,
): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ slug, body }));
  } catch {
    // Storage can be refused. The return path still opens this webinar.
  }
}

export function readPendingWebinarRegister(
  slug: string,
): RegisterRequest | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { slug?: string; body?: RegisterRequest };
    if (parsed.slug !== slug || !parsed.body?.email) return null;
    return parsed.body;
  } catch {
    return null;
  }
}

export function clearPendingWebinarRegister(slug: string): void {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { slug?: string };
    if (parsed.slug === slug) sessionStorage.removeItem(PENDING_KEY);
  } catch {
    sessionStorage.removeItem(PENDING_KEY);
  }
}
