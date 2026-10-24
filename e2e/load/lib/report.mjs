/* Per-step summary tables and the JSON results file. */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { table } from "./stats.mjs";

const lat = (s, name, p) => s.latencyMs?.[name]?.[p];
const media = (s, p) => lat(s, "part", p) ?? lat(s, "segment", p);
const topErrors = (s, n = 3) =>
  Object.entries(s.errors ?? {})
    .slice(0, n)
    .map(([k, v]) => `${k}x${v}`)
    .join(" ") || "-";

export function hlsTable(steps) {
  return table(steps, [
    ["name", "step"],
    ["target", "target"],
    [(s) => s.active, "active"],
    [(s) => s.counts?.joinOk ?? 0, "joinOk"],
    [(s) => s.counts?.joinFail ?? 0, "joinFail"],
    [(s) => lat(s, "join", "p95"), "join95"],
    [(s) => media(s, "p50"), "media50"],
    [(s) => media(s, "p95"), "media95"],
    [(s) => media(s, "p99"), "media99"],
    [(s) => lat(s, "playlist", "p95") ?? lat(s, "playlistBlocking", "p95"), "pl95"],
    [(s) => s.counts?.stall ?? 0, "stalls"],
    [(s) => s.stalledNow, "stalledNow"],
    [(s) => (lat(s, "liveLatency", "p50") ?? 0) / 1000, "live50s"],
    [(s) => (lat(s, "liveLatency", "p95") ?? 0) / 1000, "live95s"],
    [(s) => s.eventsOpen, "sseOpen"],
    [(s) => s.counts?.beatFail ?? 0, "beatFail"],
    ["mbps", "Mbit/s"],
    [(s) => s.cpuPct, "cpu%"],
    [(s) => s.maxLoopDelayP99Ms, "loop99"],
    [(s) => topErrors(s), "errors"],
  ]);
}

export function apiTable(steps) {
  return table(steps, [
    ["name", "step"],
    ["target", "rate"],
    ...["register", "join", "chat", "question", "upvote", "vote", "events"].flatMap((k) => [
      [(s) => s.counts?.[`${k}Ok`] ?? 0, `${k}Ok`],
      [(s) => lat(s, k, "p95"), `${k}95`],
    ]),
    [(s) => topErrors(s, 4), "errors"],
  ]);
}

/* Generator-bound warnings: when the numbers say the load generator, not the server, ran out. */
export function generatorWarnings(s, { cores } = {}) {
  const out = [];
  if ((s.maxLoopDelayP99Ms ?? 0) > 200) {
    out.push(`event loop p99 ${s.maxLoopDelayP99Ms} ms: the generator is CPU-bound; latencies are inflated. Add --workers or a bigger droplet.`);
  }
  if (cores && (s.cpuPct ?? 0) > cores * 85) {
    out.push(`generator CPU ${s.cpuPct}% of ${cores * 100}%: results past this step are generator-bound.`);
  }
  return out;
}

export function writeResults(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
}
