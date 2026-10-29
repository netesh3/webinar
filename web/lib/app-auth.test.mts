/* The apps' Google sign-in hand-off: the challenge, the URLs and the fragment.
 *
 * Run: node --experimental-strip-types --no-warnings lib/app-auth.test.mts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appCompleteLink,
  appStartUrl,
  challengeFor,
  currentAppKind,
  makeVerifier,
  parseReturnFragment,
  safeNextPath,
} from "./app-auth.ts";

// A verifier is 32 random bytes, base64url: 43 characters, RFC 7636's unreserved set.
const v = makeVerifier();
assert.equal(v.length, 43);
assert.match(v, /^[A-Za-z0-9_-]{43}$/);
assert.notEqual(makeVerifier(), v);
assert.equal(makeVerifier((a) => a.fill(0)), "A".repeat(43));

// S256, exactly as the server computes it (api/internal/api/auth_app.go ChallengeFor).
const want = createHash("sha256").update(v).digest("base64url");
assert.equal(await challengeFor(v), want);
// RFC 7636 appendix B's example.
assert.equal(
  await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
  "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
);

// The start URL carries the app, the challenge, next and the hint. Never the verifier.
const start = new URL(
  appStartUrl("https://webinarliv.com", {
    next: "/webinars/x",
    loginHint: "a@gmail.com",
    app: "ios",
    challenge: want,
  }),
);
assert.equal(start.pathname, "/api/auth/google/start");
assert.equal(start.searchParams.get("app"), "ios");
assert.equal(start.searchParams.get("challenge"), want);
assert.equal(start.searchParams.get("next"), "/webinars/x");
assert.equal(start.searchParams.get("login_hint"), "a@gmail.com");
assert.ok(!start.toString().includes(v));
assert.equal(
  new URL(appStartUrl("https://webinarliv.com", { next: "/", app: "desktop", challenge: want })).searchParams.has("login_hint"),
  false,
);

// The return page's fragment, and the link back into the app.
assert.deepEqual(parseReturnFragment("#app=ios&code=abc123"), { code: "abc123", error: "", app: "ios" });
assert.deepEqual(parseReturnFragment("#error=denied&app=desktop"), { code: "", error: "denied", app: "desktop" });
assert.deepEqual(parseReturnFragment(""), { code: "", error: "", app: "" });
assert.equal(appCompleteLink({ code: "abc" }), "webinarliv://auth/complete?code=abc");
assert.equal(appCompleteLink({ error: "denied" }), "webinarliv://auth/complete?error=denied");
assert.equal(appCompleteLink({}), "webinarliv://auth/complete?error=google");
// Whatever is in the fragment is encoded, never spliced into the link as is.
assert.equal(appCompleteLink({ code: "a&next=//evil" }), "webinarliv://auth/complete?code=a%26next%3D%2F%2Fevil");

// Where the exchange may send the webview: same-site paths only.
assert.equal(safeNextPath("/host"), "/host");
assert.equal(safeNextPath("/webinars/x?k=1"), "/webinars/x?k=1");
assert.equal(safeNextPath("//evil.example"), "/");
assert.equal(safeNextPath("https://evil.example"), "/");
assert.equal(safeNextPath("/\\evil.example"), "/");
assert.equal(safeNextPath(null, "/host"), "/host");

// Outside an app (no window here) there is no hand-off: the web redirect is used.
assert.equal(currentAppKind(), null);

console.log("app-auth: ok");
