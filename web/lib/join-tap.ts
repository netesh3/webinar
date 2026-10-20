/* Whether an attendee is asked to tap "Join webinar" before the room's sound starts.
 *
 * Browsers do not play sound on a page nobody has touched. Every browser enforces it and no
 * site can turn it off. It is why somebody who opened the room straight from a reminder — the
 * "Join" link in the email or the WhatsApp message — landed in a room they could see and not
 * hear, with a small "Tap to enable sound" pill that on a phone was easy to miss. Asking for
 * that one tap as the way in makes it the moment the webinar starts instead of a fix-up.
 *
 * Asked (components/room/join-tap.tsx shows the screen):
 *   - An attendee whose tab has not been touched (navigator.userActivation.hasBeenActive is
 *     false): they came from a link, or reloaded. Somebody who pressed "Join now" on the
 *     webinar's page has touched it — register-form.tsx opens the room in the same tab for
 *     exactly this — and Chrome and Firefox then play the sound without asking again.
 *   - Every attendee on an iPhone or iPad, touched or not. Safari wants the tap at the moment
 *     playback starts, not just some tap earlier on the page: livekit-client's
 *     Room.startAudio, which the tap calls, says as much.
 *   - An attendee whose browser cannot say whether the tab was touched (no
 *     navigator.userActivation). Asking costs one tap; not asking can cost the webinar.
 *
 * Not asked: a publisher. Hosts, panelists and anyone joining on stage go through the device
 * check (prejoin.tsx) first, which is a tap of its own, and nobody presenting should be told
 * to "join" their own room.
 *
 * No imports, so lib/join-tap.test.mts can load it.
 */

export type JoinTapInput = {
  /** Joining with permission to publish: the host, a panelist, someone already on stage. */
  publisher: boolean;
  /** navigator.userActivation?.hasBeenActive — undefined where the browser has no such API. */
  activated: boolean | undefined;
  userAgent: string;
  maxTouchPoints: number;
};

export function needsJoinTap({
  publisher,
  activated,
  userAgent,
  maxTouchPoints,
}: JoinTapInput): boolean {
  if (publisher) return false;
  if (isAppleTouch(userAgent, maxTouchPoints)) return true;
  return activated !== true;
}

/** An iPhone, iPod or iPad, including an iPad sending the desktop Mac user agent, which it
 *  has done by default since iPadOS 13. macOS Safari reports no touch points; an iPad does.
 *  Every browser on these is WebKit underneath, so Chrome there ("CriOS") counts too. */
export function isAppleTouch(userAgent: string, maxTouchPoints: number): boolean {
  if (/iphone|ipod|ipad/i.test(userAgent)) return true;
  return /macintosh/i.test(userAgent) && maxTouchPoints > 1;
}
