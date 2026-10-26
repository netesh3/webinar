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
  DEFAULT_FEATURES,
  av1Saving,
  boxRunHours,
  edgeGbPerViewerHour,
  edgeVideoKbps,
  featureRows,
  fixedRows,
  FEATURES,
  peakConcurrent,
  quotaFor,
  quotaWorstCase,
  sfuAdjust,
  shareMbps,
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
// recorded (30 days, 20% kept 3 months longer within the quota), AI on. ≈ ₹1,700–2,100 a coach.
const d = calculateCost(DEFAULT_INPUTS);
near(d.viewerHours, 2520);
near(d.participantHours, 250);
const coachInr = d.monthUsd * 100;
assert.ok(coachInr > 1700 && coachInr < 2100, `₹${coachInr} a coach`);
near(d.platformMonthUsd, d.monthUsd * 20, 1e-6);
near(d.monthUsd, d.lines.reduce((t, l) => t + l.usd, 0));
near(line(d, "cdn"), 2520 * 0.5228 * 0.005, 0.02);
// 20 coaches' 33 sessions each keep the on-demand box up all month (the 730 h cap).
near(line(d, "box"), 84 / 20);
near(line(d, "supabase"), 25 / 20);

// The on-demand box (api/internal/api/sfu_box.go): billed for the hours it runs.
{
  const do_ = DEFAULT_PROVIDERS.do;
  assert.equal(boxRunHours(do_, 100, 60), 100 + 55); // 60 sessions × 55 min warm-up and grace
  assert.equal(boxRunHours(do_, 2000, 600), 730);
  assert.equal(boxRunHours({ ...do_, boxHoursPerMonth: 120 }, 100, 60), 120); // measured, set by hand
  assert.equal(boxRunHours({ ...do_, boxOnDemand: false }, 1, 1), 730);
  assert.equal(boxRunHours(DEFAULT_PROVIDERS.gcp, 100, 60), 0);
  // Two coaches: 2 × (8 × 1.5 h + 25 × 1 h) = 74 session-hours, 66 sessions → 74 + 60.5 h.
  const two = calculateCost({ ...DEFAULT_INPUTS, coaches: 2 });
  near(line(two, "box"), (84 * (74 + 60.5)) / 730 / 2);
  // Always on again: the full month.
  const allMonth = calculateCost({
    ...DEFAULT_INPUTS,
    coaches: 2,
    providers: { ...DEFAULT_PROVIDERS, do: { ...DEFAULT_PROVIDERS.do, boxOnDemand: false } },
  });
  near(line(allMonth, "box"), 84 / 2);
}
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
const pooledKeys = [
  "origin", "stage", "webinar-share", "api", "api-meetings", "api-simulive", "meeting-transfer", "meeting-share",
  "turn-webinars", "turn-meetings", "av1-webinars", "av1-meetings", "youtube", "rec-upload",
];
const overageLines = pooledKeys.reduce((t, k) => t + line(tight, k), 0);
near(overageLines * 20, tight.pool.overageGb * doRate, 0.01);
// Half-full pool → only the excess bills.
const half = calculateCost(withRates("do", { boxIncludedTb: tight.pool.usedGb / 2000, apiServerIncludedTb: 0, workerIncludedTb: 0 }));
near(half.pool.overageGb, tight.pool.usedGb / 2, 1);

