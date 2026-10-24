#!/usr/bin/env node
/* Engagement check during a load test (docs/LOAD-TESTING.md): the audience's chat, questions,
 * upvotes, polls and quizzes, sent from the run's seats, then compared with what the server
 * stored. run.mjs --engage runs it during the top step; on its own, against a run in progress:
 *
 *   node engage.mjs --dir results/<run> [--web https://webinarliv.com] [--api URL] \
 *     [--chat 200] [--questions 20] [--upvotes 60] [--polls 3] [--quizzes 2] [--voters 100] \
 *     [--chat-gap 200ms] [--out FILE] [--i-know-this-is-prod]
 *
 * It signs in as the run's test host (state.json) and uses its seats (keys.json).
 *
 *   chat       N messages, "<tag> message <i>", round-robin over the seats, one every --chat-gap
 *   questions  N questions from the first N seats, then upvotes from the other seats, never a
 *              seat's own question and never the same question twice from one seat
 *   polls      --polls polls and --quizzes quizzes, one at a time: open, --voters distinct seats
 *              vote choice i % options (so the tally is known in advance), close. Opening one
 *              closes whatever was open (run.mjs pauses api-load's votes meanwhile)
 *
 * Then it checks, and prints a PASS/FAIL table:
 *   chat       the host transcript (GET /host/webinars/{slug}/chat -> {stats, messages}) holds
 *              every accepted message, by id, with its text (`message`)
 *   questions  the host's Q&A list (GET /webinars/{slug}/questions, as the host) holds every
 *              accepted question with exactly its accepted upvotes
 *   polls      each poll's stored votes equal the accepted votes per option, it is closed, and a
 *              quiz keeps its correctOption
 * A rejected send (429, 409) is reported but is not a FAIL: only what the server accepted has
 * to be there. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs, parseDuration, intFlag, sleep, stamp } from "./lib/args.mjs";
import { apiBase, assertSafeTarget, timed, Session } from "./lib/client.mjs";
import { percentile, table } from "./lib/stats.mjs";
import { writeResults } from "./lib/report.mjs";

const SELF = fileURLToPath(import.meta.url);

export const ENGAGE_DEFAULTS = { chat: 200, questions: 20, upvotes: 60, polls: 3, quizzes: 2, voters: 100, chatGapMs: 200 };

const POLLS = [
  { question: "Which topic next?", options: ["Pricing", "Scaling", "Mobile"] },
  { question: "How is the audio?", options: ["Great", "OK", "Poor", "No audio"] },
  { question: "Rate the session", options: ["1", "2", "3", "4", "5"] },
  { question: "Where are you watching from?", options: ["Office", "Home", "Phone"] },
];
const QUIZZES = [
  { question: "Quiz: 2 + 2 = ?", options: ["3", "4", "5"], correctOption: 1 },
  { question: "Quiz: LL-HLS stands for?", options: ["Low-Latency HLS", "Large-Layer HLS"], correctOption: 0 },
  { question: "Quiz: the capital of India?", options: ["Mumbai", "Delhi", "Kolkata", "Chennai"], correctOption: 1 },
];

/** The poll and quiz definitions for a run, tagged so they can be found again. */
export function pollDefs(tag, polls, quizzes) {
  const out = [];
  for (let i = 0; i < polls; i++) {
    const d = POLLS[i % POLLS.length];
    out.push({ kind: "poll", question: `${tag} ${d.question}${i >= POLLS.length ? ` (${i + 1})` : ""}`, options: d.options });
  }
  for (let i = 0; i < quizzes; i++) {
    const d = QUIZZES[i % QUIZZES.length];
    out.push({ kind: "quiz", question: `${tag} ${d.question}${i >= QUIZZES.length ? ` (${i + 1})` : ""}`, options: d.options, correctOption: d.correctOption });
  }
  return out;
}

/* upvotePlan(seats, questions, upvotes) -> [{ seat, question }]: who upvotes what. Askers are
 * seats 0..questions-1; voters come from the rest when there are any, else from everyone. A
 * seat never upvotes its own question nor one question twice. May return fewer than asked
 * when the seats run out. */
