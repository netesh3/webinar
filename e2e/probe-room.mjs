// Drive a real Chrome at a deployed room and print what the browser sees.
//
// The SFU's log can only show what reached it. When it shows a WebSocket that
// connects and then goes quiet, the interesting half of the story is in the
// browser: livekit-client logs its whole connection sequence to the console, so
// reading that says exactly which step stalled.
//
//   node e2e/probe-room.mjs <url> [seconds]
//
// Fake media devices, so a headless Chrome can publish without a camera.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantHost } from "./grant-host.mjs";

const url = process.argv[2];
const seconds = Number(process.argv[3] ?? 30);
if (!url) {
  console.error("usage: node e2e/probe-room.mjs <base-url> [seconds]");
  console.error("  With AUTH_BYPASS on, the probe provisions its own host account by");
  console.error("  simply loading the page, then creates and starts a webinar of its own");
  console.error("  and enters it. Probing somebody else's room would only ever 403.");
  process.exit(2);
}

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), "probe-"));

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "about:blank",
], { stdio: ["ignore", "ignore", "ignore"] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error("Chrome never exposed a debugging target");
}

function cleanup(code) {
  try { chrome.kill("SIGKILL"); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(code);
}


// Installed before any page script runs, so it sees every peer connection the SDK
// makes. The SFU's log can only show ICE traffic that arrived; this shows what the
// browser intended to send, which is the other half of a failed negotiation.
const SHIM = `
(() => {
  window.__probe = { pcs: [] };
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = new Native(...args);
    const rec = {
      config: (args[0] && args[0].iceServers ? args[0].iceServers.map(s => (s.urls || s.url)) : []),
      policy: args[0] && args[0].iceTransportPolicy,
      local: [], remote: [], states: [], errors: [],
    };
    window.__probe.pcs.push(rec);
    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate && e.candidate.candidate) rec.local.push(e.candidate.candidate);
    });
    pc.addEventListener('icecandidateerror', (e) => {
      rec.errors.push((e.url || '') + ' -> ' + e.errorCode + ' ' + (e.errorText || ''));
    });
    pc.addEventListener('iceconnectionstatechange', () => rec.states.push('ice:' + pc.iceConnectionState));
    // Sample the selected pair. Which transport ICE actually chose, and whether
    // bytes move over it, is the difference between "connected" and "working".
    rec.samples = [];
    setInterval(async () => {
      try {
        const stats = await pc.getStats();
        const cands = {}, pairs = [];
        let selectedId = null;
        stats.forEach(r => {
          if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r;
          if (r.type === 'candidate-pair') pairs.push(r);
          // The transport entry is where Chrome actually names the chosen pair.
          if (r.type === 'transport' && r.selectedCandidatePairId) selectedId = r.selectedCandidatePairId;
        });
        const fmt = (pr) => {
          const L = cands[pr.localCandidateId] || {}, R = cands[pr.remoteCandidateId] || {};
          return (L.protocol || '?') + ' ' + (L.candidateType || '?') + ' -> ' +
                 (R.address || '?') + ':' + (R.port || '?') + ' ' + (R.candidateType || '?') +
                 ' [' + pr.state + ']' + (pr.id === selectedId ? ' SELECTED' : '') +
                 ' tx=' + pr.bytesSent + ' rx=' + pr.bytesReceived;
        };
        const sel = pairs.find(pr => pr.id === selectedId);
        if (sel) rec.samples.push(fmt(sel));
        else rec.samples.push('none selected; pairs: ' + pairs.map(pr => (cands[pr.localCandidateId]||{}).protocol + ':' + pr.state).join(', '));
      } catch (e) { rec.samples.push('stats error ' + e.message); }
    }, 3000);
    pc.addEventListener('connectionstatechange', () => rec.states.push('pc:' + pc.connectionState));
    const srd = pc.setRemoteDescription.bind(pc);
    pc.setRemoteDescription = (d) => {
      try {
        (d.sdp || '').split(/\\r?\\n/).filter(l => l.startsWith('a=candidate')).forEach(l => rec.remote.push(l));
      } catch {}
      return srd(d);
    };
    return pc;
  };
  window.RTCPeerConnection.prototype = Native.prototype;
})();
`;

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));

const stamp = () => new Date().toISOString().slice(11, 23);

const pending = new Map();
function call(method, params = {}) {
  return new Promise((resolve) => {
    const at = ++id;
    pending.set(at, resolve);
    ws.send(JSON.stringify({ id: at, method, params }));
  });
}

