#!/usr/bin/env node
/* N real-browser viewers: headless Chrome tabs that join as attendees and play the stream with
 * the production player, ramped in steps (lib/browser-viewer.mjs, docs/LOAD-TESTING.md).
 *
 *   node browser-viewers.mjs --web https://webinarliv.com --slug <slug> --keys keys.json \
 *     --steps 10,25 --ramp 60s --hold 600s [--path cdn] [--throttle-share 0.2]
 *
 * What it reports, per viewer and summarised (lib/browser-summary.mjs): time to first frame,
 * stalls (the picture waiting for data after it first played) and their length, latency
 * behind live as the player measures it, the delivery path and the CDN edge, fallbacks, the
 * Reconnecting badge, errors; and stall waves, the share of viewers stalled in the same 10 s.
 *
 *   --api URL            API base (default <web>/api)
 *   --path cdn|direct    start every viewer on this path when the join offered both (default:
 *                        what the join chose, by the viewer's country: India -> the box)
 *   --throttle-share F   this share of the viewers on a phone-like network (default 0)
 *   --throttle NAME      fast4g or slow4g (default slow4g: 1.6 Mbit/s, 150 ms, 1% loss)
 *   --per-chrome N       tabs per Chrome process (default 10)
 *   --max-cpu PCT        the generator's own CPU ceiling (default 70): past it for 15 s, no more
 *                        tabs are opened and the results say so, so a busy generator is not
 *                        mistaken for a stalling stream
 *   --sample 5s          how often each tab is read
 *   --region NAME        label (default: the droplet's DigitalOcean region, else "local")
 *   --chat-probe-at MS   at this epoch time, post 3 tagged chat messages from one seat and time
 *                        how long each takes to reach every viewer's event stream
 *   --no-probe           no side CDN prober (lib/cdn-probe.mjs; on by default, one per path)
 *   --keys FILE --from N --start-at MS --generator NAME --max-viewers N --out FILE
 *   --i-know-this-is-prod   required for webinarliv.com
 *
 * Rough sizing, measured: a headless tab decoding the 720p mix at ~1.1 Mbit/s is about 4-6%
 * of one core; a c-4 (4 vCPU) holds ~40 tabs under 70% CPU (docs/LOAD-TESTING.md). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, parseDuration, parseSteps, intFlag, numFlag, stamp } from "./lib/args.mjs";
import { apiBase, assertSafeTarget, ABSOLUTE_MAX_VIEWERS } from "./lib/client.mjs";
import { writeResults } from "./lib/report.mjs";
import { BrowserViewer, ChromePool, CpuMeter, overloadGuard, dropletRegion, edgeOf } from "./lib/browser-viewer.mjs";
import { report, markdown } from "./lib/browser-summary.mjs";
import { CdnProbe, summariseProbe } from "./lib/cdn-probe.mjs";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const SELF = fileURLToPath(import.meta.url);

const sleep = (ms, signal) =>
  new Promise((r) => {
    const t = setTimeout(r, Math.max(0, ms));
    signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });

/* throttleFor(i, n, share) -> whether viewer i of n is one of the throttled share, spread
 * evenly through the ramp rather than all at the end. */
export function throttleFor(i, share) {
  if (!share || share <= 0) return false;
  return Math.floor((i + 1) * share) > Math.floor(i * share);
}

/* runBrowserViewers(o) -> { region, viewers: [record], cpu: [[t, pct]], edges, overloaded,
 * warnings }. o: { web, slug, keys, steps, rampMs, holdMs, path, throttle, throttleShare,
 * perChrome, maxCpu, sampleMs, region, log, signal }. */
