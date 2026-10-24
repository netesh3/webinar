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
