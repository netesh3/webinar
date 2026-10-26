/* What the browser viewers saw, in numbers (browser-viewers.mjs, docs/LOAD-TESTING.md).
 *
 * Pure functions over the viewers' records, so a run on one generator and the merge of seven
 * across the world are summarised the same way. A viewer record:
 *
 *   { id, region, path, edge, throttle, joined, firstFrameMs, watchMs, stalls, stallMs,
 *     fallbacks, badge, errors, joinApiMs, chatRttMs: [ms],
 *     samples: [[t, waiting(0|1), stalls, latencySec|null], ...],
 *     g2g: [[t, seconds], ...] (glass to glass, read off the mix's time strip) }
 *
 * A stall is the video element waiting for data after it first played: the time the picture
 * stood still. Startup (join to first frame) is reported apart, as time to first frame. A
 * stall wave is a 10 s window in which many viewers stalled at once, which no single viewer's
 * numbers show: it is what the 25 Oct webinar looked like (docs/LOAD-TESTING.md). */

export const WAVE_WINDOW_MS = 10_000;

/* The pass criteria (docs/LOAD-TESTING.md, "Browser viewers"). Tuned plain HLS sits ~3–4 s
 * behind live; p95 under 6 s leaves room for viewers far away or on a slow network. */
export const PASS = {
  joinedShare: 0.98, // of the target viewers reached the first frame
  smoothShare: 0.95, // of the viewers had at most 1 stall per 10 minutes watched
  stallsPer10Min: 1,
  latencyP95Sec: 6, // the player's own latency estimate, when no time strip was read
  waveShare: 0.1, // no 10 s window with more than 10% of the watching viewers stalled
  g2gDirectP95Sec: 6, // glass to glass, read off the picture, straight from the box
  g2gCdnP95Sec: 7, // ... and through the CDN
  firstFrameP95Ms: 5000,
};

export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[i];
}

const round = (x, d = 2) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Stalls per viewer-minute for one viewer (0 for a viewer who never watched). */
export function stallsPerMinute(v) {
  const min = (v.watchMs ?? 0) / 60_000;
  return min > 0 ? (v.stalls ?? 0) / min : 0;
}

/* waves(viewers) -> [{ at, watching, stalled, share }], one per 10 s window anyone watched in.
 * A viewer counts as watching in a window it has a sample in, after its first frame, and as
 * stalled there if any of those samples was waiting or its stall count went up since the
 * sample before. */
export function waves(viewers, windowMs = WAVE_WINDOW_MS) {
  const win = new Map();
  for (const v of viewers) {
    let prev = null;
    for (const s of v.samples ?? []) {
      const [t, waiting, stalls] = s;
      const k = Math.floor(t / windowMs) * windowMs;
      if (!win.has(k)) win.set(k, { watching: new Set(), stalled: new Set() });
      const w = win.get(k);
      w.watching.add(v.id);
      if (waiting || (prev !== null && stalls > prev)) w.stalled.add(v.id);
      prev = stalls;
    }
  }
  return [...win.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([at, w]) => ({ at, watching: w.watching.size, stalled: w.stalled.size, share: w.watching.size ? w.stalled.size / w.watching.size : 0 }));
}

/* summarise(viewers, { target }) -> one row of numbers. `target` is how many viewers were
 * meant to join (defaults to the records given). */
