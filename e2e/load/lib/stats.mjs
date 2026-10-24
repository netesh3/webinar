/* Measurement helpers: latency samples with percentiles, counters by key, and a per-step
 * recorder the tools share so their JSON results look the same. */

/** Percentile (0-100) of a numeric array, nearest-rank. 0 for an empty array. */
export function percentile(values, p) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))];
}

/* Samples keeps up to `cap` values by reservoir sampling, so a 1000-viewer hour does not keep
 * millions of numbers, while count/sum/max stay exact. */
export class Samples {
  constructor(cap = 20000) {
    this.cap = cap;
    this.values = [];
    this.count = 0;
    this.sum = 0;
    this.max = 0;
  }
  add(v) {
    if (!Number.isFinite(v)) return;
    this.count++;
    this.sum += v;
    if (v > this.max) this.max = v;
    if (this.values.length < this.cap) this.values.push(v);
    else {
      const j = Math.floor(Math.random() * this.count);
      if (j < this.cap) this.values[j] = v;
    }
  }
  summary() {
    return {
      count: this.count,
      avg: this.count ? round(this.sum / this.count) : 0,
      p50: round(percentile(this.values, 50)),
      p95: round(percentile(this.values, 95)),
      p99: round(percentile(this.values, 99)),
      max: round(this.max),
    };
  }
}

/** Counter by key: inc("404"), inc("timeout"). */
export class Counter {
  constructor() {
    this.map = new Map();
  }
  inc(key, n = 1) {
    this.map.set(String(key), (this.map.get(String(key)) ?? 0) + n);
  }
  get(key) {
    return this.map.get(String(key)) ?? 0;
  }
  total() {
    let t = 0;
    for (const v of this.map.values()) t += v;
    return t;
  }
  toJSON() {
    return Object.fromEntries([...this.map.entries()].sort((a, b) => b[1] - a[1]));
  }
}

export function round(v, digits = 1) {
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}

/* Step is everything measured while one step's client count was held. The tools create one per
 * step, record into it, and close it when the hold ends. */
export class Step {
  constructor(name, target) {
    this.name = name;
    this.target = target;
    this.startedAt = Date.now();
    this.endedAt = 0;
    this.lat = new Map(); // name -> Samples
    this.counts = new Counter(); // ok/fail tallies
    this.errors = new Counter(); // "<what> <status>" -> n
    this.bytes = 0;
    this.gauges = {};
  }
  sample(name, ms) {
    if (!this.lat.has(name)) this.lat.set(name, new Samples());
    this.lat.get(name).add(ms);
  }
  count(name, n = 1) {
    this.counts.inc(name, n);
  }
  error(what, status) {
    this.errors.inc(`${what} ${status}`);
  }
  close() {
    this.endedAt = Date.now();
  }
  toJSON() {
    const secs = Math.max(0.001, ((this.endedAt || Date.now()) - this.startedAt) / 1000);
    const lat = {};
    for (const [k, v] of this.lat) lat[k] = v.summary();
    return {
      name: this.name,
      target: this.target,
      startedAt: new Date(this.startedAt).toISOString(),
      seconds: round(secs),
      counts: this.counts.toJSON(),
      errors: this.errors.toJSON(),
      latencyMs: lat,
      bytes: this.bytes,
      mbps: round((this.bytes * 8) / 1e6 / secs, 2),
      ...this.gauges,
    };
  }
}

/** A plain-text table: rows of objects, columns [key, header]. */
export function table(rows, columns) {
  const cells = rows.map((r) => columns.map(([k]) => fmt(typeof k === "function" ? k(r) : r[k])));
  const widths = columns.map(([, h], i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (vals) => vals.map((v, i) => v.padStart(widths[i])).join("  ");
  return [line(columns.map(([, h]) => h)), line(widths.map((w) => "-".repeat(w))), ...cells.map(line)].join("\n");
}

function fmt(v) {
  if (v === undefined || v === null) return "-";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(1);
  return String(v);
}

/* Workers send their step as a dump (reservoir values included); the parent merges dumps into
 * one step. Percentiles of the merged reservoirs are an approximation, good to a few percent.
 * Numeric gauges add up across workers (active viewers, stalled now). */
export function dumpStep(step) {
  const lat = {};
  for (const [k, v] of step.lat) lat[k] = { values: v.values, count: v.count, sum: v.sum, max: v.max };
  return {
    name: step.name,
    target: step.target,
    startedAt: step.startedAt,
    endedAt: step.endedAt || Date.now(),
    counts: step.counts.toJSON(),
    errors: step.errors.toJSON(),
    lat,
    bytes: step.bytes,
    gauges: step.gauges,
  };
}

export function mergeDumps(name, target, dumps) {
  const st = new Step(name, target);
  if (!dumps.length) return st;
  st.startedAt = Math.min(...dumps.map((d) => d.startedAt));
  st.endedAt = Math.max(...dumps.map((d) => d.endedAt));
  for (const d of dumps) {
    for (const [k, n] of Object.entries(d.counts)) st.counts.inc(k, n);
    for (const [k, n] of Object.entries(d.errors)) st.errors.inc(k, n);
    for (const [k, v] of Object.entries(d.lat)) {
      if (!st.lat.has(k)) st.lat.set(k, new Samples(Number.MAX_SAFE_INTEGER));
      const s = st.lat.get(k);
      for (const x of v.values) s.values.push(x);
      s.count += v.count;
      s.sum += v.sum;
      s.max = Math.max(s.max, v.max);
    }
    st.bytes += d.bytes;
    for (const [k, v] of Object.entries(d.gauges ?? {})) {
      if (typeof v !== "number") st.gauges[k] = v;
      else if (k.startsWith("max")) st.gauges[k] = Math.max(st.gauges[k] ?? 0, v);
      else st.gauges[k] = (st.gauges[k] ?? 0) + v;
    }
  }
  return st;
}
