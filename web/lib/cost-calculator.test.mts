import assert from "node:assert/strict";
import {
  aiUsd,
  calculateCost,
  calculatePricing,
  grossUp,
  PRESETS,
  roundUpTo99,
  compareProviders,
  DEFAULT_INPUTS,
  DEFAULT_PROVIDERS,
  edgeGbPerViewerHour,
  withDefaults,
  type CostInputs,
} from "./cost-calculator.ts";

const near = (a: number, b: number, tol = 0.01) =>
  assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
type R = ReturnType<typeof calculateCost>;
const line = (r: R, key: string) => r.lines.find((l) => l.key === key)?.usd ?? 0;
const has = (r: R, key: string) => r.lines.some((l) => l.key === key);
const withRates = (provider: CostInputs["provider"], rates: Partial<typeof DEFAULT_PROVIDERS.do>): CostInputs => ({
  ...DEFAULT_INPUTS,
  provider,
  providers: { ...DEFAULT_PROVIDERS, [provider]: { ...DEFAULT_PROVIDERS[provider], ...rates } },
});

// The bitrate → GB conversion: ~0.87 GB at 1700+128, ~0.52 at 1000+96.
near(edgeGbPerViewerHour(1700, 128), 0.872, 0.005);
near(edgeGbPerViewerHour(1000, 96), 0.523, 0.005);
near(aiUsd(1000, 1000, 0.05, 0.4), 0.45);

// Defaults (DigitalOcean, 20 coaches): 8 × 1.5h × 300 at 70%, 25 meetings × 10 × 1h, all
// recorded 3 months, AI on. Lands at ≈ ₹1,700–2,100 a coach.
const d = calculateCost(DEFAULT_INPUTS);
near(d.viewerHours, 2520);
near(d.participantHours, 250);
const coachInr = d.monthUsd * 100;
assert.ok(coachInr > 1700 && coachInr < 2100, `₹${coachInr} a coach`);
near(d.platformMonthUsd, d.monthUsd * 20, 1e-6);
near(d.monthUsd, d.lines.reduce((t, l) => t + l.usd, 0));
near(line(d, "cdn"), 2520 * 0.5228 * 0.005, 0.02);
near(line(d, "box"), 84 / 20);
near(line(d, "supabase"), 25 / 20);
// ₹4,999 incl. GST, 2% fee, ₹100/$.
near(d.netRevenueUsd!, ((4999 / 1.18) * 0.98) / 100);
assert.ok(d.marginPercent! > 40, `margin ${d.marginPercent}`);

// Pool: under it, no transfer lines; the meetings show as an info line with the GCP price.
assert.ok(d.pool.percent! > 0 && d.pool.percent! < 100, `pool ${d.pool.percent}`);
assert.equal(d.pool.overageGb, 0);
assert.equal(line(d, "meeting-transfer"), 0);
assert.ok(d.lines.find((l) => l.key === "meeting-transfer")?.info);
near(d.meetingsOnGcpUsd, 250 * 0.6 * 0.12);

// Pool overage: shrink the pool and the overage is shared back by GB at $0.01/GiB.
const tight = calculateCost(withRates("do", { boxIncludedTb: 0, apiServerIncludedTb: 0, workerIncludedTb: 0 }));
near(tight.pool.overageGb, tight.pool.usedGb, 1e-6);
const doRate = 0.01 / 1.073741824;
near(line(tight, "meeting-transfer"), 250 * 0.6 * doRate, 0.001);
const overageLines = ["origin", "stage", "api", "meeting-transfer", "rec-upload"].reduce((t, k) => t + line(tight, k), 0);
near(overageLines * 20, tight.pool.overageGb * doRate, 0.01);
// Half-full pool → only the excess bills.
const half = calculateCost(withRates("do", { boxIncludedTb: tight.pool.usedGb / 2000, apiServerIncludedTb: 0, workerIncludedTb: 0 }));
near(half.pool.overageGb, tight.pool.usedGb / 2, 1);

// Concurrency: co-located render, so only edge webinars beyond the first need a c-2.
const one = calculateCost({ ...DEFAULT_INPUTS, peakConcurrentEdge: 1 });
assert.equal(line(one, "render-extra"), 0);
assert.equal(line(one, "worker"), 0);
const three = calculateCost({ ...DEFAULT_INPUTS, peakConcurrentEdge: 3, extraRenderHoursEach: 24 });
// 2 extra × (24 h + 16 starts × 10 min) × $0.0625, over 20 coaches.
near(line(three, "render-extra"), (2 * (24 + 16 / 6) * 0.0625) / 20, 1e-6);
// Each extra droplet adds its prorated 4 TB to the pool.
assert.ok(three.pool.includedGb > one.pool.includedGb);