export function summarise(viewers, { target } = {}) {
  const tgt = target ?? viewers.length;
  const joined = viewers.filter((v) => v.firstFrameMs !== null && v.firstFrameMs !== undefined);
  const watched = joined.filter((v) => (v.watchMs ?? 0) > 0);
  const rates = watched.map(stallsPerMinute);
  const smooth = watched.filter((v) => stallsPerMinute(v) * 10 <= PASS.stallsPer10Min);
  const latencies = [];
  for (const v of watched) for (const s of v.samples ?? []) if (Number.isFinite(s[3])) latencies.push(s[3]);
  const g2g = [];
  for (const v of watched) for (const x of v.g2g ?? []) if (Number.isFinite(x[1])) g2g.push(x[1]);
  const chat = viewers.flatMap((v) => v.chatRttMs ?? []);
  const w = waves(watched);
  const worst = w.reduce((m, x) => (x.share > (m?.share ?? -1) ? x : m), null);
  const watchMin = watched.reduce((a, v) => a + (v.watchMs ?? 0), 0) / 60_000;
  const totalStalls = watched.reduce((a, v) => a + (v.stalls ?? 0), 0);
  return {
    target: tgt,
    joined: joined.length,
    joinedShare: tgt ? round(joined.length / tgt, 3) : null,
    firstFrameP50Ms: round(percentile(joined.map((v) => v.firstFrameMs), 50), 0),
    firstFrameP95Ms: round(percentile(joined.map((v) => v.firstFrameMs), 95), 0),
    watchMinutes: round(watchMin, 1),
    stalls: totalStalls,
    stallSeconds: round(watched.reduce((a, v) => a + (v.stallMs ?? 0), 0) / 1000, 1),
    stallsPerViewerMinP50: round(percentile(rates, 50), 3),
    stallsPerViewerMinP95: round(percentile(rates, 95), 3),
    stallsPerViewerMinMax: round(rates.length ? Math.max(...rates) : null, 3),
    zeroStallShare: watched.length ? round(watched.filter((v) => !v.stalls).length / watched.length, 3) : null,
    smoothShare: watched.length ? round(smooth.length / watched.length, 3) : null,
    latencyP50Sec: round(percentile(latencies, 50), 2),
    latencyP95Sec: round(percentile(latencies, 95), 2),
    g2gReads: g2g.length,
    g2gMisses: viewers.reduce((a, v) => a + (v.g2gMisses ?? 0), 0),
    g2gP50Sec: round(percentile(g2g, 50), 2),
    g2gP95Sec: round(percentile(g2g, 95), 2),
    g2gMaxSec: round(g2g.length ? Math.max(...g2g) : null, 2),
    joinApiP50Ms: round(percentile(viewers.map((v) => v.joinApiMs), 50), 0),
    joinApiP95Ms: round(percentile(viewers.map((v) => v.joinApiMs), 95), 0),
    chatRttP50Ms: round(percentile(chat, 50), 0),
    chatRttP95Ms: round(percentile(chat, 95), 0),
    chatDelivered: chat.length,
    worstWave: worst ? { at: new Date(worst.at).toISOString(), stalled: worst.stalled, watching: worst.watching, share: round(worst.share, 3) } : null,
    wavesOver10pct: w.filter((x) => x.share > PASS.waveShare && x.watching >= 5).length,
    fallbacks: viewers.reduce((a, v) => a + (v.fallbacks ?? 0), 0),
    badgeViewers: viewers.filter((v) => v.badge).length,
    errors: viewers.reduce((a, v) => a + (v.errors ?? 0), 0),
    edges: countBy(viewers, (v) => v.edge || "-"),
  };
}

/* inWindow(v, from, to) -> the viewer as it was between from and to (epoch ms): its samples and
 * time-strip reads there, the stalls that began there, the time it watched there. */
export function inWindow(v, from, to) {
  const all = v.samples ?? [];
  const samples = all.filter((s) => s[0] >= from && s[0] < to);
  const before = all.filter((s) => s[0] < from).at(-1);
  const startCount = before ? before[2] : samples[0] ? samples[0][2] - samples[0][1] : 0;
  const stalls = samples.length ? Math.max(0, samples.at(-1)[2] - startCount) : 0;
  return {
    ...v,
    samples,
    g2g: (v.g2g ?? []).filter((x) => x[0] >= from && x[0] < to),
    stalls,
    stallMs: null,
    watchMs: samples.length > 1 ? samples.at(-1)[0] - samples[0][0] : 0,
    firstFrameMs: v.firstFrameMs,
    chatRttMs: [],
  };
}

