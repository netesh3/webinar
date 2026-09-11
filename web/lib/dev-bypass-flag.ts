/* Tiny, Edge-safe. Do not import LiveKit or heavy fixtures here — middleware
 * loads this module, and a Node/LiveKit import would break or skip the bypass.
 *
 * Local preview: NEXT_PUBLIC_DEV_BYPASS_AUTH=1 fakes a host session. Sign out
 * sets sessionStorage `webcast.devBypassOff=1` (mirrored as cookie for middleware)
 * so `/` shows marketing; re-enable via “Continue as Preview Host”, `/preview`,
 * or `?bypass=1`. Force marketing anytime with `/?marketing=1` or `/home`.
 */

export const DEV_BYPASS_OFF_STORAGE_KEY = "webcast.devBypassOff";
/** Cookie mirror of the sessionStorage opt-out so middleware can see it. */
export const DEV_BYPASS_OFF_COOKIE = "webcast_dev_bypass_off";

export function isDevAuthBypass(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH === "1"
  );
}
