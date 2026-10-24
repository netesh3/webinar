// The viewer's playlist reload policy (lib/viewer.mjs nextReload), against what hls.js 1.7 does,
// and a viewer riding out a CDN outage against an origin that answers stale blocking reloads
// with 400 the way MediaMTX does. node --test e2e/load/test/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { parseMedia } from "../lib/hls.mjs";
import { Step } from "../lib/stats.mjs";
import { EdgeViewer, nextReload, playlistAdvanced, playlistEdge, blockingTimeoutMs, fellOutOfWindow } from "../lib/viewer.mjs";

// MediaMTX-shaped: 2 s target, 250 ms parts, segments 10..12 done, two parts of 13 written.
const PL = (first = 10, done = 3, trailing = 2) => {
  const l = [
    "#EXTM3U",
    "#EXT-X-VERSION:9",
    "#EXT-X-TARGETDURATION:2",
    "#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.75",
    "#EXT-X-PART-INF:PART-TARGET=0.25",
    `#EXT-X-MEDIA-SEQUENCE:${first}`,
    '#EXT-X-MAP:URI="init.mp4"',
  ];
  for (let s = first; s < first + done; s++) {
    for (let p = 0; p < 4; p++) l.push(`#EXT-X-PART:DURATION=0.25,URI="p${s}_${p}.mp4"`);
    l.push("#EXTINF:1,", `s${s}.mp4`);
  }
  for (let p = 0; p < trailing; p++) l.push(`#EXT-X-PART:DURATION=0.25,URI="p${first + done}_${p}.mp4"`);
  return parseMedia(l.join("\n") + "\n", "https://cdn.example/live/x/video.m3u8");
};

test("playlistEdge / playlistAdvanced follow hls.js LevelDetails", () => {
  assert.deepEqual(playlistEdge(PL()), { endSn: 12, partSn: 13, partIndex: 1 });
  assert.deepEqual(playlistEdge(PL(10, 3, 0)), { endSn: 12, partSn: 12, partIndex: 3 });
  assert.equal(playlistAdvanced(PL(), PL(10, 3, 3)), true); // one more part
  assert.equal(playlistAdvanced(PL(10, 3, 3), PL(11, 3, 0)), true); // segment closed
  assert.equal(playlistAdvanced(PL(), PL()), false); // the same playlist again (a CDN copy)
  assert.equal(playlistAdvanced(PL(11, 3, 0), PL()), false); // an older one
});

test("blockingTimeoutMs is hls.js's max(3 parts, 0.8 target durations), not 11 s", () => {
  assert.equal(blockingTimeoutMs(PL()), 1600);
  assert.equal(blockingTimeoutMs({ partTarget: 1, targetDuration: 2 }), 3000);
  assert.equal(blockingTimeoutMs({ partTarget: 0, targetDuration: 2 }), 10000);
});

test("nextReload: blocking reload for the next part while the playlist advances", () => {
  assert.deepEqual(nextReload({ pl: PL(), ll: true, ok: true }), { req: { msn: 13, part: 2 }, delayMs: 0, tuneInGoal: 0 });
  // After a whole segment: part 0 of the next.
  assert.deepEqual(nextReload({ pl: PL(10, 3, 0), ll: true, ok: true }).req, { msn: 13, part: 0 });
});

test("nextReload: a failed blocking reload is never repeated with the same directives", () => {
  const pl = PL();
  // Timed out: the plain playlist at once (checkRetry "retry immediately ... without delivery-directives").
  assert.deepEqual(nextReload({ pl, ll: true, ok: false, timedOut: true, blocking: true }), { req: null, delayMs: 0, tuneInGoal: 0 });
  // 400 / 503 / network: the plain playlist after 1 s, 2 s, 4 s, 8 s, 8 s.
  for (const [retry, ms] of [[0, 1000], [1, 2000], [2, 4000], [3, 8000], [6, 8000]]) {
    const n = nextReload({ pl, ll: true, ok: false, blocking: true, retry });
    assert.equal(n.req, null);
    assert.equal(n.delayMs, ms);
  }
  // A plain reload that timed out waits too (it was not an LL request).
  assert.equal(nextReload({ pl, ll: true, ok: false, timedOut: true, blocking: false }).delayMs, 1000);
});

test("nextReload: a playlist that did not advance is polled, not blocked on", () => {
  const n = nextReload({ pl: PL(), ll: true, ok: true, advanced: false, elapsedMs: 200 });
  assert.equal(n.req, null);
  assert.equal(n.delayMs, 800); // half the 2 s target duration, from when the request started
  // Without low latency: every target duration.
  assert.deepEqual(nextReload({ pl: PL(), ll: false, ok: true, elapsedMs: 300 }), { req: null, delayMs: 1700, tuneInGoal: 0 });
});

test("nextReload: CDN tune-in from the Age header", () => {
  const pl = PL();
  // Age 1 s: one part target short of it is 0.75 s = 3 parts further on.
  assert.deepEqual(nextReload({ pl, ll: true, ok: true, ageSec: 1 }), { req: { msn: 13, part: 5 }, delayMs: 0, tuneInGoal: 0.75 });
  // Age 3 s (goal capped at 1.5 target durations = 3 s): one segment and two parts on.
  assert.deepEqual(nextReload({ pl, ll: true, ok: true, ageSec: 3.25 }).req, { msn: 14, part: 6 });
  // Older than 3 target durations: no directives at all.
  assert.equal(nextReload({ pl, ll: true, ok: true, ageSec: 7 }).req, null);
  // The goal grew since last time: hls.js stops trusting Age and asks for the next part.
  assert.deepEqual(nextReload({ pl, ll: true, ok: true, ageSec: 2, tuneInGoal: 0.75 }), { req: { msn: 13, part: 2 }, delayMs: 0, tuneInGoal: 0 });
});

