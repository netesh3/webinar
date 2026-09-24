/* Reproducing "callbacks.shift(...) is not a function" instead of reasoning about it.
 *
 *   node e2e/probe-segmenter-init.mjs
 *   → open http://localhost:8972 in Chrome
 *
 * That error comes out of the vendored emscripten glue's module start-up:
 *
 *     var callRuntimeCallbacks = callbacks => { while (callbacks.length > 0) {
 *       callbacks.shift()(Module)
 *     }};
 *
 * A check followed by an act on a shared array, so it is a cold-start problem: the arrays are
 * populated and drained while a module comes up, and nothing that happens afterwards can
 * reproduce it.
 *
 * ONE SCENARIO PER IFRAME, and that is the whole design. The first version of this probe ran
 * every scenario in one page and reported all green, which was worthless: the glue installs
 * globals on first load, so scenario 2 onwards were exercising an already-initialised module
 * and could not have failed. "Two concurrent creates" passed because it was two creates
 * against a runtime that had finished starting up ten scenarios earlier. Each scenario now
 * gets a fresh realm, so every one of them is a genuine cold start.
 *
 * Everything served here is the genuine article — /mediapipe/* straight out of
 * web/public/mediapipe, the bundles out of web/node_modules — so nothing can drift from what
 * ships. http://localhost is a secure context, so the browser behaves as it does on the site.
 *
 * The two bundles matter. @livekit/track-processors pins @mediapipe/tasks-vision to exactly
 * 0.10.14 and imports it at module scope; web/package.json pins the top level to 1.0.1. So npm
 * installs both, and the page holds two versions of the same library while the vendored WASM
 * runtime can only be one of them.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const web = join(here, "..", "web");
const PORT = Number(process.env.PORT ?? 8972);

const BUNDLE_TOP = join(web, "node_modules/@mediapipe/tasks-vision/vision_bundle.mjs");
const BUNDLE_NESTED = join(
  web,
  "node_modules/@livekit/track-processors/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs",
);

for (const [what, path] of [
  ["top-level tasks-vision", BUNDLE_TOP],
  ["nested tasks-vision (under track-processors)", BUNDLE_NESTED],
]) {
  if (!existsSync(path)) {
    console.error(`missing the ${what} bundle at ${path} — run npm install in web/ first`);
    process.exit(2);
  }
}

const TYPES = {
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".tflite": "application/octet-stream",
};

/** Every scenario, each run in its own fresh realm. */
const SCENARIOS = [
  ["control-new", "1.0.1 bundle + vendored runtime — one create"],
  ["control-old", "0.10.14 bundle + vendored runtime — one create"],
  ["concurrent-new", "1.0.1 bundle — TWO creates at once, from cold"],
  ["concurrent-old", "0.10.14 bundle — TWO creates at once, from cold"],
  ["both-bundles", "import BOTH bundles, then create from 1.0.1"],
  ["both-create", "create from 1.0.1 AND from 0.10.14 in the same realm"],
  ["both-concurrent", "create from both bundles AT ONCE"],
  /* What the app ACTUALLY hands MediaPipe. ProcessorWrapper builds its output canvas with
   * `if (supportsOffscreenCanvas()) return new OffscreenCanvas(w, h)` at 300x300, so on Chrome
   * the segmenter has never once been given a DOM canvas in production. Everything above used
   * one, which is why everything above passes. */
  ["offscreen-new", "1.0.1 bundle + OFFSCREEN canvas 300x300 (what the app does)"],
  ["offscreen-old", "0.10.14 bundle + OFFSCREEN canvas 300x300"],
  ["offscreen-concurrent", "1.0.1 bundle + OFFSCREEN, two creates at once"],
  ["offscreen-resized", "1.0.1 bundle + OFFSCREEN, resized after context creation"],
  /* The state the reporting machine is actually in: about twenty tabs, several of them this
   * app, all holding WebGL contexts. Chrome drops the oldest past sixteen, and this is the
   * same pressure that produced "Cannot read properties of null (reading 'alpha')" earlier —
   * getContextAttributes() returns null on a lost context. A GL init that fails part-way
   * inside emscripten is a plausible way to leave its start-up callback arrays in a state
   * callRuntimeCallbacks cannot drain, which would make callbacks.shift a SYMPTOM of the
   * same shortage rather than a separate bug. */
  ["starved", "contexts exhausted FIRST, then create a segmenter"],
  ["starved-released", "60 contexts created and released, then create a segmenter"],
];

