// The browser viewers' numbers (stall math, waves, the verdict), the worldwide generator plan
// and the droplet limit, the scenarios, and the simulive upload's parts.
import test from "node:test";
import assert from "node:assert/strict";
import { summarise, waves, report, verdict, stallsPerMinute, percentile, markdown, PASS } from "../lib/browser-summary.mjs";
import { throttleFor } from "../browser-viewers.mjs";
import { overloadGuard, roomUrl, initScript, NETWORK_PROFILES } from "../lib/browser-viewer.mjs";
import { parseRegions, checkDropletLimit, WORLD_PLAN, dropletNames, createArgs, costEstimate } from "../lib/provision.mjs";
import { plan, applyScenario } from "../run.mjs";
import { partsOf, ffmpegArgs } from "../lib/simulive.mjs";

const T0 = Date.parse("2026-10-26T10:00:00Z");

/* A viewer who watched `minutes` with samples every 5 s; `stallAt` lists sample indexes where
 * it was waiting (each starts a new stall). */
function viewer(id, { minutes = 10, stallAt = [], latency = 3.5, path = "direct", region = "blr1", firstFrameMs = 2000 } = {}) {
  const samples = [];
  let stalls = 0;
  const n = Math.round((minutes * 60) / 5);
  for (let i = 0; i <= n; i++) {
    const waiting = stallAt.includes(i) ? 1 : 0;
    if (waiting) stalls++;
    samples.push([T0 + i * 5000, waiting, stalls, latency]);
  }
  return { id, region, path, edge: path === "cdn" ? "BunnyCDN-SG1-1" : "box", throttle: null, joined: true, firstFrameMs, watchMs: n * 5000, stalls, stallMs: stalls * 2000, fallbacks: 0, badge: false, errors: 0, samples };
}

test("stalls per viewer-minute and the smooth share", () => {
  const smooth = viewer("a");
  const one = viewer("b", { stallAt: [10] });
  const bad = viewer("c", { stallAt: [10, 20, 30, 40] });
  assert.equal(stallsPerMinute(smooth), 0);
  assert.equal(stallsPerMinute(one), 0.1);
  assert.equal(stallsPerMinute(bad), 0.4);
  const s = summarise([smooth, one, bad]);
  assert.equal(s.joined, 3);
  assert.equal(s.stalls, 5);
  assert.equal(s.zeroStallShare, 0.333);
  // <= 1 stall per 10 min: a (0) and b (1 in 10 min) yes, c (4) no.
  assert.equal(s.smoothShare, 0.667);
  assert.equal(s.stallsPerViewerMinMax, 0.4);
  assert.equal(s.latencyP50Sec, 3.5);
});

test("a viewer that never got a picture is not joined, and does not count as smooth", () => {
  const never = { ...viewer("n"), joined: false, firstFrameMs: null, watchMs: 0, samples: [] };
  const s = summarise([viewer("a"), never], { target: 2 });
  assert.equal(s.joined, 1);
  assert.equal(s.joinedShare, 0.5);
  assert.equal(s.smoothShare, 1);
  assert.equal(verdict(s).find((c) => c.name.includes("reached the first frame")).pass, false);
});

test("waves: viewers stalled in the same 10 s window, the way the 25 Oct webinar stalled", () => {
  // 10 viewers; at sample 60 (5 min in) six of them wait at once; two stall alone elsewhere.
  const vs = [];
  for (let i = 0; i < 10; i++) vs.push(viewer(`v${i}`, { stallAt: i < 6 ? [60] : i === 8 ? [20] : [] }));
  const w = waves(vs);
  const worst = w.reduce((m, x) => (x.share > m.share ? x : m));
  assert.equal(worst.stalled, 6);
  assert.equal(worst.watching, 10);
  const s = summarise(vs);
  assert.equal(s.worstWave.stalled, 6);
  assert.equal(s.wavesOver10pct, 1);
  assert.equal(verdict(s).find((c) => c.name.includes("wave")).pass, false);
  // Scattered single stalls never make a wave over 10% with 10 viewers watching... unless 2 coincide.
  const scattered = [];
  for (let i = 0; i < 20; i++) scattered.push(viewer(`s${i}`, { stallAt: [i * 5 + 1] }));
  assert.equal(summarise(scattered).wavesOver10pct, 0);
});

test("a stall in progress at the end still counts (the count rises between samples)", () => {
  const v = viewer("x");
  v.samples[v.samples.length - 1][1] = 1; // waiting at the last sample, count not yet raised
  assert.equal(waves([v]).at(-1).stalled, 1);
});

