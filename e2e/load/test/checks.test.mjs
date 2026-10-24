// The pure parts of the checks and the multi-generator merge: engagement tallies, the
// recording verdict, seat slicing, merging generators' steps, the box wait, the metrics hook.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { verifyEngagement, upvotePlan, expectedTally, pollDefs, verdictTable } from "../engage.mjs";
import { checkRecording, sniffMedia } from "../lib/recording.mjs";
import { generatorPlan, parseHosts, mergeGeneratorSteps, compactDump, sshArgs } from "../lib/generators.mjs";
import { boxProgress, waitForVideoServer } from "../lib/box.mjs";
import { fillQuery, promConfig, stepMetrics } from "../lib/metrics.mjs";
import { Step, dumpStep } from "../lib/stats.mjs";
import { parseSteps } from "../lib/args.mjs";

test("upvote plan: never your own question, never twice", () => {
  const plan = upvotePlan(100, 20, 60);
  assert.equal(plan.length, 60);
  const seen = new Set();
  for (const { seat, question } of plan) {
    assert.ok(seat >= 20, "voters are not askers when there are enough seats");
    assert.ok(!seen.has(`${seat}/${question}`));
    seen.add(`${seat}/${question}`);
  }
  // Every question gets some.
  assert.equal(new Set(plan.map((x) => x.question)).size, 20);
  // Few seats: askers vote too, but not for themselves; capped by what is possible.
  const small = upvotePlan(3, 3, 100);
  assert.ok(small.length <= 6 && small.length > 0);
  for (const { seat, question } of small) assert.notEqual(seat, question);
  assert.deepEqual(upvotePlan(10, 0, 5), []);
});

test("expected tallies and poll definitions", () => {
  assert.deepEqual(expectedTally(10, 3), [4, 3, 3]);
  assert.deepEqual(expectedTally(0, 2), [0, 0]);
  const defs = pollDefs("T", 2, 1);
  assert.deepEqual(defs.map((d) => d.kind), ["poll", "poll", "quiz"]);
  assert.ok(defs.every((d) => d.question.startsWith("T ")));
  assert.equal(defs[2].correctOption, 1);
});

const SENT = {
  chat: [
    { id: "c1", text: "T message 0" },
    { id: "c2", text: "T message 1" },
  ],
  questions: [
    { id: "q1", text: "T question 0?", upvotes: 2 },
    { id: "q2", text: "T question 1?", upvotes: 0 },
  ],
  polls: [
    { id: "p1", kind: "poll", question: "Which?", votes: [2, 1], correctOption: -1 },
    { id: "p2", kind: "quiz", question: "2+2", votes: [1, 1, 0], correctOption: 1 },
  ],
};
const STORED = {
  chat: { stats: {}, messages: [{ id: "x", message: "other" }, { id: "c1", message: "T message 0" }, { id: "c2", message: "T message 1" }] },
  questions: { questions: [{ id: "q1", upvotes: 2 }, { id: "q2", upvotes: 0 }], hidden: [] },
  polls: [
    { id: "p1", state: "closed", votes: [2, 1], correctOption: -1 },
    { id: "p2", state: "closed", votes: [1, 1, 0], correctOption: 1 },
  ],
};

test("engagement verification: all match", () => {
  const rows = verifyEngagement(SENT, STORED);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.pass), JSON.stringify(rows));
  assert.match(verdictTable(rows), /PASS/);
});

test("engagement verification: each kind of mismatch fails", () => {
  const clone = () => structuredClone(STORED);
  let s = clone();
  s.chat.messages.pop();
  let r = verifyEngagement(SENT, s);
  assert.equal(r.find((x) => x.area === "chat").pass, false);
  assert.match(r.find((x) => x.area === "chat").detail, /1\/2 found.*T message 1/);

  s = clone();
  s.chat.messages[1].message = "edited";
  assert.equal(verifyEngagement(SENT, s).find((x) => x.area === "chat").pass, false);

  s = clone();
  s.questions.questions[0].upvotes = 1;
  r = verifyEngagement(SENT, s).filter((x) => x.area === "questions");
  assert.deepEqual(r.map((x) => x.pass), [true, false]);

  s = clone();
  s.questions.questions.pop();
  assert.equal(verifyEngagement(SENT, s).filter((x) => x.area === "questions")[0].pass, false);

  s = clone();
  s.polls[0].votes = [3, 1];
  assert.equal(verifyEngagement(SENT, s).find((x) => x.area === "poll").pass, false);

  s = clone();
  s.polls[1].correctOption = 0;
  assert.match(verifyEngagement(SENT, s).find((x) => x.area === "quiz").detail, /correctOption 0 \(want 1\)/);

  s = clone();
  s.polls[0].state = "open";
  assert.equal(verifyEngagement(SENT, s).find((x) => x.area === "poll").pass, false);

  s = clone();
  s.polls = [];
  assert.equal(verifyEngagement(SENT, s).filter((x) => !x.pass).length, 2);

  // An unreadable transcript is a failure, not a pass by default.
  assert.equal(verifyEngagement(SENT, { ...STORED, chat: null }).find((x) => x.area === "chat").pass, false);
  // Nothing sent, nothing to check.
  assert.deepEqual(verifyEngagement({ chat: [], questions: [], polls: [] }, {}), []);
});

