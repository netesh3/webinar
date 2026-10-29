/* Tests for lib/contact.ts: every address is the company's own, none is the noreply
 * From address, mailto() encodes its subject, and /contact lists each address once.
 * Run with `make test-web`. (29 Oct 2026) */

import assert from "node:assert/strict";
import { CONTACT, CONTACT_LIST, mailto } from "./contact.ts";

for (const [key, address] of Object.entries(CONTACT)) {
  assert.match(address, /^[a-z]+@webinarliv\.com$/, `${key} is ${address}`);
  assert.notEqual(address, "noreply@webinarliv.com");
}
assert.equal(new Set(Object.values(CONTACT)).size, Object.keys(CONTACT).length, "two keys share an address");
assert.equal(CONTACT.support, "support@webinarliv.com");
assert.equal(CONTACT.billing, "billing@webinarliv.com");

assert.equal(mailto(CONTACT.hello), "mailto:hello@webinarliv.com");
assert.equal(mailto(CONTACT.hello, "Enterprise plan"), "mailto:hello@webinarliv.com?subject=Enterprise%20plan");
assert.equal(mailto(CONTACT.support, "a&b=c?"), "mailto:support@webinarliv.com?subject=a%26b%3Dc%3F");

const listed = CONTACT_LIST.map((c) => c.key);
assert.deepEqual(listed, ["support", "hello", "billing", "partners", "security", "privacy"]);
for (const c of CONTACT_LIST) {
  assert.ok(c.label && c.for, `${c.key} needs a label and what it is for`);
}

console.log("contact: ok");
