/* The virtual background, end to end: the app's own code, in Chrome, judged frame by frame.
 *
 *   make test-background PHOTO=person.jpg [HAIR=long-hair.jpg]
 *   node e2e/probe-background.mjs person.jpg [long-hair.jpg]
 *
 * Why a probe, and why this one. A background is judged by what the audience sees, and every
 * way this one has gone wrong was a frame: the room shown for a moment while the model loaded,
 * a black frame at a switch, an edge that shimmered on somebody sitting still. No unit test
 * sees a frame. The probe this replaces, probe-mask.mjs, tried to, by copying segmenter.ts's
 * shaders into a page of its own, and the copy drifted until it tested a pipeline that no
 * longer shipped. So nothing here is a copy: the page imports lib/backgrounds.ts and
 * lib/segmenter.ts, and esbuild bundles them
 * with the React, LiveKit and MediaPipe in web/node_modules — the modules the app ships, at the
 * versions it ships.
 *
 * What is fake is the camera, and only the device: getUserMedia answers with a track fed from
 * a still photo, so LiveKit opens, mutes, restarts and stops it exactly as it would a webcam.
 * Each frame carries its index as its timestamp, which survives the processor, so every frame
 * that comes out is compared with the very picture that went in — and with MediaPipe's own
 * answer for that picture, run separately on the CPU, for where the person is.
 *
 * What it asserts, in five sessions, each in a freshly loaded page:
 *   A  the pre-join screen and then the room, in the order a presenter meets them
 *       1. an untouched camera, to calibrate what "unchanged" measures as on this machine
 *       2. the camera opened with blur on it: the first frame already hidden, the model
 *          downloaded once, the blur within half a second of ready
 *       3. every tile in turn: not one frame of the room, nor a black one, on the way
 *       4. moving: the cut-out follows the person (IoU against MediaPipe's answer)
 *       5. a listener that throws does not stop the video
 *       6. camera off and on: the first frame back is the background, not the room
 *       7. the graphics context lost once: veiled while it rebuilds, never the room
 *       8. lost over and over: gives up with a sentence, and Retry brings it back
 *       9. joining: the room adopts the pre-join screen's processor and nothing reloads
 *      10. the camera reopened at once: the warm model is reused, not downloaded again
 *      11. clicking about faster than anything can finish: it ends on the last choice
 *      12. the room's camera button: the audience's first frame is already hidden
 *      13. low light on its own, and off meaning off
 *   B  a background chosen with the camera off: the model loads meanwhile, and the camera
 *      comes on to the background
 *   C  the model unreachable: veiled through the retries, then a sentence and a Retry that works
 *   D  StrictMode and quick clicks during the first load: one processor, one download
 *   E  sitting still, with sensor noise: the edge shimmers less than the model's own answer does
 *      (needs HAIR — a photo with loose hair against a plain wall, the hardest edge there is)
 *
 * Contact sheets of what was shown go to $OUT (a temp directory unless set): one picture per
 * scenario, each frame labelled, anything showing the room in red. The numbers say whether it
 * worked; the sheet says whether it looks right, which is the question anybody asks.
 *
 * No photo ships with the repo. Use one of yourself, or one with a licence that allows it —
 * Wikimedia Commons' CC0 category has headshots.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..", "web");
const publicDir = join(web, "public");

const photo = process.argv[2] ? resolve(process.argv[2]) : null;
const hair = process.argv[3] ? resolve(process.argv[3]) : null;
if (!photo || !existsSync(photo)) {
  console.error("usage: node e2e/probe-background.mjs PERSON.jpg [LONG-HAIR.jpg]");
  console.error("  a photo of a person, head and shoulders, in a room; see the header for why");
  process.exit(2);
}

const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = resolve(process.env.OUT ?? join(tmpdir(), "probe-background"));
const VERBOSE = process.env.VERBOSE === "1";
mkdirSync(OUT, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), "bgprobechrome-"));
let chrome = null;
let server = null;
let fails = 0;
const ok = (m, detail) => console.log(`  PASS  ${m}${detail ? `  (${detail})` : ""}`);
const bad = (m, detail) => {
  fails++;
  console.log(`  FAIL  ${m}${detail ? `\n          ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup(code) {
  try {
    chrome?.kill("SIGKILL");
  } catch {}
  try {
    server?.close();
  } catch {}
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
  process.exit(code);
}
process.on("SIGINT", () => cleanup(130));

/* The page, bundled.
 *
 * With nodePaths pointing into web/node_modules, and no node_modules at the repo root, every
 * bare import in the page and in lib/ resolves to the one copy the app uses. Two Reacts would
 * break the hooks; two livekit-clients would give the processor a different Track class from
 * the one the track was made with. NODE_ENV is development for StrictMode's double effects,
 * which is what session D exists to exercise. */
