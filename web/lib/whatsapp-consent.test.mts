import assert from "node:assert/strict";
import { needsConsentPrompt } from "./whatsapp-consent.ts";

const cases: [string, { optedIn: boolean } | null, string | undefined, boolean][] = [
  ["opted in with a phone registers in one click", { optedIn: true }, "+919876543210", false],
  ["not opted in with this coach is asked", { optedIn: false }, "+919876543210", true],
  ["no phone is always asked", { optedIn: true }, "", true],
  ["blank phone is always asked", { optedIn: true }, "   ", true],
  ["no answer from the server is asked", null, "+919876543210", true],
  ["no phone and no answer is asked", null, undefined, true],
];

for (const [name, consent, phone, want] of cases) {
  assert.equal(needsConsentPrompt(consent, phone), want, name);
}
console.log(`PASS  ${cases.length}/${cases.length} checks passed`);