/** byPhase(viewers, phases) -> [{ group: phase name, from, to, ...summarise() }]. */
export function byPhase(viewers, phases) {
  return (phases ?? []).map((ph) => {
    const from = Date.parse(ph.start);
    const to = Date.parse(ph.end ?? new Date().toISOString());
    const vs = viewers.map((v) => inWindow(v, from, to)).filter((v) => v.samples.length);
    return { group: ph.name, from: ph.start, to: ph.end, ...summarise(vs, { target: viewers.length }) };
  });
}

function countBy(list, key) {
  const out = {};
  for (const x of list) {
    const k = key(x);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/* groups(viewers, key) -> [{ group, ...summarise() }], one per value of key(viewer), largest
 * first. Targets per group are the records in it (each joined attempt is one record). */
export function groups(viewers, key) {
  const by = new Map();
  for (const v of viewers) {
    const k = key(v) || "-";
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(v);
  }
  return [...by.entries()].sort((a, b) => b[1].length - a[1].length).map(([group, list]) => ({ group, ...summarise(list) }));
}

/* report(viewers, { target, phases }) -> { all, byPath, byRegion, byRegionPath, byThrottle,
 * byPhase, cdnLagSec, verdict }. cdnLag is the CDN's glass-to-glass p50 minus the box's. */
export function report(viewers, { target, phases } = {}) {
  const all = summarise(viewers, { target });
  const byPath = groups(viewers, (v) => v.path);
  const direct = byPath.find((g) => g.group === "direct");
  const cdn = byPath.find((g) => g.group === "cdn");
  return {
    all,
    byPath,
    byRegion: groups(viewers, (v) => v.region),
    byRegionPath: groups(viewers, (v) => `${v.region || "-"} / ${v.path || "-"}`),
    byThrottle: groups(viewers, (v) => v.throttle || "none"),
    byPhase: byPhase(viewers, phases),
    cdnLagSec: direct?.g2gP50Sec != null && cdn?.g2gP50Sec != null ? round(cdn.g2gP50Sec - direct.g2gP50Sec, 2) : null,
    verdict: verdict(all, { direct, cdn }),
  };
}

/** verdict(summary, { direct, cdn }) -> [{ name, pass, detail }] against PASS. */
export function verdict(s, { direct, cdn } = {}) {
  const pct = (x) => (x === null ? "-" : `${Math.round(x * 1000) / 10}%`);
  const g2g = (g, max, name) =>
    g && g.g2gReads
      ? [{ name: `glass-to-glass p95, ${name}`, pass: g.g2gP95Sec <= max, detail: `${g.g2gP95Sec} s over ${g.g2gReads} reads (needs <= ${max} s)` }]
      : [];
  return [
    ...g2g(direct, PASS.g2gDirectP95Sec, "straight from the box"),
    ...g2g(cdn, PASS.g2gCdnP95Sec, "through the CDN"),
    { name: "time to first frame p95", pass: s.firstFrameP95Ms !== null && s.firstFrameP95Ms <= PASS.firstFrameP95Ms, detail: `${fmtS(s.firstFrameP95Ms)} s (needs <= ${PASS.firstFrameP95Ms / 1000} s)` },
    { name: "viewers reached the first frame", pass: (s.joinedShare ?? 0) >= PASS.joinedShare, detail: `${s.joined}/${s.target} (${pct(s.joinedShare)}; needs ${pct(PASS.joinedShare)})` },
    { name: `viewers with <= ${PASS.stallsPer10Min} stall per 10 min`, pass: (s.smoothShare ?? 0) >= PASS.smoothShare, detail: `${pct(s.smoothShare)} (needs ${pct(PASS.smoothShare)})` },
    { name: "latency behind live p95", pass: s.latencyP95Sec !== null && s.latencyP95Sec <= PASS.latencyP95Sec, detail: `${s.latencyP95Sec ?? "-"} s (needs <= ${PASS.latencyP95Sec} s)` },
    { name: "no stall wave over 10% of viewers", pass: s.wavesOver10pct === 0, detail: s.worstWave ? `worst ${s.worstWave.stalled}/${s.worstWave.watching} at ${s.worstWave.at}; ${s.wavesOver10pct} window(s) over` : "no samples" },
  ];
}

const COLS = [
  ["group", "group"],
  ["joined", (r) => `${r.joined}/${r.target}`],
  ["first frame p50/p95 s", (r) => `${fmtS(r.firstFrameP50Ms)}/${fmtS(r.firstFrameP95Ms)}`],
  ["stalls/viewer-min p50/p95/max", (r) => `${r.stallsPerViewerMinP50 ?? "-"}/${r.stallsPerViewerMinP95 ?? "-"}/${r.stallsPerViewerMinMax ?? "-"}`],
  ["0 stalls", (r) => pctCell(r.zeroStallShare)],
  ["<=1/10min", (r) => pctCell(r.smoothShare)],
  ["glass-to-glass p50/p95/max s", (r) => `${r.g2gP50Sec ?? "-"}/${r.g2gP95Sec ?? "-"}/${r.g2gMaxSec ?? "-"}`],
  ["player latency p50/p95 s", (r) => `${r.latencyP50Sec ?? "-"}/${r.latencyP95Sec ?? "-"}`],
  ["worst wave", (r) => (r.worstWave ? `${r.worstWave.stalled}/${r.worstWave.watching}` : "-")],
  ["fallbacks", "fallbacks"],
  ["errors", "errors"],
];
const fmtS = (ms) => (ms === null || ms === undefined ? "-" : (ms / 1000).toFixed(1));
const pctCell = (x) => (x === null || x === undefined ? "-" : `${Math.round(x * 1000) / 10}%`);

/** markdown(rep) -> the run's browser-viewer section, tables in the style of the run reports. */
export function markdown(rep) {
  const t = (rows) => {
    const head = `| ${COLS.map((c) => c[0]).join(" | ")} |\n|${COLS.map(() => "---").join("|")}|`;
    const body = rows.map((r) => `| ${COLS.map(([, k]) => (typeof k === "function" ? k(r) : r[k] ?? "-")).join(" | ")} |`);
    return [head, ...body].join("\n");
  };
  const v = rep.verdict.map((c) => `| ${c.pass ? "PASS" : "FAIL"} | ${c.name} | ${c.detail} |`).join("\n");
  return [
    "## Browser viewers",
    "",
    `| verdict | check | result |\n|---|---|---|\n${v}`,
    "",
    "### All viewers",
    t([{ group: "all", ...rep.all }]),
    "",
    "### By delivery path",
    t(rep.byPath),
    "",
    "### By generator region and path",
    t(rep.byRegionPath),
    "",
    "### By network profile",
    t(rep.byThrottle),
    "",
    ...(rep.byPhase?.length ? ["### By phase", t(rep.byPhase), ""] : []),
    `CDN lag (glass-to-glass p50, CDN minus box): ${rep.cdnLagSec ?? "-"} s. ` +
      `Join API p50/p95: ${rep.all.joinApiP50Ms ?? "-"}/${rep.all.joinApiP95Ms ?? "-"} ms. ` +
      `Chat round trip to viewers p50/p95: ${rep.all.chatRttP50Ms ?? "-"}/${rep.all.chatRttP95Ms ?? "-"} ms (${rep.all.chatDelivered} deliveries).`,
    "",
    `CDN edges seen: ${Object.entries(rep.all.edges).map(([k, n]) => `${k} (${n})`).join(", ") || "-"}`,
    "",
  ].join("\n");
}