// Concurrency: the coaches' hours over the busy hours. 20 × 12 edge hours = 240 over 120 h:
// peak 2, the box renders one, so 120 h (80 starts × 10 min warm-up) on a c-2.
assert.equal(peakConcurrent(240, 120), 2);
assert.equal(peakConcurrent(241, 120), 3);
assert.equal(peakConcurrent(0, 120), 0);
assert.equal(d.servers.peakEdgeWebinars, 2);
assert.equal(d.servers.extraRenderWorkers, 1);
near(d.servers.extraRenderHours, 120);
near(line(d, "render-extra"), ((120 + 80 / 6) * 0.0625) / 20, 1e-6);
assert.equal(line(d, "worker"), 0);
// Ten coaches fit on the box: no extra render.
const ten = calculateCost({ ...DEFAULT_INPUTS, coaches: 10 });
assert.equal(line(ten, "render-extra"), 0);
// Sessions: 20 × (12 + 25) = 740 session-hours over 120 → 7 at once, under the 10 a box.
assert.equal(d.servers.peakSessions, 7);
assert.equal(d.servers.boxes, 1);
assert.equal(line(d, "extra-boxes"), 0);
// 100 coaches: 3,700 h → 31 at once → 4 boxes, 3 extra at $84, each bringing its 5 TB; and
// four boxes each render a mix, so of 1,200 edge hours 1,200 − 4 × 120 need workers.
const big = calculateCost({ ...DEFAULT_INPUTS, coaches: 100 });
assert.equal(big.servers.peakSessions, 31);
assert.equal(big.servers.extraBoxes, 3);
near(line(big, "extra-boxes"), (3 * 84) / 100, 1e-9);
near(big.servers.extraRenderHours, 1200 - 4 * 120);
assert.equal(big.servers.extraRenderWorkers, 10 - 4);
assert.ok(big.pool.includedGb >= 4 * 5000);
// GCP starts an SFU per session: never an extra box.
assert.equal(calculateCost({ ...DEFAULT_INPUTS, coaches: 100, provider: "gcp" }).servers.extraBoxes, 0);

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

// The side-by-side: same inputs, DigitalOcean beats GCP once meetings run. Hetzner is not
// offered any more (its server was deleted on 2026-10-26).
const c = compareProviders(DEFAULT_INPUTS);
assert.ok(c.do!.monthUsd < c.gcp!.monthUsd);
assert.ok(c.gcp!.perParticipantHourUsd > c.do!.perParticipantHourUsd);
assert.equal(c.hetzner, undefined);
// A calculation saved on Hetzner opens on the default provider.
assert.equal(withDefaults({ provider: "hetzner" }).provider, "do");

// Recording sizes by type: edge records the mix (≈0.52 GB/h) with no compute; meetings and
// standard delivery use a 1.75 GB/h composite with a worker.
const edgeOnly = calculateCost({ ...DEFAULT_INPUTS, meetingsPerMonth: 0 });
assert.equal(line(edgeOnly, "rec-worker"), 0);
// Held: 30 days (30 ÷ 30.42 months) plus 20% kept 3 months longer, under Business's 50 GiB.
const held = 30 / (365 / 12) + 0.2 * 3;
near(line(edgeOnly, "rec-storage"), 12 * edgeGbPerViewerHour(1000, 96) * held * 0.015, 1e-6);
const std = calculateCost({ ...DEFAULT_INPUTS, meetingsPerMonth: 0, delivery: "webrtc" });
near(line(std, "rec-storage"), 12 * 1.75 * held * 0.015, 1e-6);
near(line(std, "rec-worker"), 8 * (1.5 + 10 / 60) * 0.0625, 1e-6);
// The defaults record ~50 GB a month: Keep longer stops at the quota (50 GiB on a 300 plan).
assert.equal(d.storage.plan, "Business");
near(d.storage.quotaGb, 50 * 1.073741824, 1e-9);
near(d.storage.heldGb, d.storage.quotaGb, 1e-9);
near(line(d, "rec-storage"), 50 * 1.073741824 * 0.015, 1e-6);
// Over the quota on default retention alone, nothing is kept longer.
const over = calculateCost({ ...DEFAULT_INPUTS, planAttendeeCap: 200 });
assert.equal(over.storage.overQuota, true);
near(over.storage.heldGb, (12 * edgeGbPerViewerHour(1000, 96) + 25 * 1.75) * (30 / (365 / 12)), 1e-6);
// Enterprise's 200 GiB holds it all.
const ent = calculateCost({ ...DEFAULT_INPUTS, planAttendeeCap: 500 });
near(ent.storage.heldGb, (12 * edgeGbPerViewerHour(1000, 96) + 25 * 1.75) * held, 1e-6);
// Worst case: every coach fills the quota. 2 / 10 / 50 / 200 GiB at R2's $0.015.
const worst = quotaWorstCase(DEFAULT_INPUTS);
assert.deepEqual(worst.map((w) => w.plan), ["No plan", "Professional", "Business", "Enterprise"]);
near(worst[3].usd, 200 * 1.073741824 * 0.015, 1e-9);
near(worst[3].platformUsd, worst[3].usd * 20, 1e-9);
assert.equal(quotaFor(300).plan, "Business");
assert.equal(quotaFor(123).plan, "Business");
near(d.recordedHours, 37);
// Share recorded scales it.
const halfRec = calculateCost({ ...DEFAULT_INPUTS, recordMeetingsPercent: 50 });
near(line(halfRec, "rec-worker"), line(d, "rec-worker") / 2, 1e-6);
// B2 charges for replay; R2 doesn't.
assert.equal(line(d, "rec-replay"), 0);
near(line(calculateCost({ ...DEFAULT_INPUTS, recordingStore: "b2" }), "rec-replay"), 8 * 30 * edgeGbPerViewerHour(1000, 96) * 0.01, 1e-6);