test("fellOutOfWindow", () => {
  assert.equal(fellOutOfWindow(PL(), 12 * 1000 + 3), false);
  assert.equal(fellOutOfWindow(PL(), 9 * 1000 + 3), false); // the next is segment 10, still listed
  assert.equal(fellOutOfWindow(PL(), 8 * 1000 + 3), true);
});

/* An LL-HLS origin with MediaMTX's blocking-reload rules (gohlslib muxer_stream.go): 400 for
 * an _HLS_msn more than one past the segment being written or older than the oldest listed.
 * 100 ms parts, 4 to a segment, 4 segments listed: a 1.6 s window. From outage[0] to
 * outage[1] (ms after start) everything is a 503, like the Bunny edge in the 1,000 run. */
function startOrigin({ outage = [Infinity, Infinity] } = {}) {
  const partMs = 100;
  const pps = 4;
  const keep = 4;
  const t0 = Date.now();
  const seen = { bad: 0, blocking: 0, part: 0, partAfter: 0 };
  const partsNow = () => Math.floor((Date.now() - t0) / partMs);
  const playlist = (n) => {
    const segs = Math.floor(n / pps);
    const first = Math.max(0, segs - keep);
    const l = [
      "#EXTM3U",
      "#EXT-X-VERSION:9",
      "#EXT-X-TARGETDURATION:1",
      `#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.3`,
      "#EXT-X-PART-INF:PART-TARGET=0.1",
      `#EXT-X-MEDIA-SEQUENCE:${first}`,
      '#EXT-X-MAP:URI="init.mp4"',
    ];
    for (let s = first; s < segs; s++) {
      l.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(t0 + s * pps * partMs).toISOString()}`);
      for (let p = 0; p < pps; p++) l.push(`#EXT-X-PART:DURATION=0.1,URI="p${s}_${p}.mp4"`);
      l.push("#EXTINF:0.4,", `s${s}.mp4`);
    }
    for (let p = 0; p < n % pps; p++) l.push(`#EXT-X-PART:DURATION=0.1,URI="p${segs}_${p}.mp4"`);
    return { text: l.join("\n") + "\n", next: segs, first };
  };
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const at = Date.now() - t0;
    if (at >= outage[0] && at < outage[1]) return res.writeHead(503).end();
    if (u.pathname.endsWith(".mp4")) {
      seen.part++;
      if (at >= outage[1]) seen.partAfter++;
      return res.writeHead(200, { "content-type": "video/mp4" }).end(Buffer.alloc(500));
    }
    const msn = u.searchParams.get("_HLS_msn");
    if (msn !== null) {
      seen.blocking++;
      const m = Number(msn);
      const part = Number(u.searchParams.get("_HLS_part") ?? 0);
      for (;;) {
        const { next, first } = playlist(partsNow());
        if (m > next + 1 || m < first) {
          seen.bad++;
          return res.writeHead(400).end();
        }
        if (partsNow() >= m * pps + part + 1) break;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" }).end(playlist(partsNow()).text);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) }),
    ),
  );
}

async function watch(origin, ms) {
  const step = new Step("t", 1);
  const v = new EdgeViewer({ lowLatency: true }, { step });
  const run = v.track(`${origin.url}/live/x/video.m3u8`, null, true);
  await new Promise((r) => setTimeout(r, ms));
  v.ctl.abort();
  await run;
  return step.toJSON();
}

test("a viewer comes back after a CDN outage longer than the playlist window", async () => {
  // Waits for the first segment, so the outage starts once the viewer is playing.
  const origin = await startOrigin({ outage: [1500, 3500] });
  try {
    const s = await watch(origin, 6000);
    assert.ok(s.errors["playlist 503"] >= 1, `the outage was seen: ${JSON.stringify(s.errors)}`);
    // Before the fix every retry after the outage repeated the stale msn: ~1 x 400 a second.
    assert.equal(origin.seen.bad, 0, `stale blocking reloads: ${origin.seen.bad}`);
    assert.ok((s.counts.playlistRecovered ?? 0) >= 1, "recovered with a plain reload");
    assert.ok(origin.seen.partAfter >= 15, `parts after the outage: ${origin.seen.partAfter}`);
    assert.ok(s.latencyMs.liveLatency.max < 6000);
  } finally {
    await origin.close();
  }
});

test("a viewer keeps up with blocking reloads when nothing goes wrong", async () => {
  const origin = await startOrigin();
  try {
    const s = await watch(origin, 3000);
    assert.deepEqual(s.errors, {});
    assert.ok(origin.seen.blocking >= 10, `blocking reloads: ${origin.seen.blocking}`);
    assert.ok(s.counts.part >= 15, `parts: ${s.counts.part}`);
    assert.ok(s.latencyMs.liveLatency.p50 < 1500, `live latency ${s.latencyMs.liveLatency.p50}`);
  } finally {
    await origin.close();
  }
});