async function evaluate(expression) {
  const res = await call("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (res?.error || res?.result?.exceptionDetails) {
    console.log(`${stamp()} [setup failed] ${JSON.stringify(res.error ?? res.result.exceptionDetails).slice(0, 400)}`);
  }
  return res?.result?.result?.value;
}

ws.addEventListener("open", async () => {
  send("Runtime.enable");
  send("Log.enable");
  send("Network.enable");
  send("Page.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: SHIM });

  // Load the app first. With AUTH_BYPASS on, that single request is what provisions
  // this browser a host-capable account and sets its cookie.
  await call("Page.navigate", { url });
  await sleep(4000);

  const api = JSON.stringify(url.replace(/\/$/, "") + "/api");

  /* Sign in, when the bypass is off.
   *
   * It used to be enough to load the page: AUTH_BYPASS provisioned a host account per
   * browser. With the bypass off — which is where a real deployment should be — the probe
   * needs a credential like anybody else, so PROBE_EMAIL and PROBE_PASSWORD sign in, and
   * failing that it signs itself up a throwaway host.
   *
   * Signing up rather than refusing to run, because the alternative is a diagnostic tool
   * that only works on a misconfigured instance — which is the opposite of useful.
   */
  const email = process.env.PROBE_EMAIL || `probe-${Date.now()}@probe.invalid`;
  const password = process.env.PROBE_PASSWORD || "probe-password-1234";
  const signedIn = await evaluate(
    "fetch(" + api + " + '/auth/me').then(r => r.ok ? 'already' : " +
    "  fetch(" + api + " + '/auth/login', {method:'POST'," +
    "    headers:{'Content-Type':'application/json'}," +
    "    body:JSON.stringify({email:" + JSON.stringify(email) + ",password:" + JSON.stringify(password) + "})})" +
    "  .then(l => l.ok ? 'logged in' : " +
    "    fetch(" + api + " + '/auth/signup', {method:'POST'," +
    "      headers:{'Content-Type':'application/json'}," +
    "      body:JSON.stringify({name:'Probe',email:" + JSON.stringify(email) + "," +
    "        password:" + JSON.stringify(password) + ",wantsHost:true})})" +
    "    .then(su => su.ok ? 'signed up' : Promise.reject('signup ' + su.status))))" +
    ".catch(e => 'failed: ' + e)"
  );
  console.log(`${stamp()} --- credential: ${signedIn} (${email}) ---`);
  if (typeof signedIn === "string" && signedIn.startsWith("failed")) return cleanup(1);

  /* Ask an admin for the hosting capability.
   *
   * Signing up used to include `wantsHost: true` and that was enough. It is not any more, and
   * that is the point — a public form cannot hand out the ability to create webinars. So the
   * probe does what a person does: an admin grants it.
   *
   * Granted from Node rather than in the page, which is fine because the API re-reads the
   * account on every request: the page's existing session gains the capability immediately.
   *
   * Failing loudly here rather than pressing on, because the alternative is the 403 further
   * down being read as a bug in the room. */
  const grant = await grantHost(url.replace(/\/$/, ""), email);
  if (!grant.ok) {
    console.error(`${stamp()} cannot become a host: ${grant.reason}`);
    return cleanup(1);
  }
  console.log(`${stamp()} --- hosting granted by ${process.env.PROBE_ADMIN_EMAIL} ---`);
  const slug = await evaluate(
    "fetch(" + api + " + '/host/webinars', {method:'POST'," +
    "headers:{'Content-Type':'application/json'}," +
    "body:JSON.stringify({topic:'Probe ' + Date.now()," +
    "startsAt:new Date(Date.now()+3600000).toISOString(),durationMin:30})})" +
    ".then(r => r.ok ? r.json() : Promise.reject('create ' + r.status))" +
    ".then(w => fetch(" + api + " + '/host/webinars/' + w.id + '/start', {method:'POST'})" +
    "  .then(s => s.ok ? w.id : Promise.reject('start ' + s.status)))" +
    ".catch(e => 'failed: ' + e)"
  );

  console.log(`${stamp()} --- probe is host of "${slug}", entering the room ---`);
  if (typeof slug !== "string" || slug.includes("failed")) return cleanup(1);
  // PROBE_AS=attendee exercises the attendee gate instead of the host one. They are
  // different components with different join paths, and the attendee gate is where
  // the "Connecting to the webinar…" hang lived.
  const asAttendee = process.env.PROBE_AS === "attendee";
  const roomUrl = asAttendee
    ? `${url.replace(/\/$/, "")}/webinars/${slug}/room`
    : `${url.replace(/\/$/, "")}/host/${slug}/room`;
  console.log(`${stamp()} --- entering as ${asAttendee ? "attendee" : "host"}: ${roomUrl} ---`);
  await call("Page.navigate", { url: roomUrl });

  // A host lands on the pre-join screen and stays there until somebody clicks, so a
  // probe that only navigates measures nothing. Click it, then let the connection
  // sequence run under the frame logging below.
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const clicked = await evaluate(
      "(Array.from(document.querySelectorAll('button'))" +
      ".find(b => /join the webinar/i.test(b.textContent || '')) || {click(){return false}})" +
      ".click() !== false"
    );
    if (clicked) {
      console.log(`${stamp()} --- clicked "Join the webinar" ---`);
      break;
    }
  }
});

