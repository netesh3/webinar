/* Guards for the sign-in page's "already signed in, send them on" redirect.
 *
 * That redirect is a client navigation. The browser's redirect limit never
 * sees it, so a tab whose memory says signed-in while the cookie is gone
 * will bounce /host → /host/login → /login → /host until the machine sleeps.
 * Confirming the cookie and refusing to follow the same target forever are
 * what stop that. A server rate limit would only slow it down.
 */

export const LOGIN_REDIRECT_LIMIT = 2;
/** Long enough that a slow hop still counts as the same spin. */
export const LOGIN_REDIRECT_WINDOW_MS = 60_000;

const LOGIN_REDIRECT_KEY = "webcast.login-redirect";

/** Other tabs hear a sign-out through this key. sessionStorage would not
 *  cross tabs, and the storage event is how the rest of the app already
 *  shares a choice (theme, sidebar) without a second channel. */
export const SIGN_OUT_STORAGE_KEY = "webcast.signed-out";

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

type RedirectLog = { target?: unknown; at?: unknown };

function recentHops(target: string, now: number, storage: StorageLike): number[] | null {
  try {
    const raw = storage.getItem(LOGIN_REDIRECT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RedirectLog;
    if (!parsed || parsed.target !== target || !Array.isArray(parsed.at)) return [];
    return parsed.at.filter(
      (t): t is number => typeof t === "number" && now - t < LOGIN_REDIRECT_WINDOW_MS,
    );
  } catch {
    return null;
  }
}

/** True when this tab already followed `target` twice in the window.
 *  A storage failure says no: blocking a real sign-in because the browser
 *  refused sessionStorage is worse than one extra hop, and the cookie check
 *  is what actually ends the loop. */
export function loginRedirectBlocked(target: string, now: number, storage: StorageLike): boolean {
  const recent = recentHops(target, now, storage);
  if (recent === null) return false;
  return recent.length >= LOGIN_REDIRECT_LIMIT;
}

/** Remember a hop we are about to take. Best effort. */
export function noteLoginRedirect(target: string, now: number, storage: StorageLike): void {
  const recent = recentHops(target, now, storage);
  const at = recent === null ? [now] : [...recent, now];
  try {
    storage.setItem(LOGIN_REDIRECT_KEY, JSON.stringify({ target, at }));
  } catch {
    // Private mode can refuse storage. The hop still happens once.
  }
}

export function publishSignOut(storage?: Pick<Storage, "setItem">): void {
  const target = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
  if (!target) return;
  try {
    target.setItem(SIGN_OUT_STORAGE_KEY, String(Date.now()));
  } catch {
    // Private mode can refuse storage. This tab is already cleared.
  }
}

/** A storage event from another tab that signed out. Removing the key, or
 *  any other key, is not a sign-out. */
export function isSignOutNotice(event: { key: string | null; newValue: string | null }): boolean {
  return event.key === SIGN_OUT_STORAGE_KEY && event.newValue != null && event.newValue !== "";
}