test("recording verdict", () => {
  const mp4 = new Uint8Array([0, 0, 0, 0x18, ...Buffer.from("ftypisom")]);
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
  assert.equal(sniffMedia(mp4), "mp4");
  assert.equal(sniffMedia(webm), "webm");
  assert.equal(sniffMedia(Buffer.from("<html>nope</html>")), "");
  const probe = { status: 206, bytes: 4096, kind: "mp4", contentType: "video/mp4" };
  const row = { status: "ready", sizeBytes: 5e6, durationMs: 300_000 };
  assert.ok(checkRecording(row, probe, { recordedMs: 310_000 }).pass);
  const short = checkRecording({ ...row, durationMs: 60_000 }, probe, { recordedMs: 310_000 });
  assert.equal(short.pass, false);
  assert.equal(short.checks.find((c) => c.name === "duration").pass, false);
  assert.equal(checkRecording({ ...row, sizeBytes: 0 }, probe, { recordedMs: 300_000 }).pass, false);
  assert.equal(checkRecording({ ...row, status: "failed" }, null, { recordedMs: 300_000 }).pass, false);
  assert.equal(checkRecording(row, { ...probe, status: 403, kind: "" }, { recordedMs: 300_000 }).pass, false);
  assert.equal(checkRecording(null, null, { recordedMs: 1000 }).pass, false);
  // A short recording: 15 s of slack, not 20% of nothing.
  assert.ok(checkRecording({ ...row, durationMs: 50_000 }, probe, { recordedMs: 60_000 }).pass);
});

test("generator plan: seat slices and steps", () => {
  const gens = generatorPlan(1000, [100, 400, 1000], ["root@a", "root@b", "root@c"]);
  assert.deepEqual(gens.map((g) => [g.from, g.count]), [[0, 334], [334, 333], [667, 333]]);
  assert.equal(gens.reduce((a, g) => a + g.count, 0), 1000);
  assert.deepEqual(gens.map((g) => g.steps), [[34, 134, 334], [33, 133, 333], [33, 133, 333]]);
  for (const g of gens) assert.equal(g.steps[g.steps.length - 1], g.count);
  // Slices tile keys-extra.json with no gap and no overlap.
  for (let i = 1; i < gens.length; i++) assert.equal(gens[i].from, gens[i - 1].from + gens[i - 1].count);
  // A share may repeat; hls-viewers --generator accepts that, nothing else does.
  const flat = generatorPlan(3, [2, 3], ["a", "b"]);
  assert.deepEqual(flat.map((g) => g.steps), [[1, 2], [1, 1]]);
  assert.deepEqual(parseSteps("1,1", [], { flat: true }), [1, 1]);
  assert.throws(() => parseSteps("1,1"));
  assert.throws(() => parseSteps("2,1", [], { flat: true }));
  assert.deepEqual(parseHosts("a, ops@b,,"), ["root@a", "ops@b"]);
  assert.deepEqual(parseHosts(undefined), []);
  assert.deepEqual(sshArgs("root@a", "/k").slice(0, 2), ["-i", "/k"]);
  assert.equal(sshArgs("root@a", "").at(-1), "root@a");
});

function step(name, target, { seg = [], joinOk = 0, bytes = 0, active = 0, cpu = 50 } = {}) {
  const s = new Step(name, target);
  for (const v of seg) s.sample("segment", v);
  if (joinOk) s.count("joinOk", joinOk);
  s.bytes = bytes;
  s.gauges = { active, cpuPct: cpu, maxLoopDelayP99Ms: 20 };
  s.close();
  return s;
}

