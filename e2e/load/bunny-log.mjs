#!/usr/bin/env node
/* Bunny's request log for a load test's window, summarised (lib/bunny-log.mjs).
 *
 *   node bunny-log.mjs --file 6835297.log --from 2026-10-26T10:00:00Z --to 2026-10-26T10:20:00Z \
 *     [--slug <webinar slug>] [--out results/<run>/bunny.json]
 *   node bunny-log.mjs --zone 6835297 --from ... --to ...      # fetched, with BUNNY_API_KEY
 *
 * Without BUNNY_API_KEY (the account API key, never printed), download the day's log from the
 * dashboard: Monitoring -> Logs -> pick the pull zone (webinarlivindiav) -> Download, and pass
 * it with --file. Logging must be on for the zone (it is: 3 days kept). The log's lines are UTC
 * epoch ms; the dashboard shows them in your local time.
 *
 * Prints requests, status codes, the 499 rate (viewers who gave up waiting on the edge), the
 * 504 rate (the edge timing out on our box), the cache HIT ratio, per kind, per edge and per
 * minute. run.mjs prints this command, with the run's window, at the end of a browser run. */
import { readFileSync, writeFileSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs, stamp } from "./lib/args.mjs";
import { parseLine, summarise, logUrl } from "./lib/bunny-log.mjs";
import { table } from "./lib/stats.mjs";

const SELF = fileURLToPath(import.meta.url);

async function main() {
  const f = parseArgs(process.argv.slice(2));
  if (f.help || (!f.file && !f.zone) || !f.from || !f.to) {
    console.log(readFileSync(SELF, "utf8").split("*/")[0].replace(/^#!.*\n\/\* ?/, ""));
    process.exit(f.help ? 0 : 2);
  }
  const from = Date.parse(f.from);
  const to = Date.parse(f.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error("--from and --to are ISO times");
  // A day's log runs to hundreds of MB (694 MB on 25 Oct): read it a line at a time, keeping
  // only the window's records.
  const records = [];
  const keep = (line) => {
    const r = parseLine(line);
    if (r && r.at >= from && r.at < to) records.push(r);
  };
  if (f.file) {
    for await (const line of createInterface({ input: createReadStream(String(f.file)), crlfDelay: Infinity })) keep(line);
  } else {
    const key = process.env.BUNNY_API_KEY;
    if (!key) throw new Error("--zone needs BUNNY_API_KEY (or download the log and pass --file)");
    const days = new Set([logUrl(from, f.zone), logUrl(to, f.zone)]);
    for (const u of days) {
      const r = await fetch(u, { headers: { AccessKey: key } });
      if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
      for (const line of (await r.text()).split("\n")) keep(line);
    }
  }
  const s = summarise(records, { from, to, slug: typeof f.slug === "string" ? f.slug : undefined });
  const cols = [["key", "key"], ["requests", "requests"], ["viewers", "viewers"], ["pct499", "499 %"], ["pct504", "504 %"], ["hitPct", "HIT %"]];
  console.log(`${stamp()} ${s.all.requests} request(s) in the window; 499 ${s.all.pct499}%, 504 ${s.all.pct504}%, HIT ${s.all.hitPct}%; status ${JSON.stringify(s.all.status)}`);
  console.log("\nBy kind\n" + table(s.byKind, cols));
  console.log("\nBy edge\n" + table(s.byEdge, cols));
  console.log("\nBy minute (UTC)\n" + table(s.byMinute, cols));
  if (f.out) writeFileSync(String(f.out), JSON.stringify(s, null, 1));
}

if (process.argv[1] === SELF) {
  main().catch((e) => {
    console.error(`${stamp()} ${e.message}`);
    process.exit(1);
  });
}
