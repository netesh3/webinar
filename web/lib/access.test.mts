/* Tests for route-level access control.
 *
 * Run with `make test-web`.
 *
 * This is tested rather than eyeballed because both failure directions are silent. Too loose
 * and a participant who types /host/<slug> is reading a registrant list — real names and email
 * addresses. Too tight and an invited guest speaker cannot reach the webinar they were asked to
 * speak at, which will be discovered live, by them, in front of an audience.
 *
 * The cases are written as the three journeys rather than as a table of paths, because the
 * mistakes worth catching are about a PERSON in a SITUATION: the panelist who is not a host,
 * the participant who guessed a URL, the host who was signed out mid-session.
 */

import { readFileSync } from "node:fs";
import { decideAccess, type Viewer } from "./access.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
}

const anonymous: Viewer = { kind: "anonymous" };
const participant: Viewer = { kind: "account", canHost: false };
const host: Viewer = { kind: "account", canHost: true };

function allowed(path: string, viewer: Viewer, what: string): void {
  const d = decideAccess(path, viewer);
  ok(d.allow, what, d.allow ? "" : `was redirected to ${d.redirectTo}`);
}

function redirectedTo(
  path: string,
  viewer: Viewer,
  to: string,
  what: string,
): void {
  const d = decideAccess(path, viewer);
  if (d.allow) {
    checks++;
    failures++;
    console.log(
      `  FAIL  ${what}\n        ${path} was ALLOWED, expected a redirect to ${to}`,
    );
    return;
  }
  ok(d.redirectTo === to, what, `got ${d.redirectTo}\n        want ${to}`);
}

console.log("\nPARTICIPANT — the registration link is public");
{
  // The whole journey, with no account at any point. This is the common case and the one
  // that must never require signing in.
  allowed(
    "/webinars/redis-cache",
    anonymous,
    "the registration link opens for a stranger",
  );
  allowed(
    "/webinars/redis-cache/room",
    anonymous,
    "…and so does the participant room",
  );
  allowed("/", anonymous, "the marketing homepage is public when signed out");
  allowed(
    "/webinars/redis-cache",
    participant,
    "…and still opens once they have an account",
  );
}

console.log("\nSIGNED-IN — marketing home redirects into the app");
{
  redirectedTo(
    "/",
    host,
    "/host",
    "a host opening / lands on Hosting",
  );
  redirectedTo(
    "/",
    participant,
    "/browse",
    "a participant opening / lands on Browse",
  );
}

console.log("\nPARTICIPANT — host URLs are refused");
{
  /* Typed, pasted from a colleague, or guessed. Each lands on the public page for the
   * webinar they were evidently after, which is the one thing they can actually use. */
  redirectedTo(
    "/host/redis-cache",
    participant,
    "/webinars/redis-cache",
    "a participant who opens the manage page is sent to the public page",
  );
  redirectedTo(
    "/host/redis-cache/edit",
    participant,
    "/webinars/redis-cache",
    "…and so is the edit page",
  );
  redirectedTo(
    "/host",
    participant,
    "/account",
    "bare /host has no webinar to fall back to, so they go where hosting is turned on",
  );
  redirectedTo(
    "/host/new",
    participant,
    "/account",
    "the schedule form is not a webinar slug — it must not redirect to /webinars/new",
  );
}

console.log("\nHOST — nothing is taken away");
{
  allowed("/host", host, "the dashboard");
  allowed("/host/new", host, "the schedule form");
  allowed("/host/redis-cache", host, "manage a webinar");
  allowed("/host/redis-cache/edit", host, "edit it");
  allowed("/host/redis-cache/room", host, "present in it");
  allowed(
    "/my-webinars",
    host,
    "a host is also a person who registers for things",
  );
  allowed("/account", host, "account settings");
}

console.log("\nHOST — signed out, and sent back where they were going");
{
  redirectedTo(
    "/host",
    anonymous,
    "/host/login?next=%2Fhost",
    "a signed-out host reaches the host sign-in, not the participant one",
  );
  redirectedTo(
    "/host/redis-cache",
    anonymous,
    "/host/login?next=%2Fhost%2Fredis-cache",
    "…and the destination is remembered, so signing in continues the journey",
  );
  allowed(
    "/host/login",
    anonymous,
    "the host sign-in page itself must always open",
  );
  /* The trap in this rule: gating /host/login on being signed in locks a signed-out host
   * out of their own product with no way back. */
  allowed("/host/login", participant, "…for anybody, whatever they are");
}

