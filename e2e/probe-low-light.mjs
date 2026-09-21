/* What the low-light curve actually does to pixels, in a real WebGL2 context.
 *
 *   node --experimental-strip-types --no-warnings e2e/probe-low-light.mjs
 *
 * Why a probe rather than a unit test. Every claim the curve makes is a claim about
 * arithmetic a GPU performs — that black stays black, that white stays white, that nothing
 * in between can leave [0,1] however far the slider goes. A JavaScript reimplementation of
 * the same formula would assert all of it and prove none of it: the thing that ships is a
 * GLSL string compiled by a driver, and `pow` on a half-precision float is not `Math.pow`.
 *
 * Why it does not transcribe. probe-mask.mjs has to copy segmenter.ts's shaders by hand and
 * says what that costs — "a copy that drifts is worse than no test". For a tone curve a
 * drifted copy is worse still, because it would keep passing while the shipped curve
 * clipped. So the curve lives in web/lib/low-light-curve.ts with no imports, and this file
 * imports the exact string the composite embeds. Nothing here can drift.
 *
 * No server and no MediaPipe: the curve knows nothing about where the person is, so this is
 * one shader, one 1x1 framebuffer, and a page in a temp directory.
 *
 * What it asserts, for amounts 0, 25, 50 and 100 (the slider's own units):
 *   1. amount 0 is the identity — off means off, to the exact byte
 *   2. pure black and pure white are fixed points, at every amount
 *   3. midtones rise, and rise monotonically with the amount, so the slider does something
 *      at every step and never reverses
 *   4. nothing clips: no channel that was below 255 comes out at 255
 *   5. hue is preserved on a saturated colour — the per-channel argument in the module
 *
 * Pass an image to also write a side-by-side strip of it at each amount:
 *
 *   node --experimental-strip-types --no-warnings e2e/probe-low-light.mjs some-photo.jpg
 *
 * Numbers say the curve is correct; they do not say 50 is the right default, which is a
 * judgement about a face in a room. That needs eyes, so the strip exists to put the four
 * amounts next to each other in one picture. Nothing is committed and no photo ships.
 */

import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { LOW_LIGHT_GLSL } = await import(
  resolve(here, "..", "web", "lib", "low-light-curve.ts")
);

/** Optional, and only for the strip: the assertions below need no image at all. */
const photo = process.argv[2] ? resolve(process.argv[2]) : null;

const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const root = mkdtempSync(join(tmpdir(), "lowlightprobe-"));
const profile = mkdtempSync(join(tmpdir(), "lowlightchrome-"));
let chrome = null;
let server = null;
let fails = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup(code) {
  for (const p of [chrome, server]) { try { p?.kill("SIGKILL"); } catch {} }
  for (const d of [root, profile]) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  process.exit(code);
}
process.on("SIGINT", () => cleanup(130));

/* The slider positions under test, in stored units, and the inputs.
 *
 * The inputs are what a dark webcam frame is made of: the two endpoints that must not move,
 * a deep shadow, the midtones a face sits in, a near-highlight that a gain would clip, and
 * one saturated colour to check the channels stay in proportion. */
const AMOUNTS = [0, 25, 50, 100];
const INPUTS = {
  black: [0, 0, 0],
  shadow: [16, 16, 16],
  face: [64, 64, 64],
  midGrey: [128, 128, 128],
  nearWhite: [240, 240, 240],
  white: [255, 255, 255],
  skin: [150, 110, 90],
};

if (photo) copyFileSync(photo, join(root, "photo.img"));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#111">
<canvas id="c" width="1" height="1"></canvas>
<canvas id="strip" style="display:block"></canvas>
<script type="module">
window.__done = false;
const AMOUNTS = ${JSON.stringify(AMOUNTS)};
const INPUTS = ${JSON.stringify(INPUTS)};
const PHOTO = ${photo ? '"photo.img"' : "null"};
const MAX = 100;   // matches LOW_LIGHT_MAX in lib/backgrounds.ts

