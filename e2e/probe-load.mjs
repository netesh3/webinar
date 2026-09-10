/* How many attendees this deployment can actually carry.
 *
 *   node e2e/probe-load.mjs <base-url> <attendees> [hold-seconds]
 *
 * One host publishing a camera, N attendees subscribing, and then the only questions worth
 * asking: is each attendee's video arriving smoothly, and what is it costing the server.
 *
 * Design notes, because the shape of a load test decides whether its number means anything:
 *
 * N TABS IN ONE CHROME, not N Chromes. A browser per attendee costs ~150 MB and its own
 * process tree, which caps a laptop at a handful and makes the generator the bottleneck rather
 * than the thing being measured. Tabs share Chrome's decode and network stacks, so a laptop can
 * hold an order of magnitude more of them.
 *
 * THE REAL ATTENDEE PATH. Each tab registers through the public API, gets a join key, and has
 * it seeded into localStorage under the same key the app writes (`webcast.joinkeys.byslug.v1`)
 * so the room joins immediately — exactly what a person who registered earlier experiences. No
 * panelist shortcut: attendees are subscribe-only, which is the load that matters.
 *
 * WHAT IS MEASURED PER TAB. Inbound bitrate, frames decoded, freezes, packet loss and the
 * resolution actually received. A load test that only counts successful connections will
 * happily report 500 attendees all watching a frozen picture.
 *
 * HONEST LIMITS. This machine's downlink and CPU bound how many tabs can really decode video.
 * The probe reports its own health — if tabs start reporting zero bitrate while the server is
 * idle, the generator ran out, not the server. Read the summary's WARNING lines.
 */
import { spawn } from "node:child_process";
import { grantHost } from "./grant-host.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
const attendees = Number(process.argv[3] ?? 10);
const holdSec = Number(process.argv[4] ?? 45);
if (!base || !Number.isFinite(attendees) || attendees < 1) {
  console.error("usage: node e2e/probe-load.mjs <base-url> <attendees> [hold-seconds]");
  process.exit(2);
}
const api = `${base}/api`;
const CHROME =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

/* Per-tab stats, sampled in the page. Cumulative counters are turned into rates against the
 * previous sample so a bad patch is visible instead of averaged away over the whole run. */
const WATCH = `
(() => {
  window.__load = { pcs: [], prev: null, samples: [] };
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = new Native(...args);
    window.__load.pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Native.prototype;

  window.__sample = async () => {
    let bytes = 0, frames = 0, freezes = 0, freezeMs = 0, lost = 0, recv = 0, w = 0, h = 0, fps = 0, tracks = 0;
    for (const pc of window.__load.pcs) {
      let stats; try { stats = await pc.getStats(); } catch { continue; }
      stats.forEach((s) => {
        if (s.type !== 'inbound-rtp') return;
        if (s.kind === 'video') {
          tracks++;
          bytes += s.bytesReceived || 0;
          frames += s.framesDecoded || 0;
          freezes += s.freezeCount || 0;
          freezeMs += (s.totalFreezesDuration || 0) * 1000;
          w = Math.max(w, s.frameWidth || 0);
          h = Math.max(h, s.frameHeight || 0);
          fps = Math.max(fps, s.framesPerSecond || 0);
        }
        if (s.kind === 'video' || s.kind === 'audio') {
          lost += s.packetsLost || 0;
          recv += s.packetsReceived || 0;
        }
      });
    }
    const now = Date.now();
    const prev = window.__load.prev;
    const out = { now, bytes, frames, freezes, freezeMs, lost, recv, w, h, fps, tracks,
                  kbps: 0, fpsRate: 0 };
    if (prev && now > prev.now) {
      const dt = (now - prev.now) / 1000;
      out.kbps = Math.round(((bytes - prev.bytes) * 8) / 1000 / dt);
      out.fpsRate = Math.round(((frames - prev.frames) / dt) * 10) / 10;
    }
    window.__load.prev = out;
    return out;
  };
})();
`;

const profile = mkdtempSync(join(tmpdir(), "load-"));
let chrome = null;
const tabs = [];

function cleanup(code) {
  try { chrome?.kill("SIGKILL"); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
process.on("SIGINT", () => cleanup(130));

const PORT = 9600;

/** One CDP session against a target, with evaluate(). */
async function attach(wsUrl, label) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const call = (method, params = {}) =>
    new Promise((res) => { const at = ++id; pending.set(at, res); ws.send(JSON.stringify({ id: at, method, params })); });
  const evaluate = async (expression) => {
    const res = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res?.result?.exceptionDetails) return null;
    return res?.result?.result?.value;
  };
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: WATCH });
  return { label, call, evaluate };
}