// GCP: no pool, everything at $0.12/GB; one worker per edge webinar; SFU per session.
const g = calculateCost({ ...DEFAULT_INPUTS, provider: "gcp" });
assert.equal(g.pool.percent, null);
near(line(g, "meeting-transfer"), 250 * 0.6 * 0.12);
near(line(g, "worker"), 8 * (1.5 + 10 / 60) * 0.09);
near(line(g, "sfu"), 8 * (1.5 + 10 / 60) * 0.07);
near(line(g, "meeting-sfu"), 25 * (1 + 10 / 60) * 0.07);
near(line(g, "origin"), 12 * 3 * 0.5228 * 0.12, 0.02);
assert.ok(has(g, "cloudrun"));
assert.equal(line(g, "box"), 0);

// The side-by-side: same inputs, DigitalOcean and Hetzner beat GCP once meetings run.
const c = compareProviders(DEFAULT_INPUTS);
assert.ok(c.do.monthUsd < c.gcp.monthUsd);
assert.ok(c.hetzner.monthUsd < c.gcp.monthUsd);
assert.ok(c.gcp.perParticipantHourUsd > c.do.perParticipantHourUsd);

// Recording sizes by type: edge records the mix (≈0.52 GB/h) with no compute; meetings and
// standard delivery use a 1.75 GB/h composite with a worker.
const edgeOnly = calculateCost({ ...DEFAULT_INPUTS, meetingsPerMonth: 0 });
assert.equal(line(edgeOnly, "rec-worker"), 0);
near(line(edgeOnly, "rec-storage"), 12 * edgeGbPerViewerHour(1000, 96) * 3 * 0.015, 1e-6);
const std = calculateCost({ ...DEFAULT_INPUTS, meetingsPerMonth: 0, delivery: "webrtc" });
near(line(std, "rec-storage"), 12 * 1.75 * 3 * 0.015, 1e-6);
near(line(std, "rec-worker"), 8 * (1.5 + 10 / 60) * 0.0625, 1e-6);
near(line(d, "rec-storage"), (12 * edgeGbPerViewerHour(1000, 96) + 25 * 1.75) * 3 * 0.015, 1e-6);
near(d.recordedHours, 37);
// Share recorded scales it; Hetzner composites on the box cost nothing.
const halfRec = calculateCost({ ...DEFAULT_INPUTS, recordMeetingsPercent: 50 });
near(line(halfRec, "rec-worker"), line(d, "rec-worker") / 2, 1e-6);
assert.equal(line(calculateCost({ ...DEFAULT_INPUTS, provider: "hetzner" }), "rec-worker"), 0);
// B2 charges for replay; R2 doesn't.
assert.equal(line(d, "rec-replay"), 0);
near(line(calculateCost({ ...DEFAULT_INPUTS, recordingStore: "b2" }), "rec-replay"), 8 * 30 * edgeGbPerViewerHour(1000, 96) * 0.01, 1e-6);

// Simulive: zero egress and no SFU, only API traffic (and AI auto answers).
const base = { ...DEFAULT_INPUTS, webinarsPerMonth: 0, meetingsPerMonth: 0, ai: false, emailsPerRegistrant: 0 };
const s0 = calculateCost({ ...base, simulivesPerMonth: 0 });
const s1 = calculateCost({ ...base, simulivesPerMonth: 10, viewersPerSimulive: 1000 });
assert.ok(s1.lines.find((l) => l.key === "simulive")?.info);
for (const key of ["cdn", "origin", "sfu", "stage", "worker", "render-extra", "meeting-transfer"]) {
  assert.equal(line(s1, key), 0, key);
}
// 6,000 viewer-hours × 3 MB of API a coach, × 20 coaches.
near(s1.pool.usedGb - s0.pool.usedGb, ((10 * 1000 * 0.6 * 3) / 1000) * 20, 1e-6);
const s1g = calculateCost({ ...base, provider: "gcp", simulivesPerMonth: 10, viewersPerSimulive: 1000 });
near(line(s1g, "api"), (10 * 1000 * 0.6 * 3 * 0.12) / 1000);

