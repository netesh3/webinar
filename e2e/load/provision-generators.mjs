#!/usr/bin/env node
/* Load-generator droplets, one per region in a plan (lib/provision.mjs, docs/LOAD-TESTING.md).
 *
 *   node provision-generators.mjs --regions world --run lt1            # plan only (default)
 *   node provision-generators.mjs --regions blr1,blr1,sgp1 --run lt1 --ssh-keys <id> --create
 *   node provision-generators.mjs --run lt1 --destroy                  # delete them by tag
 *
 * Each is a stock Ubuntu 24.04 c-4 with setup-generator.sh as user data, so any region works.
 * It refuses a plan the account's droplet limit can't take with the video and captions boxes
 * still to come up (doctl account get). After --create it prints the run.mjs flags:
 *   --generators <ip,ip,...> --generator-regions <r,r,...> --generator-kit /opt/loadgen/e2e/load
 *
 *   --regions LIST    region slugs, a JSON array, or "world" (blr1 x3, sgp1, lon1, nyc3, sfo3)
 *   --size c-4        droplet size (c-8 is refused on this account)
 *   --hours N         for the cost line (default 2)
 *   --run ID          names and the tag loadgen-<run>
 *   --ssh-keys IDS    doctl ssh key id(s) or fingerprint(s), comma-separated (needed with --create)
 *   --create          actually create them (billable: c-4 is $0.125/h each)
 *   --destroy         delete every droplet tagged loadgen-<run>
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, intFlag, stamp } from "./lib/args.mjs";
import { parseRegions, checkDropletLimit, dropletNames, createArgs, costEstimate, accountDroplets, createDroplet, deleteTagged } from "./lib/provision.mjs";

const SELF = fileURLToPath(import.meta.url);

async function main() {
  const f = parseArgs(process.argv.slice(2));
  if (f.help || (!f.regions && !f.destroy)) {
    console.log(readFileSync(SELF, "utf8").split("*/")[0].replace(/^#!.*\n\/\* ?/, ""));
    process.exit(f.help ? 0 : 2);
  }
  const run = typeof f.run === "string" ? f.run : "lt";
  const tag = `loadgen-${run}`;
  if (f.destroy) {
    console.log(`${stamp()} deleting droplets tagged ${tag}`);
    deleteTagged(tag);
    return;
  }
  const regions = parseRegions(f.regions);
  const size = typeof f.size === "string" ? f.size : "c-4";
  const hours = intFlag(f.hours, 2, "hours");
  const names = dropletNames(run, regions);
  const userData = join(dirname(SELF), "setup-generator.sh");
  console.log(`${stamp()} plan: ${regions.length} generator(s) ${size}: ${regions.join(", ")}`);
  console.log(`  cost: about $${costEstimate({ generators: regions.length, hours, perHour: size === "c-4" ? 0.125 : NaN })} for ${hours} h (c-4 $0.125/h each)`);
  let acct = null;
  try {
    acct = accountDroplets();
  } catch (e) {
    console.log(`  droplet limit: could not ask doctl (${e.message.split("\n")[0]}); --create will refuse until it can`);
  }
  if (acct) {
    const why = checkDropletLimit({ limit: acct.limit, existing: acct.existing, adding: regions.length, boxesUp: acct.boxesUp });
    console.log(`  droplets: limit ${acct.limit}, ${acct.existing} now (${acct.boxesUp} of them video/captions boxes)`);
    if (why) {
      console.error(`${stamp()} refused: ${why}`);
      process.exit(1);
    }
  }
  for (const [i, r] of regions.entries()) console.log(`  doctl ${createArgs({ name: names[i], region: r, size, sshKeys: "<ids>", userDataFile: userData, tag }).join(" ")}`);
  if (!f.create) {
    console.log(`${stamp()} plan only: nothing created (add --create --ssh-keys <ids> to make them)`);
    return;
  }
  if (!acct) throw new Error("refusing --create: the droplet limit could not be checked");
  if (!f.sshKeys || f.sshKeys === true) throw new Error("--create needs --ssh-keys (doctl compute ssh-key list)");
  const made = [];
  for (const [i, r] of regions.entries()) {
    console.log(`${stamp()} creating ${names[i]} in ${r}`);
    made.push(createDroplet({ name: names[i], region: r, size, sshKeys: String(f.sshKeys), userDataFile: userData, tag }));
  }
  console.log(`\n${stamp()} ${made.length} generator(s) up; setup-generator.sh takes ~3-5 min on each. Then:\n` +
    `  node run.mjs ... --viewers browser --generators ${made.map((m) => m.ip).join(",")} --generator-regions ${made.map((m) => m.region).join(",")} ` +
    `--generator-kit /opt/loadgen/e2e/load\n  and afterwards: node provision-generators.mjs --run ${run} --destroy`);
}

if (process.argv[1] === SELF) {
  main().catch((e) => {
    console.error(`${stamp()} ${e.message}`);
    process.exit(1);
  });
}