async function newTab(url) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  });
  return res.json();
}

try {
  console.log(`${stamp()} target ${base}, ${attendees} attendee(s), hold ${holdSec}s\n`);

  chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--ignore-certificate-errors",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      // Without this Chrome throttles timers and media in background tabs, which would
      // make every attendee after the first look like a stalled connection.
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--window-size=1280,800",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );

  // Wait for the debugger, then take the first tab as the host.
  let first = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) { first = page; break; }
    } catch {}
    await sleep(250);
  }
  if (!first) { console.error("Chrome never exposed a debugger"); cleanup(1); }

  const host = await attach(first.webSocketDebuggerUrl, "host");

  const run = Date.now();
  const hostEmail = `load-host-${run}@probe.invalid`;
  const password = "probe-password-1234";

  await host.call("Page.navigate", { url: base });
  for (let i = 0; i < 40; i++) {
    if (await host.evaluate("document.readyState === 'complete'")) break;
    await sleep(250);
  }

  /* Hosting is an admin grant, so it has to happen BEFORE the in-page create call.
   *
   * Signing up and creating the webinar are one chained fetch inside the page, so there is no
   * seam between them — the account is registered here from Node first, then granted, and only
   * then does the page chain run. */
  const preflight = await host.evaluate(`
    fetch(${JSON.stringify(api)} + '/auth/signup', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({name:'Load Host', email:${JSON.stringify(hostEmail)},
        password:${JSON.stringify(password)}})})
      .then(r => r.ok ? 'ok' : 'signup ' + r.status)
  `);
  if (preflight !== "ok") {
    console.error(`${stamp()} host signup failed: ${preflight}`);
    cleanup(1);
  }
  const grant = await grantHost(base, hostEmail);
  if (!grant.ok) {
    console.error(`${stamp()} cannot become a host: ${grant.reason}`);
    cleanup(1);
  }
  console.log(`${stamp()} hosting granted to the load host`);

  const setup = await host.evaluate(`
    (async () => {
      const li = await fetch(${JSON.stringify(api)} + '/auth/login', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({email:${JSON.stringify(hostEmail)},
          password:${JSON.stringify(password)}})});
      if (!li.ok) return 'failed: login ' + li.status;
      const w = await fetch(${JSON.stringify(api)} + '/host/webinars', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({topic:'Load probe ${run}',
          startsAt:new Date(Date.now()+600000).toISOString(), durationMin:120,
          status:'scheduled', registrationRequired:true, attendeeLimit:600})});
      if (!w.ok) return 'failed: create ' + w.status;
      const webinar = await w.json();
      const s = await fetch(${JSON.stringify(api)} + '/host/webinars/' + webinar.id + '/start', {method:'POST'});
      if (!s.ok) return 'failed: start ' + s.status;
      return webinar.id;
    })()
  `);
  if (typeof setup !== "string" || setup.startsWith("failed")) {
    console.error(`${stamp()} setup failed: ${setup}`);
    console.error(
      `${stamp()} note: hosting is an admin grant now. Set PROBE_ADMIN_EMAIL and ` +
        `PROBE_ADMIN_PASSWORD to an account in the server's ADMIN_EMAILS.`,
    );
    cleanup(1);
  }
  const slug = setup;
  console.log(`${stamp()} webinar ${slug} is live`);

  // Register all attendees up front, through the public endpoint, and collect join keys.
  const keys = await host.evaluate(`
    (async () => {
      const out = [];
      for (let i = 0; i < ${attendees}; i++) {
        const r = await fetch(${JSON.stringify(api)} + '/webinars/${slug}/register', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({firstName:'Load', lastName:'A'+i,
            email:'load-' + i + '-${run}@probe.invalid', consent:true, phone:'+919876500' + String(i).padStart(3,'0')})});
        if (!r.ok) { out.push(null); continue; }
        const reg = await r.json();
        out.push(reg.joinKey || null);
      }
      return JSON.stringify(out);
    })()
  `);
  const joinKeys = JSON.parse(keys || "[]").filter(Boolean);
  console.log(`${stamp()} registered ${joinKeys.length}/${attendees} attendee(s)`);
  if (!joinKeys.length) { console.error("no attendee could register"); cleanup(1); }

  // The host joins and publishes.
  await host.call("Page.navigate", { url: `${base}/host/${slug}/room` });
  for (let i = 0; i < 120; i++) {
    const clicked = await host.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /join the webinar/i.test(x.textContent||'') && !x.disabled);
      if (!b) return false; b.click(); return true; })()`);
    if (clicked) break;
    await sleep(500);
  }
  // Publishing confirmed by the host's own outbound video, not by a timer.
  let publishing = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    publishing = await host.evaluate(`(async () => {
      for (const pc of window.__load.pcs) {
        const s = await pc.getStats(); let ok = false;
        s.forEach(r => { if (r.type === 'outbound-rtp' && r.kind === 'video' && (r.framesEncoded||0) > 0) ok = true; });
        if (ok) return true;
      }
      return false; })()`);
    if (publishing) break;
  }
  console.log(`${stamp()} host publishing: ${publishing}`);
  if (!publishing) { console.error("the host never published; nothing to load-test"); cleanup(1); }

  // Attendees, in tabs, staggered so five hundred registrations do not arrive as one burst.
  console.log(`${stamp()} opening ${joinKeys.length} attendee tab(s)…`);
  for (const [i, key] of joinKeys.entries()) {
    const target = await newTab("about:blank");
    if (!target?.webSocketDebuggerUrl) { console.log(`  tab ${i}: no debugger`); continue; }
    const tab = await attach(target.webSocketDebuggerUrl, `a${i}`);
    // Seed the join key the way the app stores it, so the room joins without a lookup.
    await tab.call("Page.navigate", { url: base });
    for (let k = 0; k < 40; k++) {
      if (await tab.evaluate("document.readyState === 'complete'")) break;
      await sleep(200);
    }
    await tab.evaluate(
      `localStorage.setItem('webcast.joinkeys.byslug.v1', JSON.stringify({${JSON.stringify(slug)}: ${JSON.stringify(key)}}))`,
    );
    await tab.call("Page.navigate", { url: `${base}/webinars/${slug}/room` });
    tabs.push(tab);
    await sleep(250);
  }
  console.log(`${stamp()} ${tabs.length} tab(s) open; settling 20s`);
  await sleep(20_000);

  // Two samples, holdSec apart: the first seeds the rate counters, the second is the answer.
  for (const t of tabs) await t.evaluate("window.__sample()");
  console.log(`${stamp()} holding ${holdSec}s…`);
  await sleep(holdSec * 1000);

  const rows = [];
  for (const t of tabs) {
    const s = await t.evaluate("window.__sample()");
    if (s) rows.push({ label: t.label, ...s });
  }

  const withVideo = rows.filter((r) => r.tracks > 0 && r.kbps > 0);
  const silent = rows.length - withVideo.length;
  const num = (xs) => xs.slice().sort((a, b) => a - b);
  const median = (xs) => (xs.length ? num(xs)[Math.floor(xs.length / 2)] : 0);
  const kbps = withVideo.map((r) => r.kbps);
  const fps = withVideo.map((r) => r.fpsRate);
  const freezes = withVideo.reduce((a, r) => a + r.freezes, 0);
  const freezeMs = Math.round(withVideo.reduce((a, r) => a + r.freezeMs, 0));
  const lossPct =
    withVideo.reduce((a, r) => a + r.recv + r.lost, 0) > 0
      ? Math.round(
          (withVideo.reduce((a, r) => a + r.lost, 0) /
            withVideo.reduce((a, r) => a + r.recv + r.lost, 0)) *
            1000,
        ) / 10
      : 0;

  console.log("");
  console.log("=".repeat(60));
  console.log(`ATTENDEES: ${tabs.length} joined, ${withVideo.length} receiving video, ${silent} silent`);
  console.log(`per-attendee bitrate   median ${median(kbps)} kbps   min ${Math.min(...kbps, 0)}   max ${Math.max(...kbps, 0)}`);
  console.log(`per-attendee framerate median ${median(fps)} fps`);
  console.log(`resolution received    ${withVideo[0]?.w ?? 0}x${withVideo[0]?.h ?? 0}`);
  console.log(`freezes                ${freezes} totalling ${freezeMs} ms across all attendees`);
  console.log(`packet loss            ${lossPct}%`);
  const totalMbps = Math.round((kbps.reduce((a, b) => a + b, 0) / 1000) * 10) / 10;
  console.log(`server egress observed ${totalMbps} Mbps for ${withVideo.length} attendee(s)`);
  if (withVideo.length) {
    console.log(`  → ${Math.round((totalMbps * 1000) / withVideo.length)} kbps per attendee`);
  }
  console.log("=".repeat(60));
  if (silent > 0) {
    console.log(`WARNING: ${silent} tab(s) received no video. If the server was idle this is the`);
    console.log("         generator running out of CPU or downlink, not a server limit.");
  }
  console.log(`\nclean up: DELETE FROM webinars WHERE slug = '${slug}'; DELETE FROM users WHERE email LIKE '%.invalid';`);
  cleanup(0);
} catch (err) {
  console.error(`${stamp()} ${err.message}`);
  cleanup(1);
}