// AI: gpt-5-nano tokens, capped per host.
near(line(d, "ai-recap"), aiUsd(14 * 37, 3 * 37, 0.05, 0.4), 1e-9);
near(line(d, "ai-followup"), aiUsd(240, 72, 0.05, 0.4), 1e-9);
assert.equal(d.aiCapped, false);
const heavy = calculateCost({ ...DEFAULT_INPUTS, draftsPerSession: 5000 });
assert.equal(heavy.aiCapped, true);
near(heavy.groups.ai, 2, 1e-9);
assert.ok(heavy.aiUncappedUsd > 2);
assert.equal(calculateCost({ ...DEFAULT_INPUTS, ai: false }).groups.ai, 0);

// Captions and WhatsApp are info, never cost.
for (const key of ["captions", "whatsapp"]) {
  const l = d.lines.find((x) => x.key === key)!;
  assert.ok(l.info && l.usd === 0, key);
}
// 37 session-hours × (1 core live + 0.75 × 2 cores final) × 20 coaches.
near(d.captions.coreHours, 37 * 2.5 * 20, 1e-6);
assert.equal(d.groups.info, 0);

// Old saved inputs (no providers, a stale videoServer) still load.
const legacy = withDefaults({ videoServer: "hetzner", webinarsPerMonth: 4 } as unknown as Partial<CostInputs>);
assert.equal(legacy.provider, "do");
assert.equal(legacy.providers.do.boxMonthlyUsd, 84);

// No price, no margin. Nonsense inputs cost nothing.
assert.equal(calculateCost({ ...DEFAULT_INPUTS, priceInr: 0 }).marginUsd, null);
const z = calculateCost({ ...DEFAULT_INPUTS, webinarsPerMonth: -3, meetingsPerMonth: NaN, simulivesPerMonth: 0 });
assert.equal(z.monthUsd, 0);
assert.equal(z.webinarUsd, 0);

// Minimum price: gross-up for margin, payment fee and GST.
near(grossUp(1000, 0, 0, false), 1000);
near(grossUp(1000, 0, 0, true), 1180);
near(grossUp(1000, 0, 2, true), 1180 / 0.98);
near(grossUp(1000, 60, 2, true), (1000 / 0.4 / 0.98) * 1.18);
// The grossed-up price really does leave the margin: net × (1 − 60%) = cost.
const gp = grossUp(1234, 60, 2, true);
near((gp / 1.18) * 0.98 * 0.4, 1234, 1e-6);
assert.equal(roundUpTo99(2950), 2999);
assert.equal(roundUpTo99(2999), 2999);
assert.equal(roundUpTo99(3000), 3099);
assert.equal(roundUpTo99(0), 0);

const pr = calculatePricing(DEFAULT_INPUTS);
near(pr.costInr, d.monthUsd * 100 + 300, 1e-6);
near(pr.breakEvenInr, (pr.costInr / 0.98) * 1.18, 1e-6);
assert.ok(pr.minimumInr >= grossUp(pr.costInr, 60, 2, true) && pr.minimumInr % 100 === 99, `${pr.minimumInr}`);
// ₹4,999 margin, overhead included.
near(pr.currentMarginInr!, (4999 / 1.18) * 0.98 - pr.costInr, 1e-6);
// Scale: the fixed share falls as coaches grow.
assert.deepEqual(pr.breakEvenAt.map((x) => x.coaches), [1, 10, 50]);
assert.ok(pr.breakEvenAt[0].inr > pr.breakEvenAt[1].inr && pr.breakEvenAt[1].inr > pr.breakEvenAt[2].inr);
// Presets order by cost; Typical is the defaults.
const at = (p: keyof typeof PRESETS) => calculatePricing({ ...DEFAULT_INPUTS, ...PRESETS[p].usage }).minimumInr;
assert.ok(at("light") < at("typical") && at("typical") < at("heavy"));
assert.equal(at("typical"), pr.minimumInr);
// Overage: none at the cap; Heavy (500) on a 300 plan prices 200 extra at the same margin.
assert.equal(pr.overage, null);
const hv = { ...DEFAULT_INPUTS, ...PRESETS.heavy.usage };
const ho = calculatePricing(hv).overage!;
near(ho.attendeeHours, 200 * 12 * 2 * 0.7, 1e-6);
near(ho.perAttendeeHourInr, grossUp(calculateCost(hv).perViewerHourUsd * 100, 60, 2, true), 1e-9);
assert.equal(calculatePricing({ ...hv, planAttendeeCap: 500 }).overage, null);

console.log("cost-calculator: ok");
