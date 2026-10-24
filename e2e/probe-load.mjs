/* How many attendees this deployment can actually carry.
 *
 *   node e2e/probe-load.mjs <base-url> <attendees> [hold-seconds]
 *
 * One host publishing a camera, N attendees subscribing, and then the only questions worth
 * asking: is each attendee's video arriving smoothly, and what is it costing the server.
 *
 * Environment (all optional; e2e/load/webrtc-attendees.mjs sets them from flags):
 *
 *   PROBE_ADMIN_EMAIL / PROBE_ADMIN_PASSWORD   an account in the server's ADMIN_EMAILS (needed
 *                      to make the probe's own host: hosting is an admin grant)
 *   PROBE_STEPS        "5,10,25": open tabs in steps, sampling each (default: one step of N)
 *   PROBE_KIND         webinar (default) | meeting: a meeting puts every tab on the stage with
 *                      camera on, mic muted (the lobby knock + admit path; cap 10 unless an admin
 *                      raised the host's meeting cap, which this does when it can)
 *   PROBE_DELIVERY     standard (default) | edge, for a webinar. A webinar on the DigitalOcean
 *                      box is always edge: its audience is LL-HLS, which this probe does not
 *                      measure; use e2e/load/hls-viewers.mjs for that and PROBE_KIND=meeting here.
 *   PROBE_SLUG + PROBE_KEYS_FILE   join an existing live session with these join keys (a JSON
 *                      array) instead of making a host and a webinar (run.mjs does this)
 *   PROBE_API          the API base, when it is not <base-url>/api
 *   PROBE_JSON         write the per-step results here
 *   CHROME, CHROME_FLAGS, PROBE_CDP_PORT   which Chrome, extra flags, debugger port (9600)
 *
 * Design notes, because the shape of a load test decides whether its number means anything:
 *
 * N TABS IN ONE CHROME, not N Chromes. A browser per attendee costs ~150 MB and its own
 * process tree, which caps a laptop at a handful and makes the generator the bottleneck rather
 * than the thing being measured. Tabs share Chrome's decode and network stacks, so a laptop can
 * hold an order of magnitude more of them.
 *
 * THE REAL ATTENDEE PATH. Each tab gets a join key and has it seeded into localStorage under the
 * same key the app writes (`webcast.joinkeys.byslug.v1`) so the room joins immediately — exactly
 * what a person who registered earlier experiences. The keys are load-test seats an admin mints
 * (a webinar) or lobby knocks the host admits (a meeting): a fresh registration's key arrives only
 * after its email is verified, which a probe's .invalid address never is.
 *
 * WHAT IS MEASURED PER TAB. Inbound bitrate, frames decoded, freezes, packet loss and the
 * resolution actually received. A load test that only counts successful connections will
 * happily report 500 attendees all watching a frozen picture.
 *
 * HONEST LIMITS. This machine's downlink and CPU bound how many tabs can really decode video.
 * The probe reports its own health — if tabs start reporting zero bitrate while the server is
 * idle, the generator ran out, not the server. Read the summary's WARNING lines.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { grantHost } from "./grant-host.mjs";
import { launchChrome, attach, newTab, clickButton, PUBLISHING } from "./load/lib/chrome.mjs";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
const attendees = Number(process.argv[3] ?? 10);
const holdSec = Number(process.argv[4] ?? 45);
if (!base || !Number.isFinite(attendees) || attendees < 1) {
  console.error("usage: node e2e/probe-load.mjs <base-url> <attendees> [hold-seconds]");
  process.exit(2);
}
const api = (process.env.PROBE_API || `${base}/api`).replace(/\/$/, "");
const steps = (process.env.PROBE_STEPS || String(attendees))
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
const total = Math.max(...steps);
const kind = process.env.PROBE_KIND === "meeting" ? "meeting" : "webinar";
const delivery = process.env.PROBE_DELIVERY === "edge" ? "edge" : "standard";
const PORT = Number(process.env.PROBE_CDP_PORT || 9600);

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

let chrome = null;
const tabs = [];

/* What the probe made itself (not a PROBE_SLUG session): removed at the end, as the admin.
 * Deleting the webinar takes its seats, lobby, visits and chat; then the host account goes.
 * PROBE_KEEP=1 leaves them. */
