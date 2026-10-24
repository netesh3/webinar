// End to end against the fake origin: a few viewers, two short steps, one and two processes.
import test from "node:test";
import assert from "node:assert/strict";
import { startFake } from "./fake-server.mjs";
import { runHlsViewers } from "../hls-viewers.mjs";

for (const workers of [1, 2]) {
  test(`hls viewers end to end (${workers} process${workers > 1 ? "es" : ""})`, async () => {
    const fake = await startFake();
    try {
      const res = await runHlsViewers({
        api: `${fake.url}/api`,
        slug: "lt-slug",
        keys: ["K1", "K2", "K3", "K4"],
        steps: [2, 4],
        rampMs: 300,
        holdMs: 2500,
        workers,
        log: () => {},
      });
      assert.equal(res.steps.length, 2);
      const [a, b] = res.steps;
      assert.equal(a.counts.joinOk, 2);
      assert.equal(b.counts.joinOk, 2);
      assert.equal(b.active, 4);
      assert.equal(b.playing, 4);
      assert.ok((b.counts.part ?? 0) > 20, `parts fetched in step 2: ${b.counts.part}`);
      assert.ok(b.latencyMs.part.p50 >= 0);
      assert.ok(b.latencyMs.liveLatency.p50 > 0 && b.latencyMs.liveLatency.p50 < 3000, `live latency ${b.latencyMs.liveLatency.p50}`);
      assert.equal(b.counts.stall ?? 0, 0);
      assert.equal(b.eventsOpen, 4);
      assert.ok(fake.seen.blocking > 10, "blocking reloads used");
      assert.ok(fake.seen.backlog >= 12, "backlogs fetched on connect");
      assert.deepEqual(a.errors, {});
    } finally {
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(fake.seen.leave >= 4, `leave beacons: ${fake.seen.leave}`);
      await fake.close();
    }
  });
}

test("captions over the events stream: every viewer and the tap count them", async () => {
  const { EdgeCaptionTap, edgeDelivery } = await import("../captions.mjs");
  const fake = await startFake({ captions: true });
  const tap = new EdgeCaptionTap({ api: `${fake.url}/api`, slug: "lt-slug", joinKey: "TAP" }).start();
  try {
    const res = await runHlsViewers({
      api: `${fake.url}/api`,
      slug: "lt-slug",
      keys: ["K1", "K2", "K3"],
      steps: [3],
      rampMs: 300,
      holdMs: 3500,
      workers: 1,
      log: () => {},
    });
    const s = res.steps[0];
    // The last of the ramp may open its stream just after the hold begins: not comparable, left out.
    assert.ok(s.capHoldViewers >= 2, `viewers on the stream all hold: ${s.capHoldViewers}`);
    assert.ok(s.capHoldFinals >= 2 * s.capHoldViewers, `finals in the hold: ${s.capHoldFinals}`);
    assert.ok(s.counts.caption >= 9 && s.counts.captionPartial >= 9, JSON.stringify(s.counts));
    await tap.stop();
    assert.ok(tap.events.filter((e) => !e.partial).length >= 3);
    assert.deepEqual(tap.meta.map((m) => m.serverCaptions), [true]);
    const d = edgeDelivery(s, s, tap.events, 300);
    assert.ok(d.ratio > 0.6 && d.ratio <= 1.5, JSON.stringify(d));
  } finally {
    await tap.stop();
    await fake.close();
  }
});