const VERTEX = \`#version 300 es
in vec2 position;
void main(){ gl_Position = vec4(position, 0.0, 1.0); }\`;

/* The curve, imported rather than copied, wrapped in the smallest shader that can run it.
 * The input arrives as a uniform rather than a texture so there is no sampling, no
 * filtering and no format conversion between the value under test and the curve. */
const FRAGMENT = \`#version 300 es
precision highp float;
uniform vec3 inColor;
uniform float amount;
out vec4 color;
${LOW_LIGHT_GLSL}
void main(){ color = vec4(liftShadows(inColor, amount), 1.0); }\`;

const out = { results: {}, error: null };
window.__out = out;

try {
  const gl = document.getElementById("c").getContext("webgl2", {
    premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: false,
  });
  if (!gl) throw new Error("no WebGL2");

  const mk = (t, s) => {
    const sh = gl.createShader(t);
    gl.shaderSource(sh, s);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  gl.useProgram(p);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(p, "position");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const read = new Uint8Array(4);
  for (const amount of AMOUNTS) {
    out.results[amount] = {};
    for (const [name, rgb] of Object.entries(INPUTS)) {
      gl.uniform3f(gl.getUniformLocation(p, "inColor"), rgb[0]/255, rgb[1]/255, rgb[2]/255);
      gl.uniform1f(gl.getUniformLocation(p, "amount"), amount / MAX);
      gl.viewport(0, 0, 1, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, read);
      out.results[amount][name] = [read[0], read[1], read[2]];
    }
  }

  /* The strip: the same curve over a real image, once per amount, side by side.
   *
   * A second tiny program that samples a texture rather than reusing the one above, because
   * the one above takes its input as a uniform on purpose — no sampling between the value
   * and the curve is what makes the numbers trustworthy, and it is the wrong shape for an
   * image. Both include the identical imported curve, which is the part under test. */
  if (PHOTO) {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error("the image could not be decoded"));
      img.src = PHOTO;
    });

    const TEX_FRAGMENT = \`#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D src;
uniform float amount;
out vec4 color;
${LOW_LIGHT_GLSL}
void main(){ color = vec4(liftShadows(texture(src, uv).rgb, amount), 1.0); }\`;
    const TEX_VERTEX = \`#version 300 es
in vec2 position; out vec2 uv;
void main(){ uv = vec2((position.x+1.0)*0.5, 1.0-(position.y+1.0)*0.5); gl_Position = vec4(position,0.0,1.0); }\`;

    const tp = gl.createProgram();
    gl.attachShader(tp, mk(gl.VERTEX_SHADER, TEX_VERTEX));
    gl.attachShader(tp, mk(gl.FRAGMENT_SHADER, TEX_FRAGMENT));
    gl.linkProgram(tp);
    if (!gl.getProgramParameter(tp, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(tp));

    // One panel per amount, at a width that keeps four of them readable side by side.
    const pw = 420;
    const ph = Math.round((img.naturalHeight / img.naturalWidth) * pw);
    const work = document.getElementById("c");
    work.width = pw;
    work.height = ph;

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

    const strip = document.getElementById("strip");
    strip.width = pw * AMOUNTS.length;
    strip.height = ph + 26;
    const ctx = strip.getContext("2d");
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, strip.width, strip.height);

    gl.useProgram(tp);
    const tloc = gl.getAttribLocation(tp, "position");
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(tloc);
    gl.vertexAttribPointer(tloc, 2, gl.FLOAT, false, 0, 0);

    for (let i = 0; i < AMOUNTS.length; i++) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(tp, "src"), 0);
      gl.uniform1f(gl.getUniformLocation(tp, "amount"), AMOUNTS[i] / MAX);
      gl.viewport(0, 0, pw, ph);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      ctx.drawImage(work, i * pw, 26);
      ctx.fillStyle = "#fff";
      ctx.font = "14px -apple-system, system-ui, sans-serif";
      ctx.fillText(AMOUNTS[i] === 0 ? "Off" : AMOUNTS[i] + "%", i * pw + 10, 18);
    }
    out.strip = strip.toDataURL("image/png");
  }
} catch (err) {
  out.error = String(err && err.message ? err.message : err);
}
window.__done = true;
</script></body></html>`;

writeFileSync(join(root, "index.html"), PAGE);

/* A static server rather than a file:// URL, and it is load-bearing for the strip.
 *
 * An image loaded from file:// into a canvas taints it, and a tainted canvas refuses
 * toDataURL — so the strip would throw SecurityError on the last line after all the work.
 * Same reason probe-mask.mjs serves its page. */
const PORT = 8677 + (process.pid % 200);
server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
  cwd: root,
  stdio: ["ignore", "ignore", "ignore"],
});

const CDP = 9760 + (process.pid % 90);
chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    // A real GPU rather than the software rasteriser where one is available: the point of
    // this probe is what a driver does with pow() on a float, not what SwiftShader does.
    "--use-gl=angle",
    `http://127.0.0.1:${PORT}/index.html`,
  ],
  { stdio: ["ignore", "ignore", "ignore"] },
);

let ws;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const page = list.find((t) => t.type === "page");
    if (page?.webSocketDebuggerUrl) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch {}
  await sleep(250);
}
if (!ws) { console.error("Chrome never exposed a debugging target"); cleanup(1); }
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const call = (method, params = {}) =>
  new Promise((res) => { const at = ++id; pending.set(at, res); ws.send(JSON.stringify({ id: at, method, params })); });
