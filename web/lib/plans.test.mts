/* The plans (lib/plans.ts, 31 Oct 2026): prices, list prices and their badges, the yearly
 * 80% OFF presentation, the card lines, and the "Compare all features" table against the tier
 * switches. The server side of every number is api/internal/billing/web_plans_test.go.
 *
 * Run: node --experimental-strip-types --no-warnings lib/plans.test.mts
 */

import assert from "node:assert/strict";
import {
  COMPARISON,
  PER_HOST_FEATURES,
  PLANS,
  PLAN_IDS,
  TIERED_FEATURES,
  TIER_FEATURES,
  TRIAL,
  YEARLY_OFF_PERCENT,
  availability,
  cardLines,
  discountPercent,
  featureGroups,
  findPlan,
  formatPrice,
  gstOn,
  indexable,
  listFor,
  offLabel,
  perMonth,
  planForServer,
  priceFor,
  pricingHref,
  selfServePlans,
  yearlyListPrice,
  yearlyPrice,
  type Currency,
  type Period,
  type PlanId,
} from "./plans.ts";

// The yearly charge is the server's rule (billing.yearly), unchanged: USD is ten months; INR
// is twelve whole months ending in 9, never above ten months.
assert.equal(yearlyPrice(39, "USD"), 390);
assert.equal(yearlyPrice(2999, "INR"), 2499 * 12);
assert.equal(yearlyPrice(9999, "INR"), 8329 * 12);
assert.equal(yearlyPrice(24999, "INR"), 20829 * 12);
for (const m of [799, 1999, 2999, 3999, 4999, 9999, 24999, 39999]) {
  const y = yearlyPrice(m, "INR");
  assert.ok(y <= m * 10, `₹${m}: yearly ${y} is over ten months`);
  assert.equal((y / 12) % 10, 9, `₹${m}: per month should end in 9`);
}

// The yearly list price is the charge / 0.2, so every yearly price is exactly 80% OFF.
assert.equal(YEARLY_OFF_PERCENT, 80);
assert.equal(yearlyListPrice(29988), 149940);
assert.equal(yearlyListPrice(390), 1950);

/* The table the owner set, per plan, currency and period: [charge, list, badge]. */
const want: Record<Exclude<PlanId, "enterprise">, Record<Currency, Record<Period, [number, number | null, string]>>> = {
  basic: {
    INR: {
      monthly: [2999, 7499, "60% OFF"],
      yearly: [29988, 149940, "80% OFF"],
    },
    USD: { monthly: [39, 99, "60% OFF"], yearly: [390, 1950, "80% OFF"] },
  },
  pro: {
    INR: { monthly: [9999, null, ""], yearly: [99948, 499740, "80% OFF"] },
    USD: { monthly: [149, null, ""], yearly: [1490, 7450, "80% OFF"] },
  },
  business: {
    INR: { monthly: [24999, null, ""], yearly: [249948, 1249740, "80% OFF"] },
    USD: { monthly: [349, null, ""], yearly: [3490, 17450, "80% OFF"] },
  },
};
for (const [id, byCurrency] of Object.entries(want)) {
  const plan = findPlan(id as PlanId);
  for (const [cur, byPeriod] of Object.entries(byCurrency)) {
    for (const [per, [charge, list, badge]] of Object.entries(byPeriod)) {
      const c = cur as Currency,
        p = per as Period;
      assert.equal(priceFor(plan, c, p), charge, `${id} ${cur} ${per} charge`);
      assert.equal(listFor(plan, c, p), list, `${id} ${cur} ${per} list`);
      assert.equal(offLabel(discountPercent(charge, list)), badge, `${id} ${cur} ${per} badge`);
    }
  }
}
assert.equal(perMonth(findPlan("basic"), "INR", "yearly"), 2499);
assert.equal(perMonth(findPlan("pro"), "USD", "yearly"), 124);
assert.equal(priceFor(findPlan("enterprise"), "INR", "monthly"), null);
assert.equal(listFor(findPlan("enterprise"), "INR", "yearly"), null);
assert.equal(discountPercent(100, null), 0);
assert.equal(offLabel(0), "");

// GST is INR only.
assert.equal(gstOn(2999, "INR"), 540);
assert.equal(gstOn(39, "USD"), 0);
assert.equal(formatPrice(2999, "INR"), "₹2,999");
assert.equal(formatPrice(149, "USD"), "$149");

// The lineup: Basic, Professional ("pro"), Business, Enterprise; Starter is not offered.
assert.deepEqual(
  PLANS.map((p) => p.id),
  PLAN_IDS,
);
assert.deepEqual(
  PLANS.map((p) => p.name),
  ["Basic", "Professional", "Business", "Enterprise"],
);
assert.deepEqual(
  PLANS.map((p) => p.server),
  ["basic", "professional", "business", "enterprise"],
);
assert.equal(planForServer("starter"), undefined);
assert.equal(planForServer("professional")?.id, "pro");
assert.deepEqual(
  selfServePlans().map((p) => p.id),
  ["basic", "pro", "business"],
);
assert.equal(PLANS.filter((p) => p.popular).length, 1);
assert.ok(findPlan("enterprise").contactOnly);
assert.throws(() => findPlan("starter" as never));
assert.equal(findPlan(TRIAL.plan).id, "pro");

