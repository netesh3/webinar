import assert from "node:assert/strict";
import { calculateCost, DEFAULT_INPUTS, edgeGbPerViewerHour } from "./cost-calculator.ts";

const near = (a: number, b: number, tol = 0.01) =>
  assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const line = (r: ReturnType<typeof calculateCost>, key: string) =>
  r.lines.find((l) => l.key === key)?.usd ?? 0;

// The bitrate → GB conversion the pricing discussion used: ~0.87 GB at 1700+128, ~0.52 at 1000+96.
near(edgeGbPerViewerHour(1700, 128), 0.872, 0.005);
near(edgeGbPerViewerHour(1000, 96), 0.523, 0.005);

// Defaults: 4 × 1.5h, 300 viewers watching 70%, 2 on stage, edge on Mumbai, recorded.
const d = calculateCost(DEFAULT_INPUTS);
near(d.viewerHours, 1260);
near(line(d, "cdn"), 1260 * 0.5228 * 0.005, 0.02);
near(line(d, "worker"), 4 * (1.5 + 10 / 60) * 0.09);
near(line(d, "origin"), 6 * 3 * 0.5228 * 0.12, 0.02);
near(line(d, "sfu"), 4 * (1.5 + 10 / 60) * 0.07);
near(d.monthUsd, d.lines.reduce((t, l) => t + l.usd, 0));
near(d.webinarUsd, d.monthUsd / 4);
// ₹4,999 incl. GST, 2% fee, ₹100/$.
near(d.netRevenueUsd!, (4999 / 1.18) * 0.98 / 100);
assert.ok(d.marginPercent! > 70 && d.marginPercent! < 95, `margin ${d.marginPercent}`);

// Hetzner: traffic and composites are the box's. The CDN and the API (Cloud Run) still bill.
const h = calculateCost({ ...DEFAULT_INPUTS, videoServer: "hetzner" });
for (const key of ["origin", "stage", "sfu", "worker", "rec-worker", "rec-upload"]) {
  assert.equal(line(h, key), 0, key);
}
assert.ok(line(h, "cdn") > 0);
assert.ok(line(h, "api") > 0);
assert.ok(line(h, "rec-storage") > 0);

// Recordings: 6 recorded hours × 1.75 GB leave GCP once; R2 stores at $0.015 with free replay,
// B2 stores cheaper and charges for replay.
near(line(d, "rec-upload"), 6 * 1.75 * 0.12);
near(line(d, "rec-storage"), 6 * 1.75 * 3 * 0.015);
assert.equal(line(d, "rec-replay"), 0);
const b2 = calculateCost({ ...DEFAULT_INPUTS, recordingStore: "b2" });
near(line(b2, "rec-storage"), 6 * 1.75 * 3 * 0.006);
near(line(b2, "rec-replay"), 4 * 30 * 1.75 * 0.01);

// API egress: 1260 viewer-hours × 3 MB at $0.12/GB.
near(line(d, "api"), (1260 * 3 * 0.12) / 1000);

// WebRTC delivery on GCP pays SFU egress per viewer and no CDN or edge worker.
const w = calculateCost({ ...DEFAULT_INPUTS, delivery: "webrtc" });
assert.equal(line(w, "cdn"), 0);
assert.equal(line(w, "worker"), 0);
near(line(w, "webrtc"), 1260 * 1.5 * 0.45 * 0.12, 0.05);

// Stage traffic grows with the square of the stage; one person on stage sends nobody anything.
assert.equal(line(calculateCost({ ...DEFAULT_INPUTS, onStage: 1 }), "stage"), 0);
assert.ok(line(calculateCost({ ...DEFAULT_INPUTS, onStage: 6 }), "stage") > 10 * line(d, "stage"));

// No recording, no recording lines. No price, no margin. Nonsense inputs cost nothing.
const n = calculateCost({ ...DEFAULT_INPUTS, recording: false, priceInr: 0 });
assert.equal(line(n, "rec-worker") + line(n, "rec-storage") + line(n, "rec-upload"), 0);
assert.equal(n.marginUsd, null);
const z = calculateCost({ ...DEFAULT_INPUTS, webinarsPerMonth: -3, viewersPerWebinar: NaN });
assert.equal(z.monthUsd, 0);
assert.equal(z.webinarUsd, 0);

console.log("cost-calculator: ok");
