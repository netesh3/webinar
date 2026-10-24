#!/usr/bin/env node
/* API load during a live session (docs/LOAD-TESTING.md): what an audience does besides
 * watching, at configurable rates (per second), reported in windows.
 *
 *   node api-load.mjs --web <origin> --slug <slug> --keys keys.json --duration 5m \
 *     [--chat 2] [--question 0.2] [--upvote 0.5] [--vote 1] [--join 1] [--register 0.2] \
 *     [--events 0.5 --events-hold 60s] [--window 30s] [--out FILE]
 *
 *   --chat R       chat messages/s, each from a random seat (POST /say kind=chat). In an edge
 *                  webinar every message fans out to every viewer's event stream.
 *   --question R   questions/s (kind=question); --upvote R upvotes/s of those questions
 *   --vote R       poll votes/s: needs --poll <id> (run.mjs creates and opens one) and spare
 *                  seats, since each seat votes once. A 409 (voting closed meanwhile) is
 *                  counted as voteConflict, not as an error
 *   --join R       joins/s with seats from the keys file (a re-join of a seat is idempotent)
 *   --register R   public registrations/s at <run>-<n>@loadtest.invalid. The server allows
 *                  REGISTER_RATE_PER_MIN (30/min) per IP, so above 0.5/s expect 429s: that is
 *                  the limit doing its job, not a failure. Each one leaves an unverified
 *                  audience account; run.mjs deletes them at cleanup. No mail is sent (.invalid).
 *   --events R     extra event-stream connections/s, each held --events-hold then closed
 *
 * Each seat sends at most 60 actions a minute (the server's per-sender limit is 90). AI stays
 * off for the session (controls.aiEnabled false), so nothing here spends AI budget.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs, parseDuration, numFlag, sleep, stamp } from "./lib/args.mjs";
import { apiBase, assertSafeTarget, timed } from "./lib/client.mjs";
import { Step } from "./lib/stats.mjs";
import { apiTable, writeResults } from "./lib/report.mjs";
import { readSSE } from "./lib/sse.mjs";

const SELF = fileURLToPath(import.meta.url);
const WORDS = "great session thanks question about pricing how does this scale can you share the slides again please what about mobile audio is clear video looks sharp".split(" ");
const sentence = (n = 8) => Array.from({ length: n }, () => WORDS[Math.floor(Math.random() * WORDS.length)]).join(" ");

/* runApiLoad(o) -> { windows: [stepJSON] }. o: { api, slug, keys, rates: {chat, question, upvote,
 * vote, join, register, events}, eventsHoldMs, durationMs, windowMs, pollId (a string, or a
 * function returning the poll to vote in now, "" to pause), run, signal, log } */
