// Measure the receiver-side playout delay, which is the largest term in what a viewer
// experiences as latency (ARCHITECTURE.md §8d).
//
//   node e2e/probe-latency.mjs <base-url>
//
// Two real Chromes against a deployed instance: one publishes a camera as host, one
// subscribes as panelist. The subscriber's inbound video stats are read directly, so the
// number reported is the browser's own accounting rather than an estimate.
//
// The experiment is A/B/A, not A/B. A WebRTC connection is not in a steady state for its
// first few seconds — the jitter buffer is still filling, the encoder is still ramping, and
// congestion control is still probing — so a plain before/after would happily attribute
// that settling to whatever change was made in between. Measuring the baseline again at the
// end is what separates "the setting did something" from "the connection warmed up".
//
//   warm-up   30s   discarded — adaptiveStream is still choosing a layer
//   A         15s   jitterBufferTarget = null   (browser default)
//   B         15s   jitterBufferTarget = 0      (ask for the shortest buffer)
//   A'        15s   jitterBufferTarget = null   (back to default)
//
// Freezes and packet loss are reported alongside the delay, because a smaller buffer that
// stutters is not an improvement and this is the only place that would show it.
//
// What it found on this deployment, and why the app sets no target: round trip 276-285 ms
// against a playout buffer of 10-14 ms whose own reported floor is 15-17 ms. The buffer is
// already under the smallest value the browser will compute, so target 0 changes nothing —
// see ARCHITECTURE.md §8d. The probe stays because that is a claim worth being able to
// re-check after any change to publishing or subscription.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantHost } from "./grant-host.mjs";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!base) {
  console.error("usage: node e2e/probe-latency.mjs <base-url>");
  process.exit(2);
}

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PHASE_MS = 15000;
const WARMUP_MS = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const api = `${base}/api`;

/* Collects every receiver the SDK creates.
 *
 * Installed before any page script runs and hung off the peer connection rather than off
 * the app, so it does not depend on a single internal staying where it is — the room
 * object is not reachable from the page, and reaching for it would make this probe break
 * every time the component tree moves.
 */
const SHIM = `
(() => {
  window.__lat = { receivers: [] };
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = new Native(...args);
    pc.addEventListener('track', (ev) => {
      if (ev.receiver) window.__lat.receivers.push(ev.receiver);
    });
    return pc;
  };
  window.RTCPeerConnection.prototype = Native.prototype;
})();
`;

// --------------------------------------------------------------------- one browser

let nextPort = 9401;

function launch(label) {
  const profile = mkdtempSync(join(tmpdir(), `lat-${label}-`));
  const port = nextPort++;
  const proc = spawn(
    CHROME,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  return { label, port, profile, proc };
}

async function connect(browser) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener("open", res, { once: true });
          ws.addEventListener("error", rej, { once: true });
        });
        const pending = new Map();
        let id = 0;
        ws.addEventListener("message", (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
          }
        });
        const call = (method, params = {}) =>
          new Promise((res) => {
            const at = ++id;
            pending.set(at, res);
            ws.send(JSON.stringify({ id: at, method, params }));
          });
        browser.call = call;
        browser.evaluate = async (expression) => {
          const res = await call("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
          });
          const bad = res?.result?.exceptionDetails;
          if (bad) throw new Error(`${browser.label}: ${JSON.stringify(bad).slice(0, 300)}`);
          return res?.result?.result?.value;
        };
        await call("Runtime.enable");
        await call("Page.enable");
        await call("Page.addScriptToEvaluateOnNewDocument", { source: SHIM });
        return browser;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error(`${browser.label}: Chrome never exposed a debugging target`);
}

/** Signs in, signing up first if the account does not exist yet. */
/* HOSTING IS AN ADMIN GRANT NOW.
 *
 * This probe used to make itself a host by signing up with `wantsHost: true`. That path is
 * closed — a public form cannot hand out the ability to create webinars and collect strangers'
 * contact details — so the probe asks an admin, exactly as a person would.
 *
 * Set PROBE_ADMIN_EMAIL and PROBE_ADMIN_PASSWORD to an account listed in the server's
 * ADMIN_EMAILS. Without them the probe stops with a reason rather than failing later on a 403
 * that reads like a bug in whatever is under test.
 */
