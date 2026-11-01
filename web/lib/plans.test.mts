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
    INR: { monthly: [9999, 24999, "60% OFF"], yearly: [99948, 499740, "80% OFF"] },
    USD: { monthly: [149, 375, "60% OFF"], yearly: [1490, 7450, "80% OFF"] },
  },
  business: {
    INR: { monthly: [24999, 62499, "60% OFF"], yearly: [249948, 1249740, "80% OFF"] },
    USD: { monthly: [349, 875, "60% OFF"], yearly: [3490, 17450, "80% OFF"] },
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

// The lineup: Basic, Professional ("pro"), Business, Enterprise; Starter is retired (2 Nov 2026).
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
// Attendees, stage, people per meeting and storage GB (1 Nov 2026).
assert.deepEqual(
  PLANS.map((p) => [p.limits.attendees, p.limits.stage, p.limits.meetingCap, p.limits.recordingGb]),
  [
    [100, 3, 10, 2],
    [300, 5, 20, 10],
    [500, 10, 100, 100],
    [1000, 100, 300, 500],
  ],
);
assert.deepEqual(cardLines(findPlan("basic")).slice(0, 4), [
  "Up to 100 attendees",
  "Up to 3 people on stage",
  "Meetings of up to 10 people",
  "2 GB storage",
]);
assert.deepEqual(cardLines(findPlan("enterprise")).slice(0, 2), ["1,000+ attendees", "Up to 100 people on stage"]);
// The lead line, Zoom style: "Everything in <the plan below>, plus:".
assert.deepEqual(PLANS.map((p) => p.lead), [
  "Includes:",
  "Everything in Basic, plus:",
  "Everything in Professional, plus:",
  "Everything in Business, plus:",
]);
// Every paid plan's monthly price shows 60% OFF; Enterprise shows no price or badge.
for (const p of selfServePlans())
  for (const c of ["INR", "USD"] as Currency[])
    assert.equal(offLabel(discountPercent(priceFor(p, c, "monthly")!, listFor(p, c, "monthly"))), "60% OFF", `${p.id} ${c}`);
assert.equal(findPlan("enterprise").list, undefined);

// Basic's card promises nothing Basic does not have.
for (const line of [findPlan("basic").lead, ...cardLines(findPlan("basic"))])
  for (const banned of ["WhatsApp", "Cloud recording", "captions", "spam", "AI", "Simulive", "follow-up"])
    assert.ok(!line.includes(banned), `Basic's card says "${line}"`);
assert.deepEqual(TIER_FEATURES.basic, []);
// Captions: AI Live captions Business and up, on the speaker's device everywhere.
const rowsByLabel = new Map(COMPARISON.flatMap((g) => g.rows).map((r) => [r.label, r]));
assert.deepEqual(PLAN_IDS.map((id) => rowsByLabel.get("AI Live captions")!.cells[id]), [false, false, true, true]);
assert.deepEqual(PLAN_IDS.map((id) => rowsByLabel.get("Captions on the speaker's device")!.cells[id]), [true, true, true, true]);
assert.deepEqual(PLAN_IDS.map((id) => rowsByLabel.get("Cloud recording")!.cells[id]), [false, true, true, true]);
assert.deepEqual(PLAN_IDS.map((id) => rowsByLabel.get("WhatsApp reminders and follow-ups")!.cells[id]), [false, true, true, true]);
assert.deepEqual(PLAN_IDS.map((id) => rowsByLabel.get("Chat spam filter")!.cells[id]), [false, false, true, true]);
assert.deepEqual(PLAN_IDS.map((id) => rowsByLabel.get("People per meeting")!.cells[id]), ["10", "20", "100", "300"]);
assert.ok(rowsByLabel.has("Storage (uploads and recordings)"));
// Streaming out and CSV exports Professional and up, Google Drive Business and up (0183); the
// AI renames (2 Nov 2026).
for (const label of ["Stream to YouTube", "Stream to LinkedIn, Facebook and Instagram", "CSV exports"])
  assert.deepEqual(PLAN_IDS.map((id) => rowsByLabel.get(label)!.cells[id]), [false, true, true, true], label);
assert.deepEqual(PLAN_IDS.map((id) => rowsByLabel.get("Google Drive")!.cells[id]), [false, false, true, true]);
assert.deepEqual(PLAN_IDS.map((id) => rowsByLabel.get("Google sign-in and calendar links")!.cells[id]), [true, true, true, true]);
assert.deepEqual(PLAN_IDS.map((id) => rowsByLabel.get("AI Blog, newsletter and social drafts")!.cells[id]), [false, false, true, true]);
for (const old of ["Server live captions", "Blog, newsletter and social drafts"]) assert.ok(!rowsByLabel.has(old), old);
assert.ok(findPlan("business").highlights.includes("AI Live captions"));
// Audience by device and location: Professional and up (migrations/0181).
for (const label of ["Attendance by device", "Attendance by location"])
  assert.deepEqual(PLAN_IDS.map((id) => rowsByLabel.get(label)!.cells[id]), [false, true, true, true], label);
// Gone for now (1 Nov 2026): the apps rows and their section, and HLS delivery.
for (const gone of ["Installable web app", "Desktop and mobile apps", "Delivery for very large audiences"])
  assert.ok(!rowsByLabel.has(gone), gone);
assert.ok(!COMPARISON.some((g) => g.id === "apps"));
// Every row a Basic host sees ticked is something every plan has.
for (const r of rowsByLabel.values()) if (r.cells.basic !== false) assert.notEqual(r.cells.enterprise, false, r.label);

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
assert.ok(!(TIER_FEATURES.basic as string[]).includes("whatsapp_crm") && TIER_FEATURES.pro.includes("whatsapp_crm"));
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
for (const banned of ["instant", "clip", "reel", "highlights and", "months free", "attendee-hour", "ai credit", "hls"]) {
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
