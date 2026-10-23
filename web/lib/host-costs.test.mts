import assert from "node:assert/strict";
import type { AdminCostHost, AdminCostPlatform, AdminCostUsage } from "./api-types.ts";
import { DEFAULT_FEATURES, DEFAULT_INPUTS, edgeGbPerViewerHour, sfuAdjust, withDefaults } from "./cost-calculator.ts";
import {
  costContext,
  hostContext,
  hostsCsv,
  platformCost,
  poolRates,
  presetRange,
  priceHost,
  priceHosts,
  priceReport,
  priceUsage,
  toCsv,
  usageGb,
  visibleHosts,
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
  hostId: email, name: email, email, byProvider, ignoredBy: "",
  extras: { recordingGbDays: 0, mediaGbDays: 0, knowledgeGbDays: 0, recordingGb: 0, mediaGb: 0, knowledgeGb: 0, ai: [], emails: [], whatsapp: [], ...extras },
});
const line = (lines: { key: string; usd: number }[], key: string) => lines.find((l) => l.key === key)?.usd ?? 0;

const START = "2026-09-01T00:00:00Z";
const END = "2026-10-01T10:00:00Z"; // 730 hours: one calculator month
// Camera-only traffic (no screen share, TURN or AV1) for the pool arithmetic below; those
// have their own test at the end.
const i = withDefaults({ ...DEFAULT_INPUTS, sharePercent: 0, features: { ...DEFAULT_FEATURES, turn: false, av1: false } });

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
    unattributedRecordingGbDays: 0, ignoredSessionHours: 0,
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
  const pools = poolRates({ byProvider: {}, firstSessionAt: {}, sessionHours: 0, unattributedAiUsd: 0, unattributedRecordingGbDays: 0, ignoredSessionHours: 0 }, START, END, i);
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
    unattributedRecordingGbDays: 0, ignoredSessionHours: 0,
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

// ---- An on-demand box (platform.boxHours): billed for the hours it ran, not since the first session.
{
  const platform: AdminCostPlatform = {
    byProvider: { do: usage({ boxShareHours: 30 }) },
    firstSessionAt: { do: "2026-09-16T05:00:00Z" },
    boxHours: { do: 50 },
    sessionHours: 40,
    unattributedAiUsd: 0,
    unattributedRecordingGbDays: 0, ignoredSessionHours: 0,
  };
  const pc = platformCost(platform, START, END, i);
  // 50 hours up, 30 of them busy: 20 idle hours, at the same hourly rate.
  near(line(pc.lines, "idle-do"), (20 * i.providers.do.boxMonthlyUsd) / 730);
  // The box's transfer allowance follows the hours too.
  const always = poolRates({ ...platform, boxHours: undefined }, START, END, i).do.includedGb;
  near(always - poolRates(platform, START, END, i).do.includedGb, (i.providers.do.boxIncludedTb * (365 - 50) * 1000) / 730);
}

// ---- The ignore list: hidden hosts leave the totals and the share's denominator.
{
  // 40 session-hours: a real host's 30 and a test account's 10.
  const platform: AdminCostPlatform = {
    byProvider: { do: usage({ boxShareHours: 40 }) },
    firstSessionAt: { do: START },
    sessionHours: 40,
    unattributedAiUsd: 2,
    unattributedRecordingGbDays: 0,
    ignoredSessionHours: 10,
  };
  const real = host("real@customer.in", { do: usage({ sessionHours: 30, boxShareHours: 30, liveHours: 30 }) });
  const test = { ...host("qa@test.dev", { do: usage({ sessionHours: 10, boxShareHours: 10, liveHours: 10 }) }), ignoredBy: "rule-1" };
  const fixed = platformCost(platform, START, END, i).usd;

  // Hidden: the real host carries the whole platform cost; the test account none of it.
  const hidden = costContext(platform, START, END, i, true, true);
  near(hidden.platform.perSessionHourUsd, fixed / 30);
  near(hidden.platform.usd, fixed);
  const rh = priceReport([real, test], hidden);
  assert.deepEqual(rh.counted.map((p) => p.host.email), ["real@customer.in"]);
  assert.deepEqual(rh.ignored.map((p) => p.host.email), ["qa@test.dev"]);
  near(rh.counted[0].columns.platform, fixed);
  assert.equal(rh.ignored[0].columns.platform, 0);
  assert.ok(rh.ignoredUsd > 0);
  near(rh.totalUsd, rh.counted[0].totalUsd);
  assert.equal(hostContext(hidden, test).allocatePlatform, false);
  assert.equal(hostContext(hidden, real).allocatePlatform, true);
  assert.deepEqual(visibleHosts(rh, true).map((p) => p.host.email), ["real@customer.in"]);

  // Shown: everybody priced as before, shared by all 40 hours; the total takes both in.
  const shown = costContext(platform, START, END, i, true, false);
  near(shown.platform.perSessionHourUsd, fixed / 40);
  const rs = priceReport([real, test], shown);
  near(rs.counted[0].columns.platform, (30 / 40) * fixed);
  near(rs.ignored[0].columns.platform, (10 / 40) * fixed);
  near(rs.totalUsd, rs.counted[0].totalUsd + rs.ignored[0].totalUsd);
  assert.equal(visibleHosts(rs, false).length, 2);

  // Everyone ignored: nothing to spread over, no division by zero.
  near(costContext({ ...platform, ignoredSessionHours: 40 }, START, END, i, true, true).platform.perSessionHourUsd, 0);

  // The CSV says which rows are ignored, and holds only what is visible.
  const hiddenCsv = hostsCsv(visibleHosts(rh, true), 100).trim().split("\n");
  assert.match(hiddenCsv[0], /,Ignored$/);
  assert.equal(hiddenCsv.length, 2);
  assert.ok(hiddenCsv[1].endsWith(","));
  const shownCsv = hostsCsv(visibleHosts(rs, false), 100).trim().split("\n");
  assert.equal(shownCsv.length, 3);
  assert.ok(shownCsv[2].startsWith("qa@test.dev,") && shownCsv[2].endsWith(",yes"));
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

// ---- Screen share, TURN and AV1 at the calculator's defaults, the same function it uses.
{
  const d = withDefaults(DEFAULT_INPUTS);
  const u = usage({ meetingParticipantHours: 100, webrtcViewerHours: 10, stagePairHours: 2 });
  const g = usageGb(u, d);
  const m = sfuAdjust(d, { camGb: 100 * 0.6, shareReceiverHours: 100, publisherHours: 100 });
  const w = sfuAdjust(d, { camGb: 10 * 1.5 * 0.45 + 2 * 1.3 * 0.45, shareReceiverHours: 10, publisherHours: 0 });
  near(g.share, m.shareGb + w.shareGb);
  near(g.turn, m.turnGb + w.turnGb);
  near(g.av1, m.av1Gb + w.av1Gb);
  assert.ok(g.av1 < 0 && g.share > 0 && g.turn > 0);
  near(g.pooled, g.webrtc + g.stage + g.meeting + g.share + g.turn + g.av1);
  // On GCP every GB bills: share and TURN cost, AV1 saves.
  const pools = poolRates({ byProvider: {}, firstSessionAt: {}, sessionHours: 0, unattributedAiUsd: 0, unattributedRecordingGbDays: 0, ignoredSessionHours: 0 }, START, END, d);
  const lines = priceUsage(u, "gcp", d, pools);
  near(line(lines, "share"), g.share * 0.12);
  near(line(lines, "turn"), g.turn * 0.12);
  near(line(lines, "av1"), g.av1 * 0.12);
}

console.log("host-costs: ok");