async function credential(b, email, password, wantsHost) {
  await b.call("Page.navigate", { url: base });
  await sleep(2500);
  const body = (extra = {}) => JSON.stringify({ email, password, ...extra });
  const outcome = await b.evaluate(`
    (async () => {
      const login = () => fetch(${JSON.stringify(api)} + '/auth/login',
        {method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(body())}});
      let r = await login();
      if (r.ok) return 'logged in';
      const su = await fetch(${JSON.stringify(api)} + '/auth/signup',
        {method:'POST',headers:{'Content-Type':'application/json'},
         body:${JSON.stringify(body({ name: "Latency probe", wantsHost }))}});
      if (!su.ok) return 'failed: signup ' + su.status;
      r = await login();
      return r.ok ? 'signed up' : 'failed: login ' + r.status;
    })()
  `);

  /* Ask an admin for hosting, when this credential is meant to be a host.
   *
   * Before the return, obviously — the first version of this sat after it and never ran,
   * which showed up as `create 403` two steps later. Granted from Node while the session
   * lives in the page, which works because the API re-reads the account every request. */
  if (wantsHost) {
    const grant = await grantHost(base, email);
    if (!grant.ok) {
      console.error(`cannot become a host: ${grant.reason}`);
      process.exit(1);
    }
  }

  return outcome;
}

/** Clicks whatever button matches, retrying while the page settles. */
async function clickButton(b, pattern, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const hit = await b.evaluate(`
      (() => {
        const el = Array.from(document.querySelectorAll('button'))
          .find(x => ${pattern}.test(x.textContent || ''));
        if (!el) return false;
        el.click();
        return true;
      })()
    `);
    if (hit) return true;
    await sleep(500);
  }
  return false;
}

// ------------------------------------------------------------------ measurement

/* Per receiver rather than summed, and live receivers only.
 *
 * A renegotiation leaves dead receivers in the array with frozen counters. Summing across
 * them hides which stream the numbers describe and makes two different phases look
 * identical, which is exactly how the first version of this probe misled me. */
const SNAPSHOT = `
  (async () => {
    const out = { tracks: [], rttMs: 0, supported: false };
    for (const r of window.__lat.receivers) {
      if (!r.track || r.track.kind !== 'video') continue;
      if (r.track.readyState !== 'live') continue;
      const has = 'jitterBufferTarget' in r;
      if (has) out.supported = true;
      const stats = await r.getStats();
      let row = null;
      stats.forEach((s) => {
        if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime) {
          out.rttMs = Math.max(out.rttMs, s.currentRoundTripTime * 1000);
        }
        if (s.type !== 'inbound-rtp' || s.kind !== 'video') return;
        row = {
          id: s.ssrc,
          target: has ? r.jitterBufferTarget : 'unsupported',
          delay: s.jitterBufferDelay || 0,
          emitted: s.jitterBufferEmittedCount || 0,
          minDelay: s.jitterBufferMinimumDelay || 0,
          frames: s.framesDecoded || 0,
          fps: s.framesPerSecond || 0,
          width: s.frameWidth || 0,
          decodeS: s.totalDecodeTime || 0,
          assemblyS: s.totalAssemblyTime || 0,
          freezes: s.freezeCount || 0,
          freezeS: s.totalFreezesDuration || 0,
          lost: s.packetsLost || 0,
          received: s.packetsReceived || 0,
          nacks: s.nackCount || 0,
        };
      });
      if (row) out.tracks.push(row);
    }
    return out;
  })()
`;