// Simulive: zero egress and no SFU, only API traffic (and AI auto answers).
const base = { ...DEFAULT_INPUTS, webinarsPerMonth: 0, meetingsPerMonth: 0, features: { ...DEFAULT_FEATURES, ai: false }, emailsPerRegistrant: 0 };
const s0 = calculateCost({ ...base, simulivesPerMonth: 0 });
const s1 = calculateCost({ ...base, simulivesPerMonth: 10, viewersPerSimulive: 1000 });
assert.ok(s1.lines.find((l) => l.key === "simulive")?.info);
for (const key of ["cdn", "origin", "sfu", "stage", "worker", "render-extra", "meeting-transfer"]) {
  assert.equal(line(s1, key), 0, key);
}
// 6,000 viewer-hours × 3 MB of API a coach, × 20 coaches.
near(s1.pool.usedGb - s0.pool.usedGb, ((10 * 1000 * 0.6 * 3) / 1000) * 20, 1e-6);
const s1g = calculateCost({ ...base, provider: "gcp", simulivesPerMonth: 10, viewersPerSimulive: 1000 });
near(line(s1g, "api-simulive"), (10 * 1000 * 0.6 * 3 * 0.12) / 1000);
// Simulive off: no viewers, no API.
const s1off = calculateCost({ ...base, provider: "gcp", simulivesPerMonth: 10, features: { ...base.features, simulive: false } });
assert.equal(line(s1off, "api-simulive"), 0);

// AI: gpt-5-nano tokens, capped per host.
near(line(d, "ai-recap"), aiUsd(14 * 37, 3 * 37, 0.05, 0.4), 1e-9);
near(line(d, "ai-followup"), aiUsd(240, 72, 0.05, 0.4), 1e-9);
assert.equal(d.aiCapped, false);
const heavy = calculateCost({ ...DEFAULT_INPUTS, draftsPerSession: 5000 });
assert.equal(heavy.aiCapped, true);
near(heavy.groups.ai, 2, 1e-9);
assert.ok(heavy.aiUncappedUsd > 2);
const noAi = { ...DEFAULT_INPUTS, features: { ...DEFAULT_FEATURES, ai: false } };
assert.equal(calculateCost(noAi).groups.ai, 0);
// The Q&A confidence gate: half the questions skip the model. 8 × 10 drafts → 40 calls.
near(line(d, "ai-drafts"), aiUsd(3.5 * 40, 0.6 * 40, 0.05, 0.4), 1e-9);
near(line(calculateCost({ ...DEFAULT_INPUTS, qaSkipPercent: 0 }), "ai-drafts"), 2 * line(d, "ai-drafts"), 1e-9);
near(line(d, "ai-auto"), aiUsd(3.5 * 40, 0.6 * 40, 0.05, 0.4), 1e-9);
// Saved inputs from before the feature table: their AI and recording switches carry over.
const old = withDefaults({ ai: false, recording: false } as unknown as Partial<CostInputs>);
assert.equal(old.features.ai, false);
assert.equal(old.features.recording, false);
assert.equal(old.features.turn, true);

// Captions and WhatsApp are info, never cost.
for (const key of ["captions", "whatsapp"]) {
  const l = d.lines.find((x) => x.key === key)!;
  assert.ok(l.info && l.usd === 0, key);
}
// 37 session-hours × (1 core live + 0.75 × 2 cores final) × 0.6 (English-only) × 20 coaches.
near(d.captions.coreHours, 37 * 2.5 * 0.6 * 20, 1e-6);
assert.equal(calculateCost({ ...DEFAULT_INPUTS, features: { ...DEFAULT_FEATURES, captions: false } }).captions.coreHours, 0);
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

