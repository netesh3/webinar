/* Other generator droplets, driven over SSH (run.mjs --generators h1,h2): each gets the kit, the
 * extra seats and its own slice of them (--from) and steps, starts hls-viewers.mjs at the same
 * instant as this generator (--start-at), and hands its results JSON back to be merged into the
 * summary step by step (docs/LOAD-TESTING.md).
 *
 *   ssh <user@>host (root@ by default), key from SSH_KEY (else ssh's own defaults), BatchMode:
 *   no password prompts. The kit is shipped as a tarball of e2e/load to /tmp/loadkit-<run>,
 *   unless --generator-kit DIR names one already there (e.g. /opt/loadgen/e2e/load from
 *   setup-generator.sh). Each generator needs Node 22. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { share } from "./steps.mjs";
import { mergeDumps, round } from "./stats.mjs";
import { stamp } from "./args.mjs";

/* generatorPlan(extra, extraSteps, hosts) -> [{ host, from, count, steps }]: generator g takes
 * keys-extra.json[from, from+count) and runs its share of every step. Its steps may repeat a
 * count (a share does not always grow), which hls-viewers accepts with --generator. */
export function generatorPlan(extra, extraSteps, hosts) {
  const out = [];
  let from = 0;
  for (const [g, host] of hosts.entries()) {
    const count = share(extra, hosts.length, g);
    const steps = extraSteps.map((n) => share(n, hosts.length, g));
    if (steps[steps.length - 1] !== count) steps[steps.length - 1] = count;
    out.push({ host, from, count, steps });
    from += count;
  }
  if (out.some((x) => x.count === 0)) throw new Error(`${extra} extra seat(s) cannot be split over ${hosts.length} generators: give each at least one`);
  return out;
}

/** "a,b" -> ["root@a", "root@b"]; a host that names its user keeps it. */
export function parseHosts(v) {
  if (!v || v === true) return [];
  return String(v)
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => (h.includes("@") ? h : `root@${h}`));
}

/* A dump's reservoirs, thinned to at most `cap` values per latency, so results.json stays a
 * reasonable size while another run can still merge it with mergeDumps. */
export function compactDump(d, cap = 4000) {
  const lat = {};
  for (const [k, v] of Object.entries(d.lat ?? {})) {
    const step = Math.max(1, Math.ceil(v.values.length / cap));
    lat[k] = { ...v, values: step === 1 ? v.values : v.values.filter((_, i) => i % step === 0) };
  }
  return { ...d, lat };
}

const GENERATOR_LOCAL = ["cpuPct", "maxLoopDelayP99Ms"];

/* mergeGeneratorSteps(parts) -> [stepJSON]: parts are [{ label, steps: [stepJSON], dumps?: [dump] }],
 * this generator first. Step i of the result is step i of every part together: counts, bytes,
 * active and the rest added up, percentiles from the merged reservoirs when every part sent
 * dumps (else the worst part's, marked approx). The generators' own CPU and event-loop gauges
 * do not add up into anything meaningful: they are kept per generator, under `generators`. */
export function mergeGeneratorSteps(parts) {
  const live = parts.filter((p) => p?.steps?.length);
  if (!live.length) return [];
  const n = Math.max(...live.map((p) => p.steps.length));
  const out = [];
  for (let i = 0; i < n; i++) {
    const here = live.filter((p) => p.steps[i]);
    const target = here.reduce((a, p) => a + (p.steps[i].target ?? 0), 0);
    let j;
    if (here.every((p) => p.dumps?.[i])) {
      j = mergeDumps(`step ${i + 1}`, target, here.map((p) => p.dumps[i])).toJSON();
    } else {
      j = approxMerge(`step ${i + 1}`, target, here.map((p) => p.steps[i]));
    }
    for (const k of GENERATOR_LOCAL) delete j[k];
    j.generators = here.map((p) => ({
      label: p.label,
      target: p.steps[i].target,
      active: p.steps[i].active,
      mbps: p.steps[i].mbps,
      cpuPct: p.steps[i].cpuPct,
      maxLoopDelayP99Ms: p.steps[i].maxLoopDelayP99Ms,
    }));
    out.push(j);
  }
  return out;
}

