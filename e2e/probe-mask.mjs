// Check that the segmentation mask lands on the person, in the right place, and stays
// there frame after frame.
//
//   node e2e/probe-mask.mjs <photo-of-a-person.jpg|png>
//
// Why this exists as its own probe, and why it needs a photograph.
//
// The virtual background is the one feature no headless test can check by accident:
// Chrome's fake camera is a synthetic pattern with no person in it, so the confidence mask
// is ~0 everywhere and every geometry bug looks identical to "nothing to segment". A mask
// that is upside down, half-scale, or averaged into mush all render the same on that
// input — which is exactly how a mask that inverted on every pass reached production.
//
// So this feeds a real photograph and compares three things that must agree:
//
//   1. the person's position in the INPUT, measured from the pixels
//   2. the mask straight out of MediaPipe via getAsFloat32Array — the CPU ground truth
//   3. the mask after the app's own GPU chain: feather across, feather down, temporal
//      blend, ping-pong, sampled the way the composite samples it
//
// (2) failing means the model or its options are wrong. (3) disagreeing with (2) means the
// GPU chain is wrong, which is a different bug with the same symptom. Keeping them apart
// is the whole point — the last time this broke, (2) was perfect.
//
// The check is self-consistency rather than a golden file, so any photo of a person works
// and none has to be committed. It runs against no server: the page is assembled in a temp
// directory from the vendored MediaPipe assets in web/public, so it also passes or fails
// without a deployment.

import { spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const photo = process.argv[2];
if (!photo) {
  console.error("usage: node e2e/probe-mask.mjs <photo-of-a-person.jpg|png>");
  console.error("  Any photograph with a person in it. Nothing is committed and no server");
  console.error("  is needed — the MediaPipe assets come from web/public.");
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..", "web");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = mkdtempSync(join(tmpdir(), "maskprobe-"));
const profile = mkdtempSync(join(tmpdir(), "maskchrome-"));
let chrome = null;
let server = null;
function cleanup(code) {
  for (const p of [chrome, server]) { try { p?.kill("SIGKILL"); } catch {} }
  for (const d of [root, profile]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  process.exit(code);
}
process.on("SIGINT", () => cleanup(130));

// The page needs the wasm and the model same-origin, and tasks-vision as a module.
mkdirSync(join(root, "mediapipe"), { recursive: true });
cpSync(join(web, "public/mediapipe/wasm"), join(root, "mediapipe/wasm"), { recursive: true });
copyFileSync(
  join(web, "public/mediapipe/selfie_segmenter_landscape.tflite"),
  join(root, "mediapipe/selfie_segmenter_landscape.tflite"),
);
copyFileSync(
  join(web, "node_modules/@mediapipe/tasks-vision/vision_bundle.mjs"),
  join(root, "vision_bundle.mjs"),
);
copyFileSync(resolve(photo), join(root, "person.img"));

/* The page mirrors lib/segmenter.ts deliberately.
 *
 * A copy that drifts is worse than no test, so the shaders, the pass order, the mask
 * target size, MASK_MIX, FEATHER and the smoothstep bounds are all transcribed rather than
 * approximated. If that
 * file changes shape, this has to change with it — which is the cost of testing GPU code
 * from outside the bundle, and cheaper than the bug it catches. */
const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8"></head>
<body><canvas id="c" width="1280" height="720"></canvas><script type="module">
import { FilesetResolver, ImageSegmenter } from "./vision_bundle.mjs";
const out = { frames: [] }; window.__out = out; window.__done = false;
const BANDS = 6;

const VERTEX_PASS = ` + "`" + `#version 300 es
in vec2 position; out vec2 uv;
void main(){ uv = (position + 1.0) * 0.5; gl_Position = vec4(position, 0.0, 1.0); }` + "`" + `;
const VERTEX_PRESENT = ` + "`" + `#version 300 es
in vec2 position; out vec2 uv;
void main(){ uv = vec2((position.x+1.0)*0.5, 1.0-(position.y+1.0)*0.5); gl_Position = vec4(position,0.0,1.0); }` + "`" + `;
const BLUR = ` + "`" + `#version 300 es
precision highp float; in vec2 uv; uniform sampler2D source; uniform vec2 direction; uniform float radius; out vec4 color;
void main(){ if (radius <= 0.0) { color = texture(source, uv); return; }
  float total=0.0; vec4 sum=vec4(0.0); float sigma=max(radius*0.5,0.0001); float t2=2.0*sigma*sigma;
  for (int i=-16;i<=16;i++){ float x=float(i); if (abs(x)>radius) continue; float w=exp(-(x*x)/t2);
    sum += texture(source, uv + direction*x)*w; total += w; } color = sum/total; }` + "`" + `;
/** r = the mask, g = the alpha the composite would derive from it. */
const SHOW = ` + "`" + `#version 300 es
precision highp float; in vec2 uv; uniform sampler2D src; out vec4 color;
void main(){ float p = texture(src, uv).r; color = vec4(p, smoothstep(0.62,0.75,p), 0.0, 1.0); }` + "`" + `;

/** Mean per horizontal band, index 0 = TOP of the picture. */
function bandsOf(read, w, h) {
  const rows = [];
  for (let b = 0; b < BANDS; b++) {
    let sum = 0, n = 0;
    for (let y = Math.floor(b*h/BANDS); y < Math.floor((b+1)*h/BANDS); y++)
      for (let x = 0; x < w; x++) { sum += read(x, y); n++; }
    rows.push(Math.round(100*sum/n));
  }
  return rows;
}

try {
const canvas = document.getElementById("c");
const gl = canvas.getContext("webgl2", { premultipliedAlpha:false, preserveDrawingBuffer:false, alpha:false, desynchronized:true });
if (!gl) throw new Error("no WebGL2");
function prog(v, f) {
  const mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; };
  const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, v)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, f));
  gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p;
}
const blurP = prog(VERTEX_PASS, BLUR);
const showP = prog(VERTEX_PRESENT, SHOW);
const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
function target(w, h) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); return { texture:t, framebuffer:f, w, h };
}
function drawQuad(p, w, h) {
  const loc = gl.getAttribLocation(p, "position"); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.viewport(0, 0, w, h); gl.drawArrays(gl.TRIANGLES, 0, 6);
}
function blurInto(source, scratch, o, radius) {
  gl.useProgram(blurP); gl.uniform1f(gl.getUniformLocation(blurP,"radius"), radius);
  gl.uniform1i(gl.getUniformLocation(blurP,"source"), 0); gl.activeTexture(gl.TEXTURE0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, scratch.framebuffer); gl.bindTexture(gl.TEXTURE_2D, source);
  gl.uniform2f(gl.getUniformLocation(blurP,"direction"), 1/scratch.w, 0); drawQuad(blurP, scratch.w, scratch.h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, o.framebuffer); gl.bindTexture(gl.TEXTURE_2D, scratch.texture);
  gl.uniform2f(gl.getUniformLocation(blurP,"direction"), 0, 1/o.h); drawQuad(blurP, o.w, o.h);
}
function copy(source, into) {
  gl.useProgram(blurP); gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
  gl.uniform1f(gl.getUniformLocation(blurP,"radius"), 0); gl.uniform2f(gl.getUniformLocation(blurP,"direction"), 0, 0);
  gl.uniform1i(gl.getUniformLocation(blurP,"source"), 0); gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, source); drawQuad(blurP, into.w, into.h);
}

