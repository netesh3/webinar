/* Generator droplets around the world (provision-generators.mjs, docs/LOAD-TESTING.md).
 *
 * A generator is a stock Ubuntu 24.04 droplet with setup-generator.sh as its user data, so
 * one can start in any DigitalOcean region: no custom snapshot to copy between regions.
 * Everything here is pure except the doctl calls at the bottom, which only run when asked. */
import { execFileSync } from "node:child_process";

/* The droplets a test brings up besides the generators: the video box and its captions box,
 * both on demand, so possibly not running yet when the generators are made. The third, the ops
 * droplet (the tick, the box's parked IP), is always up and so already in `existing`. With the
 * 10-droplet limit that leaves 7 generators. */
export const RESERVED_DROPLETS = 2;

/* A worldwide plan for 7 generators (10 droplets minus the ops droplet and the 2 boxes): most in
 * India, where most viewers are and the box serves them directly, and one in each region the
 * CDN serves from for everyone else. */
export const WORLD_PLAN = ["blr1", "blr1", "blr1", "sgp1", "lon1", "nyc3", "sfo3"];

export const DO_REGIONS = new Set(["nyc1", "nyc2", "nyc3", "sfo1", "sfo2", "sfo3", "ams2", "ams3", "sgp1", "lon1", "fra1", "tor1", "blr1", "syd1", "atl1"]);

/** "blr1,blr1,sgp1" or a JSON array -> ["blr1","blr1","sgp1"], every one a known region. */
export function parseRegions(v) {
  if (v === undefined || v === true || v === "") return [];
  let list;
  const s = String(v).trim();
  if (s.startsWith("[")) list = JSON.parse(s);
  else if (s === "world") list = WORLD_PLAN;
  else list = s.split(",");
  list = list.map((r) => String(r).trim().toLowerCase()).filter(Boolean);
  const bad = list.filter((r) => !DO_REGIONS.has(r));
  if (bad.length) throw new Error(`unknown DigitalOcean region(s): ${bad.join(", ")} (one of ${[...DO_REGIONS].join(", ")})`);
  return list;
}

/* checkDropletLimit({ limit, existing, adding, reserved }) -> null when it fits, else why not.
 * `existing` is what the account runs now (the video and captions boxes may be down between
 * tests and come up during one, so `reserved` is kept free for them). */
export function checkDropletLimit({ limit, existing, adding, reserved = RESERVED_DROPLETS, boxesUp = 0 }) {
  // Boxes already up are in `existing`; keep room only for the ones still to come up.
  const room = limit - existing - Math.max(0, reserved - boxesUp);
  if (adding <= room) return null;
  return `${adding} generator(s) need ${adding} droplet(s), but the account allows ${limit}: ${existing} exist now and ` +
    `${Math.max(0, reserved - boxesUp)} more are kept for the video and captions boxes, so ${Math.max(0, room)} can be added`;
}

/** Names for the plan: loadgen-<run>-<n>-<region>. */
export function dropletNames(run, regions) {
  return regions.map((r, i) => `loadgen-${run}-${i + 1}-${r}`);
}

/** The doctl create command for one generator (argv), stock image + cloud-init. */
export function createArgs({ name, region, size = "c-4", sshKeys, userDataFile, tag = "loadgen" }) {
  return ["compute", "droplet", "create", name, "--region", region, "--size", size, "--image", "ubuntu-24-04-x64",
    "--ssh-keys", sshKeys, "--tag-names", tag, "--user-data-file", userDataFile, "--wait", "--format", "ID,Name,PublicIPv4,Region", "--no-header"];
}

/* Cost: c-4 at $0.125/h, billed by the hour actually up (DigitalOcean bills per second with a
 * minimum; hours here are rounded up to be safe). */
export function costEstimate({ generators, hours, perHour = 0.125 }) {
  return Math.round(generators * Math.ceil(hours) * perHour * 100) / 100;
}

/* ---- doctl ---- */

const doctl = (args) => execFileSync("doctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** { limit, existing, boxesUp } from the account (doctl must be authenticated). */
export function accountDroplets() {
  const acct = JSON.parse(doctl(["account", "get", "-o", "json"]));
  const a = Array.isArray(acct) ? acct[0] : acct;
  const list = JSON.parse(doctl(["compute", "droplet", "list", "-o", "json"]) || "[]");
  const tags = (d) => d.tags ?? [];
  const boxesUp = list.filter((d) => tags(d).some((t) => /^webinar-(sfu|captions)/.test(t))).length;
  return { limit: a.droplet_limit, existing: list.length, boxesUp };
}

export function createDroplet(opts) {
  const line = doctl(createArgs(opts)).trim().split("\n").pop() ?? "";
  const [id, name, ip, region] = line.trim().split(/\s+/);
  return { id, name, ip, region };
}

export function deleteTagged(tag) {
  return doctl(["compute", "droplet", "delete", "--tag-name", tag, "--force"]);
}
