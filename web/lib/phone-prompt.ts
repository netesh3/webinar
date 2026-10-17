/* Where the app-wide phone prompt may appear.
 *
 * Every signed-in account without a typed phone is asked for one, except where the
 * page has its own flow or must not be interrupted: sign-in pages, a webinar's
 * register page (it asks for the phone together with WhatsApp consent for that
 * coach), anything inside a live room or a recording, and the recorder and preview
 * surfaces. */

const NEVER = [
  /^\/login(\/|$)/,
  /^\/signup(\/|$)/,
  /^\/auth(\/|$)/,
  /^\/host\/login(\/|$)/,
  /^\/reset-password(\/|$)/,
  /^\/forgot-password(\/|$)/,
  /^\/verify(-email)?(\/|$)/,
  /^\/webinars\//,
  /^\/w\//,
  /^\/host\/[^/]+\/room(\/|$)/,
  /^\/recorder-template(\/|$)/,
  /^\/preview(\/|$)/,
  /^\/mock(\/|$)/,
];

export function phonePromptAllowed(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return !NEVER.some((re) => re.test(pathname));
}