const INDEX = `<!doctype html>
<meta charset="utf-8">
<title>Segmenter init probe</title>
<style>
  body { font: 14px/1.6 -apple-system, system-ui, sans-serif; max-width: 54rem; margin: 2rem auto; padding: 0 1rem; }
  pre { background: #f4f4f5; padding: 1rem; border-radius: .5rem; white-space: pre-wrap; }
  iframe { display: none; }
</style>
<h1>Segmenter init probe</h1>
<p>Each scenario runs in its own iframe, so each one is a genuine cold start of the WASM
runtime. Several seconds each.</p>
<pre id="out">starting…</pre>
<script type="module">
const SCENARIOS = ${JSON.stringify(SCENARIOS)};
const out = document.getElementById("out");
const results = [];

function show(extra) {
  out.textContent =
    results.map((r) => (r.ok ? "PASS  " : "FAIL  ") + r.name + (r.detail ? "\\n      " + r.detail : "")).join("\\n") +
    (extra ? "\\n\\n" + extra : "");
}

for (const [id, name] of SCENARIOS) {
  show("running " + id + "…");
  const result = await new Promise((resolve) => {
    const frame = document.createElement("iframe");
    // A realm that has never seen the glue. Nothing survives between these.
    frame.src = "/scenario/" + id;
    const settle = (value) => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      frame.remove();
      resolve(value);
    };
    const onMessage = (event) => {
      if (event.source !== frame.contentWindow) return;
      settle(event.data);
    };
    const timer = setTimeout(() => settle({ ok: false, detail: "timed out after 30s" }), 30000);
    window.addEventListener("message", onMessage);
    document.body.appendChild(frame);
  });
  results.push({ name, ...result });
  show();
}

await fetch("/report", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ browser: navigator.userAgent, steps: results }),
}).catch(() => {});

show("Done. Results sent to the terminal.");
</script>`;