test("report splits by path and by region / path, and the markdown has every section", () => {
  const vs = [viewer("a", { path: "direct", region: "blr1" }), viewer("b", { path: "cdn", region: "sgp1" }), viewer("c", { path: "cdn", region: "lon1", stallAt: [5] })];
  const r = report(vs, { target: 3 });
  assert.deepEqual(r.byPath.map((g) => [g.group, g.joined]), [["cdn", 2], ["direct", 1]]);
  assert.ok(r.byRegionPath.some((g) => g.group === "sgp1 / cdn"));
  assert.equal(r.all.edges["BunnyCDN-SG1-1"], 2);
  const md = markdown(r);
  for (const h of ["## Browser viewers", "### By delivery path", "### By generator region and path", "### By network profile", "CDN edges seen"]) assert.ok(md.includes(h), h);
  assert.ok(md.includes("| PASS |") || md.includes("| FAIL |"));
});

test("latency p95 against the 6 s bar", () => {
  const slow = [viewer("a", { latency: 7 }), viewer("b", { latency: 7 })];
  assert.equal(verdict(summarise(slow)).find((c) => c.name.includes("latency")).pass, false);
  assert.equal(verdict(summarise([viewer("a", { latency: 3.4 })])).find((c) => c.name.includes("latency")).pass, true);
  assert.equal(PASS.latencyP95Sec, 6);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([], 95), null);
});

test("throttled share is spread through the ramp", () => {
  const picked = [...Array(100).keys()].filter((i) => throttleFor(i, 0.2));
  assert.equal(picked.length, 20);
  assert.ok(picked[0] < 10 && picked.at(-1) >= 90);
  assert.equal([...Array(10).keys()].filter((i) => throttleFor(i, 0)).length, 0);
  assert.ok(NETWORK_PROFILES.slow4g.latency >= 100);
});

test("the generator overload guard needs three busy samples in a row", () => {
  const g = overloadGuard({ maxCpu: 70, consecutive: 3 });
  assert.deepEqual([80, 50, 80, 80, 80].map(g), ["ok", "ok", "ok", "ok", "over"]);
});

test("the page and its init script", () => {
  assert.equal(roomUrl("https://webinarliv.com/", "a b", "K1"), "https://webinarliv.com/webinars/a%20b/room?k=K1");
  assert.ok(initScript({ preferPath: "cdn" }).includes(`{"preferPath":"cdn"}`));
  assert.ok(initScript().includes("window.__LOAD_PROBE__ = {}"));
});

test("regions: the world plan, a list, a JSON array; unknown ones refused", () => {
  assert.deepEqual(parseRegions("world"), WORLD_PLAN);
  assert.equal(WORLD_PLAN.length, 7);
  assert.deepEqual(parseRegions("blr1, SGP1"), ["blr1", "sgp1"]);
  assert.deepEqual(parseRegions('["lon1","nyc3"]'), ["lon1", "nyc3"]);
  assert.throws(() => parseRegions("mars1"), /unknown DigitalOcean region/);
  assert.deepEqual(dropletNames("lt1", ["blr1", "sgp1"]), ["loadgen-lt1-1-blr1", "loadgen-lt1-2-sgp1"]);
  const a = createArgs({ name: "n", region: "sgp1", sshKeys: "1", userDataFile: "s.sh" });
  assert.ok(a.includes("ubuntu-24-04-x64") && a.includes("sgp1") && a.includes("--user-data-file"));
});

test("droplet limit: 10 with the ops droplet up and both boxes to come leaves 7 generators", () => {
  assert.equal(checkDropletLimit({ limit: 10, existing: 1, adding: 7 }), null);
  assert.match(checkDropletLimit({ limit: 10, existing: 1, adding: 8 }), /7 can be added/);
  // The video box already up: it is in `existing`, and only the captions box is still to come.
  assert.equal(checkDropletLimit({ limit: 10, existing: 2, adding: 7, boxesUp: 1 }), null);
  // During the run (generators up): the boxes must still fit.
  assert.equal(checkDropletLimit({ limit: 10, existing: 8, adding: 0 }), null);
  assert.match(checkDropletLimit({ limit: 10, existing: 9, adding: 0 }), /can be added/);
  assert.equal(costEstimate({ generators: 7, hours: 2 }), 1.75);
});