// ---- Recently shipped features.
const g12 = 0.12;
const on = (patch: Partial<typeof DEFAULT_FEATURES>) => ({ ...DEFAULT_FEATURES, ...patch });
// Screen share: slides 70% VP9 2.5 / 30% H264 4 = 2.95; video 4.3; 10% video → 3.085 Mbps.
near(shareMbps(DEFAULT_INPUTS), 3.085, 1e-9);
// AV1: 40% publishers × 60% receivers × 30% smaller = 7.2% of the camera downlink.
near(av1Saving(DEFAULT_INPUTS), 0.072, 1e-9);
assert.equal(av1Saving({ ...DEFAULT_INPUTS, features: on({ av1: false }) }), 0);
const adj = sfuAdjust(DEFAULT_INPUTS, { camGb: 100, shareReceiverHours: 10, publisherHours: 4 });
near(adj.shareGb, 10 * 0.4 * 3.085 * 0.45, 1e-9);
near(adj.av1Gb, -7.2, 1e-9);
// TURN: 5% of everything they receive (after AV1, with the share) and send, once more.
near(adj.turnGb, 0.05 * (100 - 7.2 + adj.shareGb + 4 * 0.75), 1e-9);
assert.equal(sfuAdjust({ ...DEFAULT_INPUTS, features: on({ turn: false }) }, { camGb: 100, shareReceiverHours: 0, publisherHours: 4 }).turnGb, 0);

// On GCP (no pool) every GB bills, so the deltas show. Meetings: 250 participant-hours, 9 of
// 10 receive each share.
const mShare = 250 * 0.9 * 0.4 * 3.085 * 0.45;
near(line(g, "meeting-share"), mShare * g12, 1e-9);
near(line(g, "av1-meetings"), -150 * 0.072 * g12, 1e-9);
near(line(g, "turn-meetings"), 0.05 * (150 * (1 - 0.072) + mShare + 250 * 0.75) * g12, 1e-9);
// Webinars on edge: the other person on stage receives the share; the two publish.
const sGb = 12 * ((0.6 * 2 + 2 * 2) / 2) * 0.45;
const wShare = 12 * 1 * 0.4 * 3.085 * 0.45;
near(line(g, "webinar-share"), wShare * g12, 1e-9);
near(line(g, "av1-webinars"), -sGb * 0.072 * g12, 1e-9);
near(line(g, "turn-webinars"), 0.05 * (sGb * (1 - 0.072) + wShare + 24 * 0.75) * g12, 1e-9);
near(g.deltas.av1Usd, line(g, "av1-webinars") + line(g, "av1-meetings"), 1e-12);
assert.ok(g.deltas.av1Usd < 0 && g.deltas.turnUsd > 0 && g.deltas.shareUsd > 0);
// WebRTC delivery: viewers receive the share too.
const gw = calculateCost({ ...DEFAULT_INPUTS, provider: "gcp", delivery: "webrtc" });
near(line(gw, "webinar-share"), (12 + 2520) * 0.4 * 3.085 * 0.45 * g12, 1e-9);
// Under DigitalOcean's pool they are within it: $0, an info line says so.
assert.equal(d.deltas.turnUsd, 0);
assert.ok(d.lines.find((l) => l.key === "turn-cpu")?.info);
assert.ok(d.lines.find((l) => l.key === "av1-uplink")?.info);
// All three off reproduce the camera-only traffic.
const plain = calculateCost({ ...DEFAULT_INPUTS, provider: "gcp", sharePercent: 0, features: on({ turn: false, av1: false }) });
for (const k of ["meeting-share", "webinar-share", "turn-meetings", "turn-webinars", "av1-meetings", "av1-webinars"]) {
  assert.equal(line(plain, k), 0, k);
}
near(line(plain, "meeting-transfer"), 150 * g12, 1e-9);