const evaluate = async (expression) =>
  (await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))
    ?.result?.result?.value;

await call("Runtime.enable");
await call("Page.enable");

let done = false;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  if (await evaluate("window.__done === true")) { done = true; break; }
}
if (!done) { console.error("the page never finished"); cleanup(1); }

const out = await evaluate("window.__out");
if (!out || out.error) {
  console.error(`the shader did not run: ${out?.error ?? "no result"}`);
  cleanup(1);
}

console.log("\n== the low-light curve, on a real GPU");
console.log(`  amounts ${AMOUNTS.join(", ")} (stored units)\n`);

const mean = (rgb) => (rgb[0] + rgb[1] + rgb[2]) / 3;

// The table first, because every assertion below is a claim about it and a reader
// disagreeing with a threshold should be able to see the numbers it was drawn from.
for (const [name, rgb] of Object.entries(INPUTS)) {
  const row = AMOUNTS.map((a) => String(Math.round(mean(out.results[a][name]))).padStart(4));
  console.log(`  ${name.padEnd(10)} ${String(Math.round(mean(rgb))).padStart(3)} ->${row.join("")}`);
}
console.log("");

/* ------------------------------------------------------- 1. off means off */
const identity = Object.entries(INPUTS).every(([name, rgb]) =>
  out.results[0][name].every((v, i) => v === rgb[i]),
);
identity
  ? ok("amount 0 is the identity, to the byte")
  : bad(`amount 0 changed something: ${JSON.stringify(out.results[0])}`);

/* --------------------------------------------- 2. the endpoints do not move */
for (const [name, want] of [["black", 0], ["white", 255]]) {
  const moved = AMOUNTS.filter((a) => out.results[a][name].some((v) => v !== want));
  moved.length === 0
    ? ok(`${name} is a fixed point at every amount`)
    : bad(`${name} moved at amount(s) ${moved.join(", ")}: ${JSON.stringify(moved.map((a) => out.results[a][name]))}`);
}

/* ----------------------------------- 3. midtones rise, and rise monotonically */
for (const name of ["shadow", "face", "midGrey"]) {
  const series = AMOUNTS.map((a) => mean(out.results[a][name]));
  let monotonic = true;
  for (let i = 1; i < series.length; i++) if (series[i] < series[i - 1]) monotonic = false;
  const rose = series.at(-1) > series[0] + 2;
  monotonic && rose
    ? ok(`${name} rises monotonically: ${series.map((v) => Math.round(v)).join(" -> ")}`)
    : bad(`${name} is not a rising series: ${series.map((v) => Math.round(v)).join(" -> ")}`);
}

/* -------------------------------------------------------- 4. nothing clips */
const clipped = [];
for (const amount of AMOUNTS) {
  for (const [name, rgb] of Object.entries(INPUTS)) {
    out.results[amount][name].forEach((v, i) => {
      if (v >= 255 && rgb[i] < 255) clipped.push(`${name}[${i}] at ${amount}`);
    });
  }
}
clipped.length === 0
  ? ok("nothing that was below 255 reached it — no channel clipped")
  : bad(`clipped: ${clipped.join(", ")}`);

/* ------------------------------------ 5. a saturated colour keeps its order */
const skinOrdered = AMOUNTS.every((a) => {
  const [r, g, b] = out.results[a].skin;
  return r > g && g > b;
});
skinOrdered
  ? ok("a saturated colour keeps its channel order at every amount")
  : bad(`channel order broke on skin: ${JSON.stringify(AMOUNTS.map((a) => out.results[a].skin))}`);

/* How much of a lift the top of the slider actually is, reported rather than asserted.
 * Whether it is the right amount is a judgement about faces, and belongs to whoever is
 * looking at their own camera — not to a threshold in here. */
const faceLift = mean(out.results[100].face) / mean(out.results[0].face);
console.log(`\n  at full slider a face midtone is ${faceLift.toFixed(2)}x brighter`);
console.log(`  (${Math.round(mean(out.results[0].face))} -> ${Math.round(mean(out.results[100].face))} of 255)`);

if (photo) {
  const strip = await evaluate("window.__out.strip");
  if (typeof strip === "string" && strip.startsWith("data:image/png;base64,")) {
    const name = `/tmp/low-light-${basename(photo, extname(photo))}.png`;
    writeFileSync(name, Buffer.from(strip.slice("data:image/png;base64,".length), "base64"));
    console.log(`\n  strip: ${name}`);
  } else {
    bad("the strip was not produced");
  }
}

console.log(fails === 0 ? "\nALL PASS\n" : `\n${fails} FAILED\n`);
cleanup(fails === 0 ? 0 : 1);