async function phase(viewer, label, targetMs) {
  const touched = await viewer.evaluate(`
    (() => {
      let n = 0;
      for (const r of window.__lat.receivers) {
        if (!r.track || r.track.kind !== 'video') continue;
        if ('jitterBufferTarget' in r) { r.jitterBufferTarget = ${targetMs}; n++; }
      }
      return n;
    })()
  `);
  // A target change takes effect over the next few hundred milliseconds as the buffer
  // drains or fills; sampling across that transition would average the two states.
  await sleep(3000);

  const before = await viewer.evaluate(SNAPSHOT);
  await sleep(PHASE_MS);
  const after = await viewer.evaluate(SNAPSHOT);

  /* The biggest live track. A gallery subscribes to several layers and the small ones are
   * thumbnails; the number a viewer would describe as "the latency" belongs to the one
   * they are actually looking at. */
  const pick = (snap) =>
    snap.tracks.slice().sort((a, b) => b.width - a.width || b.frames - a.frames)[0] ?? null;
  const a = pick(before);
  const b = pick(after);
  if (!a || !b || a.id !== b.id) {
    return { label, target: String(targetMs), broken: "the track changed mid-phase" };
  }

  const emitted = b.emitted - a.emitted;
  const frames = b.frames - a.frames;
  const packets = b.received - a.received;
  const lost = b.lost - a.lost;
  return {
    label,
    target: targetMs === null ? "browser default" : `${targetMs} ms`,
    supported: after.supported,
    receivers: touched,
    live: after.tracks.length,
    rttMs: Math.round(after.rttMs),
    playoutMs: emitted > 0 ? ((b.delay - a.delay) / emitted) * 1000 : null,
    /* What the browser says it could not go below. If this equals the delay actually
     * applied, the buffer is already at its floor and no target can lower it. */
    minDelayMs: emitted > 0 ? ((b.minDelay - a.minDelay) / emitted) * 1000 : null,
    decodeMs: frames > 0 ? ((b.decodeS - a.decodeS) / frames) * 1000 : null,
    assemblyMs: frames > 0 ? ((b.assemblyS - a.assemblyS) / frames) * 1000 : null,
    fps: Math.round(b.fps),
    resolution: b.width,
    frames,
    freezes: b.freezes - a.freezes,
    freezeMs: Math.round((b.freezeS - a.freezeS) * 1000),
    nacks: b.nacks - a.nacks,
    lossPercent: packets + lost > 0 ? Math.round((lost / (packets + lost)) * 1000) / 10 : 0,
  };
}

// ------------------------------------------------------------------------ run

const browsers = [];
function cleanup(code) {
  for (const b of browsers) {
    try { b.proc.kill("SIGKILL"); } catch {}
    try { rmSync(b.profile, { recursive: true, force: true }); } catch {}
  }
  process.exit(code);
}
process.on("SIGINT", () => cleanup(130));