export function upvotePlan(seats, questions, upvotes) {
  const out = [];
  if (!questions || !seats) return out;
  const pool = seats > questions ? Array.from({ length: seats - questions }, (_, i) => questions + i) : Array.from({ length: seats }, (_, i) => i);
  const used = new Set();
  for (let j = 0; out.length < upvotes && j < upvotes * 4 + pool.length * questions; j++) {
    const seat = pool[j % pool.length];
    const question = (j + Math.floor(j / pool.length)) % questions;
    if (seat === question || used.has(`${seat}/${question}`)) continue;
    used.add(`${seat}/${question}`);
    out.push({ seat, question });
  }
  return out;
}

/** The tally a deterministic vote run gives: voter i picks i % options. */
export function expectedTally(voters, options) {
  const t = Array.from({ length: options }, () => 0);
  for (let i = 0; i < voters; i++) t[i % options]++;
  return t;
}

const listOf = (j, ...keys) => (Array.isArray(j) ? j : keys.map((k) => j?.[k]).find(Array.isArray) ?? []);

/* verifyEngagement(sent, stored) -> [{ area, name, pass, detail }]. Pure: what was accepted
 * against what the server returned.
 *   sent:   { chat: [{ id, text }], questions: [{ id, text, upvotes }], polls: [{ id, kind, question, votes, correctOption }] }
 *   stored: { chat: <transcript JSON>, questions: <RoomQuestions JSON>, polls: <host poll list> } */
export function verifyEngagement(sent, stored) {
  const rows = [];
  const add = (area, name, pass, detail) => rows.push({ area, name, pass: !!pass, detail });

  if (sent.chat?.length) {
    if (!stored.chat) add("chat", "transcript", false, "the host transcript could not be read");
    else {
      const byId = new Map(listOf(stored.chat, "messages", "items").map((m) => [m.id, m]));
      const missing = sent.chat.filter((m) => !byId.has(m.id));
      const wrong = sent.chat.filter((m) => byId.has(m.id) && String(byId.get(m.id).message ?? byId.get(m.id).text ?? "") !== m.text);
      add("chat", `${sent.chat.length} accepted messages stored`, !missing.length && !wrong.length,
        `${sent.chat.length - missing.length}/${sent.chat.length} found` +
          (missing.length ? `; missing e.g. ${missing.slice(0, 3).map((m) => m.text).join(", ")}` : "") +
          (wrong.length ? `; ${wrong.length} with different text` : ""));
    }
  }

  if (sent.questions?.length) {
    if (!stored.questions) add("questions", "list", false, "the Q&A list could not be read");
    else {
      const byId = new Map(listOf(stored.questions, "questions", "items").map((q) => [q.id, q]));
      const missing = sent.questions.filter((q) => !byId.has(q.id));
      add("questions", `${sent.questions.length} accepted questions listed`, !missing.length,
        `${sent.questions.length - missing.length}/${sent.questions.length} found${missing.length ? `; missing e.g. ${missing.slice(0, 3).map((q) => q.text).join(", ")}` : ""}`);
      const off = sent.questions.filter((q) => byId.has(q.id) && (byId.get(q.id).upvotes ?? 0) !== q.upvotes);
      const total = sent.questions.reduce((a, q) => a + q.upvotes, 0);
      add("questions", `upvotes (${total} accepted)`, !off.length,
        off.length ? `${off.length} differ, e.g. ${off.slice(0, 3).map((q) => `${q.text}: ${byId.get(q.id).upvotes} stored, ${q.upvotes} sent`).join("; ")}` : "every count matches");
    }
  }

  const polls = listOf(stored.polls, "polls", "items");
  for (const p of sent.polls ?? []) {
    const s = polls.find((x) => x.id === p.id);
    const name = `${p.kind} "${p.question}"`;
    if (!s) {
      add(p.kind, name, false, "not in the host's poll list");
      continue;
    }
    const tallyOk = JSON.stringify(s.votes ?? []) === JSON.stringify(p.votes);
    const closed = s.state === "closed";
    const quizOk = p.kind !== "quiz" || s.correctOption === p.correctOption;
    add(p.kind, name, tallyOk && closed && quizOk,
      `stored ${JSON.stringify(s.votes ?? [])} vs accepted ${JSON.stringify(p.votes)}` +
        (closed ? "" : `; state ${s.state}`) +
        (p.kind === "quiz" ? `; correctOption ${s.correctOption} (want ${p.correctOption})` : ""));
  }
  return rows;
}

