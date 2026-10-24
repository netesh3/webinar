/* The proposed plans (lib/plans.ts): prices, the yearly rule, the comparison table read from
 * the plan limits, and the proposal switch.
 *
 * Run: node --experimental-strip-types --no-warnings lib/plans.test.mts
 */

import assert from "node:assert/strict";
import {
  ADD_ON_CELL,
  COMPARISON,
  PLANS,
  PLAN_IDS,
  TRIAL,
  availability,
  featureGroups,
  findPlan,
  formatPrice,
  gstOn,
  indexable,
  perMonth,
  priceFor,
  pricingHref,
  selfServePlans,
  yearlyPrice,
  yearlySavingPercent,
} from "./plans.ts";

// The yearly rule is the server's (api/internal/billing/billing.go yearly): USD is ten
// months; INR is twelve whole months ending in 9, never above ten months.
assert.equal(yearlyPrice(49, "USD"), 490);
assert.equal(yearlyPrice(3999, "INR"), 3329 * 12);
assert.equal(yearlyPrice(9999, "INR"), 8329 * 12);
assert.equal(yearlyPrice(24999, "INR"), 20829 * 12);
for (const m of [799, 1999, 3999, 9999, 24999, 39999]) {
  const y = yearlyPrice(m, "INR");
  assert.ok(y <= m * 10, `₹${m}: yearly ${y} is over ten months`);
  assert.equal((y / 12) % 10, 9, `₹${m}: per month should end in 9`);
}

// Prices and the per-month headline.
const starter = findPlan("starter");
assert.equal(priceFor(starter, "INR", "monthly"), 3999);
assert.equal(perMonth(starter, "INR", "yearly"), 3329);
assert.equal(perMonth(starter, "USD", "yearly"), 41);
assert.equal(priceFor(findPlan("enterprise"), "INR", "monthly"), null);
assert.equal(perMonth(findPlan("enterprise"), "USD", "yearly"), null);
assert.equal(yearlySavingPercent(starter, "USD"), 17);
assert.ok(yearlySavingPercent(starter, "INR") >= 16);
assert.equal(yearlySavingPercent(findPlan("enterprise"), "INR"), 0);

// GST is INR only.
assert.equal(gstOn(3999, "INR"), 720);
assert.equal(gstOn(49, "USD"), 0);

assert.equal(formatPrice(3999, "INR"), "₹3,999");
assert.equal(formatPrice(24999, "INR"), "₹24,999");
assert.equal(formatPrice(149, "USD"), "$149");

// Plans: unique ids in table order, Enterprise last and contact-only, exactly one popular.
assert.deepEqual(
  PLANS.map((p) => p.id),
  PLAN_IDS,
);
assert.deepEqual(
  selfServePlans().map((p) => p.id),
  ["starter", "pro", "business"],
);
assert.equal(PLANS.filter((p) => p.popular).length, 1);
assert.throws(() => findPlan("free" as never));
assert.equal(findPlan(TRIAL.plan).id, "pro");

// Every limit grows (or holds) up the tiers, and prices rise with them.
const paid = selfServePlans();
for (let i = 1; i < paid.length; i++) {
  const a = paid[i - 1], b = paid[i];
  for (const k of Object.keys(a.limits!) as (keyof NonNullable<typeof a.limits>)[]) {
    assert.ok(b.limits![k] >= a.limits![k], `${b.name}.${k} is below ${a.name}`);
  }
  assert.ok(b.monthly!.INR > a.monthly!.INR && b.monthly!.USD > a.monthly!.USD);
}

// The comparison table has a cell for every plan in every row, and its limit rows are read
// from PLANS rather than typed in again.
for (const g of COMPARISON) {
  assert.ok(g.rows.length > 0, g.title);
  for (const r of g.rows) for (const id of PLAN_IDS) assert.ok(id in r.cells, `${g.title} / ${r.label} / ${id}`);
}
const limits = COMPARISON.find((g) => g.id === "limits")!;
const attendees = limits.rows.find((r) => r.label === "Attendees per webinar")!;
assert.equal(attendees.cells.pro, findPlan("pro").limits!.attendees.toLocaleString("en-IN"));
const ai = limits.rows.find((r) => r.label === "AI credits a month")!;
assert.equal(ai.cells.starter, ADD_ON_CELL);
assert.equal(ai.cells.business, "5,000");

// Nothing on a lower plan is missing from a higher one.
for (const g of COMPARISON)
  for (const r of g.rows)
    for (let i = 1; i < PLAN_IDS.length; i++) {
      if (r.cells[PLAN_IDS[i - 1]] !== false) assert.notEqual(r.cells[PLAN_IDS[i]], false, `${r.label} drops at ${PLAN_IDS[i]}`);
    }

// The /features sections: the requested seven, each row with a sentence for the page.
assert.deepEqual(
  featureGroups().map((g) => g.title),
  ["Run live sessions", "Grow your audience", "Engage", "Automate with AI", "Repurpose content", "Integrations", "Security & privacy"],
);

// Availability in words.
const row = (cells: Record<string, unknown>) => ({ label: "x", cells }) as never;
assert.equal(availability(row({ starter: true, pro: true, business: true, enterprise: true })), "Every plan");
assert.equal(availability(row({ starter: false, pro: true, business: true, enterprise: true })), "Pro and up");
assert.equal(availability(row({ starter: false, pro: false, business: true, enterprise: true })), "Business and up");
assert.equal(availability(row({ starter: false, pro: false, business: false, enterprise: true })), "Enterprise");
assert.equal(
  availability(row({ starter: ADD_ON_CELL, pro: true, business: true, enterprise: true })),
  "AI add-on on Starter, included from Pro",
);

// The proposal switch: kept out of search, and "see pricing" goes to the proposal page.
assert.equal(pricingHref("proposal"), "/pricing/proposed");
assert.equal(pricingHref("live"), "/pricing");
assert.equal(indexable("proposal"), false);
assert.equal(indexable("live"), true);

console.log("plans: ok");