try {
  const run = Date.now();
  const hostEmail = `lat-host-${run}@probe.invalid`;
  const viewEmail = `lat-view-${run}@probe.invalid`;
  const password = "probe-password-1234";

  const host = await connect(launch("host"));
  const viewer = await connect(launch("view"));
  browsers.push(host, viewer);

  // The panelist account has to exist before the host can add it to the roster.
  console.log(`${stamp()} viewer credential: ${await credential(viewer, viewEmail, password, false)}`);
  console.log(`${stamp()} host credential:   ${await credential(host, hostEmail, password, true)}`);

  const slug = await host.evaluate(`
    (async () => {
      const w = await fetch(${JSON.stringify(api)} + '/host/webinars', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({topic:'Latency probe ${run}',
          startsAt:new Date(Date.now()+3600000).toISOString(), durationMin:30})});
      if (!w.ok) return 'failed: create ' + w.status;
      const webinar = await w.json();
      const p = await fetch(${JSON.stringify(api)} + '/host/webinars/' + webinar.id + '/panelists', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({email:${JSON.stringify(viewEmail)}})});
      if (!p.ok) return 'failed: panelist ' + p.status;
      const s = await fetch(${JSON.stringify(api)} + '/host/webinars/' + webinar.id + '/start', {method:'POST'});
      if (!s.ok) return 'failed: start ' + s.status;
      return webinar.id;
    })()
  `);
  if (typeof slug !== "string" || slug.startsWith("failed")) {
    console.error(`${stamp()} setup failed: ${slug}`);
    cleanup(1);
  }
  console.log(`${stamp()} webinar ${slug} is live`);

  await host.call("Page.navigate", { url: `${base}/host/${slug}/room` });
  await clickButton(host, "/join the webinar/i");
  console.log(`${stamp()} host joined and publishing`);

  await viewer.call("Page.navigate", { url: `${base}/host/${slug}/room` });
  await clickButton(viewer, "/join the webinar/i");
  console.log(`${stamp()} viewer joined`);

  // Wait for video to actually be arriving before measuring anything about it.
  let arriving = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    arriving = await viewer.evaluate(
      "window.__lat.receivers.filter(r => r.track && r.track.kind === 'video').length",
    );
    if (arriving > 0) break;
  }
  if (!arriving) {
    console.error(`${stamp()} no inbound video ever arrived — nothing to measure`);
    cleanup(1);
  }
  /* A long warm-up, because adaptiveStream is still choosing a layer for the first few
   * seconds and a layer change is a new SSRC. Phase A raced it and got discarded on the
   * first run of this probe, which is the failure this length prevents. */
  console.log(`${stamp()} ${arriving} inbound video receiver(s); warming up ${WARMUP_MS / 1000}s`);
  await sleep(WARMUP_MS);

  const results = [
    await phase(viewer, "A  default", null),
    await phase(viewer, "B  target 0", 0),
    await phase(viewer, "A' default", null),
  ];

  console.log("");
  for (const r of results) {
    if (r.broken) {
      console.log(`${r.label}: skipped — ${r.broken}`);
      continue;
    }
    console.log(
      `${r.label}  target=${r.target}\n` +
        `   playout ${r.playoutMs === null ? "n/a" : Math.round(r.playoutMs) + " ms"}` +
        `   (browser floor ${r.minDelayMs === null ? "n/a" : Math.round(r.minDelayMs) + " ms"})\n` +
        `   rtt ${r.rttMs} ms   assembly ${r.assemblyMs === null ? "n/a" : r.assemblyMs.toFixed(1) + " ms"}` +
        `   decode ${r.decodeMs === null ? "n/a" : r.decodeMs.toFixed(1) + " ms"}\n` +
        `   ${r.resolution}px @ ${r.fps}fps   ${r.frames} frames   ${r.freezes} freezes (${r.freezeMs}ms)` +
        `   ${r.nacks} nacks   ${r.lossPercent}% loss   ${r.live} live track(s)`,
    );
  }

  const [a, b, a2] = results;
  console.log(`\njitterBufferTarget supported: ${a.supported ? "yes" : "NO"}`);
  if (a.playoutMs !== null && b.playoutMs !== null && a2.playoutMs !== null) {
    const baseline = (a.playoutMs + a2.playoutMs) / 2;
    const drift = Math.abs(a.playoutMs - a2.playoutMs);
    const saved = baseline - b.playoutMs;
    console.log(`baseline A=${Math.round(a.playoutMs)}ms A'=${Math.round(a2.playoutMs)}ms -> drift ${Math.round(drift)}ms`);
    console.log(`target 0 = ${Math.round(b.playoutMs)}ms -> saved ${Math.round(saved)}ms vs mean baseline`);
    console.log(
      saved > drift
        ? "VERDICT: the setting moves the number by more than run-to-run drift."
        : "VERDICT: within drift — NOT a demonstrated improvement on this path.",
    );
  }

  console.log(`\nclean up: DELETE FROM webinars WHERE slug = '${slug}'; DELETE FROM users WHERE email LIKE '%@probe.invalid';`);
  cleanup(0);
} catch (err) {
  console.error(`${stamp()} ${err.message}`);
  cleanup(1);
}