export function verdictTable(rows) {
  return table(rows.map((r) => ({ ...r, result: r.pass ? "PASS" : "FAIL" })), [
    ["result", "result"],
    ["area", "area"],
    ["name", "check"],
    ["detail", "detail"],
  ]);
}

/* runEngage(o) -> summary. o: { api, slug, host: Session (the webinar's host), keys, tag?,
 * chat, questions, upvotes, polls, quizzes, voters, chatGapMs, beforePolls(), afterPolls(),
 * log, signal }. beforePolls/afterPolls let run.mjs pause and resume api-load's votes. */
export async function runEngage(o) {
  const log = o.log ?? console.log;
  const cfg = { ...ENGAGE_DEFAULTS, ...Object.fromEntries(Object.entries(o).filter(([k, v]) => k in ENGAGE_DEFAULTS && v !== undefined)) };
  const tag = o.tag ?? `ENG${Date.now().toString(36)}`;
  const keys = o.keys;
  if (!keys?.length) throw new Error("engage: no seats");
  const say = (body) => timed(`${o.api}/webinars/${o.slug}/say`, { method: "POST", body, signal: o.signal });
  const tally = (errs, r) => (errs[r.status] = (errs[r.status] ?? 0) + 1);
  const summary = { tag, config: cfg, chat: {}, questions: {}, polls: [], problems: [] };
  const sent = { chat: [], questions: [], polls: [] };
  log(`${stamp()} engage ${tag}: ${cfg.chat} chat, ${cfg.questions} questions + ${cfg.upvotes} upvotes, ${cfg.polls} poll(s), ${cfg.quizzes} quiz(zes), ${Math.min(cfg.voters, keys.length)} voters each`);

  // 1. Chat burst.
  {
    const ms = [];
    const errors = {};
    for (let i = 0; i < cfg.chat && !o.signal?.aborted; i++) {
      const m = { id: randomUUID(), text: `${tag} message ${i}` };
      const r = await say({ joinKey: keys[i % keys.length], kind: "chat", id: m.id, text: m.text });
      ms.push(r.ms);
      if (r.ok) sent.chat.push(m);
      else tally(errors, r);
      await sleep(cfg.chatGapMs, o.signal);
    }
    summary.chat = { sent: cfg.chat, accepted: sent.chat.length, rejected: errors, p50ms: Math.round(percentile(ms, 50)), p95ms: Math.round(percentile(ms, 95)) };
    log(`${stamp()} engage chat: ${sent.chat.length}/${cfg.chat} accepted, p95 ${summary.chat.p95ms} ms${Object.keys(errors).length ? `, rejected ${JSON.stringify(errors)}` : ""}`);
  }

  // 2. Questions, then upvotes.
  {
    const nq = Math.min(cfg.questions, keys.length);
    const asked = [];
    const errors = {};
    for (let i = 0; i < nq && !o.signal?.aborted; i++) {
      const q = { id: `q-eng-${randomUUID()}`, text: `${tag} question ${i}?`, upvotes: 0 };
      const r = await say({ joinKey: keys[i], kind: "question", id: q.id, text: q.text, anonymous: false });
      if (r.ok) sent.questions.push(q);
      else tally(errors, r);
      asked.push(r.ok ? q : null);
    }
    const plan = upvotePlan(keys.length, nq, cfg.upvotes);
    let up = 0;
    const upErr = {};
    for (const { seat, question } of plan) {
      if (o.signal?.aborted) break;
      const q = asked[question];
      if (!q) continue;
      const r = await say({ joinKey: keys[seat], kind: "upvote", questionId: q.id });
      if (r.ok) {
        q.upvotes++;
        up++;
      } else tally(upErr, r);
    }
    summary.questions = { sent: nq, accepted: sent.questions.length, rejected: errors, upvotesSent: plan.length, upvotesAccepted: up, upvotesRejected: upErr };
    log(`${stamp()} engage questions: ${sent.questions.length}/${nq} accepted, upvotes ${up}/${plan.length}`);
  }

  // 3. Polls and quizzes, one at a time.
  await o.beforePolls?.();
  try {
    let seatAt = 0;
    const voters = Math.min(cfg.voters, keys.length);
    for (const d of pollDefs(tag, cfg.polls, cfg.quizzes)) {
      if (o.signal?.aborted) break;
      let c;
      try {
        c = await o.host.call("POST", `/host/webinars/${o.slug}/polls`, d);
        await o.host.call("POST", `/host/webinars/${o.slug}/polls/${c.id}/open`);
      } catch (e) {
        summary.problems.push(`${d.kind} "${d.question}": ${e.message}`);
        continue;
      }
      const votes = d.options.map(() => 0);
      const errors = {};
      const ms = [];
      for (let i = 0; i < voters && !o.signal?.aborted; i++) {
        const choice = i % d.options.length;
        const r = await timed(`${o.api}/webinars/${o.slug}/polls/${c.id}/vote`, {
          method: "POST",
          body: { joinKey: keys[seatAt++ % keys.length], choice },
          signal: o.signal,
        });
        ms.push(r.ms);
        if (r.ok) votes[choice]++;
        else tally(errors, r);
      }
      await sleep(1000, o.signal);
      await o.host.call("POST", `/host/webinars/${o.slug}/polls/${c.id}/close`).catch((e) => summary.problems.push(`close ${c.id}: ${e.message}`));
      const p = { id: c.id, kind: d.kind, question: d.question.slice(tag.length + 1), votes, correctOption: d.correctOption ?? -1, rejected: errors, p95ms: Math.round(percentile(ms, 95)) };
      sent.polls.push(p);
      summary.polls.push(p);
      log(`${stamp()} engage ${d.kind} "${p.question}": ${votes.reduce((a, b) => a + b, 0)}/${voters} votes ${JSON.stringify(votes)}${Object.keys(errors).length ? `, rejected ${JSON.stringify(errors)}` : ""}`);
    }
  } finally {
    await o.afterPolls?.();
  }

  // 4. What the server kept.
  await sleep(3000, o.signal);
  const get = (path) => o.host.call("GET", path).catch((e) => (summary.problems.push(`GET ${path}: ${e.message}`), null));
  const stored = {
    chat: sent.chat.length ? await get(`/host/webinars/${o.slug}/chat`) : null,
    questions: sent.questions.length ? await get(`/webinars/${o.slug}/questions`) : null,
    polls: sent.polls.length ? await get(`/host/webinars/${o.slug}/polls`) : null,
  };
  summary.checks = verifyEngagement(sent, stored);
  for (const p of summary.problems) summary.checks.push({ area: "run", name: "request", pass: false, detail: p });
  summary.pass = summary.checks.length > 0 && summary.checks.every((c) => c.pass);
  return summary;
}