// The caps the server enforces, and the card lines it writes (billing.Plan.AllFeatures).
assert.deepEqual(
  PLANS.map((p) => [p.limits.attendees, p.limits.stage]),
  [
    [100, 3],
    [300, 5],
    [500, 10],
    [1000, 100],
  ],
);
assert.deepEqual(cardLines(findPlan("basic")).slice(0, 2), ["Up to 100 attendees", "Up to 3 people on stage"]);
assert.deepEqual(cardLines(findPlan("enterprise")).slice(0, 2), ["1,000+ attendees", "Up to 100 people on stage"]);
assert.equal(findPlan("pro").highlights[0], "Everything in Basic");
assert.equal(findPlan("business").highlights[0], "Everything in Professional");
assert.equal(findPlan("enterprise").highlights[0], "Everything in Business");

// Every limit grows (or holds) up the tiers, and prices rise with them.
for (let i = 1; i < PLANS.length; i++) {
  const a = PLANS[i - 1],
    b = PLANS[i];
  for (const k of Object.keys(a.limits) as (keyof typeof a.limits)[]) {
    assert.ok(b.limits[k] >= a.limits[k], `${b.name}.${k} is below ${a.name}`);
  }
  if (a.monthly && b.monthly) assert.ok(b.monthly.INR > a.monthly.INR && b.monthly.USD > a.monthly.USD);
}

// The tier switches: each plan has everything the one below has; WhatsApp from Professional;
// simulive, AI and Zoom from Business; nothing per-host on any plan.
for (let i = 1; i < PLAN_IDS.length; i++) {
  for (const k of TIER_FEATURES[PLAN_IDS[i - 1]])
    assert.ok(TIER_FEATURES[PLAN_IDS[i]].includes(k), `${k} drops at ${PLAN_IDS[i]}`);
}
assert.ok(!TIER_FEATURES.basic.includes("whatsapp_crm") && TIER_FEATURES.pro.includes("whatsapp_crm"));
for (const k of ["simulive", "ai", "ai_knowledge", "zoom", "repurpose"]) {
  assert.ok(!TIER_FEATURES.pro.includes(k) && TIER_FEATURES.business.includes(k), k);
}
for (const id of PLAN_IDS)
  for (const k of PER_HOST_FEATURES) assert.ok(!TIER_FEATURES[id].includes(k), `${id} has ${k}`);

// The comparison table: a cell for every plan in every row; its limit rows read from PLANS;
// every row that is a server switch says exactly what TIER_FEATURES says; every tiered switch
// has a row; nothing on a lower plan is missing from a higher one.
const rows = COMPARISON.flatMap((g) => g.rows);
for (const g of COMPARISON) {
  assert.ok(g.rows.length > 0, g.title);
  for (const r of g.rows) for (const id of PLAN_IDS) assert.ok(id in r.cells, `${g.title} / ${r.label} / ${id}`);
}
for (const r of rows.filter((r) => r.feature)) {
  for (const id of PLAN_IDS) {
    assert.equal(r.cells[id], TIER_FEATURES[id].includes(r.feature!), `${r.label} on ${id}`);
  }
}
for (const k of TIERED_FEATURES)
  assert.ok(
    rows.some((r) => r.feature === k),
    `no row for ${k}`,
  );
for (const r of rows)
  for (let i = 1; i < PLAN_IDS.length; i++) {
    if (r.cells[PLAN_IDS[i - 1]] !== false)
      assert.notEqual(r.cells[PLAN_IDS[i]], false, `${r.label} drops at ${PLAN_IDS[i]}`);
  }
const capacity = COMPARISON.find((g) => g.id === "capacity")!;
const attendees = capacity.rows.find((r) => r.label === "Attendees per webinar")!;
assert.deepEqual(
  PLAN_IDS.map((id) => attendees.cells[id]),
  ["100", "300", "500", "1,000+"],
);
const stage = capacity.rows.find((r) => r.label === "People on stage")!;
assert.deepEqual(
  PLAN_IDS.map((id) => stage.cells[id]),
  ["3", "5", "10", "100"],
);

// Not sold on any plan, so not in the table or the cards (31 Oct 2026): instant sessions,
// clips, highlights and reels; and nothing about months free.
const text = JSON.stringify([COMPARISON, PLANS]).toLowerCase();
for (const banned of ["instant", "clip", "reel", "highlights and", "months free", "attendee-hour", "ai credit"]) {
  assert.ok(!text.includes(banned), `the plans mention "${banned}"`);
}

// The /features sections, each row with a sentence for the page.
assert.deepEqual(
  featureGroups().map((g) => g.id),
  ["live", "grow", "reminders", "engage", "recording", "streaming", "ai", "integrations", "security"],
);

// Availability in words.
const row = (cells: Record<string, unknown>) => ({ label: "x", cells }) as never;
assert.equal(availability(row({ basic: true, pro: true, business: true, enterprise: true })), "Every plan");
assert.equal(availability(row({ basic: false, pro: true, business: true, enterprise: true })), "Professional and up");
assert.equal(availability(row({ basic: false, pro: false, business: true, enterprise: true })), "Business and up");
assert.equal(availability(row({ basic: false, pro: false, business: false, enterprise: true })), "Enterprise");

// Live: indexed, and "see pricing" goes to /pricing.
assert.equal(pricingHref(), "/pricing");
assert.equal(pricingHref("proposal"), "/pricing/proposed");
assert.equal(indexable(), true);
assert.equal(indexable("proposal"), false);

console.log("plans: ok");