let created = null;
async function teardown() {
  if (!created || process.env.PROBE_KEEP) return;
  const { slug, hostId, cookie } = created;
  created = null;
  const del = (path) => fetch(api + path, { method: "DELETE", headers: { cookie } }).then((r) => r.status).catch((e) => e.message);
  let webinar = "none";
  if (slug) {
    await fetch(`${api}/admin/webinars/${slug}/end`, { method: "POST", headers: { cookie } }).catch(() => {});
    webinar = await del(`/admin/webinars/${slug}`);
  }
  console.log(`${stamp()} cleanup: webinar ${webinar}, host ${await del(`/admin/users/${hostId}`)}`);
}

async function cleanup(code) {
  chrome?.close();
  await teardown();
  process.exit(code);
}
process.on("SIGINT", () => cleanup(130));

const post = (path, body, cookie) =>
  fetch(api + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/* The probe's own host and session: a fresh .invalid account the admin verifies and lets host,
 * an instant webinar or meeting, live, with the host publishing from the first tab. Returns
 * { slug, keys }. */
async function makeSession(host) {
  const run = Date.now();
  const hostEmail = `load-host-${run}@probe.invalid`;
  const password = `probe-${run}-pw`;
  const su = await post("/auth/signup", {
    name: "Load Host",
    email: hostEmail,
    password,
    phone: `+9198765${String(run % 100000).padStart(5, "0")}`,
  });
  if (su.status !== 201) throw new Error(`host signup failed (${su.status})`);
  // grant-host.mjs speaks to <origin>/api: the API's own origin when PROBE_API is set.
  const grant = await grantHost(api.replace(/\/api$/, ""), hostEmail, { features: ["instant_webinar"] });
  if (!grant.ok) throw new Error(`cannot become a host: ${grant.reason}`);
  console.log(`${stamp()} hosting granted to the load host`);
  created = { slug: null, hostId: grant.id, cookie: grant.cookie };
  if (kind === "meeting" && total + 1 > 10) {
    const r = await fetch(`${api}/admin/users/${grant.id}/meeting-cap`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: grant.cookie },
      body: JSON.stringify({ meetingCap: Math.min(50, total + 1) }),
    });
    console.log(`${stamp()} meeting cap ${Math.min(50, total + 1)}: ${r.status}`);
  }

  // Sign in inside the page so its session cookie is the page's own, then create and start.
  await host.navigate(base);
  const body = {
    topic: `Load probe ${run}`, summary: "", description: "", track: "",
    startsAt: new Date().toISOString(), durationMin: 120, timeZone: "Asia/Kolkata",
    kind: kind === "meeting" ? "meeting" : "live", status: "scheduled", instant: true,
    delivery: kind === "meeting" ? "standard" : delivery, registrationRequired: true,
    approval: "automatic", attendeeLimit: 200, passcode: "", agenda: [], takeaways: [],
    customQuestions: [], panelistEmails: [],
  };
  const setup = await host.evaluate(`
    (async () => {
      const opt = (m, b) => ({ method: m, credentials: 'include', headers: {'Content-Type':'application/json'},
        body: b === undefined ? undefined : JSON.stringify(b) });
      const li = await fetch(${JSON.stringify(api)} + '/auth/login',
        opt('POST', {email:${JSON.stringify(hostEmail)}, password:${JSON.stringify(password)}}));
      if (!li.ok) return 'failed: login ' + li.status;
      const w = await fetch(${JSON.stringify(api)} + '/host/webinars', opt('POST', ${JSON.stringify(body)}));
      if (!w.ok) return 'failed: create ' + w.status + ' ' + (await w.text()).slice(0, 300);
      const webinar = await w.json();
      const s = await fetch(${JSON.stringify(api)} + '/host/webinars/' + webinar.id + '/start', opt('POST'));
      if (!s.ok) return 'failed: start ' + s.status;
      return webinar.id;
    })()
  `);
  if (typeof setup !== "string" || setup.startsWith("failed")) throw new Error(`setup failed: ${setup}`);
  const slug = setup;
  created.slug = slug;
  console.log(`${stamp()} ${kind} ${slug} is live`);

  let keys = [];
  if (kind === "meeting") {
    // The lobby: every tab knocks with a name, and the host lets them all in.
    for (let i = 0; i < total; i++) {
      const r = await post(`/webinars/${slug}/meeting/knock`, { name: `Load ${i + 1}` });
      if (r.ok) keys.push((await r.json()).joinKey);
    }
    const admitted = await host.evaluate(`fetch(${JSON.stringify(api)} + '/host/webinars/${slug}/lobby/admit-all',
      {method:'POST', credentials:'include'}).then(r => r.ok ? r.json() : {error: r.status})`);
    console.log(`${stamp()} lobby: ${keys.length} knocked, admitted ${JSON.stringify(admitted)}`);
  } else {
    // Load-test seats (api/internal/api/admin_loadtest.go): the host is a .invalid test account.
    const mark = await fetch(`${api}/admin/webinars/${slug}/load-test`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie: grant.cookie },
      body: JSON.stringify({ viewers: total }),
    });
    if (!mark.ok) throw new Error(`mark as load test failed (${mark.status})`);
    const seats = await post(`/admin/webinars/${slug}/load-test/seats`, { count: total }, grant.cookie);
    if (!seats.ok) throw new Error(`seats failed (${seats.status})`);
    keys = (await seats.json()).joinKeys;
  }
  console.log(`${stamp()} ${keys.length} join key(s)`);

  // The host joins and publishes; confirmed by the host's own outbound video, not a timer.
  await host.navigate(`${base}/host/${slug}/room`);
  await host.waitFor(clickButton("join the webinar|join the meeting|^join$|join now"), 60000);
  const publishing = await host.waitFor(PUBLISHING, 60000, 1000);
  console.log(`${stamp()} host publishing: ${!!publishing}`);
  if (!publishing) throw new Error("the host never published; nothing to load-test");
  return { slug, keys };
}

