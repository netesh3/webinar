/* Headless Chrome over the DevTools protocol, no dependencies (e2e/ deliberately has none).
 * Shared by e2e/probe-load.mjs and e2e/load/presenter.mjs. */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The Chrome binary: $CHROME, else the macOS app, else google-chrome / chromium on PATH. */
export function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(mac)) return mac;
  for (const bin of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
    try {
      return execFileSync("which", [bin], { encoding: "utf8" }).trim();
    } catch {}
  }
  throw new Error("no Chrome found: set CHROME, or run e2e/load/setup-generator.sh");
}

/* Analytics and tag managers never get a load test's page views (web/app/layout.tsx loads
 * GA4 and GTM on every page). Mapped to an unroutable address inside Chrome. */
export const BLOCK_ANALYTICS =
  "--host-resolver-rules=MAP www.googletagmanager.com 0.0.0.0, MAP www.google-analytics.com 0.0.0.0, " +
  "MAP region1.google-analytics.com 0.0.0.0, MAP analytics.google.com 0.0.0.0, MAP stats.g.doubleclick.net 0.0.0.0";

/* launchChrome({ port, flags }) -> { proc, port, profile, close() }. Headless, fake devices,
 * no background throttling (else every tab after the first looks stalled). As root (a fresh
 * droplet) Chrome needs --no-sandbox. Extra flags from $CHROME_FLAGS (space-separated). */
export async function launchChrome({ port = 9600, flags = [], headless = true } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "load-chrome-"));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    ...(headless ? ["--headless=new"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--ignore-certificate-errors",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-dev-shm-usage",
    "--window-size=1280,800",
    BLOCK_ANALYTICS,
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    ...(process.env.CHROME_FLAGS ? process.env.CHROME_FLAGS.split(" ").filter(Boolean) : []),
    ...flags,
    "about:blank",
  ];
  const proc = spawn(chromePath(), args, { stdio: ["ignore", "ignore", "ignore"] });
  let first = null;
  for (let i = 0; i < 120 && !first; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      first = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? null;
    } catch {}
    if (!first) await sleep(250);
  }
  const close = () => {
    try {
      proc.kill("SIGKILL");
    } catch {}
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  };
  if (!first) {
    close();
    throw new Error("Chrome never exposed a debugger");
  }
  return { proc, port, profile, first, close };
}

/* attach(wsUrl, label, { init }) -> { call, evaluate, navigate, waitFor, close }. `init` is a
 * script added to every new document (e.g. probe-load's RTCPeerConnection watcher). */
export async function attach(wsUrl, label, { init } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const call = (method, params = {}) =>
    new Promise((res) => {
      const at = ++id;
      pending.set(at, res);
      ws.send(JSON.stringify({ id: at, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res?.result?.exceptionDetails) return null;
    return res?.result?.result?.value;
  };
  const navigate = async (url, readyMs = 10000) => {
    await call("Page.navigate", { url });
    for (let t = 0; t < readyMs; t += 200) {
      if (await evaluate("document.readyState === 'complete'")) return true;
      await sleep(200);
    }
    return false;
  };
  const waitFor = async (expression, timeoutMs = 30000, everyMs = 500) => {
    for (let t = 0; t < timeoutMs; t += everyMs) {
      const v = await evaluate(expression);
      if (v) return v;
      await sleep(everyMs);
    }
    return null;
  };
  await call("Runtime.enable");
  await call("Page.enable");
  if (init) await call("Page.addScriptToEvaluateOnNewDocument", { source: init });
  return { label, call, evaluate, navigate, waitFor, close: () => ws.close() };
}

/* newWindow(browser, port) -> a fresh target in its OWN window: its DevTools WebSocket URL.
 * `browser` is attach()ed to the browser target (/json/version). A background tab is
 * "hidden", and Chrome keeps a hidden page's autoplaying video paused: with tabs, one viewer per
 * Chrome played and the rest sat still (measured 2026-10-26, browser-viewers.mjs). A window of
 * its own is "visible", as a person watching is. */
export async function newWindow(browser, port, url = "about:blank") {
  const res = await browser.call("Target.createTarget", { url, newWindow: true });
  const id = res?.result?.targetId;
  if (!id) throw new Error("Chrome did not open a window");
  return `ws://127.0.0.1:${port}/devtools/page/${id}`;
}

/** The browser target's DevTools WebSocket URL (for Target.* calls). */
export async function browserWsUrl(port) {
  return (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
}

/** newTab(port) -> a fresh target's DevTools WebSocket URL. */
export async function newTab(port, url = "about:blank") {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const t = await res.json();
  return t.webSocketDebuggerUrl;
}

/* Clicks the first enabled button whose text or aria-label matches `re` (a RegExp source).
 * Expression for evaluate(): true if it clicked. */
export function clickButton(re) {
  return `(() => {
    const re = new RegExp(${JSON.stringify(re)}, 'i');
    const b = [...document.querySelectorAll('button,[role=menuitem]')].find(x =>
      !x.disabled && (re.test((x.textContent||'').trim()) || re.test(x.getAttribute('aria-label')||'')));
    if (!b) return false; b.click(); return true; })()`;
}

/* Watches RTCPeerConnections in the page so stats can be read: window.__load.pcs. */
export const WATCH_PCS = `
(() => {
  window.__load = { pcs: [] };
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = new Native(...args);
    window.__load.pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Native.prototype;
})();
`;

/** Expression: the page is sending video (some outbound-rtp has encoded frames). */
export const PUBLISHING = `(async () => {
  for (const pc of (window.__load?.pcs || [])) {
    let s; try { s = await pc.getStats(); } catch { continue; }
    let ok = false;
    s.forEach(r => { if (r.type === 'outbound-rtp' && r.kind === 'video' && (r.framesEncoded||0) > 0) ok = true; });
    if (ok) return true;
  }
  return false; })()`;

/** Expression: outbound video stats summed: { frames, bytes, w, h, fps, limited }. */
export const OUTBOUND = `(async () => {
  let frames = 0, bytes = 0, w = 0, h = 0, fps = 0, limited = '';
  for (const pc of (window.__load?.pcs || [])) {
    let s; try { s = await pc.getStats(); } catch { continue; }
    s.forEach(r => { if (r.type === 'outbound-rtp' && r.kind === 'video') {
      frames += r.framesEncoded || 0; bytes += r.bytesSent || 0;
      w = Math.max(w, r.frameWidth || 0); h = Math.max(h, r.frameHeight || 0);
      fps = Math.max(fps, r.framesPerSecond || 0);
      if (r.qualityLimitationReason && r.qualityLimitationReason !== 'none') limited = r.qualityLimitationReason;
    }});
  }
  return { frames, bytes, w, h, fps, limited }; })()`;