test("merging generators' steps", () => {
  const a = [step("step 1", 10, { seg: [10, 20], joinOk: 10, bytes: 1000, active: 10 }), step("step 2", 20, { seg: [30], joinOk: 10, bytes: 2000, active: 20 })];
  const b = [step("step 1", 5, { seg: [100], joinOk: 5, bytes: 500, active: 5, cpu: 90 }), step("step 2", 10, { seg: [200, 300], joinOk: 5, bytes: 500, active: 10 })];
  const part = (label, steps) => ({ label, steps: steps.map((s) => s.toJSON()), dumps: steps.map((s) => compactDump(dumpStep(s))) });
  const m = mergeGeneratorSteps([part("local", a), part("b", b)]);
  assert.equal(m.length, 2);
  assert.equal(m[0].target, 15);
  assert.equal(m[0].active, 15);
  assert.equal(m[0].counts.joinOk, 15);
  assert.equal(m[0].bytes, 1500);
  assert.equal(m[0].latencyMs.segment.count, 3);
  assert.equal(m[0].latencyMs.segment.max, 100);
  assert.equal(m[1].latencyMs.segment.p50, 200);
  assert.equal(m[0].cpuPct, undefined, "one generator's CPU is not a total");
  assert.deepEqual(m[0].generators.map((g) => [g.label, g.cpuPct]), [["local", 50], ["b", 90]]);
  assert.ok(!m[0].approx);

  // Without dumps (an older generator): sums, and the worst percentile, marked approx.
  const n = mergeGeneratorSteps([part("local", a), { label: "old", steps: b.map((s) => s.toJSON()) }]);
  assert.ok(n[0].approx);
  assert.equal(n[0].target, 15);
  assert.equal(n[0].counts.joinOk, 15);
  assert.equal(n[0].active, 15);
  assert.equal(n[0].latencyMs.segment.p95, 100);
  assert.equal(n[0].latencyMs.segment.count, 3);
  // A generator that failed (no steps) is left out; nothing at all gives nothing.
  assert.equal(mergeGeneratorSteps([part("local", a), { label: "dead" }])[0].target, 10);
  assert.deepEqual(mergeGeneratorSteps([]), []);
  // Thinning keeps the shape.
  const big = step("s", 1, { seg: Array.from({ length: 10000 }, (_, i) => i) });
  const d = compactDump(dumpStep(big), 1000);
  assert.equal(d.lat.segment.values.length, 1000);
  assert.equal(d.lat.segment.count, 10000);
});

