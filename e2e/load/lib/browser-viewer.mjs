/* Real-browser viewers (browser-viewers.mjs): headless Chrome tabs that join a webinar as
 * attendees through the real room page and play the stream with the production player.
 *
 * Why: the kit's simulated viewers (lib/viewer.mjs) fetch HLS the way hls.js would and model
 * a buffer. They proved the server's capacity on 24 Oct, and a customer webinar stalled the
 * next day. These viewers decode real video in real Chromium, so what they report is what a
 * person in front of that page would have seen.
 *
 * Each tab gets an init script, before the app loads, that:
 *   - defines window.__LOAD_PROBE__ (web/lib/load-probe.ts): the edge player writes its
 *     latency, path, URL, fallbacks and badge there every second, and reads `preferPath`;
 *   - watches every <video> for the time it stood waiting after it first played (a stall),
 *     the first frame, and media errors (window.__LOAD_WATCH__).
 * The kit samples both every few seconds over the DevTools protocol. Nothing else in the page
 * is changed: no extensions, no request interception, real decoding (audio muted). */
import { launchChrome, attach, newWindow, browserWsUrl, clickButton } from "./chrome.mjs";
import { readFileSync } from "node:fs";
import { READ_STRIP, decodeClock } from "./clock-strip.mjs";
import { cpus } from "node:os";

const sleep = (ms, signal) =>
  new Promise((r) => {
    const t = setTimeout(r, Math.max(0, ms));
    signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });

/* Network shapes for a share of the viewers, to look like phones (Chrome DevTools presets,
 * plus a little loss on Slow 4G; packetLoss is a percentage, honoured by recent Chrome). */
export const NETWORK_PROFILES = {
  fast4g: { latency: 60, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8, packetLoss: 0 },
  slow4g: { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, packetLoss: 1 },
};

/** The script run in every tab before the app (see the header). */
export function initScript({ preferPath } = {}) {
  return `
(() => {
  window.__LOAD_PROBE__ = ${JSON.stringify(preferPath ? { preferPath } : {})};
  const w = window.__LOAD_WATCH__ = { stalls: 0, stallMs: 0, waitingSince: null, firstFrameAt: null, played: false, errors: 0, badge: false, marks: {} };
  /* Chat round trip: the kit posts messages tagged LOADMARK-<id> (browser-viewers.mjs); note when
   * each first arrives on any of the page's event streams, whatever event name carries it. */
  const NativeES = window.EventSource;
  if (NativeES) {
    const mark = (e) => {
      const d = e && e.data;
      if (typeof d !== 'string' || d.indexOf('LOADMARK-') < 0) return;
      for (const k of d.match(/LOADMARK-[a-z0-9]+/g) || []) if (!(k in w.marks)) w.marks[k] = Date.now();
    };
    window.EventSource = function (url, opts) {
      const es = new NativeES(url, opts);
      const seen = new Set(['message']);
      es.addEventListener('message', mark);
      const add = es.addEventListener.bind(es);
      es.addEventListener = (type, fn, o) => {
        if (!seen.has(type)) { seen.add(type); add(type, mark); }
        return add(type, fn, o);
      };
      return es;
    };
    window.EventSource.prototype = NativeES.prototype;
    Object.assign(window.EventSource, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
  }
  const now = () => Date.now();
  const isVideo = (e) => e.target && e.target.tagName === 'VIDEO';
  document.addEventListener('playing', (e) => {
    if (!isVideo(e)) return;
    if (!w.played) { w.played = true; w.firstFrameAt = now(); }
    if (w.waitingSince !== null) { w.stalls++; w.stallMs += now() - w.waitingSince; w.waitingSince = null; }
  }, true);
  document.addEventListener('waiting', (e) => {
    if (!isVideo(e) || !w.played || w.waitingSince !== null) return;
    w.waitingSince = now();
  }, true);
  document.addEventListener('error', (e) => { if (isVideo(e)) w.errors++; }, true);
})();`;
}

/* The sample expression: one snapshot of the tab. A stall in progress counts its time so far
 * (and is "waiting"), so a viewer frozen at the end of a run is not reported as smooth. */