ws.addEventListener("message", (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }

  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }

  if (msg.method === "Runtime.consoleAPICalled") {
    const text = (msg.params.args ?? [])
      .map((a) => a.value ?? a.description ?? (a.preview ? JSON.stringify(a.preview.properties?.map((p) => `${p.name}=${p.value}`)) : a.type))
      .join(" ");
    console.log(`${stamp()} [${msg.params.type}] ${text.slice(0, 400)}`);
  }
  if (msg.method === "Log.entryAdded") {
    const e = msg.params.entry;
    console.log(`${stamp()} [${e.level}] ${String(e.text).slice(0, 400)}`);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    console.log(`${stamp()} [EXCEPTION] ${d.text} ${d.exception?.description?.slice(0, 300) ?? ""}`);
  }
  // The signalling socket's lifetime is the thing the SFU log cannot show.
  if (msg.method === "Network.webSocketCreated") {
    console.log(`${stamp()} [ws open ] ${msg.params.url.split("?")[0]}`);
  }
  // The signalling frames are the whole story: livekit-client defaults to a warn
  // log level, so the console says nothing, but every SDP and ICE message crosses
  // this socket. Direction and size are enough to see which step stalled.
  if (msg.method === "Network.webSocketFrameSent") {
    console.log(`${stamp()} [ws  -> ] ${(msg.params.response.payloadData ?? "").length} b64`);
  }
  if (msg.method === "Network.webSocketFrameReceived") {
    console.log(`${stamp()} [ws <-  ] ${(msg.params.response.payloadData ?? "").length} b64`);
  }
  if (msg.method === "Network.responseReceived" && msg.params.response.status >= 400) {
    console.log(`${stamp()} [http ${msg.params.response.status}] ${msg.params.response.url.slice(0, 140)}`);
  }
  if (msg.method === "Network.loadingFailed") {
    console.log(`${stamp()} [failed ] ${msg.params.errorText} ${msg.params.type}`);
  }
  if (msg.method === "Network.webSocketClosed") {
    console.log(`${stamp()} [ws close] requestId=${msg.params.requestId}`);
  }
  if (msg.method === "Network.webSocketFrameError") {
    console.log(`${stamp()} [ws error] ${msg.params.errorMessage}`);
  }
});

ws.addEventListener("error", (e) => {
  console.error("CDP error", e.message ?? e);
  cleanup(1);
});

setTimeout(async () => {
  const dump = await evaluate("JSON.stringify(window.__probe || {})");
  console.log(`\n${stamp()} --- what the browser negotiated ---`);
  try {
    const probe = JSON.parse(dump || "{}");
    (probe.pcs ?? []).forEach((pc, i) => {
      console.log(`  peer connection #${i}  iceServers=${JSON.stringify(pc.config)} policy=${pc.policy ?? "all"}`);
      console.log(`    states : ${pc.states.join(" -> ") || "(none)"}`);
      console.log(`    local  : ${pc.local.length} candidates`);
      pc.local.slice(0, 8).forEach((c) => console.log(`       ${c.replace(/^candidate:/, "").slice(0, 110)}`));
      console.log(`    remote : ${pc.remote.length} candidates`);
      pc.remote.slice(0, 8).forEach((c) => console.log(`       ${c.replace(/^a=candidate:/, "").slice(0, 110)}`));
      if (pc.samples?.length) {
        console.log(`    selected pair over time:`);
        pc.samples.slice(-8).forEach((x) => console.log(`       ${x}`));
      }
      if (pc.errors.length) {
        console.log(`    ICE ERRORS:`);
        pc.errors.slice(0, 6).forEach((e) => console.log(`       ${e.slice(0, 140)}`));
      }
    });
  } catch (e) {
    console.log("  could not read probe state:", e.message);
  }
  cleanup(0);
}, seconds * 1000);