test("box wait: progress text, and waits for ready", async () => {
  assert.equal(boxProgress({ state: "starting", etaSec: 40, message: "Starting servers…" }, 95_000),
    "waiting for the video server (starting, 95 s so far, about 40 s left): Starting servers…");
  let calls = 0;
  const srv = createServer((req, res) => {
    calls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(calls < 3 ? { state: "starting", etaSec: 10 } : { state: "ready" }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const lines = [];
  try {
    const st = await waitForVideoServer({ api: `http://127.0.0.1:${srv.address().port}/api`, slug: "s", pollMs: 20, everyMs: 0, log: (l) => lines.push(l) });
    assert.equal(st.state, "ready");
    assert.equal(calls, 3);
    assert.ok(lines.some((l) => /waiting for the video server \(starting/.test(l)));
    assert.ok(lines.some((l) => /video server ready/.test(l)));
    // Gives up after the timeout, still starting.
    calls = -1000;
    const late = await waitForVideoServer({ api: `http://127.0.0.1:${srv.address().port}/api`, slug: "s", pollMs: 10, timeoutMs: 50, log: () => {} });
    assert.equal(late.state, "starting");
  } finally {
    srv.close();
  }
});

test("metrics hook: off without the variables, per step with them", async () => {
  assert.equal(promConfig({}), null);
  assert.equal(await stepMetrics([{ name: "s" }], null), null);
  const cfg = promConfig({ GRAFANA_PROM_URL: "https://prom.example/api/prom/push", GRAFANA_PROM_TOKEN: "t", GRAFANA_PROM_USER: "1" });
  assert.equal(cfg.base, "https://prom.example/api/prom");
  assert.match(cfg.auth, /^Basic /);
  assert.equal(fillQuery('x{box="$box"}[$window]', { box: "b1", windowSec: 150 }), 'x{box="b1"}[150s]');
  const seen = [];
  const srv = createServer((req, res) => {
    seen.push(new URL(req.url, "http://x").searchParams.get("query"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "success", data: { result: [{ value: [0, "1.234"] }] } }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const c = promConfig({ GRAFANA_PROM_URL: `http://127.0.0.1:${srv.address().port}/api/prom`, GRAFANA_PROM_TOKEN: "t", GRAFANA_PROM_QUERIES: '{"cpu":"up{box=\\"$box\\"}"}' });
    const rows = await stepMetrics([{ name: "step 1", startedAt: new Date().toISOString(), seconds: 60 }], c);
    assert.equal(rows[0].cpu, 1.23);
    assert.deepEqual(seen, ['up{box="sfu-blr-1"}']);
  } finally {
    srv.close();
  }
});

/* A fake API with just enough state for engage.mjs: chat, questions with per-seat upvotes,
 * polls where opening one closes the other and a closed poll answers 409. */
function engageFake({ loseVote = false } = {}) {
  const chat = [];
  const questions = new Map();
  const polls = new Map();
  let open = "";
  let n = 0;
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    let body = "";
    for await (const c of req) body += c;
    const b = body ? JSON.parse(body) : {};
    const json = (code, v) => {
      res.writeHead(code, { "content-type": "application/json", "set-cookie": "webcast_session=s; Path=/" });
      res.end(JSON.stringify(v));
    };
    const p = u.pathname;
    let m;
    if (p === "/api/auth/login") return json(200, {});
    if (p.endsWith("/say")) {
      if (b.kind === "chat") chat.push({ id: b.id, message: b.text });
      if (b.kind === "question") questions.set(b.id, { id: b.id, text: b.text, upvotes: 0, voters: new Set() });
      if (b.kind === "upvote") {
        const q = questions.get(b.questionId);
        if (!q.voters.has(b.joinKey)) {
          q.voters.add(b.joinKey);
          q.upvotes++;
        }
      }
      return json(200, {});
    }
    if (/\/host\/webinars\/s\/polls$/.test(p) && req.method === "POST") {
      const id = `p${++n}`;
      polls.set(id, { id, ...b, state: "draft", votes: b.options.map(() => 0), voters: new Set(), correctOption: b.correctOption ?? -1 });
      return json(201, { id });
    }
    if ((m = p.match(/\/polls\/(p\d+)\/(open|close)$/))) {
      if (m[2] === "open" && open) polls.get(open).state = "closed";
      open = m[2] === "open" ? m[1] : "";
      polls.get(m[1]).state = m[2] === "open" ? "open" : "closed";
      return json(200, {});
    }
    if ((m = p.match(/\/polls\/(p\d+)\/vote$/))) {
      const pl = polls.get(m[1]);
      if (pl.state !== "open" || pl.voters.has(b.joinKey)) return json(409, { error: "already_voted" });
      pl.voters.add(b.joinKey);
      if (!(loseVote && pl.voters.size === 1)) pl.votes[b.choice]++;
      return json(200, {});
    }
    if (p === "/api/host/webinars/s/chat") return json(200, { stats: {}, messages: chat });
    if (p === "/api/webinars/s/questions") return json(200, { questions: [...questions.values()].map(({ voters, ...q }) => q), hidden: [] });
    if (p === "/api/host/webinars/s/polls") return json(200, [...polls.values()].map(({ voters, ...x }) => x));
    json(404, {});
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ api: `http://127.0.0.1:${srv.address().port}/api`, close: () => srv.close() })));
}

test("engage end to end against a fake API", async () => {
  const { runEngage } = await import("../engage.mjs");
  const { Session } = await import("../lib/client.mjs");
  const keys = Array.from({ length: 30 }, (_, i) => `K${i}`);
  const opts = { slug: "s", keys, chat: 12, questions: 5, upvotes: 15, polls: 2, quizzes: 1, voters: 20, chatGapMs: 0, log: () => {} };
  const fake = await engageFake();
  try {
    const host = await new Session(fake.api, "host").login("h@x.invalid", "pw");
    const order = [];
    const res = await runEngage({ ...opts, api: fake.api, host, beforePolls: () => order.push("pause"), afterPolls: () => order.push("resume") });
    assert.ok(res.pass, verdictTable(res.checks));
    assert.deepEqual(order, ["pause", "resume"]);
    assert.equal(res.chat.accepted, 12);
    assert.equal(res.questions.upvotesAccepted, 15);
    assert.deepEqual(res.polls.map((x) => x.votes), [expectedTally(20, 3), expectedTally(20, 4), expectedTally(20, 3)]);
  } finally {
    fake.close();
  }
  // A server that drops a vote it accepted is caught.
  const lossy = await engageFake({ loseVote: true });
  try {
    const host = await new Session(lossy.api, "host").login("h@x.invalid", "pw");
    const res = await runEngage({ ...opts, api: lossy.api, host });
    assert.equal(res.pass, false);
    assert.equal(res.checks.filter((c) => !c.pass).length, 3, "each poll lost one");
  } finally {
    lossy.close();
  }
});
