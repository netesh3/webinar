/* The pricing card's button: contact, free trial, or pay now.
 *
 * Run: node --experimental-strip-types --no-warnings lib/pricing-cta.test.mts
 */

import assert from "node:assert/strict";
import { planCta } from "./pricing-cta.ts";

const trialsOn = { trialDays: 7, trialCurrency: "INR" };
const trialsOff = { trialDays: 0 };

// Enterprise is contact-only whatever the toggles say.
assert.equal(planCta({ contactOnly: true }, "monthly", "INR", trialsOn), "contact");
assert.equal(planCta({ contactOnly: true }, "yearly", "USD", trialsOff), "contact");

// The trial is monthly, in the trial currency, and only while trials are on.
assert.equal(planCta({}, "monthly", "INR", trialsOn), "trial");
assert.equal(planCta({}, "yearly", "INR", trialsOn), "buy");
assert.equal(planCta({}, "monthly", "USD", trialsOn), "buy");
assert.equal(planCta({}, "monthly", "INR", trialsOff), "buy");

// Before the catalogue loads nothing claims a trial.
assert.equal(planCta({}, "monthly", "INR", null), "buy");

console.log("pricing-cta: ok");