export async function runApiLoad(o) {
  const log = o.log ?? console.log;
  const rates = o.rates;
  const windows = [];
  let win = new Step("window 1", 0);
  const questions = [];
  const voted = new Set();
  const lastUse = new Map(); // seat -> [timestamps] within the minute
  let regN = 0;
  const end = Date.now() + o.durationMs;
  const inflight = new Set();

  const seat = () => {
    for (let tries = 0; tries < 10; tries++) {
      const k = o.keys[Math.floor(Math.random() * o.keys.length)];
      const now = Date.now();
      const used = (lastUse.get(k) ?? []).filter((t) => now - t < 60_000);
      if (used.length < 60) {
        used.push(now);
        lastUse.set(k, used);
        return k;
      }
    }
    return null;
  };
  const rec = (name, r) => {
    win.sample(name, r.ms);
    if (r.ok) win.count(`${name}Ok`);
    else win.error(name, r.status);
  };
  const say = async (name, body) => {
    const r = await timed(`${o.api}/webinars/${o.slug}/say`, { method: "POST", body, signal: o.signal });
    rec(name, r);
    return r;
  };

  const actions = {
    chat: async () => {
      const k = seat();
      if (k) await say("chat", { joinKey: k, kind: "chat", id: randomUUID(), text: sentence() });
    },
    question: async () => {
      const k = seat();
      if (!k) return;
      const id = `q-lt-${randomUUID()}`;
      const r = await say("question", { joinKey: k, kind: "question", id, text: `${sentence(10)}?`, anonymous: false });
      if (r.ok) questions.push(id);
    },
    upvote: async () => {
      const k = seat();
      if (k && questions.length) await say("upvote", { joinKey: k, kind: "upvote", questionId: questions[Math.floor(Math.random() * questions.length)] });
    },
    vote: async () => {
      // pollId may be a function: the poll open right now, or "" while votes are paused
      // (run.mjs --engage opens its own polls, which closes this one).
      const pollId = typeof o.pollId === "function" ? o.pollId() : o.pollId;
      if (!pollId) return;
      const k = o.keys.find((x) => !voted.has(`${pollId}/${x}`));
      if (!k) return;
      voted.add(`${pollId}/${k}`);
      const r = await timed(`${o.api}/webinars/${o.slug}/polls/${pollId}/vote`, {
        method: "POST",
        body: { joinKey: k, choice: Math.floor(Math.random() * 3) },
        signal: o.signal,
      });
      /* 409 is "already answered, or voting has closed": expected when a poll was closed or
       * swapped between picking it and the vote landing. Counted, not an error. */
      if (r.status === 409) {
        win.sample("vote", r.ms);
        win.count("voteConflict");
      } else rec("vote", r);
    },
    join: async () => {
      const k = o.keys[Math.floor(Math.random() * o.keys.length)];
      const r = await timed(`${o.api}/webinars/${o.slug}/join`, { method: "POST", body: { joinKey: k }, signal: o.signal });
      rec("join", r);
    },
    register: async () => {
      const n = ++regN;
      const r = await timed(`${o.api}/webinars/${o.slug}/register`, {
        method: "POST",
        signal: o.signal,
        body: {
          firstName: `Load Reg ${n}`,
          lastName: "",
          email: `reg-${o.run}-${n}@loadtest.invalid`,
          phone: `+9197${String(n).padStart(8, "0")}`,
          consent: true,
          whatsappOptIn: false,
        },
      });
      rec("register", r);
    },
    events: async () => {
      // A short-lived extra viewer stream: join a seat for its token, hold the stream, leave.
      const k = o.keys[Math.floor(Math.random() * o.keys.length)];
      const j = await timed(`${o.api}/webinars/${o.slug}/join`, { method: "POST", body: { joinKey: k }, signal: o.signal });
      if (!j.ok) return rec("events", j);
      const token = JSON.parse(j.body).eventsToken;
      const ctl = new AbortController();
      const r = await timed(`${o.api}/webinars/${o.slug}/events?t=${encodeURIComponent(token)}`, { stream: true, signal: ctl.signal });
      rec("events", r);
      if (!r.ok) return;
      const t = setTimeout(() => ctl.abort(), o.eventsHoldMs);
      win.bytes += await readSSE(r.res, {});
      clearTimeout(t);
    },
  };

  // One ticker per action: Poisson arrivals at the given rate, so bursts look like people.
  const tickers = Object.entries(rates)
    .filter(([, r]) => r > 0)
    .map(async ([name, rate]) => {
      while (Date.now() < end && !o.signal?.aborted) {
        await sleep(-Math.log(1 - Math.random()) * (1000 / rate), o.signal);
        if (Date.now() >= end || o.signal?.aborted) break;
        const p = actions[name]().catch((e) => win.error(name, e.message));
        inflight.add(p);
        p.finally(() => inflight.delete(p));
      }
    });

  const reporter = (async () => {
    let i = 1;
    while (Date.now() < end && !o.signal?.aborted) {
      await sleep(Math.min(o.windowMs, end - Date.now()), o.signal);
      win.close();
      const j = win.toJSON();
      windows.push(j);
      log(`${stamp()} api ${j.name}: ${Object.entries(j.counts).map(([k, v]) => `${k} ${v}`).join(", ") || "nothing"}` +
        (Object.keys(j.errors).length ? `; errors ${JSON.stringify(j.errors)}` : ""));
      win = new Step(`window ${++i}`, 0);
    }
  })();
  await Promise.all(tickers);
  await Promise.allSettled([...inflight]);
  await reporter;
  return { windows, registered: regN };
}

async function main() {
  const f = parseArgs(process.argv.slice(2));
  if (f.help || !f.web || !f.slug || !f.keys) {
    console.log(readFileSync(SELF, "utf8").split("*/")[0].replace(/^#!.*\n\/\* ?/, ""));
    process.exit(f.help ? 0 : 2);
  }
  const api = apiBase(f.web, f);
  assertSafeTarget([f.web, api], f);
  const keys = JSON.parse(readFileSync(f.keys, "utf8"));
  const o = {
    api,
    slug: f.slug,
    keys,
    run: f.run || `lt${Date.now()}`,
    pollId: f.poll || "",
    rates: {
      chat: numFlag(f.chat, 1, "chat"),
      question: numFlag(f.question, 0.1, "question"),
      upvote: numFlag(f.upvote, 0.2, "upvote"),
      vote: numFlag(f.vote, f.poll ? 1 : 0, "vote"),
      join: numFlag(f.join, 0, "join"),
      register: numFlag(f.register, 0, "register"),
      events: numFlag(f.events, 0, "events"),
    },
    eventsHoldMs: parseDuration(f.eventsHold, 60_000),
    durationMs: parseDuration(f.duration, 300_000),
    windowMs: parseDuration(f.window, 30_000),
  };
  if (f.dryRun) {
    console.log(`dry run: api load on ${o.slug} at ${api}: ${JSON.stringify(o.rates)} for ${o.durationMs / 1000}s`);
    return;
  }
  const res = await runApiLoad(o);
  console.log("\n" + apiTable(res.windows));
  const out = f.out || `results/api-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeResults(out, { tool: "api-load", api, slug: o.slug, rates: o.rates, ...res });
  console.log(`\nresults: ${out}`);
}

if (process.argv[1] === SELF) {
  main().catch((e) => {
    console.error(`${stamp()} ${e.message}`);
    process.exit(1);
  });
}