async function main() {
  const f = parseArgs(process.argv.slice(2));
  if (f.help || !f.dir) {
    console.log(readFileSync(SELF, "utf8").split("*/")[0].replace(/^#!.*\n\/\* ?/, ""));
    process.exit(f.help ? 0 : 2);
  }
  const state = JSON.parse(readFileSync(join(f.dir, "state.json"), "utf8"));
  const web = String(f.web || state.web).replace(/\/$/, "");
  const api = f.api ? apiBase(web, f) : state.api || apiBase(web, f);
  assertSafeTarget([web, api], f);
  const slug = f.slug || state.slug;
  const keys = JSON.parse(readFileSync(join(f.dir, "keys.json"), "utf8")).map((k) => (typeof k === "string" ? k : k.joinKey || k.key)).filter(Boolean);
  const host = await new Session(api, "host").login(state.host.email, state.host.password);
  const res = await runEngage({
    api,
    slug,
    host,
    keys,
    chat: intFlag(f.chat, undefined, "chat"),
    questions: intFlag(f.questions, undefined, "questions"),
    upvotes: intFlag(f.upvotes, undefined, "upvotes"),
    polls: intFlag(f.polls, undefined, "polls"),
    quizzes: intFlag(f.quizzes, undefined, "quizzes"),
    voters: intFlag(f.voters, undefined, "voters"),
    chatGapMs: f.chatGap === undefined ? undefined : parseDuration(f.chatGap),
  });
  console.log(`\n=== Engagement ${res.pass ? "PASS" : "FAIL"} ===\n` + verdictTable(res.checks));
  const out = f.out || join(f.dir, `engage-${Date.now()}.json`);
  writeResults(out, res);
  console.log(`\nresults: ${out}`);
  process.exitCode = res.pass ? 0 : 1;
}

if (process.argv[1] === SELF) {
  main().catch((e) => {
    console.error(`${stamp()} ${e.message}`);
    process.exit(1);
  });
}