async function openTab(slug, key, i) {
  const ws = await newTab(PORT);
  if (!ws) return null;
  const tab = await attach(ws, `a${i}`, { init: WATCH });
  // Seed the join key the way the app stores it, so the room joins without a lookup.
  await tab.navigate(base, 8000);
  await tab.evaluate(
    `localStorage.setItem('webcast.joinkeys.byslug.v1', JSON.stringify({${JSON.stringify(slug)}: ${JSON.stringify(key)}}))`,
  );
  await tab.call("Page.navigate", { url: `${base}/webinars/${slug}/room` });
  // On a stage (a meeting) the room may open on the camera check first: press its Join.
  if (kind === "meeting") tab.waitFor(clickButton("join the webinar|join the meeting|^join$|join now"), 30000).catch(() => {});
  return tab;
}

function summarise(rows, target) {
  const withVideo = rows.filter((r) => r.tracks > 0 && r.kbps > 0);
  const silent = rows.length - withVideo.length;
  const sorted = (xs) => xs.slice().sort((a, b) => a - b);
  const median = (xs) => (xs.length ? sorted(xs)[Math.floor(xs.length / 2)] : 0);
  const kbps = withVideo.map((r) => r.kbps);
  const fps = withVideo.map((r) => r.fpsRate);
  const lost = withVideo.reduce((a, r) => a + r.lost, 0);
  const all = withVideo.reduce((a, r) => a + r.recv + r.lost, 0);
  return {
    target,
    joined: rows.length,
    receiving: withVideo.length,
    silent,
    kbpsMedian: median(kbps),
    kbpsMin: kbps.length ? Math.min(...kbps) : 0,
    kbpsMax: kbps.length ? Math.max(...kbps) : 0,
    fpsMedian: median(fps),
    resolution: `${withVideo[0]?.w ?? 0}x${withVideo[0]?.h ?? 0}`,
    freezes: withVideo.reduce((a, r) => a + r.freezes, 0),
    freezeMs: Math.round(withVideo.reduce((a, r) => a + r.freezeMs, 0)),
    lossPct: all > 0 ? Math.round((lost / all) * 1000) / 10 : 0,
    egressMbps: Math.round((kbps.reduce((a, b) => a + b, 0) / 1000) * 10) / 10,
  };
}

