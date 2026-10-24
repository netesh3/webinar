#!/usr/bin/env node
/* N simulated edge (LL-HLS) viewers, ramped in steps (docs/LOAD-TESTING.md).
 *
 *   node hls-viewers.mjs --web https://staging.example --slug <slug> --keys keys.json \
 *     --steps 50,200,500,1000 --ramp 30s --hold 120s [--workers 8] [--origin <origin base>]
 *
 * Each viewer joins with its own join key, holds the events stream open and beats every 30 s
 * (so attendance counts it), and plays the LL-HLS stream the way hls.js does (lib/viewer.mjs).
 * Join keys come from --keys (a JSON array, e.g. what run.mjs writes) or, with --mint and the
 * admin variables, are minted for a webinar an admin marked as a load test.
 *
 *   --api URL           API base (default <web>/api)
 *   --origin URL        fetch HLS from the origin instead of the CDN, e.g.
 *                       https://152.42.156.192.sslip.io/live (stresses the video box itself)
 *   --low-latency / --no-low-latency   force the player mode (default: what join says)
 *   --variant first|highest|lowest     which rendition (default first listed, like hls.js)
 *   --no-events         HLS only: no event stream, beats or backlogs
 *   --workers N         processes (default: one per 150 viewers, at most the CPU count)
 *   --start-at MS       start at this epoch time (run.mjs --extra-seats prints it)
 *   --from N            skip the first N keys of --keys (a second generator takes the next slice)
 *   --max-viewers N     refuse more than N (default 1000; hard cap 5000)
 *   --out FILE          JSON results (default results/hls-<time>.json)
 *   --i-know-this-is-prod   required for webinarliv.com / *.run.app
 */
import { availableParallelism } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, parseDuration, parseSteps, intFlag, stamp } from "./lib/args.mjs";
import { apiBase, assertSafeTarget, ABSOLUTE_MAX_VIEWERS } from "./lib/client.mjs";
import { runLocal, runWorkers, workerMain } from "./lib/steps.mjs";
import { EdgeViewer } from "./lib/viewer.mjs";
import { hlsTable, generatorWarnings, writeResults } from "./lib/report.mjs";
import { adminSession, seatViewers } from "./lib/fixture.mjs";

const SELF = fileURLToPath(import.meta.url);

function viewerOptions(o, joinKey) {
  return {
    api: o.api,
    slug: o.slug,
    joinKey,
    originBase: o.originBase || "",
    lowLatency: o.lowLatency ?? null,
    variant: o.variant || "first",
    events: o.events !== false,
    backlog: o.events !== false,
  };
}

/* runHlsViewers(o) -> { steps: [stepJSON], warnings } . o: { api, slug, keys, steps, holdMs,
 * rampMs, workers, originBase, lowLatency, variant, events, log } */
export async function runHlsViewers(o) {
  const log = o.log ?? console.log;
  const total = o.steps[o.steps.length - 1];
  if (o.keys.length < total) throw new Error(`${total} viewers need ${total} join keys, have ${o.keys.length}`);
  const workers = Math.max(1, Math.min(o.workers || Math.ceil(total / 150), availableParallelism(), total || 1));
  const results = [];
  const onStep = (st) => {
    const j = st.toJSON();
    results.push(j);
    log(`${stamp()} ${j.name}: ${j.target} viewers held ${j.seconds}s, active ${j.active ?? 0}, ` +
      `join ok ${j.counts.joinOk ?? 0} fail ${j.counts.joinFail ?? 0}, stalls ${j.counts.stall ?? 0}, ${j.mbps} Mbit/s`);
    for (const w of generatorWarnings(j, { cores: workers })) log(`${stamp()} WARNING ${w}`);
  };
  log(`${stamp()} ${total} edge viewer(s) over steps ${o.steps.join(",")} (ramp ${o.rampMs / 1000}s, hold ${o.holdMs / 1000}s), ${workers} process(es)` +
    (o.originBase ? `, ORIGIN ${o.originBase}` : ", via the CDN playback URL"));
  if (workers === 1) {
    await runLocal({
      steps: o.steps,
      holdMs: o.holdMs,
      rampMs: o.rampMs,
      signal: o.signal,
      makeClient: (i, ctx) => new EdgeViewer(viewerOptions(o, o.keys[i]), ctx),
      onStep,
    });
  } else {
    // Each worker takes a contiguous slice of the keys, as large as its share of the last step.
    const per = [];
    let at = 0;
    for (let w = 0; w < workers; w++) {
      const n = Math.floor(total / workers) + (w < total % workers ? 1 : 0);
      per.push(o.keys.slice(at, at + n));
      at += n;
    }
    await runWorkers({
      script: SELF,
      workers,
      steps: o.steps,
      holdMs: o.holdMs,
      rampMs: o.rampMs,
      payload: (w) => ({ ...viewerOptions(o, ""), keys: per[w] }),
      onStep,
      signal: o.signal,
    });
  }
  return { steps: results };
}

