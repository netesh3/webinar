/* Typed account phone vs Google's People number.
 *
 * Run: node --experimental-strip-types --no-warnings lib/account-phone.test.mts
 */

import { needsManualPhone } from "./account-phone.ts";
import { webinarSignInHref } from "./webinar-register.ts";

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean, detail = "") {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? "\n        " + detail : ""}`);
  }
}

ok("null is not prompted", !needsManualPhone(null));
ok("empty phone needs a number", needsManualPhone({ phone: "" }));
ok("whitespace phone needs a number", needsManualPhone({ phone: "  " }));
ok("typed phone is enough", !needsManualPhone({ phone: "+919876543210" }));
ok(
  "Google's number does not count as the typed phone",
  needsManualPhone({ phone: "", googlePhone: "+14155552671" }),
);

ok(
  "webinar sign-in returns to this slug",
  webinarSignInHref("intro-to-go") ===
    "/login?next=%2Fwebinars%2Fintro-to-go",
);
ok(
  "a slug is encoded, not concatenated raw",
  webinarSignInHref("a/b") === "/login?next=%2Fwebinars%2Fa%2Fb",
);

console.log(
  `\n${failed === 0 ? "PASS" : "FAIL"}  ${passed}/${passed + failed} checks passed`,
);
process.exit(failed === 0 ? 0 : 1);