test("scenarios: a splits 150 over this machine and the generators; c is a simulive", () => {
  const a = plan({ scenario: "a", generators: "h1,h2" });
  assert.equal(a.viewersMode, "browser");
  assert.equal(a.viewers + a.extra, 150);
  assert.equal(a.viewers, 1); // the orchestrator runs one; the generators the rest
  assert.deepEqual(a.generators.map((g) => g.count), [75, 74]);
  // The content phases set the hold: camera 3 + screen 6 + video 6 + engagement 2 minutes.
  assert.deepEqual(a.phases.map((x) => x.kind), ["camera", "screen", "video", "engage"]);
  assert.equal(a.holdMs, 17 * 60_000);
  assert.ok(a.captions && a.engage);
  assert.equal(a.engage.atMs, a.rampMs + 15 * 60_000); // the engagement phase's start
  assert.equal(plan({ scenario: "b" }).browser.path, "cdn");
  const c = plan({ scenario: "c" });
  assert.equal(c.kind, "simulive");
  assert.equal(c.presenters, 0);
  assert.equal(c.viewers, 100);
  assert.equal(c.holdMs, 600_000);
  assert.deepEqual(c.phases, []);
  assert.throws(() => plan({ viewers: "browser", steps: "5,10" }), /--phases runs one step/);
  assert.equal(plan({ viewers: "browser", steps: "5", phases: false }).phases.length, 0);
  assert.throws(() => plan({ viewers: "browser", steps: "5", phases: "dance:3m" }), /not one of/);
  assert.equal(plan({ scenario: "d" }).browser.throttleShare, 0.2);
  assert.equal(applyScenario({ scenario: "a", steps: "5" }).steps, "5"); // a flag given wins
  assert.throws(() => plan({ scenario: "z" }), /scenario is one of/);
  assert.throws(() => plan({ kind: "simulive" }), /needs --viewers browser/);
  assert.throws(() => plan({ viewers: "browser", generators: "h1", generatorRegions: "blr1,sgp1" }), /2 region\(s\) for 1 generator/);
  assert.equal(plan({ viewers: "browser", steps: "10" }).maxViewers, 300);
});

test("simulive: the upload's parts cover the file exactly; the test video is faststart", () => {
  const parts = partsOf(25, 10);
  assert.deepEqual(parts.map((p) => [p.part, p.start, p.end]), [[1, 0, 10], [2, 10, 20], [3, 20, 25]]);
  const args = ffmpegArgs("/tmp/x.mp4", 600.2);
  assert.ok(args.includes("+faststart") && args.includes("601"));
});

test("the time strip: the fixture decodes (contract with web/lib/clock-strip.test.mts), noise is tolerated, damage is refused", async () => {
  const { decodeClock, lumasOf, CELLS } = await import("../lib/clock-strip.mjs");
  const FIXTURE = "101011111100101010010011101000110011000011";
  const at = Date.UTC(2026, 9, 26, 10, 0, 0, 120);
  const cells = [...FIXTURE].map((c) => c === "1");
  assert.equal(cells.length, CELLS);
  assert.equal(decodeClock(lumasOf(cells), at + 3000), at);
  // A real decode's levels are not 0/255: H.264 at ~1 Mbit/s read 255/0 in the local check,
  // but a darker encode with noise still reads.
  const noisy = lumasOf(cells, { white: 190, black: 40 }).map((l, i) => l + ((i * 37) % 21) - 10);
  assert.equal(decodeClock(noisy, at), at);
  // One flipped bit fails the checksum; no contrast is no read.
  const flipped = [...cells];
  flipped[20] = !flipped[20];
  assert.equal(decodeClock(lumasOf(flipped), at), null);
  assert.equal(decodeClock(cells.map(() => 128), at), null);
  assert.equal(decodeClock([], at), null);
});

test("glass to glass, join API, chat round trip, phases and the CDN lag in the report", async () => {
  const { report, byPhase, inWindow } = await import("../lib/browser-summary.mjs");
  const mk = (id, path, g2gSec, stallAt = []) => {
    const v = viewer(id, { path, stallAt });
    v.g2g = v.samples.filter((_, i) => i % 2 === 0).map((s) => [s[0], g2gSec]);
    v.joinApiMs = 300;
    v.chatRttMs = [450];
    return v;
  };
  const vs = [mk("d1", "direct", 3.5), mk("d2", "direct", 3.7), mk("c1", "cdn", 4.6, [70]), mk("c2", "cdn", 4.8)];
  const phases = [
    { name: "camera", start: new Date(T0).toISOString(), end: new Date(T0 + 300_000).toISOString() },
    { name: "screen share", start: new Date(T0 + 300_000).toISOString(), end: new Date(T0 + 600_000).toISOString() },
  ];
  const r = report(vs, { target: 4, phases });
  assert.equal(r.byPath.find((g) => g.group === "direct").g2gP95Sec, 3.7);
  assert.equal(r.cdnLagSec, 1.1);
  assert.equal(r.all.joinApiP50Ms, 300);
  assert.equal(r.all.chatRttP95Ms, 450);
  assert.deepEqual(r.byPhase.map((p) => [p.group, p.stalls]), [["camera", 0], ["screen share", 1]]);
  assert.ok(r.verdict.some((c) => c.name.includes("through the CDN") && c.pass));
  // A window holds only its own stalls: c1's stall at sample 70 (5 min 50 s) is in the second.
  const w1 = inWindow(vs[2], T0, T0 + 300_000);
  assert.equal(w1.stalls, 0);
  assert.equal(byPhase(vs, []).length, 0);
});