const esbuild = createRequire(join(web, "package.json"))("esbuild");
let bundle;
try {
  const built = await esbuild.build({
    entryPoints: [join(here, "probe-background.page.mjs")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    nodePaths: [join(web, "node_modules")],
    define: {
      "process.env.NODE_ENV": '"development"',
      /* Kill switch reads this at runtime; without a define, `process` is missing in the
       * browser bundle and openCamera throws before any scenario can start. Probe always
       * exercises the effect path — set to "0" only when testing the off switch itself. */
      "process.env.NEXT_PUBLIC_VIRTUAL_BACKGROUNDS": '"1"',
      global: "globalThis",
    },
    logLevel: "silent",
  });
  bundle = built.outputFiles[0].contents;
} catch (err) {
  console.error(`the page did not bundle:\n${err?.message ?? err}`);
  cleanup(1);
}

/* Recorded before anything else runs: every "[background]" line the app writes, and every
 * WebGL context anything creates, so the page can tell which of them are still alive. The
 * app's lines are the same ones a presenter's console would show — nothing is added for the
 * probe's sake. */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>probe-background</title></head><body>
<script>
  window.__probeLog = [];
  for (const level of ["info", "warn", "error", "log"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      if (typeof args[0] === "string" && args[0].startsWith("[background]")) {
        let detail = "";
        try {
          detail = args.slice(1).map((a) =>
            a instanceof Error ? a.message : typeof a === "object" ? JSON.stringify(a) : String(a),
          ).join(" ");
        } catch {}
        window.__probeLog.push({ at: performance.now(), level, text: args[0], detail });
      }
      original(...args);
    };
  }
  window.__probeContexts = [];
  for (const C of [HTMLCanvasElement, OffscreenCanvas]) {
    const original = C.prototype.getContext;
    C.prototype.getContext = function (type, ...rest) {
      const ctx = original.call(this, type, ...rest);
      if (ctx && (type === "webgl2" || type === "webgl") &&
          !window.__probeContexts.some((c) => c.ctx === ctx)) {
        window.__probeContexts.push({ ctx, type, at: performance.now() });
      }
      return ctx;
    };
  }
</script>
<script type="module" src="/bundle.js"></script>
</body></html>`;

/* The server. The app's own assets, from web/public, under the paths the app asks for them by,
 * counted — the model downloaded twice where once would do is one of the things under test.
 * The truth's copies come from other paths so they are not counted with them. And a switch to
 * make the model unreachable, for session C. */
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".tflite": "application/octet-stream",
};
const counts = { tflite: 0, wasmJs: 0, wasm: 0 };
let modelDown = false;

function within(base, rest) {
  const file = normalize(join(base, decodeURIComponent(rest)));
  return file.startsWith(base + sep) ? file : null;
}

function send(res, file) {
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  res.end(readFileSync(file));
}

server = createServer((req, res) => {
  const url = new URL(req.url, "http://probe");
  const p = url.pathname;
  if (p === "/") {
    res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
    res.end(PAGE);
    return;
  }
  if (p === "/bundle.js") {
    res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" });
    res.end(bundle);
    return;
  }
  if (p === "/__probe/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(counts));
    return;
  }
  if (p === "/__probe/model") {
    modelDown = url.searchParams.get("fail") === "1";
    res.writeHead(204).end();
    return;
  }
  if (p === "/__probe/sheet" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const name = (url.searchParams.get("name") ?? "sheet").replace(/[^\w.-]/g, "_");
      writeFileSync(join(OUT, `${name}.png`), Buffer.concat(chunks));
      res.writeHead(204).end();
    });
    return;
  }
  if (p === "/fixtures/desk.jpg") return send(res, photo);
  if (p === "/fixtures/hair.jpg") return send(res, hair);
  if (p.startsWith("/truth-wasm/")) return send(res, within(join(publicDir, "mediapipe", "wasm"), p.slice(12)));
  if (p.startsWith("/truth/")) return send(res, within(join(publicDir, "mediapipe"), p.slice(7)));
  if (p.startsWith("/backgrounds/")) return send(res, within(join(publicDir, "backgrounds"), p.slice(13)));
  if (p.startsWith("/mediapipe/")) {
    const file = within(join(publicDir, "mediapipe"), p.slice(11));
    if (p.endsWith(".tflite")) {
      counts.tflite++;
      if (modelDown) {
        res.writeHead(503, { "Cache-Control": "no-store" }).end();
        return;
      }
    } else if (p.endsWith(".wasm")) counts.wasm++;
    else if (p.endsWith(".js")) counts.wasmJs++;
    return send(res, file);
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const CDP = 9860 + (process.pid % 90);
chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    // A real GPU where there is one: context loss, and how long a model takes to compile its
    // shaders, are both things a driver does, and SwiftShader does neither the same way.
    "--use-gl=angle",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    // Every scenario is timed. A background tab's timers are throttled to once a second, and a
    // headless window counts as one unless told otherwise.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--window-size=1280,800",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "ignore"] },
);

let ws;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const page = list.find((t) => t.type === "page");
    if (page?.webSocketDebuggerUrl) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      break;
    }
  } catch {}
  await sleep(250);
}
if (!ws) {
  console.error("Chrome never exposed a debugging target");
  cleanup(1);
}
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let id = 0;
const pending = new Map();
const exceptions = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    exceptions.push(d.exception?.description ?? d.text);
  }
});
/** One CDP call, which gives up rather than hanging the run on a page that stopped answering. */
const call = (method, params = {}, ms = 120_000) =>
  new Promise((res, rej) => {
    const at = ++id;
    const timer = setTimeout(() => {
      pending.delete(at);
      rej(new Error(`${method} did not answer in ${ms / 1000}s`));
    }, ms);
    pending.set(at, (m) => {
      clearTimeout(timer);
      res(m);
    });
    ws.send(JSON.stringify({ id: at, method, params }));
  });
const evaluate = async (expression, ms) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, ms);
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
  }
  return r.result?.result?.value;
};

await call("Runtime.enable");
await call("Page.enable");

const SESSIONS = {
  A: [
    "raw",
    "coldBlur",
    "switches",
    "motion",
    "listenerThrows",
    "muteUnmute",
    "loseOnce",
    "loseRepeatedly",
    "adopt",
    "park",
    "churn",
    "enableCamera",
    "lowLight",
  ],
  B: ["dormant"],
  C: ["modelDown"],
  D: ["strictQuick"],
  E: ["stillFlicker"],
};
const wanted = (process.env.SESSIONS ?? (hair ? "A,B,C,D,E" : "A,B,C,D")).split(",").map((s) => s.trim());
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;

let calibrated = null;
let rendererShown = false;

for (const session of wanted) {
  const scenarios = SESSIONS[session];
  if (!scenarios) continue;
  if (session === "E" && !hair) {
    console.log("\n== E skipped: no HAIR photo was given");
    continue;
  }
  await call("Page.navigate", { url: `${ORIGIN}/?session=${session}` });
  let ready = null;
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    ready = await evaluate("window.__ready ?? null").catch(() => null);
    if (ready !== null) break;
  }
  if (ready !== true) {
    bad(`session ${session} never loaded`, String(ready ?? exceptions.slice(-3).join("\n")));
    continue;
  }
  if (!rendererShown) {
    rendererShown = true;
    console.log(`\n  GPU: ${await evaluate("window.__renderer")}`);
    if (VERBOSE) console.log(`  truth: ${JSON.stringify(await evaluate("window.__refs"))}`);
  }
  if (calibrated !== null) await evaluate(`probe.thresholds({ raw: ${calibrated} })`);

  for (const name of scenarios) {
    if (only && !only.has(name) && name !== "raw") continue;
    console.log(`\n== ${session}.${name}`);
    let r;
    try {
      r = await evaluate(`probe.run(${JSON.stringify(name)})`, 90_000);
    } catch (err) {
      bad(`${name} did not finish`, err.message);
      continue;
    }
    if (name === "raw" && r.info?.untouched) calibrated = r.info.untouched.rawBelow;
    if (Object.keys(r.info).length) console.log(`  ${JSON.stringify(r.info)}`);
    let failed = false;
    for (const c of r.checks) {
      if (c.ok) ok(c.what, VERBOSE ? c.detail : c.detail.slice(0, 160));
      else {
        failed = true;
        bad(c.what, c.detail.slice(0, 2000));
      }
    }
    if (failed || VERBOSE) {
      console.log(`     frames: ${r.timeline.slice(0, 3000)}`);
      console.log(`     status: ${r.status}`);
      for (const line of r.console.slice(0, 40)) console.log(`     ${line.slice(0, 400)}`);
    }
  }
}

if (exceptions.length) {
  console.log(`\n  uncaught in the page (${exceptions.length}):`);
  for (const e of [...new Set(exceptions)].slice(0, 10)) console.log(`     ${e.split("\n").slice(0, 3).join(" | ")}`);
}
console.log(`\n  contact sheets: ${OUT}`);
console.log(fails === 0 ? "\nALL PASS\n" : `\n${fails} FAILED\n`);
cleanup(fails === 0 ? 0 : 1);
