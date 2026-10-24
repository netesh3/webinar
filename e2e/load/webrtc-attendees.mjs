#!/usr/bin/env node
/* WebRTC attendees for a cloud generator: flags around e2e/probe-load.mjs, which does the work
 * (N headless Chrome tabs, real join path, per-tab inbound video stats, stepping).
 *
 *   node webrtc-attendees.mjs --web <origin> --steps 5,10,25 --hold 60s [--kind meeting]
 *   node webrtc-attendees.mjs --web <origin> --slug <live slug> --keys keys.json --steps 10,50
 *
 *   --kind meeting     a meeting: every tab is on the stage, camera on and mic muted, through the
 *                      lobby (knock, host admits all). The 10-person meeting test is
 *                      `--kind meeting --steps 9` (host + 9 = the default cap of 10).
 *   --kind webinar     (default) a webinar's audience over WebRTC: only on a server where the
 *                      webinar is standard delivery. On the DigitalOcean box every webinar is edge
 *                      (LL-HLS), so measure that audience with hls-viewers.mjs instead.
 *   --slug/--keys      join a session that is already live (run.mjs) instead of making one
 *   --api URL, --out FILE, --cdp-port N, --dry-run, --i-know-this-is-prod
 *
 * Needs PROBE_ADMIN_EMAIL / PROBE_ADMIN_PASSWORD unless --slug is given. Rough sizing: a c-16
 * droplet holds 50-100 tabs of 720p video; watch the WARNING lines, which say when the tabs, not
 * the server, ran out.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parseArgs, parseDuration, parseSteps } from "./lib/args.mjs";
import { apiBase, assertSafeTarget } from "./lib/client.mjs";

const SELF = fileURLToPath(import.meta.url);
const PROBE = join(dirname(SELF), "..", "probe-load.mjs");

/** The probe-load command line and environment for these options. */
export function probeCommand(o) {
  const steps = o.steps.join(",");
  const env = {
    ...process.env,
    PROBE_STEPS: steps,
    PROBE_KIND: o.kind || "webinar",
    PROBE_DELIVERY: o.delivery || "standard",
    PROBE_API: o.api,
    ...(o.slug ? { PROBE_SLUG: o.slug, PROBE_KEYS_FILE: resolve(o.keysFile) } : {}),
    ...(o.out ? { PROBE_JSON: resolve(o.out) } : {}),
    ...(o.cdpPort ? { PROBE_CDP_PORT: String(o.cdpPort) } : {}),
  };
  const args = [PROBE, o.web, String(o.steps[o.steps.length - 1]), String(Math.round(o.holdMs / 1000))];
  return { args, env };
}

/** Runs probe-load; resolves with its exit code. */
export function runWebrtcAttendees(o) {
  const { args, env } = probeCommand(o);
  return new Promise((res) => {
    const child = spawn(process.execPath, args, { env, stdio: "inherit" });
    o.signal?.addEventListener("abort", () => child.kill("SIGINT"), { once: true });
    child.on("exit", (code) => res(code ?? 1));
  });
}

async function main() {
  const f = parseArgs(process.argv.slice(2));
  if (f.help || !f.web) {
    console.log(readFileSync(SELF, "utf8").split("*/")[0].replace(/^#!.*\n\/\* ?/, ""));
    process.exit(f.help ? 0 : 2);
  }
  const api = apiBase(f.web, f);
  assertSafeTarget([f.web, api], f);
  const o = {
    web: String(f.web).replace(/\/$/, ""),
    api,
    steps: parseSteps(f.steps ?? f.tabs, [5]),
    holdMs: parseDuration(f.hold, 60_000),
    kind: f.kind,
    delivery: f.delivery,
    slug: f.slug,
    keysFile: f.keys,
    out: f.out,
    cdpPort: f.cdpPort,
  };
  if (o.slug && !o.keysFile) throw new Error("--slug needs --keys");
  if (o.steps[o.steps.length - 1] > 200) throw new Error("more than 200 tabs on one generator measures the generator, not the server");
  if (f.dryRun) {
    const { args, env } = probeCommand(o);
    console.log(`dry run: node ${args.join(" ")}`);
    for (const k of Object.keys(env).filter((k) => k.startsWith("PROBE_") && !k.includes("PASSWORD"))) console.log(`  ${k}=${env[k]}`);
    return;
  }
  process.exit(await runWebrtcAttendees(o));
}

if (process.argv[1] === SELF) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
