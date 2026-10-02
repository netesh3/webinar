/* Where the host goes once a webinar has ended.
 *
 * The live room used to leave them on "The webinar has ended", the same screen
 * the audience uses to answer the survey. The host's next question is how the
 * session went, which is the Results tab on the webinar page. `?tab=results`
 * is the spelling lib/host-tabs.ts maps onto that tab. Callers use
 * router.replace so Back does not return to a room that no longer exists.
 *
 * Instant webinars use the same host page as a scheduled one.
 */

/** Results tab for this webinar. */
export function hostResultsPath(slug: string): string {
  return `/host/${encodeURIComponent(slug)}?tab=results`;
}

export type AfterEnd =
  | { go: "results"; href: string }
  | { go: "stay" }
  | { go: "ended-screen" };

/** What this person should see once the session's end is known.
 *
 * `ownEndPending` is this browser's End request, still in flight. That request
 * is what launches an on-end survey, and leaving the page before it returns
 * cancels it — so nobody is moved until it settles. The dialog that fired the
 * request then goes to Results itself.
 *
 * Only the host (role "host") is sent to Results when the session ends from
 * somewhere else: the duration limit, another device, the sweeper. A co-host's
 * role stays "panelist", and panelists and attendees keep the ended screen.
 * Leaving without ending is not an end (`ended` is false), and a failed End
 * is the same. */
export function afterWebinarEnd(input: {
  role: string;
  ended: boolean;
  ownEndPending: boolean;
  slug: string;
}): AfterEnd {
  if (!input.ended || input.ownEndPending) return { go: "stay" };
  if (input.role !== "host") return { go: "ended-screen" };
  return { go: "results", href: hostResultsPath(input.slug) };
}
