/* How long an audience waits for a picture, broken into the stages that make it up.
 *
 *   node e2e/probe-firstframe.mjs <base-url> [runs]
 *
 * The complaint this exists to measure: "it says connected but video appears after 5 to 10
 * seconds". That is not one delay, it is a chain of them, and no single number tells you which
 * link is long. So this records absolute timestamps for each stage on both sides and subtracts:
 *
 *   HOST                                   VIEWER
 *   publish resolves                       transport connected
 *   first frame ENCODED  ← dynacast        inbound-rtp report appears   ← subscribed
 *                                          first byte received         ← SFU forwarding
 *                                          first frame DECODED         ← keyframe arrived
 *                                          first frame RENDERED
 *
 * Both Chromes run on this machine, so Date.now() is directly comparable between them and the
 * cross-browser subtractions are meaningful.
 *
 * Two orders are measured, because they fail differently and only one of them is the reported
 * symptom:
 *
 *   JOIN-LATE    host is already publishing, viewer joins. The common case.
 *   HOST-LATE    viewer is already waiting in the room, host joins and publishes. THIS is the
 *                one described — the audience sits on a connected room with no picture.
 *
 * HOST-LATE is the interesting one for dynacast: with no subscriber wanting a layer, the
 * publisher's encoder for it is paused, so the first subscriber pays for a resume, an encoder
 * start and a keyframe — across a 264 ms round trip.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantHost } from "./grant-host.mjs";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
const runs = Number(process.argv[3] ?? 3);
if (!base) {
  console.error("usage: node e2e/probe-firstframe.mjs <base-url> [runs]");
  process.exit(2);
}
const api = `${base}/api`;
const CHROME =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* How long the presenter is imagined to spend on the pre-join screen before clicking.
 *
 * It matters, and leaving it at zero is how this probe understated its own subject. The room
 * now connects while that screen is up, so the saving IS the overlap: a probe that clicks the
 * millisecond the button appears measures the one case where there is no overlap to have.
 * Three seconds is a fast but real person checking their camera and microphone.
 *
 * PREJOIN_DWELL_MS=0 reproduces the worst case deliberately. */
const DWELL_MS = Number(process.env.PREJOIN_DWELL_MS ?? 3000);
const stamp = () => new Date().toISOString().slice(11, 23);

/* Installed before the app loads, so nothing is missed.
 *
 * Records the transport coming up — which is the moment our UI flips to "Connected", and
 * therefore the moment the user starts waiting — and keeps every receiver and sender so the
 * poll loop can read stats without hunting for the peer connection. */
const SHIM = `
(() => {
  window.__ff = { connectedAt: null, receivers: [], senders: [], pcs: [] };
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = new Native(...args);
    window.__ff.pcs.push(pc);
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected' && window.__ff.connectedAt === null) {
        window.__ff.connectedAt = Date.now();
      }
    });
    pc.addEventListener('track', (ev) => { if (ev.receiver) window.__ff.receivers.push(ev.receiver); });
    return pc;
  };
  window.RTCPeerConnection.prototype = Native.prototype;

  /* Poll our own stats and stamp each milestone the first time it is true.
   *
   * In the page rather than from the driver, because a 250 ms polling interval over CDP would
   * put its own latency into the answer. 100 ms here, and the numbers below are therefore
   * accurate to about that. */
  window.__ff.marks = {};
  const mark = (k) => { if (window.__ff.marks[k] == null) window.__ff.marks[k] = Date.now(); };
  setInterval(async () => {
    for (const r of window.__ff.receivers) {
      if (!r.track || r.track.kind !== 'video') continue;
      let stats; try { stats = await r.getStats(); } catch { continue; }
      stats.forEach((s) => {
        if (s.type !== 'inbound-rtp' || s.kind !== 'video') return;
        mark('inboundReport');
        if ((s.bytesReceived || 0) > 0) mark('firstByte');
        if ((s.framesDecoded || 0) > 0) mark('firstDecoded');
        if ((s.framesRendered || 0) > 0) mark('firstRendered');
        if ((s.keyFramesDecoded || 0) > 0) mark('firstKeyframe');
      });
    }
    for (const pc of window.__ff.pcs) for (const snd of pc.getSenders()) {
      if (!snd.track || snd.track.kind !== 'video') continue;
      let stats; try { stats = await snd.getStats(); } catch { continue; }
      stats.forEach((s) => {
        if (s.type !== 'outbound-rtp' || s.kind !== 'video') return;
        if ((s.framesEncoded || 0) > 0) mark('firstEncoded');
        if ((s.packetsSent || 0) > 0) mark('firstPacketSent');
      });
    }
  }, 100);
})();
`;