/** The page for one scenario. Runs it, reports to the parent, and dies with its realm. */
function scenarioPage(id) {
  return `<!doctype html>
<meta charset="utf-8">
<script type="module">
const NEW = "/vision_bundle.mjs";
const OLD = "/vision_bundle_nested.mjs";
const MODEL = "/mediapipe/selfie_segmenter_landscape.tflite";
const WASM = "/mediapipe/wasm";

function makeCanvas(kind, w, h) {
  const canvas =
    kind === "offscreen"
      ? new OffscreenCanvas(w || 300, h || 300)
      : document.createElement("canvas");
  if (kind !== "offscreen") {
    canvas.width = w || 640;
    canvas.height = h || 360;
  }
  const gl = canvas.getContext("webgl2", {
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    alpha: false,
    desynchronized: true,
  });
  if (!gl) throw new Error("no webgl2");
  return canvas;
}

/* Built exactly as lib/segmenter.ts builds one: our own canvas handed to MediaPipe, the
 * landscape model, confidence masks, GPU delegate. */
async function create(url, kind, w, h) {
  const vision = await import(url);
  const fileset = await vision.FilesetResolver.forVisionTasks(WASM);
  return vision.ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
    runningMode: "VIDEO",
    outputConfidenceMasks: true,
    outputCategoryMask: false,
    canvas: makeCanvas(kind, w, h),
  });
}

const scenarios = {
  "control-new": async () => { (await create(NEW)).close(); return "ok"; },
  "control-old": async () => { (await create(OLD)).close(); return "ok"; },
  "concurrent-new": async () => {
    const both = await Promise.all([create(NEW), create(NEW)]);
    for (const s of both) s.close();
    return "ok";
  },
  "concurrent-old": async () => {
    const both = await Promise.all([create(OLD), create(OLD)]);
    for (const s of both) s.close();
    return "ok";
  },
  "both-bundles": async () => {
    await import(OLD);
    (await create(NEW)).close();
    return "both bundles evaluated, 1.0.1 started fine";
  },
  "both-create": async () => {
    const a = await create(NEW);
    const b = await create(OLD);
    a.close();
    b.close();
    return "ok";
  },
  "both-concurrent": async () => {
    const both = await Promise.all([create(NEW), create(OLD)]);
    for (const s of both) s.close();
    return "ok";
  },
  "offscreen-new": async () => { (await create(NEW, "offscreen")).close(); return "ok"; },
  "offscreen-old": async () => { (await create(OLD, "offscreen")).close(); return "ok"; },
  "offscreen-concurrent": async () => {
    const both = await Promise.all([create(NEW, "offscreen"), create(NEW, "offscreen")]);
    for (const s of both) s.close();
    return "ok";
  },
  starved: async () => {
    const held = [];
    for (let i = 0; i < 24; i++) {
      const gl = document.createElement("canvas").getContext("webgl2");
      if (gl) held.push(gl);
    }
    const lost = held.filter((gl) => gl.isContextLost() || gl.getContextAttributes() === null).length;
    const seg = await create(NEW, "offscreen");
    seg.close();
    return "survived with " + lost + " of " + held.length + " contexts already lost";
  },
  "starved-released": async () => {
    for (let i = 0; i < 60; i++) {
      const gl = document.createElement("canvas").getContext("webgl2");
      if (gl) gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    const seg = await create(NEW, "offscreen");
    seg.close();
    return "ok";
  },
  "offscreen-resized": async () => {
    // SoftSegmenter.transform resizes the canvas to the frame on the first frame, after the
    // context exists. Worth separating from the 300x300 case.
    const vision = await import(NEW);
    const canvas = makeCanvas("offscreen", 300, 300);
    canvas.width = 1280;
    canvas.height = 720;
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM);
    const seg = await vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      outputConfidenceMasks: true,
      outputCategoryMask: false,
      canvas,
    });
    seg.close();
    return "ok";
  },
};

const id = ${JSON.stringify(id)};
try {
  const detail = await scenarios[id]();
  parent.postMessage({ ok: true, detail }, "*");
} catch (err) {
  const name = err && err.name ? err.name + ": " : "";
  parent.postMessage({ ok: false, detail: name + (err && err.message ? err.message : String(err)) }, "*");
}
</script>`;
}

const server = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];

  if (req.method === "POST" && url === "/report") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(204).end();
      let report;
      try {
        report = JSON.parse(body);
      } catch {
        console.log("(unreadable report)");
        return;
      }
      console.log("\n===== segmenter cold-start matrix =====");
      console.log(report.browser);
      let failed = 0;
      for (const s of report.steps ?? []) {
        if (!s.ok) failed++;
        console.log(`${s.ok ? "PASS" : "FAIL"}  ${s.name}${s.detail ? `\n      ${s.detail}` : ""}`);
      }
      console.log(`\n${failed} of ${(report.steps ?? []).length} failed`);
    });
    return;
  }

  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(INDEX);
    return;
  }

  if (url.startsWith("/scenario/")) {
    const id = url.slice("/scenario/".length);
    if (!SCENARIOS.some(([s]) => s === id)) {
      res.writeHead(404).end("no such scenario");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(scenarioPage(id));
    return;
  }

  const file =
    url === "/vision_bundle.mjs"
      ? BUNDLE_TOP
      : url === "/vision_bundle_nested.mjs"
        ? BUNDLE_NESTED
        : url.startsWith("/mediapipe/")
          ? join(web, "public", url)
          : null;

  if (!file || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
  });
  res.end(readFileSync(file));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`probe listening on http://localhost:${PORT}`);
  console.log("open it in Chrome; results print here.");
});