export async function runBrowserViewers(o) {
  const log = o.log ?? console.log;
  const region = o.region || (await dropletRegion()) || "local";
  const total = o.steps[o.steps.length - 1];
  if (o.keys.length < total) throw new Error(`${total} viewers need ${total} join keys, have ${o.keys.length}`);
  const pool = new ChromePool({ perChrome: o.perChrome ?? 10 });
  const cpu = new CpuMeter();
  const guard = overloadGuard({ maxCpu: o.maxCpu ?? 70, consecutive: 3 });
  const viewers = [];
  const cpuLog = [];
  const warnings = [];
  const edges = {}; // path -> the edge this generator reaches for it
  const probes = {}; // path -> CdnProbe on that path's playlist, from this generator
  const chatSent = []; // [{ tag, at }]
  let overloaded = null;
  let stop = false;
  o.signal?.addEventListener("abort", () => (stop = true), { once: true });

  // Every sampleMs: read every tab and the generator's CPU; every 30 s: which edge serves us.
  const sampler = (async () => {
    let n = 0;
    while (!stop) {
      await sleep(o.sampleMs ?? 5000, o.signal);
      if (stop) break;
      await Promise.all(viewers.map((v) => v.sample()));
      // Every 10 s: the true delay, from the time strip in the picture.
      if (n % Math.max(1, Math.round(10_000 / (o.sampleMs ?? 5000))) === 0) await Promise.all(viewers.map((v) => v.glassToGlass()));
      const pct = cpu.pct();
      cpuLog.push([Date.now(), pct]);
      if (guard(pct) === "over" && !overloaded) {
        overloaded = { at: new Date().toISOString(), cpuPct: pct, viewers: viewers.length };
        const msg = `generator ${region} CPU ${pct}% for 15 s with ${viewers.length} tabs: opening no more (--max-cpu ${o.maxCpu ?? 70}); its numbers past here are the generator's, not the stream's`;
        warnings.push(msg);
        log(`${stamp()} WARNING ${msg}`);
      }
      // One side prober per path the viewers here play, from the URL the player chose.
      for (const p of ["cdn", "direct"]) {
        const v = viewers.find((x) => x.last?.path === p && x.last?.url);
        if (v && !probes[p] && o.probe !== false) probes[p] = new CdnProbe(v.last.url, { everyMs: 2000, label: `${region}/${p}` }).start();
      }
      // The chat round trip: a few tagged messages at --chat-probe-at, from one seat here.
      if (o.chatProbeAt && !chatSent.length && Date.now() >= o.chatProbeAt && o.api) {
        for (let k = 0; k < 3; k++) {
          const tag = `LOADMARK-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
          const at = Date.now();
          const r = await fetch(`${o.api}/webinars/${encodeURIComponent(o.slug)}/say`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ joinKey: o.keys[0], kind: "chat", id: randomUUID(), text: `${tag} round trip ${k + 1}` }),
          }).catch(() => null);
          chatSent.push({ tag, at, status: r?.status ?? 0 });
          await sleep(2000, o.signal);
        }
      }
      if (n++ % Math.max(1, Math.round(30_000 / (o.sampleMs ?? 5000))) === 0) {
        for (const p of ["cdn", "direct"]) {
          const v = viewers.find((x) => x.last?.path === p && x.last?.url);
          if (v) edges[p] = p === "direct" ? "box" : (await edgeOf(v.last.url)) || edges[p] || "";
        }
      }
    }
  })();

  let opened = 0;
  const t0 = Date.now();
  for (const [si, target] of o.steps.entries()) {
    if (stop) break;
    const from = opened;
    const n = target - from;
    log(`${stamp()} step ${si + 1}: ${from} -> ${target} browser viewers over ${o.rampMs / 1000}s (${region})`);
    for (let k = 0; k < n && !stop; k++) {
      if (overloaded) break;
      const i = opened++;
      const v = new BrowserViewer({
        id: i, web: o.web, slug: o.slug, joinKey: o.keys[i], chrome: await pool.next(), region,
        throttle: throttleFor(i, o.throttleShare) ? o.throttle || "slow4g" : null,
        preferPath: o.path || null,
      });
      viewers.push(v);
      v.start().catch((e) => {
        v.joinError = e.message;
        log(`${stamp()} viewer ${i}: ${e.message}`);
      });
      await sleep(n > 1 ? o.rampMs / n : 0, o.signal);
    }
    await sleep(o.holdMs, o.signal);
    const joined = viewers.filter((v) => v.last?.firstFrameAt).length;
    log(`${stamp()} step ${si + 1} held: ${joined}/${viewers.length} playing, stalls so far ${viewers.reduce((a, v) => a + (v.last?.stalls ?? 0), 0)}, CPU ${cpuLog.at(-1)?.[1] ?? "?"}%`);
  }
  stop = true;
  await sampler;
  await Promise.all(viewers.map((v) => v.sample()));
  const records = viewers.map((v) => v.record((path) => edges[path] ?? (path === "direct" ? "box" : "")));
  // The round trip each viewer saw for each tagged message sent from here.
  for (const r of records) {
    r.chatRttMs = chatSent.map((c) => (r.marks?.[c.tag] ? r.marks[c.tag] - c.at : null)).filter((x) => x !== null);
    delete r.marks;
  }
  await Promise.all(viewers.map((v) => v.stop()));
  pool.close();
  const probe = {};
  for (const [p, pr] of Object.entries(probes)) {
    const requests = await pr.stop();
    probe[p] = { url: pr.url, summary: summariseProbe(requests), requests };
  }
  return { region, target: total, seconds: Math.round((Date.now() - t0) / 1000), viewers: records, cpu: cpuLog, edges, probe, chatSent, overloaded, warnings };
}

async function main() {
  const f = parseArgs(process.argv.slice(2));
  if (f.help || !f.web) {
    console.log(readFileSync(SELF, "utf8").split("*/")[0].replace(/^#!.*\n\/\* ?/, ""));
    process.exit(f.help ? 0 : 2);
  }
  const web = String(f.web).replace(/\/$/, "");
  const api = apiBase(web, f);
  assertSafeTarget([web, api], f);
  if (!f.slug) throw new Error("--slug is required");
  if (!f.keys) throw new Error("--keys FILE is required (run.mjs mints and passes them)");
  const steps = parseSteps(f.steps, [5], { flat: !!f.generator });
  const total = steps[steps.length - 1];
  const maxViewers = Math.min(intFlag(f.maxViewers, 300, "max-viewers"), ABSOLUTE_MAX_VIEWERS);
  if (total > maxViewers) throw new Error(`${total} viewers is over --max-viewers ${maxViewers}`);
  const path = f.path === undefined ? null : String(f.path);
  if (path && !["cdn", "direct"].includes(path)) throw new Error("--path is cdn or direct");
  const throttle = f.throttle === undefined ? "slow4g" : String(f.throttle);
  const keys = JSON.parse(readFileSync(f.keys, "utf8")).slice(intFlag(f.from, 0, "from"));
  if (f.startAt) {
    const at = Number(f.startAt);
    if (!Number.isFinite(at)) throw new Error("--start-at is epoch milliseconds");
    if (at - Date.now() < -60_000) throw new Error("--start-at is over a minute ago: the others have started; ask for a new time");
    await sleep(at - Date.now());
  }
  if (f.dryRun) {
    console.log(`dry run: would open ${total} browser viewers on ${f.slug} (${web}) over steps ${steps.join(",")}${path ? `, path ${path}` : ""}`);
    return;
  }
  const res = await runBrowserViewers({
    web, slug: f.slug, keys, steps,
    rampMs: parseDuration(f.ramp, 60_000),
    holdMs: parseDuration(f.hold, 600_000),
    path,
    throttle,
    throttleShare: numFlag(f.throttleShare, 0, "throttle-share"),
    perChrome: intFlag(f.perChrome, 10, "per-chrome"),
    maxCpu: numFlag(f.maxCpu, 70, "max-cpu"),
    sampleMs: parseDuration(f.sample, 5000),
    region: typeof f.region === "string" ? f.region : "",
    api,
    chatProbeAt: f.chatProbeAt ? Number(f.chatProbeAt) : null,
    probe: f.probe !== false,
  });
  const rep = report(res.viewers, { target: res.target });
  const out = f.out || `results/browser-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeResults(out, { tool: "browser-viewers", generator: typeof f.generator === "string" ? f.generator : null, web, slug: f.slug, path, ...res, report: rep });
  if (!f.generator) {
    const md = markdown(rep);
    writeFileSync(out.replace(/\.json$/, ".md"), md);
    console.log("\n" + md);
  }
  console.log(`results: ${out}`);
}

if (process.argv[1] === SELF) {
  main().catch((e) => {
    console.error(`${stamp()} ${e.message}`);
    process.exit(1);
  });
}