function approxMerge(name, target, steps) {
  const sumMap = (key) => {
    const m = {};
    for (const s of steps) for (const [k, v] of Object.entries(s[key] ?? {})) m[k] = (m[k] ?? 0) + v;
    return m;
  };
  const lat = {};
  for (const s of steps) {
    for (const [k, v] of Object.entries(s.latencyMs ?? {})) {
      const cur = lat[k];
      if (!cur) lat[k] = { ...v };
      else {
        const count = cur.count + v.count;
        lat[k] = {
          count,
          avg: count ? round((cur.avg * cur.count + v.avg * v.count) / count) : 0,
          p50: Math.max(cur.p50, v.p50),
          p95: Math.max(cur.p95, v.p95),
          p99: Math.max(cur.p99, v.p99),
          max: Math.max(cur.max, v.max),
        };
      }
    }
  }
  const out = {
    name,
    target,
    approx: true,
    startedAt: steps.map((s) => s.startedAt).sort()[0],
    seconds: Math.max(...steps.map((s) => s.seconds ?? 0)),
    counts: sumMap("counts"),
    errors: sumMap("errors"),
    latencyMs: lat,
    bytes: steps.reduce((a, s) => a + (s.bytes ?? 0), 0),
    mbps: round(steps.reduce((a, s) => a + (s.mbps ?? 0), 0), 2),
  };
  // Gauges: numbers add up (active, stalledNow, eventsOpen, clients), as mergeDumps does.
  const fixed = new Set(Object.keys(out));
  for (const s of steps) {
    for (const [k, v] of Object.entries(s)) {
      if (fixed.has(k) || typeof v !== "number") continue;
      if (k.startsWith("max")) out[k] = Math.max(out[k] ?? 0, v);
      else out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}

/* ---- SSH ---- */

export function sshArgs(host, key = process.env.SSH_KEY) {
  return [
    ...(key ? ["-i", key] : []),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=30",
    host,
  ];
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Runs `cmd` on host. Resolves { code, stdout } (stdout kept when keep), lines streamed to onLine. */
export function ssh(host, cmd, { input, keep = false, onLine, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...sshArgs(host), cmd], { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    let out = "";
    let buf = "";
    const line = (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine?.(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    };
    child.stdout.on("data", (c) => (keep ? (out += c) : line(String(c))));
    child.stderr.on("data", (c) => line(String(c)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (buf) onLine?.(buf);
      resolve({ code, stdout: out });
    });
    if (input) {
      if (typeof input === "string" || Buffer.isBuffer(input)) child.stdin.end(input);
      else input.pipe(child.stdin);
    }
    signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  });
}

/* startGenerators(o) -> Promise<[{ host, ok, result?, error? }]>, resolved when every generator
 * has finished. o: { gens: generatorPlan(), kitDir (this e2e/load), remoteKit (optional), run,
 * keysFile, viewerArgs: [...] (shared hls-viewers flags), startAt, log, signal }.
 * Preparation (kit, keys) happens before `ready` resolves, so the caller can wait for it
 * before the shared start time. */
export function startGenerators(o) {
  const log = o.log ?? console.log;
  const keys = readFileSync(o.keysFile);
  // Per generator, so one host listed twice (a big box running two slices) does not collide.
  const where = o.gens.map((g, i) => {
    const tag = `${o.run}-${i + 1}`;
    const base = o.remoteKit ? null : `/tmp/loadkit-${tag}`;
    return { tag, base, kit: o.remoteKit ?? `${base}/load` };
  });
  const prepared = o.gens.map(async (g, i) => {
    const { tag, base, kit } = where[i];
    if (base) {
      // A tarball of this e2e/load (without results/), unpacked as /tmp/loadkit-<run>-<n>/load.
      const tar = spawn("tar", ["-C", o.kitDir, "--exclude", "./results", "-cz", "."], {
        stdio: ["ignore", "pipe", "inherit"],
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      });
      const r = await ssh(g.host, `rm -rf ${shq(base)} && mkdir -p ${shq(kit)} && tar -xzf - -C ${shq(kit)} 2>/dev/null; test -f ${shq(`${kit}/hls-viewers.mjs`)}`, { input: tar.stdout });
      if (r.code !== 0) throw new Error(`${g.host}: could not copy the kit (ssh exit ${r.code})`);
    }
    const k = await ssh(g.host, `cat > ${shq(`${kit}/keys-extra-${tag}.json`)} && node -v`, { input: keys, keep: true });
    if (k.code !== 0) throw new Error(`${g.host}: could not copy the seats (ssh exit ${k.code})`);
    if (!/^v(2[2-9]|[3-9]\d)\./.test(k.stdout.trim())) log(`${stamp()} WARNING generator ${g.host} runs node ${k.stdout.trim() || "?"}; the kit wants Node 22`);
    log(`${stamp()} generator ${g.host}: kit and seats ready (${g.count} viewers from seat ${g.from}, steps ${g.steps.join(",")})`);
    return g;
  });
  const ready = Promise.allSettled(prepared);
  const done = ready.then((settled) =>
    Promise.all(
      settled.map(async (s, i) => {
        const g = o.gens[i];
        const { tag, base, kit } = where[i];
        if (s.status === "rejected") return { host: g.host, ok: false, error: s.reason?.message ?? String(s.reason) };
        const out = `${kit}/gen-${tag}.json`;
        const cmd =
          `cd ${shq(kit)} && { ulimit -n 1048576 2>/dev/null || true; } && exec node hls-viewers.mjs ` +
          [...o.viewerArgs, "--keys", `keys-extra-${tag}.json`, "--from", String(g.from), "--steps", g.steps.join(","), "--generator", g.host,
            "--max-viewers", String(g.count), "--start-at", String(o.startAt), "--out", out].map(shq).join(" ");
        const r = await ssh(g.host, cmd, { onLine: (l) => l.trim() && log(`[${g.host}] ${l}`), signal: o.signal });
        // Interrupted: closing ssh does not reliably stop the remote node; this does.
        if (o.signal?.aborted) await ssh(g.host, `pkill -f ${shq(`gen-${tag}.json`)} || true`).catch(() => {});
        const got = await ssh(g.host, `cat ${shq(out)}`, { keep: true }).catch(() => ({ code: 1, stdout: "" }));
        if (base) await ssh(g.host, `rm -rf ${shq(base)}`).catch(() => {});
        else await ssh(g.host, `rm -f ${shq(`${kit}/keys-extra-${tag}.json`)} ${shq(out)}`).catch(() => {});
        try {
          return { host: g.host, ok: r.code === 0, exit: r.code, result: JSON.parse(got.stdout) };
        } catch {
          return { host: g.host, ok: false, exit: r.code, error: `no results from ${g.host} (exit ${r.code})` };
        }
      }),
    ),
  );
  return { ready, done };
}