export const SAMPLE = `(() => {
  const w = window.__LOAD_WATCH__ || {};
  const p = (window.__LOAD_PROBE__ && window.__LOAD_PROBE__.state) || {};
  const now = Date.now();
  const waiting = w.waitingSince !== null && w.waitingSince !== undefined;
  const badge = !!p.reconnecting;
  if (badge) w.badge = true;
  const vids = [...document.querySelectorAll('video')];
  const v = vids.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0];
  return {
    now, waiting,
    stalls: w.stalls || 0,
    stallMs: (w.stallMs || 0) + (waiting ? now - w.waitingSince : 0),
    firstFrameAt: w.firstFrameAt || null,
    errors: w.errors || 0,
    badge: !!w.badge,
    latencySec: Number.isFinite(p.latencySec) ? p.latencySec : null,
    path: p.path || null,
    url: p.url || null,
    fallbacks: p.fallbacks || 0,
    marks: w.marks || {},
    // The join request's own timing (no regex: this text is a template literal, where a
    // backslash would be eaten).
    joinApiMs: (performance.getEntriesByType('resource').find(e => e.name.indexOf('/api/webinars/') >= 0 && e.name.split('?')[0].endsWith('/join')) || {}).duration || null,
    playing: !!(v && !v.paused && v.readyState >= 3),
    width: v ? v.videoWidth : 0,
  };
})()`;

/** The attendee's room page for a join key. */
export function roomUrl(web, slug, joinKey) {
  return `${String(web).replace(/\/$/, "")}/webinars/${encodeURIComponent(slug)}/room?k=${encodeURIComponent(joinKey)}`;
}

/* One viewer: a tab in one of the pool's Chromes. start() joins and waits for the first
 * frame (in the background); sample() takes a snapshot into the record; record() is the
 * viewer for lib/browser-summary.mjs. */
export class BrowserViewer {
  constructor({ id, web, slug, joinKey, chrome, region = "", throttle = null, preferPath = null, viewport = { width: 640, height: 360 } }) {
    Object.assign(this, { id, web, slug, joinKey, chrome, region, throttle, preferPath, viewport });
    this.tab = null;
    this.openedAt = null;
    this.last = null;
    this.samples = [];
    this.joinError = null;
    this.g2g = []; // [t, glass-to-glass seconds] read off the mix's time strip
    this.g2gMisses = 0;
  }

  async start() {
    this.openedAt = Date.now();
    // A window of its own, not a tab: a background tab is hidden and its video stays paused.
    const ws = await newWindow(this.chrome.browser, this.chrome.port);
    this.tab = await attach(ws, `viewer${this.id}`, { init: initScript({ preferPath: this.preferPath }) });
    // A small viewport: the decode is real, the compositing of a big page is not the point.
    await this.tab.call("Emulation.setDeviceMetricsOverride", { width: this.viewport.width, height: this.viewport.height, deviceScaleFactor: 1, mobile: false });
    if (this.throttle && NETWORK_PROFILES[this.throttle]) {
      await this.tab.call("Network.enable");
      await this.tab.call("Network.emulateNetworkConditions", { offline: false, ...NETWORK_PROFILES[this.throttle] });
    }
    await this.tab.navigate(roomUrl(this.web, this.slug, this.joinKey), 30_000);
    // Some rooms ask for a click before playing (a Join button); the edge room plays by itself.
    for (let i = 0; i < 20; i++) {
      if (await this.tab.evaluate("!!(window.__LOAD_WATCH__ && window.__LOAD_WATCH__.played)")) break;
      await this.tab.evaluate(clickButton("join the webinar|join now|^join$|^watch")).catch(() => false);
      await sleep(1000);
    }
  }

  async sample() {
    if (!this.tab) return null;
    const s = await this.tab.evaluate(SAMPLE).catch(() => null);
    if (!s) return null;
    this.last = s;
    if (s.firstFrameAt) this.samples.push([s.now, s.waiting ? 1 : 0, s.stalls, s.latencySec]);
    return s;
  }

  /* The true delay: the time in the picture (the mix's strip) against this machine's clock,
   * which DigitalOcean keeps NTP-synced (tens of ms). A miss is a frame without a clean read. */
  async glassToGlass() {
    if (!this.tab || !this.last?.firstFrameAt) return null;
    const r = await this.tab.evaluate(READ_STRIP).catch(() => null);
    const shown = r ? decodeClock(r.lumas, r.at) : null;
    if (shown === null) {
      this.g2gMisses++;
      return null;
    }
    const sec = Math.round((r.at - shown) / 10) / 100;
    this.g2g.push([r.at, sec]);
    return sec;
  }