const MW = 256, MH = 144, MASK_MIX = 0.6, FEATHER = 2.0;
const maskA = target(MW, MH), maskB = target(MW, MH), maskScratch = target(MW, MH);
let maskReadsA = true, hasPrevious = false;
function updateMask(raw) {
  const write = maskReadsA ? maskB : maskA;
  const read = maskReadsA ? maskA : maskB;
  blurInto(raw, write, maskScratch, FEATHER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, write.framebuffer); gl.viewport(0, 0, write.w, write.h);
  if (hasPrevious) {
    gl.disable(gl.BLEND); copy(read.texture, write);
    gl.enable(gl.BLEND); gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA); gl.blendColor(0,0,0,MASK_MIX);
    copy(maskScratch.texture, write); gl.disable(gl.BLEND);
  } else { gl.disable(gl.BLEND); copy(maskScratch.texture, write); hasPrevious = true; }
  maskReadsA = !maskReadsA;
}
/** The current mask, sampled the way the composite samples it. */
function readComposite() {
  const cur = maskReadsA ? maskA : maskB;
  const W = 320, H = 180, t = target(W, H);
  gl.useProgram(showP); gl.bindFramebuffer(gl.FRAMEBUFFER, t.framebuffer);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, cur.texture);
  gl.uniform1i(gl.getUniformLocation(showP,"src"), 0); gl.disable(gl.BLEND); drawQuad(showP, W, H);
  const px = new Uint8Array(W*H*4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  // readPixels row 0 is the framebuffer bottom, so flip to make index 0 the visual top.
  const at = (c) => (x, y) => px[((((H-1-y)*W)+x)*4)+c] / 255;
  return { mask: bandsOf(at(0), W, H), alpha: bandsOf(at(1), W, H) };
}

const img = new Image(); img.src = "./person.img"; await img.decode();
out.image = img.naturalWidth + "x" + img.naturalHeight;

// 1. Where the person is in the input, by variance: a band containing a person has more
//    pixel-to-pixel variation than a wall. Crude, and enough to tell top from bottom.
{
  const W = 320, H = 180, c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  out.inputDetail = bandsOf((x, y) => {
    const i = (y*W+x)*4, j = (y*W + Math.min(x+1, W-1))*4;
    return Math.min(1, (Math.abs(d[i]-d[j]) + Math.abs(d[i+1]-d[j+1]) + Math.abs(d[i+2]-d[j+2])) / 90);
  }, W, H);
}

const fileset = await FilesetResolver.forVisionTasks("./mediapipe/wasm");
const seg = await ImageSegmenter.createFromOptions(fileset, {
  baseOptions: { modelAssetPath: "./mediapipe/selfie_segmenter_landscape.tflite", delegate: "GPU" },
  runningMode: "VIDEO", outputConfidenceMasks: true, outputCategoryMask: false, canvas,
});

