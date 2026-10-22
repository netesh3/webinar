/* Whether the broadcast player starts with sound, the decision half (lib/media-unlock.ts and
 * the players in components/room do the rest).
 *
 * Browsers hold sound back until the person has interacted:
 *  - Chrome, Edge and Firefox count any click on the document (sticky activation), and a
 *    same-tab, client-side navigation keeps it: "Join now" on the webinar's page is a Next
 *    <Link>, so the room that follows may play with sound.
 *    navigator.userActivation.hasBeenActive says so.
 *  - Safari (macOS and iOS) counts a tap per media element, at the moment it plays. So the
 *    Join tap also plays a silent clip on a spare <video> (primeMediaElement), and the room
 *    adopts that element: it stays allowed to play with sound, whatever it plays next.
 *
 * Either is reason to try with sound. Only a NotAllowedError from play() says no; then the
 * player plays muted and the first tap or key anywhere turns the sound on.
 *
 * No imports, so lib/autoplay-sound.test.mts can load it. */

export type SoundInput = {
  /** navigator.userActivation?.hasBeenActive; undefined where the browser has no such API. */
  activated: boolean | undefined;
  /** The player's element was unlocked by a tap (lib/media-unlock.ts). */
  primed: boolean;
};

/** Try play() with sound first. False only when the browser says nobody has touched this
 *  tab and no element was unlocked: a cold room link, a refresh, a new tab. */
export function tryWithSound({ activated, primed }: SoundInput): boolean {
  if (primed) return true;
  return activated !== false;
}

/** Whether a play() rejection is the autoplay policy refusing sound, as opposed to a load
 *  aborted, no data yet, or a reload, which say nothing about sound. */
export function isAutoplayRefusal(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "NotAllowedError";
}