// Edge 1080p share profile: 1300 kbps for 40% of the session → 1120 kbps on average.
assert.equal(edgeVideoKbps(DEFAULT_INPUTS), 1000);
const es = { ...DEFAULT_INPUTS, features: on({ edgeShare: true }) };
near(edgeVideoKbps(es), 1120, 1e-9);
near(edgeVideoKbps({ ...es, edgeShareKbps: 1600 }), 1240, 1e-9);
const esr = calculateCost(es);
const dGb = edgeGbPerViewerHour(1120, 96) - edgeGbPerViewerHour(1000, 96);
near(line(esr, "edge-share-cdn"), 2520 * dGb * 0.005, 1e-9);
near(line(esr, "cdn"), line(d, "cdn"), 1e-12);
assert.ok(esr.lines.find((l) => l.key === "edge-share-cpu")?.info);
assert.equal(line(d, "edge-share-cdn"), 0);
near(line(calculateCost({ ...es, provider: "gcp" }), "edge-share-origin"), 12 * 3 * dGb * g12, 1e-9);

// YouTube: 10% of webinars push the edge mix; on standard delivery an unrecorded stream
// needs its own composite worker.
near(line(g, "youtube"), 1.2 * edgeGbPerViewerHour(1000, 96) * g12, 1e-9);
assert.equal(line(d, "youtube-worker"), 0);
const ytStd = calculateCost({ ...DEFAULT_INPUTS, delivery: "webrtc", recordWebinarsPercent: 0 });
near(line(ytStd, "youtube-worker"), (1.2 + (1.2 / 1.5) * (10 / 60)) * 0.0625, 1e-9);
assert.equal(line(calculateCost({ ...DEFAULT_INPUTS, delivery: "webrtc" }), "youtube-worker"), 0);

// Push: off by default (in progress). On, 30% of the 3 reminders each of 2,400 registrants
// gets go by push instead: 2,160 fewer emails.
assert.equal(line(d, "push"), 0);
const pushed = calculateCost({ ...DEFAULT_INPUTS, features: on({ push: true }) });
near(line(pushed, "push"), -2160 * 0.0002, 1e-12);
near(pushed.monthUsd, d.monthUsd - 2160 * 0.0002, 1e-9);

// Mix recording (#620): edge webinars' recordings need no worker on any provider.
for (const prov of ["do", "gcp"] as const) {
  const r0 = calculateCost({ ...DEFAULT_INPUTS, provider: prov, meetingsPerMonth: 0 });
  assert.equal(line(r0, "rec-worker"), 0, prov);
}

// The feature table: rows plus the fixed costs add up to the coach's month.
const rows = featureRows(d, DEFAULT_FEATURES);
assert.deepEqual(rows.map((x) => x.key), FEATURES.map((x) => x.key));
const fixedSum = fixedRows(d).reduce((t, x) => t + x.usd, 0);
near(rows.reduce((t, x) => t + x.usd, 0) + fixedSum, d.monthUsd, 1e-9);
for (const x of rows) near(x.platformUsd, x.usd * 20, 1e-9);
near(fixedSum, d.groups.fixed, 1e-12);
// A feature off costs nothing and leaves its row at zero.
for (const key of ["webinars", "meetings", "recording", "ai", "youtube", "messaging"] as const) {
  const offR = calculateCost({ ...DEFAULT_INPUTS, features: on({ [key]: false }) });
  const row = featureRows(offR, on({ [key]: false })).find((x) => x.key === key)!;
  assert.equal(row.usd, 0, key);
  assert.equal(row.on, false);
  // YouTube's GB are within DigitalOcean's pool, so dropping it saves nothing there.
  assert.ok(key === "youtube" ? offR.monthUsd <= d.monthUsd : offR.monthUsd < d.monthUsd, key);
}
// Coach scaling: the fixed share falls with more coaches; usage rows stay put on GCP.
const g40 = calculateCost({ ...DEFAULT_INPUTS, provider: "gcp", coaches: 40 });
near(featureRows(g40, DEFAULT_FEATURES)[1].usd, featureRows(g, DEFAULT_FEATURES)[1].usd, 1e-9);
assert.ok(g40.groups.fixed < g.groups.fixed);
near(g40.platformMonthUsd, g40.monthUsd * 40, 1e-9);

console.log("cost-calculator: ok");