test("the CDN prober's playlist reading", async () => {
  const { mediaPlaylistUrl, newestSegment, summariseProbe } = await import("../lib/cdn-probe.mjs");
  const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1088216\nvideo1_stream.m3u8\n";
  assert.equal(mediaPlaylistUrl(master, "https://cdn.test/live/s/index.m3u8"), "https://cdn.test/live/s/video1_stream.m3u8");
  const media = "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\nseg1.mp4\n#EXTINF:1.0,\nseg2.mp4\n";
  assert.equal(newestSegment(media, "https://cdn.test/live/s/video1_stream.m3u8"), "https://cdn.test/live/s/seg2.mp4");
  const s = summariseProbe([
    { kind: "playlist", status: 200, ttfbMs: 100, totalMs: 110, edge: "BunnyCDN-SG1-1", cache: "MISS" },
    { kind: "playlist", status: 200, ttfbMs: 1500, totalMs: 1510, edge: "BunnyCDN-SG1-1", cache: "HIT" },
    { kind: "segment", status: 0, ttfbMs: null, totalMs: 10000, edge: "", cache: "" },
  ]);
  assert.equal(s.playlist.slowOver1s, 1);
  assert.equal(s.playlist.edges["BunnyCDN-SG1-1"], 2);
  assert.equal(s.segment.errors, 1);
});

test("the in-page scripts parse (they are template literals: a stray backslash breaks them silently)", async () => {
  const { SAMPLE, initScript } = await import("../lib/browser-viewer.mjs");
  const { READ_STRIP } = await import("../lib/clock-strip.mjs");
  for (const src of [SAMPLE, READ_STRIP]) assert.doesNotThrow(() => new Function(`return ${src}`));
  assert.doesNotThrow(() => new Function(initScript({ preferPath: "cdn" })));
});

test("Bunny's log: lines parsed, the window and the webinar kept, 499/504/HIT as percentages", async () => {
  const { parseLine, summarise, logUrl } = await import("../lib/bunny-log.mjs");
  const at = Date.UTC(2026, 9, 25, 5, 46, 43);
  const line = (cache, status, t, url, edge = "SG") => `${cache}|${status}|${t}|736|6835297|103.160.237.0|https://webinarliv.com/|${url}|${edge}|Mozilla|id|IN`;
  const u = (p) => `https://webinarlivindiav.b-cdn.net/live/slug-1/${p}`;
  const recs = [
    line("MISS", 200, at, u("video1_stream.m3u8?_HLS_msn=1585&_HLS_part=0")),
    line("-", 499, at + 2000, u("video1_stream.m3u8?_HLS_msn=1585&_HLS_part=0")),
    line("HIT", 200, at + 3000, u("seg1585.mp4")),
    line("MISS", 504, at + 4000, u("seg1586.mp4"), "MU"),
    line("HIT", 200, at + 5000, "https://webinarlivindiav.b-cdn.net/live/other/index.m3u8"),
    line("HIT", 200, at + 120_000, u("seg1700.mp4")), // outside the window
    "not a log line",
  ].map(parseLine).filter(Boolean);
  assert.equal(recs.length, 6);
  assert.equal(recs[0].kind, "playlist");
  assert.equal(recs[2].kind, "segment");
  const s = summarise(recs, { from: at, to: at + 60_000, slug: "slug-1" });
  assert.equal(s.all.requests, 4);
  assert.equal(s.all.pct499, 25);
  assert.equal(s.all.pct504, 25);
  assert.equal(s.all.hitPct, 25);
  assert.deepEqual(s.byEdge.map((e) => e.key), ["MU", "SG"]);
  assert.equal(logUrl(at, 6835297), "https://logging.bunnycdn.com/10-25-26/6835297.log");
});

test("metrics: series stats, and the captions box's latency line", async () => {
  const { stats, parseCaptionLatency, PHASE_QUERIES } = await import("../lib/metrics.mjs");
  assert.deepEqual(stats([1, 2, 3, 4, 100]), { avg: 22, p95: 100, max: 100 });
  assert.equal(stats([NaN]), null);
  const line = "2026-10-25 05:11:48,403 INFO captions.latency caption latency webinar_self-testing: finals 15, partials 0 | e2e p50 2131 p90 3297 | queue p50 153 p90 1446";
  assert.deepEqual(parseCaptionLatency(line), { room: "webinar_self-testing", finals: 15, e2eP50Ms: 2131, e2eP90Ms: 3297 });
  assert.equal(parseCaptionLatency("something else"), null);
  for (const k of ["boxCpuPct", "boxCpuByService", "captionsCpuCores", "apiP95Sec", "apiJoinP95Sec", "dbSizeMB"]) assert.ok(PHASE_QUERIES[k], k);
});
