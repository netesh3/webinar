import assert from "node:assert/strict";
import type { AdminCostHost, AdminCostPlatform, AdminCostUsage } from "./api-types.ts";
import { DEFAULT_INPUTS, edgeGbPerViewerHour, withDefaults } from "./cost-calculator.ts";
import {
  costContext,
  hostsCsv,
  platformCost,
  poolRates,
  presetRange,
  priceHost,
  priceHosts,
  priceUsage,
  toCsv,
  usageGb,
} from "./host-costs.ts";

const near = (a: number, b: number, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

const zero: AdminCostUsage = {
  sessions: 0, webinars: 0, meetings: 0, simulives: 0, attendees: 0, sessionHours: 0, liveHours: 0,
  boxShareHours: 0, edgeLiveHours: 0, edgeExtraHours: 0, stagePairHours: 0, edgeViewerHours: 0,
  webrtcViewerHours: 0, meetingParticipantHours: 0, simuliveViewerHours: 0, zoomAttendeeHours: 0,
  compositeRecHours: 0, mixRecHours: 0, browserRecHours: 0, recordedGb: 0, captionLiveHours: 0,
  captionFinalHours: 0,
};
const usage = (u: Partial<AdminCostUsage>): AdminCostUsage => ({ ...zero, ...u });
const host = (email: string, byProvider: Record<string, AdminCostUsage>, extras: Partial<AdminCostHost["extras"]> = {}): AdminCostHost => ({
  hostId: email, name: email, email, byProvider,
  extras: { recordingGbDays: 0, mediaGbDays: 0, knowledgeGbDays: 0, recordingGb: 0, mediaGb: 0, knowledgeGb: 0, ai: [], emails: [], whatsapp: [], ...extras },
});
const line = (lines: { key: string; usd: number }[], key: string) => lines.find((l) => l.key === key)?.usd ?? 0;

const START = "2026-09-01T00:00:00Z";
const END = "2026-10-01T10:00:00Z"; // 730 hours: one calculator month
const i = withDefaults(DEFAULT_INPUTS);

// ---- Usage to GB.
{
  const g = usageGb(usage({ edgeViewerHours: 10, webrtcViewerHours: 2, meetingParticipantHours: 5, stagePairHours: 2, edgeLiveHours: 1 }), i);
  const pvh = edgeGbPerViewerHour(i.edgeVideoKbps, i.edgeAudioKbps);
  near(g.cdn, 10 * pvh);
  near(g.origin, i.originPulls * pvh);
  near(g.webrtc, 2 * i.webrtcViewerMbps * 0.45);
  near(g.meeting, 5 * i.meetingGbPerParticipantHour);
  // Two ordered pairs (two people on stage) at 1.3 Mbps each: stageMbps 0.6–2, midpoint.
  near(g.stage, 2 * 1.3 * 0.45);
}

// ---- Pool allocation: DigitalOcean's 5 TB box pool; overage spread over every GB.
{
  const platform: AdminCostPlatform = {
    byProvider: { do: usage({ meetingParticipantHours: 25000 }) }, // 15,000 GB at 0.6 GB/h
    firstSessionAt: { do: "2026-08-01T00:00:00Z" },
    sessionHours: 100,
    unattributedAiUsd: 0,
    unattributedRecordingGbDays: 0,
  };
  const pools = poolRates(platform, START, END, i);
  near(pools.do.usedGb, 15000);
  // The box (5 TB) and, as the API runs on a DO droplet by default, its 4 TB.
  near(pools.do.includedGb, 9000);
  near(pools.do.overageGb, 6000);
  near(pools.do.perGb, (6000 * i.providers.do.overagePerGb) / 15000);
  // A host with a third of the GB pays a third of the overage.
  const lines = priceUsage(usage({ meetingParticipantHours: 25000 / 3 }), "do", i, pools);
  near(line(lines, "meeting-transfer"), (6000 * i.providers.do.overagePerGb) / 3);
  // Within the pool it is free, and says so.
  const small = poolRates({ ...platform, byProvider: { do: usage({ meetingParticipantHours: 100 }) } }, START, END, i);
  assert.equal(small.do.perGb, 0);
  const free = priceUsage(usage({ meetingParticipantHours: 100 }), "do", i, small);
  assert.equal(line(free, "meeting-transfer"), 0);
  assert.ok(free.some((l) => l.key === "meeting-transfer" && l.info));
  // GCP has no pool: its egress price.
  near(pools.gcp.perGb, i.providers.gcp.overagePerGb);
}

// ---- Line totals on one provider.
{
  const pools = poolRates({ byProvider: {}, firstSessionAt: {}, sessionHours: 0, unattributedAiUsd: 0, unattributedRecordingGbDays: 0 }, START, END, i);
  const u = usage({ boxShareHours: 2, liveHours: 3, edgeLiveHours: 3, edgeExtraHours: 1, webrtcViewerHours: 10, compositeRecHours: 2, captionLiveHours: 1 });
  // GCP: per-session SFU by shared hours, a worker for every Edge hour, composite workers.
  const g = priceUsage(u, "gcp", i, pools);
  near(line(g, "server"), 2 * i.providers.gcp.sfuPerHour);
  near(line(g, "render"), 3 * i.providers.gcp.workerPerHour);
  near(line(g, "composite"), 2 * i.providers.gcp.workerPerHour);
  near(line(g, "webrtc"), 10 * i.webrtcViewerMbps * 0.45 * i.providers.gcp.overagePerGb);
  assert.ok(g.some((l) => l.key === "captions" && l.info && l.usd === 0));
  // Hetzner: the box's hour, only the extra render, composites on the box.
  const h = priceUsage(u, "hetzner", i, pools);
  near(line(h, "server"), (2 * i.providers.hetzner.boxMonthlyUsd) / 730);
  near(line(h, "render"), 1 * i.providers.hetzner.workerPerHour);
  assert.equal(line(h, "composite"), 0);
  // No video server: info only.
  const none = priceUsage(usage({ simuliveViewerHours: 50 }), "none", i, pools);
  assert.ok(none.every((l) => l.usd === 0) && none.some((l) => l.key === "simulive"));
}

// ---- Platform cost and its share.
{
  const platform: AdminCostPlatform = {
    byProvider: { do: usage({ boxShareHours: 30 }) },
    firstSessionAt: { do: "2026-09-16T05:00:00Z" }, // half the range
    sessionHours: 40,
    unattributedAiUsd: 1,
    unattributedRecordingGbDays: 0,
  };
  const pc = platformCost(platform, START, END, i);
  near(line(pc.lines, "supabase"), i.supabaseUsd);
  near(line(pc.lines, "idle-do"), ((365 - 30) * i.providers.do.boxMonthlyUsd) / 730);
  near(line(pc.lines, "ai"), 1);
  near(pc.perSessionHourUsd, pc.usd / 40);

  const a = host("a@x", { do: usage({ sessionHours: 30, boxShareHours: 30, liveHours: 30 }) }, {
    ai: [{ feature: "recap", calls: 2, promptTokens: 2000, completionTokens: 200, costUsd: 0.02 }],
    emails: [{ kind: "followup", count: 10 }],
    recordingGbDays: 30.416666666666668, // one GB for one calculator month
  });
  const b = host("b@x", { none: usage({ sessionHours: 10, simuliveViewerHours: 5 }) });
  const ctx = costContext(platform, START, END, i, true);
  const pa = priceHost(a, ctx);
  near(pa.columns.ai, 0.02);
  near(pa.columns.email, 10 * i.emailUsd);
  near(line(pa.lines, "rec-storage"), 0.015);
  near(pa.columns.platform, (30 / 40) * pc.usd);
  near(pa.totalUsd, Object.values(pa.columns).reduce((t, x) => t + x, 0));
  const sorted = priceHosts([b, a], ctx);
  assert.equal(sorted[0].host.email, "a@x");
  // Unallocated: no share on anybody.
  assert.equal(priceHost(a, costContext(platform, START, END, i, false)).columns.platform, 0);

  const csv = hostsCsv(sorted, 100).split("\n");
  assert.match(csv[0], /^Host,Email,Session hours,Total USD,Total INR/);
  assert.ok(csv[1].startsWith("a@x,a@x,30.0000,"));
}

// ---- Ranges and CSV quoting.
{
  const now = new Date(2026, 9, 23);
  assert.deepEqual(presetRange("month", now), { from: "2026-10-01", to: "2026-10-23" });
  assert.deepEqual(presetRange("last-month", now), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(presetRange("last-month", new Date(2026, 0, 5)), { from: "2025-12-01", to: "2025-12-31" });
  assert.deepEqual(presetRange("all", now), { from: "", to: "" });
  assert.equal(toCsv([["a,b", 'say "hi"', 1]]), '"a,b","say ""hi""",1.0000\n');
}

console.log("host-costs: ok");
