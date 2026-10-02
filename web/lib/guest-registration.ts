/* A registrant without an account: what the browser holds for them, and the link that
 * gets them in.
 *
 * Pure functions, so the guest journey's edges are tested here rather than discovered by
 * an attendee. The hooks that use them are in components/registrations.tsx and
 * components/attendee-room-gate.tsx.
 */

/* What `/registrations/lookup` and remember() leave for this browser to show.
 *
 * `fetched` is the lookup's answer for the keys in localStorage, plus anything remember()
 * adopted from a POST /register during this visit. A registration whose email is not
 * confirmed yet has no key, so a first-time guest holds no keys at all. Dropping
 * `fetched` whenever the key list is empty used to throw that registration away, which
 * left the form on "Registering…" instead of "Check your email". A row that does carry a
 * key still needs a stored key behind it, as before: with none left, it was cleared. */
export function heldRegistrations<R extends { joinKey: string }>(
  keys: readonly string[],
  fetched: R[] | null,
): R[] | null {
  if (keys.length === 0) return (fetched ?? []).filter((r) => !r.joinKey);
  return fetched;
}

/** A registration still waiting for its email to be confirmed: no key yet, and nothing
 *  the server would let in. */
export function isAwaitingEmail(reg: {
  state: string;
  joinKey: string;
  needsEmailVerification?: boolean;
}): boolean {
  return !reg.joinKey && (reg.state === "unverified" || reg.needsEmailVerification === true);
}

/* The join key a personal link carries: /webinars/<slug>/room?k=<KEY>.
 *
 * Every link the API sends a registrant is that shape: the "You're registered" and
 * approval emails (api/internal/api/approvals.go joinURLFor) and WhatsApp's one-tap Join
 * (api/internal/engage/crm_rich.go). Since a registration waits for its email to be
 * confirmed before it gets a key, that link is the only place a registrant without an
 * account can get one, on any device.
 *
 * Normalised the way the server does it (join.go resolveRegistration trims and
 * upper-cases), and limited to letters and digits, so a mangled link is ignored rather
 * than treated as a credential. newJoinKey makes 12 characters; the range leaves room. */
const JOIN_KEY = /^[A-Z0-9]{8,64}$/;

export function joinKeyFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get("k");
  if (raw === null) return null;
  const key = raw.trim().toUpperCase();
  return JOIN_KEY.test(key) ? key : null;
}

/* Join refusals that can only come after the server matched the key to a registration
 * for this webinar. handleAttendeeJoin resolves the key first; what fails there is
 * no_join_key, not_registered or invalid_join_key. Everything below is "not now" (too
 * early, locked, awaiting approval…), never "no such key". */
const REFUSED_AFTER_KEY_MATCHED = new Set([
  "email_unverified",
  "not_approved",
  "not_joinable",
  "too_early",
  "locked",
  "room_full",
  "zoom_link_missing",
]);

/** Whether a join outcome proves a link's key is a real registration, and so is worth
 *  keeping in this browser. A network failure or a refused key proves nothing. */
export function joinProvesKey(outcome: { joined: true } | { code: string }): boolean {
  return "joined" in outcome || REFUSED_AFTER_KEY_MATCHED.has(outcome.code);
}
