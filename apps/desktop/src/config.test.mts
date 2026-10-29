/* Deep links for Continue with Google. Chrome and Safari disagree on the slashes.
 *
 * Run: node --experimental-strip-types --no-warnings src/config.test.mts
 */

import assert from "node:assert/strict";
import {
  isAuthCompleteUrl,
  isFocusOnlyLink,
  isSignInStartUrl,
  resolveLaunchTarget,
} from "./config.ts";

const code = "a".repeat(64);
const complete = `https://webinarliv.com/auth/complete?code=${code}`;

for (const link of [
  `webinarliv://auth/complete?code=${code}`,
  `webinarliv://auth/complete/?code=${code}`,
  `webinarliv:///auth/complete?code=${code}`,
  `webinarliv:auth/complete?code=${code}`,
]) {
  assert.equal(resolveLaunchTarget(link), complete, link);
}

assert.equal(
  resolveLaunchTarget("webinarliv://auth/complete?error=google"),
  "https://webinarliv.com/auth/complete?error=google",
);
assert.equal(resolveLaunchTarget("webinarliv://auth/complete"), null);
assert.equal(resolveLaunchTarget("webinarliv://auth/other?code=abc"), null);

assert.equal(
  isSignInStartUrl(
    "https://webinarliv.com/api/auth/google/start?app=desktop&challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&next=%2F",
  ),
  true,
);
assert.equal(
  isSignInStartUrl("https://webinarliv.com/api/auth/google/start?next=%2F"),
  false,
);
assert.equal(isAuthCompleteUrl(complete), true);
assert.equal(isFocusOnlyLink("webinarliv://connect/picked"), true);
assert.equal(isFocusOnlyLink("webinarliv://connect/picked/"), true);

console.log("desktop-config: ok");
