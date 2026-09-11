/* Who may open which URL.
 *
 * Three experiences share one deployment, and they are separated by route rather than by
 * what is rendered:
 *
 *   HOST         /host/login → /host → /host/<slug> → /host/<slug>/room
 *   PARTICIPANT  /webinars/<slug> → register → /webinars/<slug>/room
 *   PANELIST     /host/<slug>/room  (an invitation, not a dashboard)
 *
 * A participant must never reach the host dashboard, and "must never reach" is the point:
 * not rendering the buttons is not access control, because the URL is still there to be
 * typed. So this decides, `middleware.ts` enforces it before a page renders, and the API
 * enforces it again on every request. Three layers, and only the last one is authoritative —
 * this exists so somebody who guesses a URL gets a redirect instead of a broken screen.
 *
 * Pure and separate from the middleware so it can be tested. Route protection is the kind of
 * logic where a mistake is silent in both directions: too loose and a participant is looking
 * at a registrant list, too tight and a panelist cannot reach the webinar they were invited
 * to speak at. Neither shows up in a screenshot.
 */

/** What the middleware knows about whoever is asking. */
export type Viewer =
  | { kind: "anonymous" }
  /** A valid session. `canHost` is the capability, not the role in any one webinar. */
  | { kind: "account"; canHost: boolean; isAdmin?: boolean };

export type Decision = { allow: true } | { allow: false; redirectTo: string };

const ALLOW: Decision = { allow: true };

/* First segments under /host that are pages rather than webinar slugs.
 *
 * `/host/new` is the schedule form and `/host/login` is the way in; everything else after
 * /host is a slug. Getting this list wrong would make the schedule form look like a webinar
 * called "new" and redirect a host to /webinars/new, which does not exist. */
const HOST_PAGES = new Set(["login", "new"]);

/**
 * decideAccess answers one request.
 *
 * `pathname` is a URL path with no query string. Trailing slashes are tolerated because a
 * pasted link often has one.
 */
export function decideAccess(pathname: string, viewer: Viewer): Decision {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const segments = path.split("/").filter(Boolean);

  /* Marketing home is for visitors only. Signed-in users skip the brand page and
   * land in the app — hosts on Hosting, everyone else on Browse. Matches the
   * post-OAuth default when `next` is `/`. */
  if (segments.length === 0) {
    if (viewer.kind === "account") {
      return {
        allow: false,
        redirectTo: viewer.canHost ? "/host" : "/browse",
      };
    }
    return ALLOW;
  }

  // The participant experience and the public catalogue are open to everyone, including
  // people with no account at all — that is the entire point of a registration link.
  if (segments[0] !== "host") {
    /* The admin area. Signed out goes to the sign-in page with a next= so they land here
     * afterwards; signed in but not an admin goes to /account rather than /login, because
     * bouncing an authenticated person to a sign-in form makes them think their session
     * expired. This is a hint, not the control: the API refuses every /api/admin request
     * from a non-admin regardless of what the browser rendered. */
    if (segments[0] === "admin") {
      if (viewer.kind === "anonymous") return redirect("/login", path);
      return viewer.isAdmin ? ALLOW : { allow: false, redirectTo: "/account" };
    }
    if (path === "/my-webinars" || path === "/account") {
      return viewer.kind === "anonymous" ? redirect("/login", path) : ALLOW;
    }
    return ALLOW;
  }

  const second = segments[1];

  // The host's way in. Always reachable, or a signed-out host cannot sign back in.
  if (second === "login") return ALLOW;

  if (viewer.kind === "anonymous") return redirect("/host/login", path);

  /* The panelist link, and the reason it is not gated on `canHost`.
   *
   * A guest speaker is invited by name to somebody else's webinar. They have an account and
   * no hosting capability of their own, and requiring one would mean the invitation does not
   * work — so any signed-in account may ASK for this room, and the API answers: the join
   * endpoint requires owner-or-panelist on this specific webinar and refuses everyone else.
   * That is the authoritative check and it cannot be made here, because whether this account
   * is on this webinar's stage is not something a session cookie knows.
   */
  // Exactly /host/<slug>/room, not a prefix of it. `>= 3` would have let
  // /host/<slug>/room/anything through, which is how a future subpage becomes public.
  if (
    segments.length === 3 &&
    segments[2] === "room" &&
    !HOST_PAGES.has(second ?? "")
  ) {
    return ALLOW;
  }

  // Everything else under /host is the dashboard, and the dashboard needs the capability.
  if (viewer.canHost) return ALLOW;

  /* A signed-in participant who typed a host URL.
   *
   * Sent to the public page for the webinar they were evidently looking for, which is both
   * what they can actually use and the least confusing thing to land on. With no slug to go
   * on — bare /host — they go to their account page, which is where hosting is turned on, so
   * somebody who genuinely wants to host is one toggle away rather than stuck.
   */
  if (second && !HOST_PAGES.has(second)) {
    return { allow: false, redirectTo: `/webinars/${second}` };
  }
  return { allow: false, redirectTo: "/account" };
}

/** A redirect that remembers where the person was going, so signing in continues the
 *  journey instead of dumping them on a dashboard. */
function redirect(to: string, from: string): Decision {
  return { allow: false, redirectTo: `${to}?next=${encodeURIComponent(from)}` };
}
