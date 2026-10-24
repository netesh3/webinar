// node --test e2e/load/test/
import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, parseDuration, parseSteps, rampSchedule } from "../lib/args.mjs";
import { percentile, Samples, Step, Counter, table, dumpStep, mergeDumps } from "../lib/stats.mjs";
import { PlayerModel } from "../lib/player.mjs";
import {
  parseMultivariant,
  parseMedia,
  nextBlockingRequest,
  withBlocking,
  pendingMedia,
  liveEdgePdt,
  isMultivariant,
} from "../lib/hls.mjs";

test("parseArgs", () => {
  const a = parseArgs(["https://x", "--steps", "50,200", "--hold=2m", "--origin", "--no-cdn", "--dry-run"]);
  assert.deepEqual(a._, ["https://x"]);
  assert.equal(a.steps, "50,200");
  assert.equal(a.hold, "2m");
  assert.equal(a.origin, true);
  assert.equal(a.cdn, false);
  assert.equal(a.dryRun, true);
});

test("parseDuration", () => {
  assert.equal(parseDuration("120s"), 120000);
  assert.equal(parseDuration("2m"), 120000);
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("90"), 90000);
  assert.equal(parseDuration(undefined, 7), 7);
  assert.throws(() => parseDuration("soon"));
});

test("parseSteps", () => {
  assert.deepEqual(parseSteps("50,200,500,1000"), [50, 200, 500, 1000]);
  assert.deepEqual(parseSteps(undefined, [5]), [5]);
  assert.throws(() => parseSteps("200,50"));
  assert.throws(() => parseSteps("a"));
});

test("rampSchedule", () => {
  assert.deepEqual(rampSchedule(0, 3, 1000), [0, 500, 1000]);
  assert.deepEqual(rampSchedule(50, 52, 0), [0, 0]);
  assert.deepEqual(rampSchedule(10, 10, 1000), []);
  assert.deepEqual(rampSchedule(0, 1, 1000), [0]);
});

test("percentile and Samples", () => {
  const v = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(v, 50), 50);
  assert.equal(percentile(v, 95), 95);
  assert.equal(percentile(v, 99), 99);
  assert.equal(percentile([], 50), 0);
  const s = new Samples(10);
  for (const x of v) s.add(x);
  const sum = s.summary();
  assert.equal(sum.count, 100);
  assert.equal(sum.max, 100);
  assert.equal(sum.avg, 50.5);
  assert.equal(s.values.length, 10);
});

test("Step and table", () => {
  const st = new Step("step 1", 50);
  st.sample("join", 10);
  st.sample("join", 30);
  st.count("joinOk");
  st.error("segment", 404);
  st.error("segment", 404);
  st.bytes = 1_000_000;
  st.close();
  const j = st.toJSON();
  assert.equal(j.counts.joinOk, 1);
  assert.equal(j.errors["segment 404"], 2);
  assert.equal(j.latencyMs.join.p50, 10);
  const c = new Counter();
  c.inc("a", 2);
  assert.equal(c.total(), 2);
  const t = table([{ a: 1, b: 2.25 }], [["a", "A"], ["b", "Bee"]]);
  assert.match(t, /A\s+Bee/);
  assert.match(t, /2\.3|2\.2/);
});

const MULTI = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE="AUDIO",GROUP-ID="audio",NAME="audio2",AUTOSELECT=YES,DEFAULT=YES,URI="audio2_stream.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1200000,AVERAGE-BANDWIDTH=1000000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=30.000,AUDIO="audio"
video1_stream.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360
low/stream.m3u8
`;

test("multivariant", () => {
  assert.ok(isMultivariant(MULTI));
  const m = parseMultivariant(MULTI, "https://cdn.example/live/abc/index.m3u8?t=1");
  assert.equal(m.variants.length, 2);
  assert.equal(m.variants[0].uri, "https://cdn.example/live/abc/video1_stream.m3u8");
  assert.equal(m.variants[1].uri, "https://cdn.example/live/abc/low/stream.m3u8");
  assert.equal(m.media[0].uri, "https://cdn.example/live/abc/audio2_stream.m3u8");
});

const MEDIA = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-TARGETDURATION:2
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.5,HOLD-BACK=6
#EXT-X-PART-INF:PART-TARGET=0.5
#EXT-X-MEDIA-SEQUENCE:40
#EXT-X-MAP:URI="init.mp4"
#EXT-X-PROGRAM-DATE-TIME:2026-10-24T10:00:00.000Z
#EXT-X-PART:DURATION=0.5,URI="part100.mp4",INDEPENDENT=YES
#EXT-X-PART:DURATION=0.5,URI="part101.mp4"
#EXT-X-PART:DURATION=0.5,URI="part102.mp4"
#EXT-X-PART:DURATION=0.5,URI="part103.mp4"
#EXTINF:2.00000,
seg40.mp4
#EXT-X-PROGRAM-DATE-TIME:2026-10-24T10:00:02.000Z
#EXT-X-PART:DURATION=0.5,URI="part104.mp4",INDEPENDENT=YES
#EXT-X-PART:DURATION=0.5,URI="part105.mp4"
#EXT-X-PART:DURATION=0.5,URI="part106.mp4"
#EXT-X-PART:DURATION=0.5,URI="part107.mp4"
#EXTINF:2.00000,
seg41.mp4
#EXT-X-PART:DURATION=0.5,URI="part108.mp4",INDEPENDENT=YES
#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part109.mp4"
`;