  record(edgeFor = () => "") {
    const s = this.last ?? {};
    const first = s.firstFrameAt ?? null;
    const lastAt = this.samples.length ? this.samples[this.samples.length - 1][0] : null;
    const path = s.path || (s.url ? "" : "recording");
    return {
      id: `${this.region || "local"}-${this.id}`,
      region: this.region,
      path,
      edge: edgeFor(path, s.url),
      throttle: this.throttle,
      joined: !!first,
      firstFrameMs: first ? first - this.openedAt : null,
      watchMs: first && lastAt ? Math.max(0, lastAt - first) : 0,
      stalls: s.stalls ?? 0,
      stallMs: s.stallMs ?? 0,
      fallbacks: s.fallbacks ?? 0,
      badge: !!s.badge,
      errors: (s.errors ?? 0) + (this.joinError ? 1 : 0),
      joinError: this.joinError,
      g2g: this.g2g,
      g2gMisses: this.g2gMisses,
      joinApiMs: s.joinApiMs ? Math.round(s.joinApiMs) : null,
      marks: s.marks ?? {},
      samples: this.samples,
    };
  }

  async stop() {
    try {
      this.tab?.close();
    } catch {}
  }
}

/* A pool of Chromes, `perChrome` viewer windows each: one Chrome for hundreds of windows is one
 * crash away from losing all of them, and a few processes use the cores better. */
export class ChromePool {
  constructor({ perChrome = 10, basePort = 9800, flags = [] } = {}) {
    Object.assign(this, { perChrome, basePort, flags });
    this.chromes = [];
    this.used = [];
  }

  async next() {
    let i = this.used.findIndex((n) => n < this.perChrome);
    if (i < 0) {
      i = this.chromes.length;
      const c = await launchChrome({ port: this.basePort + i, flags: ["--mute-audio", ...this.flags] });
      c.browser = await attach(await browserWsUrl(c.port), `chrome${i}`);
      this.chromes.push(c);
      this.used.push(0);
    }
    this.used[i]++;
    return this.chromes[i];
  }

  close() {
    for (const c of this.chromes) {
      try {
        c.browser?.close();
      } catch {}
      c.close();
    }
  }
}

/* The generator's own CPU (all cores, %), from successive /proc/stat or os.cpus() readings.
 * A loaded generator stalls its own tabs, which would read as the stream's fault. */
export class CpuMeter {
  constructor() {
    this.prev = this.read();
  }

  read() {
    try {
      const line = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
      const idle = line[3] + (line[4] ?? 0);
      return { idle, total: line.reduce((a, b) => a + b, 0) };
    } catch {
      let idle = 0;
      let total = 0;
      for (const c of cpus()) {
        idle += c.times.idle;
        total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
      }
      return { idle, total };
    }
  }

  /** Percent busy since the last call. */
  pct() {
    const now = this.read();
    const dt = now.total - this.prev.total;
    const di = now.idle - this.prev.idle;
    this.prev = now;
    return dt > 0 ? Math.round(1000 * (1 - di / dt)) / 10 : 0;
  }
}

/* overloadGuard({ maxCpu, consecutive }) -> (pct) => "ok" | "over": "over" once the generator
 * has been past maxCpu for `consecutive` samples in a row (one busy second is not overload). */
export function overloadGuard({ maxCpu = 70, consecutive = 3 } = {}) {
  let run = 0;
  return (pct) => {
    run = pct > maxCpu ? run + 1 : 0;
    return run >= consecutive ? "over" : "ok";
  };
}

/** The DigitalOcean region this droplet is in (its metadata service), or "" off DigitalOcean. */
export async function dropletRegion() {
  try {
    const r = await fetch("http://169.254.169.254/metadata/v1/region", { signal: AbortSignal.timeout(1000) });
    return r.ok ? (await r.text()).trim() : "";
  } catch {
    return "";
  }
}

/* edgeOf(url) -> the CDN edge that answers this generator for url (Bunny's Server header,
 * e.g. "BunnyCDN-SG1-1096"), from a request made here: every tab on a generator reaches the
 * same edge, and a page cannot read that header itself (Bunny does not expose it to CORS). */
export async function edgeOf(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { "Cache-Control": "no-cache" } });
    await r.arrayBuffer().catch(() => null);
    return r.headers.get("server") || "";
  } catch {
    return "";
  }
}