console.log("\nPANELIST — an invitation, not a capability");
{
  /* The case most likely to be broken by a naive "host routes need canHost" rule. A guest
   * speaker has an ordinary account and no hosting of their own; the API decides whether they
   * are on this webinar's stage, because a session cookie cannot know that. */
  allowed(
    "/host/redis-cache/room",
    participant,
    "an invited panelist without hosting rights reaches the stage",
  );
  allowed("/host/redis-cache/room", host, "and so does the host");
  redirectedTo(
    "/host/redis-cache/room",
    anonymous,
    "/host/login?next=%2Fhost%2Fredis-cache%2Froom",
    "but a stranger still has to sign in — the panelist link is not public",
  );
}

console.log("\nACCOUNT PAGES — a session, not a capability");
{
  redirectedTo(
    "/my-webinars",
    anonymous,
    "/login?next=%2Fmy-webinars",
    "my-webinars needs a session and uses the ordinary sign-in, not the host one",
  );
  redirectedTo(
    "/account",
    anonymous,
    "/login?next=%2Faccount",
    "so does the account page",
  );
  allowed(
    "/my-webinars",
    participant,
    "a participant with an account may see their own list",
  );
  allowed("/account", participant, "…and their own settings");
}

console.log("\nEDGE CASES");
{
  // A pasted link with a trailing slash is the same link.
  redirectedTo(
    "/host/redis-cache/",
    participant,
    "/webinars/redis-cache",
    "a trailing slash does not open a hole",
  );
  allowed("/host/login/", anonymous, "…nor close one");

  // Slugs contain hyphens and digits; nothing here may treat them specially.
  redirectedTo(
    "/host/q3-2026-launch-01",
    participant,
    "/webinars/q3-2026-launch-01",
    "a slug with digits and hyphens survives the redirect intact",
  );

  /* Deeper host paths that do not exist yet. Defaulting to "allow" for anything unrecognised
   * is how a future /host/<slug>/registrants ends up readable by a participant, so an unknown
   * path under a slug must still require the capability. */
  redirectedTo(
    "/host/redis-cache/registrants",
    participant,
    "/webinars/redis-cache",
    "an unrecognised host subpath is still refused, not allowed by default",
  );
  redirectedTo(
    "/host/redis-cache/room/extra",
    participant,
    "/webinars/redis-cache",
    "…and 'room' only counts as the stage at its own depth",
  );

  allowed("/webinars", anonymous, "the plural listing is public");
  allowed(
    "/login",
    anonymous,
    "sign-in pages open for the signed-out, obviously",
  );
  allowed("/signup", anonymous, "and so does signup");

  /* The admin area. Two different refusals, deliberately.
   *
   * A signed-out visitor goes to /login with a next= so they land here afterwards. A
   * signed-in non-admin goes to /account instead, because bouncing somebody who IS
   * authenticated to a sign-in form reads as "your session expired" and they will try
   * signing in again — and succeed, and be bounced again. */
  redirectedTo(
    "/admin",
    anonymous,
    "/login?next=%2Fadmin",
    "signed out, the admin area sends you to sign in and come back",
  );
  redirectedTo(
    "/admin",
    { kind: "account", canHost: true, isAdmin: false },
    "/account",
    "a host is not an admin, and is not sent to a login form",
  );
  allowed(
    "/admin",
    { kind: "account", canHost: false, isAdmin: true },
    "an admin need not be a host to administer",
  );
}

/* Every path decideAccess has an opinion about is actually MATCHED by the middleware.
 *
 * This exists because /admin was not. decideAccess gained a rule for it, the rule got tests,
 * the tests passed — and middleware.ts never listed the path, so in production the function was
 * never called for it and the gate was dead code. Nothing errored: the page rendered its shell
 * and the API refused the fetch behind it, so it looked like a styling choice.
 *
 * Read out of middleware.ts rather than duplicated here, because a second copy of the list is
 * exactly the thing that drifts.
 */
{
  const middleware = readFileSync(new URL("../middleware.ts", import.meta.url), "utf8");
  const matcher = middleware.slice(middleware.indexOf("matcher:"));

  for (const [path, why] of [
    ["/", "marketing home (signed-in redirect)"],
    ["/host", "the host portal"],
    ["/my-webinars", "an attendee's own list"],
    ["/account", "account settings"],
    ["/admin", "the admin area"],
  ] as const) {
    ok(
      matcher.includes(`"${path}"`),
      `middleware matches ${path} — ${why}`,
      "decideAccess gates it, so the middleware has to run for it",
    );
  }

  // And each of those really is a path decideAccess refuses an anonymous visitor.
  for (const path of ["/host", "/my-webinars", "/account", "/admin"]) {
    ok(
      decideAccess(path, anonymous).allow === false,
      `${path} refuses an anonymous visitor`,
    );
  }
}

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`,
);
process.exit(failures === 0 ? 0 : 1);