let nextPort = 9501;
const browsers = [];

function launch(label) {
  const profile = mkdtempSync(join(tmpdir(), `ff-${label}-`));
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
      "--ignore-certificate-errors",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      // A real window size, so adaptiveStream sees a sized element rather than a 0x0 one.
      "--window-size=1280,800",
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
        browser.logs = [];
        ws.addEventListener("message", (ev) => {
          const m = JSON.parse(ev.data);
          if (m.method === "Runtime.consoleAPICalled") {
            const level = m.params.type;
            if (level !== "error" && level !== "warning") return;
            const text = (m.params.args || [])
              .map((a) => a.value ?? a.description ?? a.unserializableValue ?? "")
              .join(" ")
              .slice(0, 220);
            if (text) browser.logs.push(`[${level}] ${text}`);
          }
          if (m.method === "Runtime.exceptionThrown") {
            browser.logs.push(`[exception] ${(m.params.exceptionDetails?.text ?? "").slice(0, 220)}`);
          }
        });
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
  for (let i = 0; i < 40; i++) {
    if (await b.evaluate("document.readyState === 'complete'")) break;
    await sleep(250);
  }
  const outcome = await b.evaluate(`
    (async () => {
      const login = await fetch(${JSON.stringify(api)} + '/auth/login', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({email:${JSON.stringify(email)}, password:${JSON.stringify(password)}})});
      if (login.ok) return 'signed in';
      const su = await fetch(${JSON.stringify(api)} + '/auth/signup', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({name:'FF Probe', email:${JSON.stringify(email)},
          password:${JSON.stringify(password)}, wantsHost:${wantsHost}})});
      return su.ok ? 'signed up' : 'signup ' + su.status;
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

/** Clicks the join button, which is what a person does and therefore what should be timed. */
async function clickJoin(b, tries = 120) {
  for (let i = 0; i < tries; i++) {
    /* Returns the in-page timestamp of the click, and marks it, so "how long did connecting
     * take" is measured from the click itself rather than from when this loop happened to
     * notice the button. The two differ by page load plus up to a polling interval, which on
     * the first version of this probe was most of the number being reported. */
    const at = await b.evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')]
        .find(x => /join the webinar/i.test(x.textContent || '') && !x.disabled);
      if (!btn) return null;
      const now = Date.now();
      window.__ff.marks.clicked = now;
      btn.click();
      return now;
    })()`);
    if (at) return at;
    await sleep(250);
  }
  return null;
}