for (let f = 1; f <= 12; f++) {
  await new Promise((res) => {
    seg.segmentForVideo(img, performance.now() + f*40, (result) => {
      const m = result.confidenceMasks?.[0];
      if (m) {
        if (f === 1) {
          out.confidenceMaskCount = result.confidenceMasks.length;
          out.maskSize = m.width + "x" + m.height;
          const arr = m.getAsFloat32Array();
          out.cpuMask = bandsOf((x, y) => arr[y*m.width+x], m.width, m.height);
          let max = 0; for (const v of arr) if (v > max) max = v;
          out.cpuMax = Math.round(max*100)/100;
        }
        updateMask(m.getAsWebGLTexture());
      }
      result.close(); res();
    });
  });
  if (f === 1 || f === 12) out.frames.push({ frame: f, ...readComposite() });
}
out.ok = true;
} catch (e) { out.error = String((e && e.stack) || e); }
window.__done = true;
</script></body></html>`;
writeFileSync(join(root, "index.html"), PAGE);

// A static server, because module imports and the wasm both need a real origin.
const PORT = 8877 + (process.pid % 200);
server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
  cwd: root,
  stdio: ["ignore", "ignore", "ignore"],
});

const CDP = 9470 + (process.pid % 90);
chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
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
const noise = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") noise.push("EXC " + m.params.exceptionDetails.text);
});
const call = (method, params = {}) =>
  new Promise((res) => { const at = ++id; pending.set(at, res); ws.send(JSON.stringify({ id: at, method, params })); });
const evaluate = async (expression) =>
  (await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))?.result?.result?.value;

await call("Runtime.enable");
await call("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
for (let i = 0; i < 90; i++) { await sleep(1000); if (await evaluate("window.__done === true")) break; }

const raw = await evaluate("JSON.stringify(window.__out ?? null)");
const r = raw ? JSON.parse(raw) : null;
if (!r || r.error) {
  console.error("probe failed:", r?.error ?? "no result", noise.slice(0, 3));
  cleanup(1);
}

const bar = (v) => "#".repeat(Math.max(0, Math.round(v / 4))).padEnd(10);
const show = (label, rows) =>
  console.log(`  ${label.padEnd(22)} ${rows.map((v) => String(v).padStart(3)).join(" ")}   ${bar(Math.max(...rows))}`);

console.log(`\nimage ${r.image}   mask ${r.maskSize}   confidenceMasks ${r.confidenceMaskCount}   peak ${r.cpuMax}`);
console.log("\nmean per horizontal band, INDEX 0 = TOP OF PICTURE:");
show("input detail", r.inputDetail);
show("mask (CPU truth)", r.cpuMask);
const first = r.frames.find((f) => f.frame === 1);
const last = r.frames.find((f) => f.frame === 12);
show("mask after chain f1", first.mask);
show("mask after chain f12", last.mask);
show("alpha f12", last.alpha);

/* Which half is heavier. Comparing halves rather than exact values is what makes this
 * work on any photograph: an inverted mask swaps them, and nothing else does. */
const half = (rows) => {
  const h = rows.length / 2;
  const top = rows.slice(0, h).reduce((a, b) => a + b, 0);
  const bottom = rows.slice(h).reduce((a, b) => a + b, 0);
  return { top, bottom, side: top === bottom ? "even" : top > bottom ? "top" : "bottom" };
};
const truth = half(r.cpuMask);
const chain = half(last.mask);
const detail = half(r.inputDetail);

console.log("");
let failures = 0;
const check = (ok, what, detailText = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${detailText ? ` — ${detailText}` : ""}`);
  if (!ok) failures++;
};

check(r.confidenceMaskCount === 1, "one confidence mask, which is the person's probability");
check(r.cpuMax > 0.8, "the model is confident somewhere", `peak ${r.cpuMax}`);
check(
  truth.side === detail.side,
  "the mask is on the same half of the picture as the person",
  `person ${detail.side}, mask ${truth.side}`,
);
check(
  chain.side === truth.side,
  "the GPU chain does not invert the mask",
  `CPU ${truth.side} (${truth.top}/${truth.bottom}), after chain ${chain.side} (${chain.top}/${chain.bottom})`,
);
/* The temporal blend must be a running average, not a slow corruption. When the copy
 * inside it still inverted V, this drifted from a correct mask on frame 1 to a flat field
 * by frame 4 — so comparing frame 1 with frame 12 is what catches it. */
const drift = last.mask.reduce((a, v, i) => a + Math.abs(v - first.mask[i]), 0);
check(drift <= 6, "the temporal blend is stable across frames", `total drift ${drift}`);
/* The alpha the composite actually uses, checked by HALF rather than by peak.
 *
 * A peak threshold is nearly worthless here: with the mask inverted and diffused, the
 * peak alpha was still 9% — a real number, in entirely the wrong place. Where the alpha
 * is has to be part of the assertion. */
const alphaHalf = half(last.alpha);
check(
  alphaHalf.side === detail.side && Math.max(...last.alpha) >= 8,
  "the composite keeps the person, on the person's own half of the picture",
  `person ${detail.side}, alpha ${alphaHalf.side} (${alphaHalf.top}/${alphaHalf.bottom}), peak ${Math.max(...last.alpha)}%`,
);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${6 - failures}/6 checks passed`);
cleanup(failures === 0 ? 0 : 1);
