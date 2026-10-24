// api-load against the fake API; run.mjs's plan and the production guard; the probe command.
import test from "node:test";
import assert from "node:assert/strict";
import { startFake } from "./fake-server.mjs";
import { runApiLoad } from "../api-load.mjs";
import { plan, topStepAt, scaleSteps } from "../run.mjs";
import { isProduction, assertSafeTarget, apiBase } from "../lib/client.mjs";
import { probeCommand } from "../webrtc-attendees.mjs";
import { toOrigin } from "../lib/viewer.mjs";
import { share } from "../lib/steps.mjs";
import { parseSSEText } from "../lib/sse.mjs";

test("api load sends what it is asked to", async () => {
  const fake = await startFake();
  try {
    const res = await runApiLoad({
      api: `${fake.url}/api`,
      slug: "s",
      keys: ["A", "B", "C", "D"],
      run: "lt1",
      pollId: "p1",
      rates: { chat: 20, question: 5, upvote: 5, vote: 20, join: 5, register: 5, events: 2 },
      eventsHoldMs: 300,
      durationMs: 1500,
      windowMs: 500,
      log: () => {},
    });
    assert.ok(res.windows.length >= 2);
    const sum = (k) => res.windows.reduce((a, w) => a + (w.counts[k] ?? 0), 0);
    assert.ok(sum("chatOk") > 5, `chat ${sum("chatOk")}`);
    assert.ok(sum("questionOk") > 0);
    assert.equal(sum("voteOk"), 4, "each seat votes once");
    assert.ok(sum("registerOk") > 0);
    assert.ok(fake.seen.say > 5 && fake.seen.register > 0);
  } finally {
    await fake.close();
  }
});

test("production guard", () => {
  assert.ok(isProduction("https://webinarliv.com"));
  assert.ok(isProduction("https://www.webinarliv.com/x"));
  assert.ok(isProduction("https://webcast-api-abc-el.a.run.app/api"));
  assert.ok(isProduction("https://152.42.156.192.sslip.io/live"));
  assert.ok(!isProduction("http://localhost:3000"));
  assert.ok(!isProduction("https://staging.example.test"));
  assert.throws(() => assertSafeTarget(["https://webinarliv.com"], {}), /refusing/);
  assert.equal(assertSafeTarget(["https://webinarliv.com"], { iKnowThisIsProd: true }), true);
  assert.equal(assertSafeTarget(["http://localhost:3000"], {}), false);
  assert.equal(apiBase("https://x.test/", {}), "https://x.test/api");
  assert.equal(apiBase("https://x.test", { api: "https://api.x.test/api/" }), "https://api.x.test/api");
});

test("run plan: defaults, caps, seats", () => {
  const p = plan({});
  assert.deepEqual(p.steps, [50, 200, 500, 1000]);
  assert.equal(p.viewers, 1000);
  assert.equal(p.seats, 1000);
  assert.equal(p.durationMs, 4 * 150_000);
  assert.throws(() => plan({ steps: "100,2000" }), /max-viewers/);
  assert.equal(plan({ steps: "100,2000", maxViewers: "2000" }).viewers, 2000);
  assert.throws(() => plan({ steps: "10", maxViewers: "9000" }) && plan({ steps: "6000", maxViewers: "9000" }), /hard cap/);
  assert.throws(() => plan({ presenters: "4" }), /0 to 3/);
  assert.throws(() => plan({ webrtcSteps: "5" }), /standard/);
  const a = plan({ steps: "10", apiLoad: true, hold: "60s", ramp: "0s" });
  assert.ok(a.spare >= 50 && a.seats === 10 + a.spare);
  const w = plan({ steps: "10", delivery: "standard", webrtcSteps: "2,4" });
  assert.equal(w.seats, 14);
  // A second generator: 500 more, its steps scaled from this one's.
  const x = plan({ steps: "50,200,500", extraSeats: "500" });
  assert.equal(x.seats, 1000);
  assert.deepEqual(x.extraSteps, [50, 200, 500]);
  // Extra seats raise the default cap to fit (24 Oct: "10 + 1000 over --max-viewers 1000"),
  // but not an explicit --max-viewers, nor the hard cap.
  const r = plan({ steps: "10", extraSeats: "1000" });
  assert.equal(r.maxViewers, 1010);
  assert.match(r.notes.join(" "), /raised from 1000 to 1010/);
  assert.throws(() => plan({ steps: "500,1000", extraSeats: "500", maxViewers: "1000" }), /max-viewers 1000/);
  assert.throws(() => plan({ steps: "1000", extraSeats: "4500" }), /5000/);
  // Spare seats leave room for the extra ones under the hard cap.
  const s = plan({ steps: "1000", extraSeats: "3900", apiLoad: true });
  assert.ok(s.seats <= 5000 && s.spare === 100, `seats ${s.seats} spare ${s.spare}`);
});

