import assert from "node:assert/strict";
import { featureShare, whatsAppUsageLine } from "./whatsapp-usage.ts";

const base = {
  hosts: 12, remindersOnly: 8, usedCrm: 4, inactive: 0,
  broadcasts: 3, drips: 1, chatbot: 0, inbox: 2,
};
assert.equal(whatsAppUsageLine(base), "12 hosts: 8 reminders only, 4 used CRM features");
assert.equal(
  whatsAppUsageLine({ ...base, hosts: 13, inactive: 1 }),
  "13 hosts: 8 reminders only, 4 used CRM features, 1 sent nothing",
);
assert.equal(whatsAppUsageLine({ ...base, hosts: 0, remindersOnly: 0, usedCrm: 0 }), "No hosts on WhatsApp yet.");
assert.equal(featureShare(3, 12), "3 of 12 (25%)");
assert.equal(featureShare(0, 0), "0");
console.log("PASS whatsapp-usage");
