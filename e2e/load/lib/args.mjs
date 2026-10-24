/* Flag parsing shared by the load-test tools. No dependencies: the kit runs on a fresh droplet
 * with nothing but Node 22.
 *
 *   --steps 50,200,500   --hold 120s   --ramp 30s   --flag   --no-flag   --key=value
 */

/** parseArgs(argv) -> { _: positional[], key: value|true } (keys camelCased). */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    let key = a.slice(2);
    let val;
    const eq = key.indexOf("=");
    if (eq >= 0) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (key.startsWith("no-")) {
      out[camel(key.slice(3))] = false;
      continue;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      val = argv[++i];
    } else {
      val = true;
    }
    out[camel(key)] = val;
  }
  return out;
}

function camel(s) {
  return s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** Duration in ms: "120s", "2m", "500ms", "1h", "90" (seconds). Throws on nonsense. */
export function parseDuration(v, def) {
  if (v === undefined || v === null || v === true || v === "") {
    if (def === undefined) throw new Error("missing duration");
    return def;
  }
  if (typeof v === "number") return v * 1000;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(v).trim());
  if (!m) throw new Error(`not a duration: ${v} (use e.g. 500ms, 30s, 2m)`);
  const n = Number(m[1]);
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "s"];
  return Math.round(n * mult);
}

/** "50,200,500" -> [50, 200, 500]: positive integers, strictly increasing (or, with
 * { flat: true }, never decreasing: a generator's share of a step may stay the same). */
export function parseSteps(v, def = [10], { flat = false } = {}) {
  if (v === undefined || v === true || v === "") return def;
  const steps = String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 0) throw new Error(`not a step count: ${s}`);
      return n;
    });
  if (!steps.length) throw new Error("no steps");
  for (let i = 1; i < steps.length; i++) {
    if (steps[i] < steps[i - 1] || (!flat && steps[i] === steps[i - 1])) throw new Error(`steps must increase: ${steps.join(",")}`);
  }
  return steps;
}

/** Non-negative integer flag with a default. */
export function intFlag(v, def, name = "value") {
  if (v === undefined || v === true || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer, got ${v}`);
  return n;
}

/** Number flag (may be fractional) with a default. */
export function numFlag(v, def, name = "value") {
  if (v === undefined || v === true || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number, got ${v}`);
  return n;
}

/* The ramp: going from `from` to `to` clients over `rampMs`, the times (ms from the start of the
 * step) at which each new client starts. Evenly spaced; a zero ramp starts them all at once. */
export function rampSchedule(from, to, rampMs) {
  const n = Math.max(0, to - from);
  const out = [];
  for (let i = 0; i < n; i++) out.push(n <= 1 || rampMs <= 0 ? 0 : Math.round((rampMs * i) / (n - 1)));
  return out;
}

/** sleep(ms, signal?): resolves after ms, or as soon as the signal aborts. */
export const sleep = (ms, signal) =>
  new Promise((r) => {
    if (signal?.aborted) return r();
    const t = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      r();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
export const stamp = () => new Date().toISOString().slice(11, 19);