test("run plan: generators, engagement, recording, box wait", () => {
  const g = plan({ steps: "50,200", generators: "10.0.0.1,ops@10.0.0.2" });
  assert.equal(g.extra, 400, "default: as many on each generator as here");
  assert.deepEqual(g.generators.map((x) => [x.host, x.from, x.count]), [["root@10.0.0.1", 0, 200], ["ops@10.0.0.2", 200, 200]]);
  assert.deepEqual(g.generators[0].steps, [50, 200]);
  assert.equal(g.seats, 600);
  const odd = plan({ steps: "10,20", extraSeats: "5", generators: "a,b" });
  assert.deepEqual(odd.extraSteps, [3, 5]);
  assert.deepEqual(odd.generators.map((x) => x.steps), [[2, 3], [1, 2]]);
  assert.throws(() => plan({ steps: "10", extraSeats: "0", generators: "a" }), /nothing/);
  assert.throws(() => plan({ steps: "10", extraSeats: "1", generators: "a,b" }), /at least one/);
  const e = plan({ steps: "50,200,500", ramp: "30s", hold: "120s", engage: true, engageChat: "10" });
  assert.equal(e.engage.atMs, 2 * 150_000 + 30_000, "the top step's hold");
  assert.equal(e.engage.chat, 10);
  assert.equal(topStepAt([5], 10_000, 60_000), 10_000);
  assert.equal(plan({}).engage, null);
  assert.equal(plan({ record: true }).record, true);
  assert.equal(plan({}).boxWaitMs, 360_000);
  assert.equal(plan({ boxWait: "10m" }).boxWaitMs, 600_000);
  assert.deepEqual(scaleSteps([50, 200, 500], 500), [50, 200, 500]);
  assert.deepEqual(scaleSteps([10, 20], 1), [1]);
  assert.deepEqual(scaleSteps([10, 20], 0), []);
});

test("api load: votes follow the open poll, pause, and 409 is not an error", async () => {
  const fake = await startFake();
  try {
    const poll = { id: "p1" };
    const run = runApiLoad({
      api: `${fake.url}/api`,
      slug: "s",
      keys: ["A", "B", "C", "D"],
      run: "lt1",
      pollId: () => poll.id,
      rates: { vote: 40 },
      eventsHoldMs: 0,
      durationMs: 1500,
      windowMs: 500,
      log: () => {},
    });
    await new Promise((r) => setTimeout(r, 400));
    poll.id = "";
    await new Promise((r) => setTimeout(r, 300));
    poll.id = "closed";
    const res = await run;
    const sum = (k) => res.windows.reduce((a, w) => a + (w.counts[k] ?? 0), 0);
    const errs = res.windows.reduce((a, w) => a + Object.keys(w.errors).length, 0);
    assert.equal(sum("voteOk"), 4, "each seat once in p1");
    assert.equal(sum("voteConflict"), 4, "and once in the closed poll: counted, not an error");
    assert.equal(errs, 0);
  } finally {
    await fake.close();
  }
});

test("webrtc wrapper builds the probe-load call", () => {
  const { args, env } = probeCommand({ web: "http://localhost:3000", api: "http://localhost:8080/api", steps: [2, 5], holdMs: 30000, kind: "meeting" });
  assert.ok(args[0].endsWith("e2e/probe-load.mjs"));
  assert.deepEqual(args.slice(1), ["http://localhost:3000", "5", "30"]);
  assert.equal(env.PROBE_STEPS, "2,5");
  assert.equal(env.PROBE_KIND, "meeting");
  assert.equal(env.PROBE_API, "http://localhost:8080/api");
  assert.equal(env.PROBE_SLUG, undefined);
});

test("origin URL, worker shares, SSE parsing", async () => {
  assert.equal(
    toOrigin("https://zone.b-cdn.net/live/abc-123/index.m3u8", "abc-123", "https://152.42.156.192.sslip.io/live/"),
    "https://152.42.156.192.sslip.io/live/abc-123/index.m3u8",
  );
  assert.throws(() => toOrigin("https://x/live/other/index.m3u8", "abc", "https://o/live"));
  assert.deepEqual([0, 1, 2].map((i) => share(10, 3, i)), [4, 3, 3]);
  assert.deepEqual([0, 1, 2].map((i) => share(1, 3, i)), [1, 0, 0]);
  const ev = await parseSSEText("retry: 2000\n\nevent: meta\ndata: {}\n\n: ping\n\nevent: packet\ndata: a\ndata: b\n\n");
  assert.deepEqual(ev, [["meta", "{}"], ["packet", "a\nb"]]);
});