test("media playlist", () => {
  const base = "https://cdn.example/live/abc/video1_stream.m3u8";
  const pl = parseMedia(MEDIA, base);
  assert.equal(pl.targetDuration, 2);
  assert.equal(pl.mediaSequence, 40);
  assert.equal(pl.partTarget, 0.5);
  assert.ok(pl.canBlockReload);
  assert.equal(pl.partHoldBack, 1.5);
  assert.equal(pl.map.uri, "https://cdn.example/live/abc/init.mp4");
  assert.equal(pl.segments.length, 2);
  assert.equal(pl.segments[1].msn, 41);
  assert.equal(pl.segments[0].parts.length, 4);
  assert.equal(pl.trailingParts.length, 1);
  assert.equal(pl.preloadHint.uri, "https://cdn.example/live/abc/part109.mp4");
  assert.equal(pl.segments[1].pdt, Date.parse("2026-10-24T10:00:02.000Z"));
  assert.equal(liveEdgePdt(pl), Date.parse("2026-10-24T10:00:04.500Z"));

  const req = nextBlockingRequest(pl);
  assert.deepEqual(req, { msn: 42, part: 1 });
  assert.equal(withBlocking(base, req), base + "?_HLS_msn=42&_HLS_part=1");

  // Start-up: only PART-HOLD-BACK (1.5s = 3 parts) behind live.
  const start = pendingMedia(pl, null, { lowLatency: true, startBackSec: 1.5 });
  assert.deepEqual(start.map((x) => x.uri.split("/").pop()), ["part106.mp4", "part107.mp4", "part108.mp4"]);
  assert.equal(start[0].pdt, Date.parse("2026-10-24T10:00:03.000Z"));
  assert.equal(start[2].pdt, Date.parse("2026-10-24T10:00:04.000Z"));
  // Afterwards, only what comes after the cursor (not the older parts before the start point).
  const cursor = start[start.length - 1].key;
  assert.equal(pendingMedia(pl, cursor).length, 0);
  const next = parseMedia(MEDIA + "#EXT-X-PART:DURATION=0.5,URI=\"part109.mp4\"\n", base);
  assert.deepEqual(pendingMedia(next, cursor).map((x) => x.uri.split("/").pop()), ["part109.mp4"]);
  // Without low latency, whole segments.
  const segs = pendingMedia(pl, null, { lowLatency: false });
  assert.deepEqual(segs.map((x) => x.uri.split("/").pop()), ["seg40.mp4", "seg41.mp4"]);
});

test("no blocking reload without server control", () => {
  const pl = parseMedia("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\na.ts\n", "http://o/x.m3u8");
  assert.equal(nextBlockingRequest(pl), null);
  assert.equal(liveEdgePdt(pl), null);
});

test("player model: steady, stall, latency", () => {
  let t = 1_000_000;
  const p = new PlayerModel(() => t);
  // First part at t; its PDT 2s before now: end PDT 1.5s ago, 0.5s buffered ahead.
  let r = p.append(0.5, t - 2000);
  assert.equal(r.stalledMs, 0);
  assert.equal(r.latencyMs, 2000);
  // Parts arrive every 0.5s: no stall.
  for (let i = 0; i < 4; i++) {
    t += 500;
    r = p.append(0.5, null);
    assert.equal(r.stalledMs, 0);
  }
  assert.equal(p.stalls, 0);
  assert.ok(Math.abs(p.bufferAhead() - 0.5) < 1e-9);
  // Nothing for 2s: the 0.5s buffer runs out, a 1.5s stall.
  t += 2000;
  assert.ok(p.isStalled());
  r = p.append(0.5, null);
  assert.equal(p.stalls, 1);
  assert.ok(Math.abs(r.stalledMs - 1500) < 1e-6);
  assert.ok(!p.isStalled());
});

test("dump and merge steps", () => {
  const a = new Step("s", 2);
  const b = new Step("s", 2);
  a.sample("seg", 10);
  b.sample("seg", 30);
  b.sample("seg", 50);
  a.count("joinOk");
  b.count("joinOk", 2);
  b.error("seg", 404);
  a.bytes = 100;
  b.bytes = 50;
  a.gauges.active = 1;
  b.gauges.active = 2;
  a.close();
  b.close();
  const m = mergeDumps("s", 4, [dumpStep(a), dumpStep(b)]).toJSON();
  assert.equal(m.counts.joinOk, 3);
  assert.equal(m.errors["seg 404"], 1);
  assert.equal(m.latencyMs.seg.count, 3);
  assert.equal(m.latencyMs.seg.p50, 30);
  assert.equal(m.latencyMs.seg.max, 50);
  assert.equal(m.bytes, 150);
  assert.equal(m.active, 3);
  assert.equal(m.target, 4);
});