/** When the join button first became clickable: page load plus the token fetch. */
async function waitForJoinButton(b, limitMs = 45_000) {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    const at = await b.evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')]
        .find(x => /join the webinar/i.test(x.textContent || '') && !x.disabled);
      if (!btn) return null;
      if (window.__ff.marks.buttonReady == null) window.__ff.marks.buttonReady = Date.now();
      return window.__ff.marks.buttonReady;
    })()`);
    if (at) return at;
    await sleep(100);
  }
  return null;
}

async function marks(b) {
  return b.evaluate("JSON.stringify(window.__ff ? window.__ff.marks : {})").then((s) =>
    JSON.parse(s || "{}"),
  );
}
async function connectedAt(b) {
  return b.evaluate("window.__ff ? window.__ff.connectedAt : null");
}

/** Waits for a mark to appear, up to a limit. Returns the value or null. */
async function waitMark(b, key, limitMs) {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    const m = await marks(b);
    if (m[key] != null) return m[key];
    await sleep(200);
  }
  return null;
}

function cleanup(code) {
  for (const b of browsers) {
    try { b.proc.kill("SIGKILL"); } catch {}
    try { rmSync(b.profile, { recursive: true, force: true }); } catch {}
  }
  process.exit(code);
}
process.on("SIGINT", () => cleanup(130));

const ms = (a, b) => (a == null || b == null ? null : b - a);
const show = (label, v) =>
  `${label.padEnd(34)} ${v === null ? "     n/a" : String(v).padStart(6) + " ms"}`;

try {
  const run = Date.now();
  const password = "probe-password-1234";
  const hostEmail = `ff-host-${run}@probe.invalid`;
  const viewEmail = `ff-view-${run}@probe.invalid`;

  const host = await connect(launch("host"));
  const viewer = await connect(launch("view"));
  browsers.push(host, viewer);

  console.log(`${stamp()} viewer credential: ${await credential(viewer, viewEmail, password, false)}`);
  console.log(`${stamp()} host credential:   ${await credential(host, hostEmail, password, true)}`);

  const slug = await host.evaluate(`
    (async () => {
      const w = await fetch(${JSON.stringify(api)} + '/host/webinars', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({topic:'First frame probe ${run}',
          startsAt:new Date(Date.now()+3600000).toISOString(), durationMin:60})});
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
  console.log(`${stamp()} pre-join dwell: ${DWELL_MS} ms (PREJOIN_DWELL_MS to change)\n`);

  const roomUrl = `${base}/host/${slug}/room`;
  const joinLate = [];
  const hostLate = [];

  for (let i = 1; i <= runs; i++) {
    /* ---------------------------------------------------------- HOST-LATE
     *
     * The reported case. The viewer is in the room first, on a connected transport with
     * nothing to show, and then the host arrives. Everything is torn down between runs so
     * each one starts from a cold subscription. */
    await host.call("Page.navigate", { url: "about:blank" });
    await viewer.call("Page.navigate", { url: "about:blank" });
    await sleep(1500);

    await viewer.call("Page.navigate", { url: roomUrl });
    if (!(await clickJoin(viewer))) { console.error("viewer never got a join button"); cleanup(1); }
    const viewerUp = await (async () => {
      for (let k = 0; k < 60; k++) {
        const at = await connectedAt(viewer);
        if (at) return at;
        await sleep(250);
      }
      return null;
    })();
    console.log(`${stamp()} [host-late ${i}] viewer is in the room, waiting`);
    await sleep(3000); // settled, and definitely showing "connected" with no picture

    const hostNavigatedAt = Date.now();
    await host.call("Page.navigate", { url: roomUrl });
    const hostButtonAt = await waitForJoinButton(host);
    await sleep(DWELL_MS);
    const hostClickedAt = await clickJoin(host);
    if (!hostClickedAt) { console.error("host never got a join button"); cleanup(1); }

    const decoded = await waitMark(viewer, "firstDecoded", 40_000);
    const vm = await marks(viewer);
    const hm = await marks(host);
    const hostUp = await connectedAt(host);

    hostLate.push({
      // Page load and the token fetch, which happen before anybody clicks anything.
      pageReady: ms(hostNavigatedAt, hostButtonAt),
      // And the part that is actually "connecting", from the click.
      hostConnect: ms(hostClickedAt, hostUp),
      hostEncode: ms(hostClickedAt, hm.firstEncoded),
      hostSend: ms(hostClickedAt, hm.firstPacketSent),
      inbound: ms(hostClickedAt, vm.inboundReport),
      firstByte: ms(hostClickedAt, vm.firstByte),
      keyframe: ms(hostClickedAt, vm.firstKeyframe),
      wait: ms(hostClickedAt, decoded),
      rendered: ms(hostClickedAt, vm.firstRendered),
      // What a person actually experiences: opening the room until the audience sees them.
      doorToGlass: ms(hostNavigatedAt, decoded) === null ? null : ms(hostNavigatedAt, decoded) - DWELL_MS,
      viewerUp,
    });
    console.log(
      `${stamp()} [host-late ${i}] page ready ${ms(hostNavigatedAt, hostButtonAt)} ms, ` +
        `then audience waited ${decoded === null ? "NEVER" : ms(hostClickedAt, decoded) + " ms"} from the click`,
    );

    /* ---------------------------------------------------------- JOIN-LATE
     *
     * The other order: the host is already publishing and a viewer arrives. Measured from the
     * viewer's own transport coming up, which is when their UI says connected. */
    await viewer.call("Page.navigate", { url: "about:blank" });
    await sleep(1500);
    const viewNavAt = Date.now();
    await viewer.call("Page.navigate", { url: roomUrl });
    const viewButtonAt = await waitForJoinButton(viewer);
    await sleep(DWELL_MS);
    const viewClickedAt = await clickJoin(viewer);
    if (!viewClickedAt) { console.error("viewer never got a join button"); cleanup(1); }

    const decoded2 = await waitMark(viewer, "firstDecoded", 40_000);
    const vm2 = await marks(viewer);
    const up2 = await connectedAt(viewer);
    joinLate.push({
      pageReady: ms(viewNavAt, viewButtonAt),
      connect: ms(viewClickedAt, up2),
      wait: ms(up2, decoded2),
      inbound: ms(up2, vm2.inboundReport),
      firstByte: ms(up2, vm2.firstByte),
      keyframe: ms(up2, vm2.firstKeyframe),
      rendered: ms(up2, vm2.firstRendered),
      doorToGlass: ms(viewNavAt, decoded2) === null ? null : ms(viewNavAt, decoded2) - DWELL_MS,
    });
    console.log(
      `${stamp()} [join-late ${i}] viewer waited ${decoded2 === null ? "NEVER" : ms(up2, decoded2) + " ms"} after connecting\n`,
    );
  }

  const mean = (rows, key) => {
    const vals = rows.map((r) => r[key]).filter((v) => v != null);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };

  console.log("=".repeat(62));
  console.log(`HOST-LATE — viewer already in the room, host joins  (${runs} runs)`);
  console.log("  measured from the moment the host presses Join");
  console.log(show("  [page load + token fetch]", mean(hostLate, "pageReady")) + "   before the click");
  /* A NEGATIVE number here is the good outcome: the transport was already up before the
   * presenter clicked, so none of the handshake is in their wait. */
  console.log(show("  host transport connected", mean(hostLate, "hostConnect")) +
    (mean(hostLate, "hostConnect") < 0 ? "   ← already up before the click" : ""));
  console.log(show("  host encoded its first frame", mean(hostLate, "hostEncode")));
  console.log(show("  host sent its first packet", mean(hostLate, "hostSend")));
  console.log(show("  viewer saw an inbound report", mean(hostLate, "inbound")));
  console.log(show("  viewer received a first byte", mean(hostLate, "firstByte")));
  console.log(show("  viewer decoded a keyframe", mean(hostLate, "keyframe")));
  console.log(show("  VIEWER SAW A PICTURE", mean(hostLate, "wait")));
  console.log(show("  viewer rendered it", mean(hostLate, "rendered")));
  console.log(show("  DOOR TO GLASS (navigate → picture)", mean(hostLate, "doorToGlass")));

  console.log("");
  console.log(`JOIN-LATE — host already publishing, viewer joins  (${runs} runs)`);
  console.log("  measured from the viewer's transport coming up");
  console.log(show("  [page load + token fetch]", mean(joinLate, "pageReady")) + "   before the click");
  console.log(show("  transport connected", mean(joinLate, "connect")) + "   (from the click)");
  console.log(show("  inbound report", mean(joinLate, "inbound")));
  console.log(show("  first byte", mean(joinLate, "firstByte")));
  console.log(show("  keyframe decoded", mean(joinLate, "keyframe")));
  console.log(show("  VIEWER SAW A PICTURE", mean(joinLate, "wait")));
  console.log(show("  rendered", mean(joinLate, "rendered")));
  console.log(show("  DOOR TO GLASS (navigate → picture)", mean(joinLate, "doorToGlass")));
  console.log("=".repeat(62));

  for (const b of [host, viewer]) {
    const pcs = await b.evaluate("window.__ff ? window.__ff.pcs.length : -1");
    console.log(`\n${b.label}: ${pcs} peer connection(s) built` +
      (pcs > 2 ? "  ← more than one attempt: the connect is being torn down and remade" : ""));
    const seen = [...new Set(b.logs)].slice(0, 8);
    if (seen.length) console.log(seen.map((l) => "   " + l).join("\n"));
  }

  console.log(`\nper-run host-late waits: ${hostLate.map((r) => r.wait).join(", ")} ms`);
  console.log(`per-run join-late waits: ${joinLate.map((r) => r.wait).join(", ")} ms`);
  console.log(
    `\nclean up: DELETE FROM webinars WHERE slug = '${slug}'; DELETE FROM users WHERE email LIKE '%@probe.invalid';`,
  );
  cleanup(0);
} catch (err) {
  console.error(`${stamp()} ${err.message}`);
  cleanup(1);
}