function print(s) {
  console.log("");
  console.log("=".repeat(60));
  console.log(`STEP ${s.target}: ${s.joined} joined, ${s.receiving} receiving video, ${s.silent} silent`);
  console.log(`per-attendee bitrate   median ${s.kbpsMedian} kbps   min ${s.kbpsMin}   max ${s.kbpsMax}`);
  console.log(`per-attendee framerate median ${s.fpsMedian} fps (frames decoded per second, all received videos)`);
  console.log(`resolution received    ${s.resolution}`);
  console.log(`freezes                ${s.freezes} totalling ${s.freezeMs} ms across all attendees`);
  console.log(`packet loss            ${s.lossPct}%`);
  console.log(`server egress observed ${s.egressMbps} Mbps for ${s.receiving} attendee(s)`);
  if (s.receiving) console.log(`  → ${Math.round((s.egressMbps * 1000) / s.receiving)} kbps per attendee`);
  console.log("=".repeat(60));
  if (s.silent > 0) {
    console.log(`WARNING: ${s.silent} tab(s) received no video. If the server was idle this is the`);
    console.log("         generator running out of CPU or downlink, not a server limit.");
  }
}

try {
  console.log(`${stamp()} target ${base}, ${kind}, steps ${steps.join(",")}, hold ${holdSec}s\n`);
  chrome = await launchChrome({ port: PORT });
  let slug = process.env.PROBE_SLUG || "";
  let keys = [];
  if (slug) {
    keys = JSON.parse(readFileSync(process.env.PROBE_KEYS_FILE || "", "utf8"));
    console.log(`${stamp()} joining ${slug} with ${keys.length} key(s)`);
  } else {
    const host = await attach(chrome.first.webSocketDebuggerUrl, "host", { init: WATCH });
    ({ slug, keys } = await makeSession(host));
  }
  if (keys.length < total) throw new Error(`${total} tabs need ${total} join keys, have ${keys.length}`);

  const results = [];
  for (const target of steps) {
    // Attendees, in tabs, staggered so a step does not arrive as one burst.
    console.log(`${stamp()} opening tabs ${tabs.length + 1}..${target}`);
    while (tabs.length < target) {
      const tab = await openTab(slug, keys[tabs.length], tabs.length);
      if (!tab) {
        console.log(`  tab ${tabs.length}: no debugger`);
        break;
      }
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
    const sum = summarise(rows, target);
    results.push(sum);
    print(sum);
  }
  if (process.env.PROBE_JSON) {
    writeFileSync(process.env.PROBE_JSON, JSON.stringify({ tool: "probe-load", base, slug, kind, steps: results }, null, 2));
    console.log(`results: ${process.env.PROBE_JSON}`);
  }
  cleanup(0);
} catch (err) {
  console.error(`${stamp()} ${process.env.PROBE_DEBUG ? err.stack : err.message}${err.cause ? ` (${err.cause.message ?? err.cause})` : ""}`);
  cleanup(1);
}