async function main() {
  const f = parseArgs(process.argv.slice(2));
  if (f.worker) {
    workerMain((m) => (i, ctx) => new EdgeViewer({ ...m.payload, joinKey: m.payload.keys[i] }, ctx));
    return;
  }
  if (f.help || (!f.web && !f.api)) {
    console.log(readFileSync(SELF, "utf8").split("*/")[0].replace(/^#!.*\n\/\* ?/, ""));
    process.exit(f.help ? 0 : 2);
  }
  const api = apiBase(f.web, f);
  assertSafeTarget([f.web, api, f.origin], f);
  const steps = parseSteps(f.steps, [5]);
  const maxViewers = Math.min(intFlag(f.maxViewers, 1000, "max-viewers"), ABSOLUTE_MAX_VIEWERS);
  const total = steps[steps.length - 1];
  if (total > maxViewers) throw new Error(`${total} viewers is over --max-viewers ${maxViewers}`);
  if (!f.slug) throw new Error("--slug is required");
  let keys = [];
  if (f.keys) keys = JSON.parse(readFileSync(f.keys, "utf8")).slice(intFlag(f.from, 0, "from"));
  else if (f.mint) {
    const admin = await adminSession(api);
    keys = await seatViewers(admin, f.slug, Math.max(total, intFlag(f.viewers, total)), total);
  } else throw new Error("--keys FILE or --mint is required");
  if (f.startAt) {
    // Started by run.mjs's --extra-seats: begin with the other generators, not before.
    const at = Number(f.startAt);
    if (!Number.isFinite(at)) throw new Error("--start-at is epoch milliseconds");
    if (at - Date.now() > 0) console.log(`${stamp()} starting in ${Math.round((at - Date.now()) / 1000)}s`);
    if (at - Date.now() < -60_000) throw new Error("--start-at is over a minute ago: the others have started; ask for a new time");
    await new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));
  }
  if (f.dryRun) {
    console.log(`dry run: would start ${total} viewers on ${f.slug} at ${api} over steps ${steps.join(",")}`);
    return;
  }
  const out = f.out || `results/hls-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const res = await runHlsViewers({
    api,
    slug: f.slug,
    keys,
    steps,
    holdMs: parseDuration(f.hold, 120_000),
    rampMs: parseDuration(f.ramp, 30_000),
    workers: intFlag(f.workers, 0, "workers"),
    originBase: typeof f.origin === "string" ? f.origin : "",
    lowLatency: f.lowLatency === undefined ? null : !!f.lowLatency,
    variant: f.variant,
    events: f.events,
  });
  console.log("\n" + hlsTable(res.steps));
  writeResults(out, { tool: "hls-viewers", api, slug: f.slug, origin: f.origin || null, ...res });
  console.log(`\nresults: ${out}`);
}

if (process.argv[1] === SELF) {
  main().catch((e) => {
    console.error(`${stamp()} ${e.message}`);
    process.exit(1);
  });
}
