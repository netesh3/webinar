/* The in-page half of probe-background.mjs, which bundles this with esbuild out of
 * web/node_modules. Everything here runs the modules the app ships — lib/backgrounds.ts and
 * lib/segmenter.ts themselves, React, livekit-client, MediaPipe — so nothing is a copy that can
 * drift. See the driver for what is asserted and why.
 *
 * Three pieces, and the rest is scenarios:
 *
 *   the camera     getUserMedia answered with a MediaStreamTrackGenerator fed from a photo,
 *                  so LiveKit opens, mutes and restarts a real track exactly as it would a
 *                  webcam. Each frame's timestamp is its index, which is how an output frame
 *                  is traced back to the picture it was made from.
 *   the sampler    reads whatever track.mediaStreamTrack is — what the preview shows and what
 *                  the audience is sent — and measures every frame against the input.
 *   the truth      MediaPipe on the CPU, in IMAGE mode, on the same pictures: where the person
 *                  is, so "the room is hidden" and "the person is kept" can be measured.
 */

import { createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createLocalVideoTrack } from "livekit-client";
import {
  enableCamera,
  openCamera,
  retryBackground,
  useBackgroundStatus,
  useVirtualBackground,
  VIRTUAL_BACKGROUNDS,
} from "../web/lib/backgrounds.ts";
import { SoftSegmenter } from "../web/lib/segmenter.ts";

const W = 1280;
const H = 720;
/** Where frames are measured: a quarter of the camera, which keeps every frame affordable. */
const SW = 320;
const SH = 180;
const N = SW * SH;
const RES = { width: W, height: H, frameRate: 30 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const probeLog = window.__probeLog;
const probeContexts = window.__probeContexts;
const params = new URLSearchParams(location.search);
const SESSION = params.get("session") ?? "A";

/* The two photos, and the part of each the camera sees.
 *
 * The desk crop has room to move: `dx` slides it sideways, which is the whole picture moving —
 * a camera being nudged, or somebody leaning — and is what the motion scenario does. */
const PHOTOS = {
  desk: { src: "/fixtures/desk.jpg", crop: (dx) => [160 + 5 * dx, 80, 1600, 900] },
  hair: { src: "/fixtures/hair.jpg", crop: () => [0, 0, 1920, 1080] },
};
const MOTION_DX = [];
for (let dx = -32; dx <= 32; dx += 4) MOTION_DX.push(dx);
const motionDx = (idx) => 4 * Math.round(8 * Math.sin((2 * Math.PI * idx) / 60));

/* Labels, from what a frame looks like against its own input.
 *
 * `raw` is set from the control run, which measures what an untouched frame's difference from
 * its reference is on this machine; the others are starting points the driver prints alongside
 * every run, so they can be judged rather than trusted. */
const T = { raw: 6, black: 8, image: 16, person: 10, sharp: 0.8, soft: 0.4, keep: 0.75, room: 0.5 };

// ------------------------------------------------------------------- the camera

const images = {};
const cam = {
  photo: "desk",
  motion: false,
  noise: false,
  idx: 0,
  sinks: new Set(),
  frames: new Map(),
  noisy: [],
  opened: 0,
};

const input = new OffscreenCanvas(W, H);
const ictx = input.getContext("2d", { alpha: false });

function drawInput(ctx, photo, dx) {
  const [sx, sy, sw, sh] = PHOTOS[photo].crop(dx);
  ctx.drawImage(images[photo], sx, sy, sw, sh, 0, 0, W, H);
}

/* Four copies of the still picture with a webcam's worth of sensor noise in each, cycled at
 * random. Without noise a still picture is the same picture every frame, the model's answer is
 * the same every frame, and flicker cannot happen — which would make a flicker test pass for
 * the wrong reason. Sigma 3 of 255 is a decent webcam in decent light. */
function makeNoisy(photo) {
  drawInput(ictx, photo, 0);
  const base = ictx.getImageData(0, 0, W, H);
  cam.noisy = [];
  for (let v = 0; v < 4; v++) {
    const img = new ImageData(new Uint8ClampedArray(base.data), W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const u = Math.random() || 1e-9;
        const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
        d[i + c] = d[i + c] + 3 * g;
      }
    }
    const canvas = new OffscreenCanvas(W, H);
    canvas.getContext("2d", { alpha: false }).putImageData(img, 0, 0);
    cam.noisy.push(canvas);
  }
}

function pump() {
  if (cam.sinks.size === 0) return;
  cam.idx += 1;
  const idx = cam.idx;
  const dx = cam.motion ? motionDx(idx) : 0;
  const variant = cam.noise && cam.noisy.length ? Math.floor(Math.random() * cam.noisy.length) : -1;
  if (variant >= 0) ictx.drawImage(cam.noisy[variant], 0, 0);
  else drawInput(ictx, cam.photo, dx);
  cam.frames.set(idx, { photo: cam.photo, dx, variant, at: now() });
  cam.frames.delete(idx - 6000);
  const frame = new VideoFrame(input, { timestamp: Math.round((idx * 1e6) / 30) });
  for (const sink of cam.sinks) {
    if (sink.track.readyState === "ended") {
      cam.sinks.delete(sink);
      continue;
    }
    const copy = frame.clone();
    sink.writer.write(copy).catch(() => {
      try {
        copy.close();
      } catch {}
      cam.sinks.delete(sink);
    });
  }
  frame.close();
}
setInterval(pump, 33);

const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async (constraints) => {
  if (!constraints?.video) return realGetUserMedia(constraints);
  cam.opened += 1;
  const track = new MediaStreamTrackGenerator({ kind: "video" });
  const writer = track.writable.getWriter();
  const settings = {
    width: W,
    height: H,
    frameRate: 30,
    aspectRatio: W / H,
    deviceId: "probe-camera",
    groupId: "probe",
    resizeMode: "none",
  };
  const real = track.getSettings.bind(track);
  track.getSettings = () => ({ ...real(), ...settings });
  track.getCapabilities = () => ({
    width: { min: 1, max: W },
    height: { min: 1, max: H },
    frameRate: { min: 1, max: 30 },
    deviceId: "probe-camera",
    groupId: "probe",
  });
  track.getConstraints = () => ({});
  track.applyConstraints = async () => {};
  cam.sinks.add({ track, writer });
  return new MediaStream([track]);
};

// ------------------------------------------------------------------ measuring

const mcanvas = new OffscreenCanvas(SW, SH);
const mctx = mcanvas.getContext("2d", { alpha: false, willReadFrequently: true });
mctx.imageSmoothingEnabled = true;
mctx.imageSmoothingQuality = "high";

/** A frame at measuring size, through exactly the path the sampler uses. */
function shrink(source) {
  mctx.drawImage(source, 0, 0, SW, SH);
  return mctx.getImageData(0, 0, SW, SH).data;
}

function lumaOf(px) {
  const l = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    l[i] = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
  }
  return l;
}

const laplacian = (luma, i) => 4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - SW] - luma[i + SW];

function detail(luma, idxs) {
  if (!idxs.length) return 0;
  let sum = 0;
  for (const i of idxs) sum += Math.abs(laplacian(luma, i));
  return sum / idxs.length;
}

/* Whether the room's own texture is in the picture: the correlation between the fine detail
 * of the output and of the camera frame, over the room. Near 1 when the room shows through,
 * whether or not it has been brightened; near 0 for a still, whose detail is its own, and for
 * a blur, which has none. Detail alone could not say this: a plain wall has less of it than
 * any still, so a still fading in over one would read as more detail than the room had. */
function sameTexture(luma, lap, idxs) {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  idxs.forEach((i, k) => {
    const a = laplacian(luma, i);
    ab += a * lap[k];
    aa += a * a;
    bb += lap[k] * lap[k];
  });
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

function meanAbs(a, b, idxs) {
  if (!idxs.length) return 0;
  let sum = 0;
  for (const i of idxs) {
    const o = i * 4;
    sum += Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2]);
  }
  return sum / (3 * idxs.length);
}

/* Distance from the person's outline, in measuring pixels, on each side of it — so the room is
 * judged well clear of the edge and the person well inside it, and the edge on its own. */
function regions(mask) {
  const inside = new Uint8Array(N);
  for (let i = 0; i < N; i++) inside[i] = mask[i] > 0.5 ? 1 : 0;
  const dist = (side) => {
    const d = new Float32Array(N);
    for (let i = 0; i < N; i++) d[i] = inside[i] === side ? 1e9 : 0;
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        const i = y * SW + x;
        if (!d[i]) continue;
        let m = d[i];
        if (x > 0) m = Math.min(m, d[i - 1] + 1);
        if (y > 0) {
          m = Math.min(m, d[i - SW] + 1);
          if (x > 0) m = Math.min(m, d[i - SW - 1] + 1);
          if (x < SW - 1) m = Math.min(m, d[i - SW + 1] + 1);
        }
        d[i] = m;
      }
    }
    for (let y = SH - 1; y >= 0; y--) {
      for (let x = SW - 1; x >= 0; x--) {
        const i = y * SW + x;
        if (!d[i]) continue;
        let m = d[i];
        if (x < SW - 1) m = Math.min(m, d[i + 1] + 1);
        if (y < SH - 1) {
          m = Math.min(m, d[i + SW] + 1);
          if (x < SW - 1) m = Math.min(m, d[i + SW + 1] + 1);
          if (x > 0) m = Math.min(m, d[i + SW - 1] + 1);
        }
        d[i] = m;
      }
    }
    return d;
  };
  const dIn = dist(1);
  const dOut = dist(0);
  const P = [];
  const R = [];
  const E = [];
  for (let y = 1; y < SH - 1; y++) {
    for (let x = 1; x < SW - 1; x++) {
      const i = y * SW + x;
      if (inside[i] && dIn[i] >= 4 && mask[i] > 0.9) P.push(i);
      if (!inside[i] && dOut[i] >= 6 && mask[i] < 0.1) R.push(i);
      if ((inside[i] ? dIn[i] : dOut[i]) <= 2) E.push(i);
    }
  }
  return { P: Int32Array.from(P), R: Int32Array.from(R), E: Int32Array.from(E) };
}

/* ------------------------------------------------------------------- the truth
 *
 * MediaPipe on the CPU, loaded from its own paths so the app's downloads can still be counted.
 * The same model the app runs on the GPU; IMAGE mode, so each picture is judged on its own. */

const refs = new Map();
const bgs = [];
const refKey = (photo, dx, variant = -1) => (variant >= 0 ? `${photo}:n${variant}` : `${photo}:${dx}`);

function resample(mask, mw, mh) {
  const out = new Float32Array(N);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const fx = ((x + 0.5) * mw) / SW - 0.5;
      const fy = ((y + 0.5) * mh) / SH - 0.5;
      const x0 = Math.max(0, Math.min(mw - 1, Math.floor(fx)));
      const y0 = Math.max(0, Math.min(mh - 1, Math.floor(fy)));
      const x1 = Math.min(mw - 1, x0 + 1);
      const y1 = Math.min(mh - 1, y0 + 1);
      const ax = Math.max(0, Math.min(1, fx - x0));
      const ay = Math.max(0, Math.min(1, fy - y0));
      const top = mask[y0 * mw + x0] * (1 - ax) + mask[y0 * mw + x1] * ax;
      const bottom = mask[y1 * mw + x0] * (1 - ax) + mask[y1 * mw + x1] * ax;
      out[y * SW + x] = top * (1 - ay) + bottom * ay;
    }
  }
  return out;
}

async function buildTruth(photo, dxs, withNoise) {
  const before = probeContexts.length;
  const vision = await import("@mediapipe/tasks-vision");
  const fileset = await vision.FilesetResolver.forVisionTasks("/truth-wasm");
  const segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "/truth/selfie_segmenter_landscape.tflite", delegate: "CPU" },
    runningMode: "IMAGE",
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { alpha: false });
  const one = (key, draw) => {
    draw(ctx);
    const frame = new VideoFrame(canvas, { timestamp: 0 });
    const raw = shrink(frame).slice();
    frame.close();
    const result = segmenter.segment(canvas);
    const m = result.confidenceMasks[0];
    const mask = resample(m.getAsFloat32Array(), m.width, m.height);
    result.close();
    const reg = regions(mask);
    const luma = lumaOf(raw);
    let lumaSum = 0;
    for (let i = 0; i < N; i++) lumaSum += luma[i];
    refs.set(key, {
      raw,
      mask,
      ...reg,
      luma: lumaSum / N,
      detR: detail(luma, reg.R),
      detP: detail(luma, reg.P),
      lapR: Float32Array.from(reg.R, (i) => laplacian(luma, i)),
    });
  };
  for (const dx of dxs) one(refKey(photo, dx), (c) => drawInput(c, photo, dx));
  if (withNoise) {
    makeNoisy(photo);
    cam.noisy.forEach((n, v) => one(refKey(photo, 0, v), (c) => c.drawImage(n, 0, 0)));
  }
  segmenter.close();
  // Handed back, so the app starts with the browser's contexts as a fresh tab would have them.
  for (const c of probeContexts.slice(before)) {
    if (!c.ctx.isContextLost()) c.ctx.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

async function loadBackgrounds() {
  for (const bg of VIRTUAL_BACKGROUNDS) {
    const img = new Image();
    img.src = bg.src;
    await img.decode();
    bgs.push({ id: bg.id, px: shrink(img).slice() });
  }
}

/* ------------------------------------------------------------------ the sampler
 *
 * Whatever track.mediaStreamTrack is at the moment — LiveKit swaps it for a new generator every
 * time the processor restarts — polled every few milliseconds, so a swap costs at most a frame. */

const alarms = new Set(["black", "raw", "raw-room"]);

function measure(px, ref, keepAlpha) {
  const luma = lumaOf(px);
  let lumaSum = 0;
  for (let i = 0; i < N; i++) lumaSum += luma[i];
  const m = {
    luma: lumaSum / N,
    lumaRef: ref.luma,
    dR: meanAbs(px, ref.raw, ref.R),
    dP: meanAbs(px, ref.raw, ref.P),
    detR: ref.detR ? detail(luma, ref.R) / ref.detR : 0,
    detP: ref.detP ? detail(luma, ref.P) / ref.detP : 0,
    roomR: sameTexture(luma, ref.lapR, ref.R),
    imageId: null,
    imageR: Infinity,
    imageP: Infinity,
  };
  for (const bg of bgs) {
    const d = meanAbs(px, bg.px, ref.R);
    if (d < m.imageR) {
      m.imageR = d;
      m.imageId = bg.id;
    }
  }
  m.label = labelOf(m, ref);
  if (m.label.startsWith("image:")) {
    const bg = bgs.find((b) => b.id === m.imageId).px;
    Object.assign(m, matte(px, ref, bg, keepAlpha));
  }
  return m;
}

function labelOf(m) {
  if (m.luma < T.black) return "black";
  if (m.dR < T.raw && m.dP < T.raw) return "raw";
  if (m.imageR < T.image) return m.dP < T.person ? `image:${m.imageId}` : `image:${m.imageId}~`;
  if (m.luma - m.lumaRef > 3 && m.detR > T.sharp && m.detP > T.sharp) return "lifted";
  if (m.detR < T.soft && m.detP > T.keep && m.dP < T.person) return "blur";
  if (m.detR < T.soft && m.detP < T.soft) return "veiled";
  if (m.roomR >= T.room) return "raw-room";
  return "fading";
}

/* How much of each pixel is the person, from the picture alone: where the output sits on the
 * line from the background still to the camera frame. Only where those two differ enough to
 * tell apart. */
function matte(px, ref, bg, keepAlpha) {
  const alpha = new Float32Array(N).fill(NaN);
  let inter = 0;
  let union = 0;
  let interHalf = 0;
  let unionHalf = 0;
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    const fr = ref.raw[o] - bg[o];
    const fg = ref.raw[o + 1] - bg[o + 1];
    const fb = ref.raw[o + 2] - bg[o + 2];
    const den = fr * fr + fg * fg + fb * fb;
    if (den < 1600) continue;
    const num = (px[o] - bg[o]) * fr + (px[o + 1] - bg[o + 1]) * fg + (px[o + 2] - bg[o + 2]) * fb;
    const a = Math.max(0, Math.min(1, num / den));
    alpha[i] = a;
    const shown = a > 0.5;
    const truth = ref.mask[i] > 0.685;
    const truthHalf = ref.mask[i] > 0.5;
    if (shown && truth) inter++;
    if (shown || truth) union++;
    if (shown && truthHalf) interHalf++;
    if (shown || truthHalf) unionHalf++;
  }
  const share = (idxs, pred) => {
    let n = 0;
    let hit = 0;
    for (const i of idxs) {
      if (Number.isNaN(alpha[i])) continue;
      n++;
      if (pred(alpha[i])) hit++;
    }
    return n ? hit / n : NaN;
  };
  const out = {
    iou: union ? inter / union : NaN,
    iouHalf: unionHalf ? interHalf / unionHalf : NaN,
    roomKept: share(ref.R, (a) => a > 0.5),
    personDropped: share(ref.P, (a) => a < 0.5),
  };
  // Over one fixed band, the same pixels in every frame, so consecutive frames can be compared.
  if (keepAlpha) out.alphaE = Float32Array.from(keepAlpha, (i) => alpha[i]);
  return out;
}

const sampler = {
  samples: [],
  thumbs: [],
  switches: [],
  track: null,
  current: null,
  reader: null,
  n: 0,
  timer: null,
  keepAlpha: false,
  sinceThumb: 0,

  watch(track) {
    this.track = track;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.poll(), 4);
    this.poll();
  },

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.reader?.cancel().catch(() => {});
    this.reader = null;
    this.current = null;
    this.track = null;
  },

  poll() {
    const t = this.track?.mediaStreamTrack ?? null;
    if (t === this.current) return;
    this.current = t;
    this.reader?.cancel().catch(() => {});
    this.reader = null;
    if (!t || t.readyState === "ended") return;
    const n = ++this.n;
    this.switches.push({ at: now(), n });
    const reader = new MediaStreamTrackProcessor({ track: t }).readable.getReader();
    this.reader = reader;
    let first = true;
    (async () => {
      for (;;) {
        let r;
        try {
          r = await reader.read();
        } catch {
          return;
        }
        if (r.done) return;
        this.take(r.value, n, first);
        first = false;
      }
    })();
  },

  take(frame, n, first) {
    const at = now();
    const ts = frame.timestamp;
    let px;
    try {
      px = shrink(frame);
    } finally {
      frame.close();
    }
    const idx = Math.round((ts * 30) / 1e6);
    const source = cam.frames.get(idx);
    const ref =
      refs.get(source ? refKey(source.photo, source.dx, source.variant) : "") ??
      refs.get(source ? refKey(source.photo, 0) : "") ??
      refs.get(refKey(cam.photo, 0));
    if (!ref) return;
    const m = measure(px, ref, this.keepAlpha);
    const s = { at, idx, n, lat: source ? at - source.at : NaN, key: source ? refKey(source.photo, source.dx, source.variant) : null, ...m };
    this.samples.push(s);
    this.sinceThumb++;
    if (first || this.sinceThumb >= 10 || alarms.has(m.label)) {
      this.sinceThumb = 0;
      const c = new OffscreenCanvas(SW / 2, SH / 2);
      c.getContext("2d").drawImage(mcanvas, 0, 0, SW / 2, SH / 2);
      this.thumbs.push({ at, label: m.label, n, canvas: c });
      if (this.thumbs.length > 400) this.thumbs.splice(0, 100);
    }
  },

  since(t) {
    return this.samples.filter((s) => s.at >= t);
  },
};

/* ---------------------------------------------------------------- the React side
 *
 * The hook the pre-join screen and the room both use, mounted as they mount it. The status is
 * read by a component of its own that is never unmounted, so every change is seen whichever
 * screen is showing. */

const statusLog = [];
let status = null;
function StatusSpy() {
  const s = useBackgroundStatus();
  if (s !== status) {
    status = s;
    statusLog.push({ at: now(), phase: s.phase, error: s.error, attempt: s.attempt });
  }
  return null;
}
const spyHost = document.createElement("div");
document.body.append(spyHost);
createRoot(spyHost).render(createElement(StatusSpy));

const events = [];
function Harness({ track, choice, lowLight }) {
  useVirtualBackground(track, choice, lowLight, () => events.push({ at: now(), what: "degraded" }));
  return null;
}

/** One screen showing the camera: the pre-join, or the room. */
function screen(strict = false) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  return {
    show(track, choice, lowLight = 0) {
      const el = createElement(Harness, { track, choice, lowLight });
      root.render(strict ? createElement(StrictMode, null, el) : el);
    },
    close() {
      root.unmount();
      host.remove();
    },
  };
}

/** The room's participant, as far as enableCamera can tell. */
function participant() {
  const pub = { track: undefined };
  return {
    pub,
    getTrackPublication: (source) => (source === "camera" && pub.track ? pub : undefined),
    async setCameraEnabled(on, options) {
      if (!pub.track) {
        if (on) pub.track = await createLocalVideoTrack({ resolution: RES, ...(options ?? {}) });
        return;
      }
      if (on) await pub.track.unmute();
      else await pub.track.mute();
    },
  };
}

// Which transformers were started, so "one processor" is counted rather than assumed.
const started = new Set();
const originalInit = SoftSegmenter.prototype.init;
SoftSegmenter.prototype.init = function (...args) {
  started.add(this);
  return originalInit.apply(this, args);
};

// ------------------------------------------------------------------- helpers

const BLUR = { mode: "blur" };
const NONE = { mode: "none" };
const image = (id) => ({ mode: "image", id });
const want = (choice, lowLight = 0) =>
  choice.mode === "blur" ? "blur" : choice.mode === "image" ? `image:${choice.id}` : lowLight > 0 ? "lifted" : "raw";

async function until(pred, ms, step = 20) {
  const end = now() + ms;
  while (now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return !!pred();
}

async function stats() {
  return (await fetch("/__probe/stats")).json();
}
async function modelDown(down) {
  await fetch(`/__probe/model?fail=${down ? 1 : 0}`);
}

const logsSince = (t, text) => probeLog.filter((l) => l.at >= t && l.text.startsWith(text));
const statusSince = (t) => statusLog.filter((s) => s.at >= t);
const firstStatus = (t, phase) => statusSince(t).find((s) => s.phase === phase)?.at ?? null;
const liveContexts = () => probeContexts.filter((c) => !c.ctx.isContextLost()).length;
const hidden = (label) =>
  label === "veiled" || label === "fading" || label === "blur" || label.startsWith("image:");
const softer = (label) => label === "veiled" || label === "fading" || label.endsWith("~");

function counts(samples) {
  const c = {};
  for (const s of samples) c[s.label] = (c[s.label] ?? 0) + 1;
  return c;
}

function timeline(samples, t0) {
  const out = [];
  let cur = null;
  for (const s of samples) {
    if (cur && cur.n === s.n && cur.label === s.label) {
      cur.count++;
      continue;
    }
    if (cur && cur.n !== s.n) out.push("|");
    cur = { n: s.n, label: s.label, count: 1, at: s.at };
    out.push(cur);
  }
  return out
    .map((r) => (r === "|" ? "|" : `${r.label}×${r.count}@${((r.at - t0) / 1000).toFixed(2)}`))
    .join(" ");
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const quantile = (xs, q) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
const describeFrames = (xs) =>
  xs.slice(0, 6).map((s) => `${s.label}@${Math.round(s.at)}`).join(", ") + (xs.length > 6 ? ", …" : "");

/** The processor LiveKit holds for a track, and the transformer inside it. */
const processorOf = (track) => track?.getProcessor?.();
const softOf = (track) => processorOf(track)?.soft;

async function sheet(name, t0, t1) {
  const picks = sampler.thumbs.filter((t) => t.at >= t0 && t.at < t1);
  const chosen = picks.length > 36 ? picks.filter((_, i) => i % Math.ceil(picks.length / 36) === 0) : picks;
  if (!chosen.length) return;
  const cols = 6;
  const tw = SW / 2;
  const th = SH / 2;
  const rows = Math.ceil(chosen.length / cols);
  const canvas = new OffscreenCanvas(cols * tw, rows * (th + 14));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = "11px sans-serif";
  chosen.forEach((t, i) => {
    const x = (i % cols) * tw;
    const y = Math.floor(i / cols) * (th + 14);
    ctx.drawImage(t.canvas, x, y);
    ctx.fillStyle = alarms.has(t.label) ? "#f55" : "#ddd";
    ctx.fillText(`${t.label} ${((t.at - t0) / 1000).toFixed(2)}s`, x + 3, y + th + 11);
  });
  const blob = await canvas.convertToBlob({ type: "image/png" });
  await fetch(`/__probe/sheet?name=${encodeURIComponent(`${SESSION}-${name}`)}`, { method: "POST", body: blob });
}

/* ------------------------------------------------------------------ assertions
 *
 * The checks every scenario shares, over a window of frames:
 *
 *   never black
 *   never the room, while a background is on and has not been given up on
 *   veiled only while something is genuinely on its way: until `settleBy`
 *   and, from `settleBy`, what was asked for
 */
function judge(check, samples, { what, expect, settleBy = -Infinity, allowRaw = false }) {
  const black = samples.filter((s) => s.label === "black");
  check(black.length === 0, `${what}: no black frames`, black.length ? describeFrames(black) : `${samples.length} frames`);
  if (!allowRaw) {
    const room = samples.filter((s) => s.label === "raw" || s.label === "raw-room");
    check(room.length === 0, `${what}: the room is never shown`, room.length ? `${room.length} frames: ${describeFrames(room)}` : `${samples.length} frames`);
  }
  if (expect) {
    const late = samples.filter((s) => s.at >= settleBy && s.label !== expect);
    const settled = samples.filter((s) => s.at >= settleBy);
    check(
      settled.length > 0 && late.length <= Math.max(1, settled.length * 0.02),
      `${what}: shows ${expect} once settled`,
      late.length ? `${late.length}/${settled.length} otherwise: ${JSON.stringify(counts(late))}` : `${settled.length} frames`,
    );
  }
}

// ------------------------------------------------------------------- scenarios

const scenarios = {};
const state = { track: null, prejoin: null, room: null, participant: null };

/* A camera with no processor at all: whether a frame's timestamp survives the trip from the
 * generator through a track to a reader (everything else depends on it), and what an untouched
 * frame measures as on this machine, which is where `raw` is drawn. */
scenarios.raw = async ({ check, info }) => {
  const t0 = now();
  const track = await createLocalVideoTrack({ resolution: RES });
  sampler.watch(track);
  await sleep(1500);
  const s = sampler.since(t0);
  const traced = s.filter((x) => x.key);
  check(
    s.length > 30 && traced.length >= s.length * 0.95,
    "a frame's timestamp survives camera → track → reader, so every output frame can be traced to its input",
    `${traced.length}/${s.length} traced, median ${r2(quantile(traced.map((x) => x.lat), 0.5))}ms after it was written`,
  );
  const worst = traced.map((x) => Math.max(x.dR, x.dP));
  T.raw = Math.max(4, 2.5 * quantile(worst, 0.99));
  info.untouched = { p50: r2(quantile(worst, 0.5)), p99: r2(quantile(worst, 0.99)), rawBelow: r2(T.raw) };

  // What LiveKit itself does at unmute, before the processor is blamed for anything there.
  await track.mute();
  await sleep(600);
  const u = now();
  await track.unmute();
  await sleep(1200);
  const after = sampler.since(u);
  info.unmuteWithoutProcessor = counts(after);
  check(after.length > 20, "an unprocessed camera comes back after unmute", `${after.length} frames`);
  track.stop();
  sampler.stop();
};

/* The pre-join screen, from cold: the camera opened with blur already on it. The first frame
 * anybody sees must already be processed — veiled while the model loads, never the room. */
scenarios.coldBlur = async ({ check, info }) => {
  const s0 = await stats();
  const t0 = now();
  const track = await openCamera(BLUR, 0, (processor) =>
    createLocalVideoTrack({ resolution: RES, processor }),
  );
  const opened = now();
  sampler.watch(track);
  state.track = track;
  state.prejoin = screen();
  state.prejoin.show(track, BLUR);
  const ready = await until(() => firstStatus(t0, "ready") !== null, 15000);
  const readyAt = firstStatus(t0, "ready");
  await sleep(1500);
  const s = sampler.since(t0);
  const s1 = await stats();
  check(ready, "reaches ready", ready ? `${Math.round(readyAt - t0)}ms after the camera was asked for` : JSON.stringify(statusSince(t0)));
  check(s.length && hidden(s[0].label), "the very first frame is already processed", s.length ? s[0].label : "no frames");
  judge(check, s, { what: "cold start", expect: "blur", settleBy: (readyAt ?? Infinity) + 500 });
  check(s1.tflite - s0.tflite === 1, "the model is downloaded once", `${s1.tflite - s0.tflite} downloads`);
  info.ms = {
    open: Math.round(opened - t0),
    firstFrame: s.length ? Math.round(s[0].at - t0) : null,
    ready: readyAt ? Math.round(readyAt - t0) : null,
    firstSharp: Math.round((s.find((x) => x.label === "blur")?.at ?? NaN) - t0),
  };
  info.labels = counts(s);
};

/* Every choice in turn on the running processor, as the tiles do it. No frame of the room on the
 * way through anything but None, and each still shown within a moment of the click — the first
 * visit of each has to decode it, and the blur or the last still stands in meanwhile. */
scenarios.switches = async ({ check, info }) => {
  const track = state.track;
  const order = [...VIRTUAL_BACKGROUNDS.map((b) => image(b.id)), NONE, BLUR, image("office"), BLUR];
  const lat = [];
  const s0 = await stats();
  for (const choice of order) {
    const t = now();
    state.prejoin.show(track, choice);
    await sleep(1300);
    const s = sampler.since(t);
    const expect = want(choice);
    judge(check, s, { what: `→ ${expect}`, expect, settleBy: t + 700, allowRaw: choice.mode === "none" });
    const hit = s.find((x) => x.label === expect);
    if (hit) lat.push(Math.round(hit.at - t));
    if (choice.mode !== "none") {
      const bad = s.filter((x) => x.at < t + 700 && !hidden(x.label));
      check(bad.length === 0, `→ ${expect}: nothing but a background while it switches`, bad.length ? describeFrames(bad) : "");
    }
  }
  const s1 = await stats();
  check(s1.tflite === s0.tflite, "switching never reloads the model", `${s1.tflite - s0.tflite} downloads`);
  info.msToShow = lat;
};

/* Moving, on a still: the matte keeps up with the picture rather than trailing it. Measured as
 * the overlap between where the output shows the person and where MediaPipe says they are, for
 * every frame, against the frame's own position. */
scenarios.motion = async ({ check, info }) => {
  const track = state.track;
  state.prejoin.show(track, image("office"));
  await sleep(800);
  const still = sampler.since(now() - 500).filter((s) => s.label === "image:office");
  cam.motion = true;
  const t = now();
  await sleep(4000);
  cam.motion = false;
  await sleep(400);
  const moving = sampler.since(t).filter((s) => s.at < t + 4000);
  judge(check, moving, { what: "moving", expect: "image:office", settleBy: t });
  const iou = moving.filter((s) => Number.isFinite(s.iou)).map((s) => s.iou);
  const iouStill = still.filter((s) => Number.isFinite(s.iou)).map((s) => s.iou);
  info.iou = { still: r2(mean(iouStill)), moving: r2(mean(iou)), movingP05: r2(quantile(iou, 0.05)) };
  info.moving = {
    roomKept: r2(mean(moving.map((s) => s.roomKept).filter(Number.isFinite))),
    personDropped: r2(mean(moving.map((s) => s.personDropped).filter(Number.isFinite))),
  };
  check(mean(iou) >= 0.9, "the person is where MediaPipe says, while moving (mean IoU ≥ 0.9)", JSON.stringify(info.iou));
  check(quantile(iou, 0.05) >= 0.8, "and on the worst frames (5th percentile IoU ≥ 0.8)", JSON.stringify(info.iou));
};

/* A listener that throws — a toast that could not be shown, a setState on a screen that has
 * gone — must not stop the video. Before safely() it errored the stream, and the wrapper answers
 * a stream error by destroying itself. */
scenarios.listenerThrows = async ({ check }) => {
  const track = state.track;
  state.prejoin.show(track, BLUR);
  await sleep(500);
  const soft = softOf(track);
  const t = now();
  soft.setOnFrame(() => {
    throw new Error("probe: a listener threw");
  });
  await sleep(1200);
  const s = sampler.since(t + 200);
  check(s.length >= 25, "frames keep coming after a listener throws", `${s.length} frames in a second`);
  judge(check, s, { what: "listener threw", expect: "blur" });
  const said = logsSince(t, "[background] a status or frame listener threw");
  check(said.length === 1, "said once in the console, not per frame", `${said.length} lines`);
  // Put a real listener back the way a screen would.
  state.prejoin.show(track, image("office"));
  await sleep(200);
  state.prejoin.show(track, BLUR);
  await sleep(300);
};

/* The camera off and on, as the pre-join toggle and the room's button do it. LiveKit stops the
 * device and restarts the processor on a new one; the engine, the model and the still survive,
 * so the first frame back is the background — not the room, and not a veil. */
scenarios.muteUnmute = async ({ check, info }) => {
  const track = state.track;
  const s0 = await stats();
  const firstBack = [];
  for (const choice of [image("office"), BLUR]) {
    state.prejoin.show(track, choice);
    await sleep(700);
    await track.mute();
    await sleep(700);
    const t = now();
    await track.unmute();
    await sleep(1500);
    const s = sampler.since(t);
    const expect = want(choice);
    check(s.length > 20, `unmuted on ${expect}: frames flow again`, `${s.length} frames`);
    judge(check, s, { what: `unmuted on ${expect}`, expect, settleBy: -Infinity });
    firstBack.push(s.length ? `${s[0].label} after ${Math.round(s[0].at - t)}ms` : "none");
  }
  const s1 = await stats();
  check(s1.tflite === s0.tflite, "unmuting never reloads the model", `${s1.tflite - s0.tflite} downloads`);
  info.firstFrameBack = firstBack;
};

/* The graphics context taken away once — the browser evicting it for another tab. The engine is
 * rebuilt and the model reloaded; meanwhile the frame is veiled, never the room. */
scenarios.loseOnce = async ({ check, info }) => {
  const track = state.track;
  state.prejoin.show(track, BLUR);
  await sleep(500);
  const s0 = await stats();
  const t = now();
  softOf(track).engine.gl.getExtension("WEBGL_lose_context").loseContext();
  const back = await until(() => firstStatus(t, "ready") !== null, 15000);
  const readyAt = firstStatus(t, "ready");
  await sleep(1500);
  const s = sampler.since(t);
  const s1 = await stats();
  check(logsSince(t, "[background] graphics context lost").length === 1, "the loss is noticed", "");
  check(back, "recovers by itself", back ? `${Math.round(readyAt - t)}ms` : JSON.stringify(statusSince(t)));
  judge(check, s, { what: "after a lost context", expect: "blur", settleBy: (readyAt ?? Infinity) + 500 });
  info.labels = counts(s);
  info.downloads = s1.tflite - s0.tflite;
  info.liveContexts = liveContexts();
  check(liveContexts() <= 2, "no contexts left behind", `${liveContexts()} live`);
};

/* The context taken away as fast as it can be rebuilt, which is what a machine that is out of
 * GPU for good looks like. It gives up after three rebuilds and says so in words a presenter can
 * act on — sending the camera as it is, because a permanently blurred camera looks broken. Then
 * Retry brings it back. */
scenarios.loseRepeatedly = async ({ check, info }) => {
  const track = state.track;
  const t = now();
  let losses = 0;
  const killer = setInterval(() => {
    const gl = softOf(track)?.engine?.gl;
    if (gl && !gl.isContextLost()) {
      gl.getExtension("WEBGL_lose_context").loseContext();
      losses++;
    }
  }, 15);
  const failed = await until(() => firstStatus(t, "failed") !== null, 15000);
  clearInterval(killer);
  const failedAt = firstStatus(t, "failed");
  check(failed, "gives up rather than fighting it", failed ? `after ${losses} losses, ${Math.round(failedAt - t)}ms` : JSON.stringify(statusSince(t)));
  const shown = statusSince(t).find((x) => x.phase === "failed")?.error ?? "";
  check(
    shown === "Couldn't start the background: your browser ran out of graphics capacity. Close a few tabs and try again.",
    "and says why, in a sentence",
    shown,
  );
  const before = sampler.since(t).filter((s) => s.at < (failedAt ?? Infinity));
  judge(check, before, { what: "while it keeps losing the context" });
  info.whileLosing = counts(before);
  await sleep(1000);
  info.afterGivingUp = counts(sampler.since((failedAt ?? t) + 300));

  const r = now();
  retryBackground();
  const back = await until(() => firstStatus(r, "ready") !== null, 15000);
  const readyAt = firstStatus(r, "ready");
  await sleep(1500);
  const s = sampler.since(r + 150);
  check(back, "Retry brings it back", back ? `${Math.round(readyAt - r)}ms` : JSON.stringify(statusSince(r)));
  judge(check, s, { what: "after Retry", expect: "blur", settleBy: (readyAt ?? Infinity) + 500 });
  info.liveContexts = liveContexts();
};

/* Joining: the pre-join screen goes and the room takes over its track, processor and all. The
 * track is published, so it gains a sid, which is a new key for the hook. Nothing reloads and
 * nothing flashes. */
scenarios.adopt = async ({ check, info }) => {
  const track = state.track;
  state.prejoin.show(track, image("library"));
  await sleep(1000);
  const s0 = await stats();
  const before = processorOf(track);
  const t = now();
  state.prejoin.close();
  state.prejoin = null;
  track.sid = "TR_probe";
  state.room = screen();
  state.room.show(track, image("library"));
  await sleep(1500);
  const s = sampler.since(t);
  const s1 = await stats();
  check(processorOf(track) === before, "the room keeps the pre-join screen's processor", "");
  check(s1.tflite === s0.tflite, "and does not reload the model", `${s1.tflite - s0.tflite} downloads`);
  judge(check, s, { what: "joining", expect: "image:library" });
  info.labels = counts(s);
};

/* The camera stopped and opened again straight away — the pre-join toggle, or another camera
 * chosen. A new processor, but the engine it would have built is still warm, so the model is not
 * downloaded again. */
scenarios.park = async ({ check, info }) => {
  state.room.close();
  state.room = null;
  sampler.stop();
  state.track.stop();
  await sleep(300);
  const s0 = await stats();
  const t = now();
  const track = await openCamera(BLUR, 0, (processor) =>
    createLocalVideoTrack({ resolution: RES, processor }),
  );
  sampler.watch(track);
  state.track = track;
  state.prejoin = screen();
  state.prejoin.show(track, BLUR);
  await sleep(2000);
  const s = sampler.since(t);
  const s1 = await stats();
  check(s1.tflite === s0.tflite, "a camera reopened within the minute reuses the warm model", `${s1.tflite - s0.tflite} downloads`);
  const firstAt = s[0]?.at ?? Infinity;
  judge(check, s, { what: "reopened", expect: "blur", settleBy: firstAt + 500 });
  info.labels = counts(s);
  info.firstFrame = s.length ? `${s[0].label} after ${Math.round(s[0].at - t)}ms` : null;
};

/* Somebody clicking about: the camera toggled and the choice changed faster than anything can
 * finish. Whatever the order, it must end on the last choice, with no contexts piling up. */
scenarios.churn = async ({ check, info }) => {
  const t = now();
  const choices = [image("horizon"), BLUR, image("studio"), NONE, image("conference")];
  for (const choice of choices) {
    state.prejoin.close();
    sampler.stop();
    state.track.stop();
    const track = await openCamera(choice, 0, (processor) =>
      createLocalVideoTrack({ resolution: RES, processor }),
    );
    state.track = track;
    sampler.watch(track);
    state.prejoin = screen();
    state.prejoin.show(track, choice);
    await sleep(120);
    state.prejoin.show(track, image("sage"));
    await sleep(80);
  }
  const settled = await until(() => status?.phase === "ready", 10000);
  await sleep(1500);
  const end = sampler.since(now() - 1000);
  check(settled, "settles", status?.phase);
  judge(check, end, { what: "after the churn", expect: "image:sage" });
  check(liveContexts() <= 2, "no contexts pile up", `${liveContexts()} live`);
  const failures = logsSince(t, "[background] failed to start").length + logsSince(t, "[background] gave up").length;
  check(failures === 0, "and nothing failed on the way", `${failures} failures`);
  info.startedTransformers = started.size;
};

/* The room's camera button, with a background already chosen: enableCamera opens the camera
 * with the processor on it, so the audience's first frame is not the room either. Then off and
 * on again, which in the room keeps the publication and restarts the processor. */
scenarios.enableCamera = async ({ check, info }) => {
  state.prejoin.close();
  state.prejoin = null;
  sampler.stop();
  state.track.stop();
  await sleep(200);
  const p = participant();
  state.participant = p;
  const choice = image("studio");
  const t = now();
  await enableCamera(p, choice, 0);
  const track = p.pub.track;
  sampler.watch(track);
  state.track = track;
  state.room = screen();
  state.room.show(track, choice);
  await until(() => status?.phase === "ready", 10000);
  await sleep(1200);
  const s = sampler.since(t);
  check(s.length && hidden(s[0].label), "the audience's first frame is already processed", s.length ? s[0].label : "none");
  judge(check, s, { what: "camera on in the room", expect: "image:studio", settleBy: now() - 800 });

  await p.setCameraEnabled(false);
  await sleep(600);
  const u = now();
  await enableCamera(p, choice, 0);
  await sleep(1500);
  const back = sampler.since(u);
  judge(check, back, { what: "camera back on in the room", expect: "image:studio" });
  info.firstBack = back.length ? `${back[0].label} after ${Math.round(back[0].at - u)}ms` : null;
};

/* Low light alone, then off: no model, no mask, the whole frame lifted — and off is off. */
scenarios.lowLight = async ({ check, info }) => {
  const track = state.track;
  const s0 = await stats();
  const t = now();
  state.room.show(track, NONE, 50);
  await sleep(1200);
  const lit = sampler.since(t + 200);
  check(lit.length && lit.every((s) => s.label === "lifted"), "low light on its own lifts every frame", JSON.stringify(counts(lit)));
  const u = now();
  state.room.show(track, NONE, 0);
  await sleep(1000);
  const off = sampler.since(u + 200);
  check(off.length && off.every((s) => s.label === "raw"), "and off is the camera as it is", JSON.stringify(counts(off)));
  const s1 = await stats();
  info.downloads = s1.tflite - s0.tflite;
};

/* Chosen with the camera off, in the room: the processor waits on a stopped camera and loads
 * the model meanwhile, so the camera comes on to the background — not to the room, and not to a
 * second of veil while the model loads. */
scenarios.dormant = async ({ check, info }) => {
  const p = participant();
  await enableCamera(p, NONE, 0);
  const track = p.pub.track;
  sampler.watch(track);
  const room = screen();
  room.show(track, NONE);
  await sleep(800);
  await p.setCameraEnabled(false);
  await sleep(300);
  const s0 = await stats();
  const t = now();
  room.show(track, BLUR);
  const warmed = await until(() => logsSince(t, "[background] segmentation ready").length > 0, 15000);
  check(warmed, "the model loads while the camera is off", warmed ? `${Math.round(logsSince(t, "[background] segmentation ready")[0].at - t)}ms` : "");
  await sleep(300);
  const u = now();
  await enableCamera(p, BLUR, 0);
  await sleep(1800);
  const s = sampler.since(u);
  const s1 = await stats();
  check(s.length && hidden(s[0].label), "the first frame after the camera comes on is processed", s.length ? `${s[0].label} after ${Math.round(s[0].at - u)}ms` : "none");
  judge(check, s, { what: "camera on after choosing blur", expect: "blur", settleBy: (s[0]?.at ?? Infinity) + 500 });
  check(s1.tflite - s0.tflite === 1, "the model downloaded once", `${s1.tflite - s0.tflite}`);
  info.labels = counts(s);
  info.timelineStart = s.slice(0, 14).map((x) => x.label).join(" ");
};

/* The model unreachable: veiled through the retries, then given up on with a sentence and a
 * Retry. The camera goes out as it is once it has given up — a background that can never arrive
 * is not a reason to show a blur forever — and Retry, with the network back, brings it. */
scenarios.modelDown = async ({ check, info }) => {
  await modelDown(true);
  const t = now();
  const track = await openCamera(BLUR, 0, (processor) =>
    createLocalVideoTrack({ resolution: RES, processor }),
  );
  sampler.watch(track);
  const pre = screen();
  pre.show(track, BLUR);
  const failed = await until(() => firstStatus(t, "failed") !== null, 20000);
  const failedAt = firstStatus(t, "failed");
  const shown = statusSince(t).find((x) => x.phase === "failed")?.error ?? "";
  check(failed, "gives up after its retries", failed ? `${Math.round(failedAt - t)}ms` : JSON.stringify(statusSince(t)));
  check(
    shown === "Couldn't download the background effect. Check your connection and try again.",
    "and says to check the connection",
    shown,
  );
  judge(check, sampler.since(t).filter((s) => s.at < (failedAt ?? Infinity)), { what: "while the model will not load" });
  await sleep(800);
  info.afterGivingUp = counts(sampler.since((failedAt ?? t) + 200));
  await modelDown(false);
  const r = now();
  retryBackground();
  const back = await until(() => firstStatus(r, "ready") !== null, 15000);
  const readyAt = firstStatus(r, "ready");
  await sleep(1500);
  check(back, "Retry with the network back brings it", back ? `${Math.round(readyAt - r)}ms` : JSON.stringify(statusSince(r)));
  judge(check, sampler.since(r + 150), { what: "after Retry", expect: "blur", settleBy: (readyAt ?? Infinity) + 500 });
};

/* React's StrictMode, which mounts every effect twice, and a presenter clicking through the tiles
 * while the model is still on its way. One processor, one download, and the last click wins. The
 * camera is already on when the first background is chosen, which is the one path where the room
 * was on show before the choice — so it only has to stop being shown once processing starts. */
scenarios.strictQuick = async ({ check, info }) => {
  const s0 = await stats();
  const t0 = now();
  const track = await createLocalVideoTrack({ resolution: RES });
  sampler.watch(track);
  const pre = screen(true);
  pre.show(track, NONE);
  await sleep(700);
  const seen = new Set();
  const watch = setInterval(() => {
    const p = processorOf(track);
    if (p) seen.add(p);
  }, 10);
  const t = now();
  for (const choice of [BLUR, image("office"), image("library"), BLUR, image("sage")]) {
    pre.show(track, choice);
    await sleep(150);
  }
  const ready = await until(() => firstStatus(t, "ready") !== null && status?.phase === "ready", 15000);
  await sleep(1500);
  clearInterval(watch);
  const s = sampler.since(t);
  const s1 = await stats();
  const firstProcessed = s.find((x) => x.label !== "raw");
  check(ready, "settles", status?.phase);
  check(seen.size === 1 && started.size === 1, "one processor, however many clicks and mounts", `${seen.size} attached, ${started.size} started`);
  check(s1.tflite - s0.tflite === 1, "one download", `${s1.tflite - s0.tflite}`);
  const afterFirst = s.filter((x) => x.at > (firstProcessed?.at ?? Infinity));
  judge(check, afterFirst, { what: "once processing starts", expect: "image:sage", settleBy: now() - 800 });
  info.msToFirstProcessed = firstProcessed ? Math.round(firstProcessed.at - t) : null;
  info.labels = counts(s);
  void t0;
};

/* Standing still, with sensor noise: how much the edge shimmers. MediaPipe's own answer moves a
 * little every frame with the noise; the temporal blend is there to hold a still edge still, so
 * the output must shimmer less than the model does. */
scenarios.stillFlicker = async ({ check, info }) => {
  cam.photo = "hair";
  cam.noise = true;
  const t0 = now();
  const track = await openCamera(image("office"), 0, (processor) =>
    createLocalVideoTrack({ resolution: RES, processor }),
  );
  sampler.watch(track);
  const pre = screen();
  pre.show(track, image("office"));
  await until(() => firstStatus(t0, "ready") !== null, 15000);
  await sleep(1200);
  judge(check, sampler.since(t0), {
    what: "opened on a still",
    expect: "image:office",
    settleBy: (firstStatus(t0, "ready") ?? Infinity) + 500,
  });

  // The edge, where the output can be read at all: the person and the still must differ.
  const ref = refs.get(refKey("hair", 0));
  const office = bgs.find((b) => b.id === "office").px;
  const band = ref.E.filter((i) => {
    const o = i * 4;
    const d = [0, 1, 2].map((c) => ref.raw[o + c] - office[o + c]);
    return d[0] * d[0] + d[1] * d[1] + d[2] * d[2] >= 1600;
  });
  sampler.keepAlpha = band;
  const t = now();
  await sleep(5000);
  sampler.keepAlpha = false;
  const s = sampler.since(t).filter((x) => x.alphaE);
  judge(check, s, { what: "still, with noise", expect: "image:office" });

  /* The shimmer, frame to frame, against what showing MediaPipe's answer as it stands would
   * have shimmered for the very same pair of frames — each frame is one of four noisy copies,
   * and the truth has the model's answer for each, through the smoothstep the composite uses. */
  const smooth = (m) => {
    const x = Math.max(0, Math.min(1, (m - 0.62) / (0.75 - 0.62)));
    return x * x * (3 - 2 * x);
  };
  const answers = new Map();
  const answer = (key) => {
    if (!answers.has(key)) {
      const m = refs.get(key)?.mask;
      answers.set(key, m ? Float32Array.from(band, (i) => smooth(m[i])) : null);
    }
    return answers.get(key);
  };
  const shown = [];
  const model = [];
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1].alphaE;
    const b = s[i].alphaE;
    const ma = answer(s[i - 1].key);
    const mb = answer(s[i].key);
    if (!ma || !mb) continue;
    let sum = 0;
    let msum = 0;
    let n = 0;
    for (let j = 0; j < a.length; j++) {
      if (Number.isNaN(a[j]) || Number.isNaN(b[j])) continue;
      sum += Math.abs(a[j] - b[j]);
      msum += Math.abs(ma[j] - mb[j]);
      n++;
    }
    if (!n) continue;
    shown.push(sum / n);
    model.push(msum / n);
  }
  const iou = s.map((x) => x.iou).filter(Number.isFinite);
  const r4 = (x) => Math.round(x * 1e4) / 1e4;
  info.edgeShimmer = {
    shown: r4(mean(shown)),
    modelAsIs: r4(mean(model)),
    // The number to compare between builds: how much of the model's own shimmer gets through.
    ratio: r2(mean(shown) / mean(model)),
    pairs: shown.length,
    band: band.length,
  };
  info.iou = r2(mean(iou));
  info.roomKept = r2(mean(s.map((x) => x.roomKept).filter(Number.isFinite)));
  info.personDropped = r2(mean(s.map((x) => x.personDropped).filter(Number.isFinite)));
  check(
    shown.length > 100 && mean(shown) <= mean(model),
    "a still edge shimmers less than MediaPipe's own answer would",
    JSON.stringify(info.edgeShimmer),
  );
  check(mean(iou) >= 0.9, "and sits where the model says (mean IoU ≥ 0.9)", String(info.iou));
};

// ------------------------------------------------------------------- the runner

const SESSIONS = {
  A: { photo: "desk", dxs: MOTION_DX, noise: false },
  B: { photo: "desk", dxs: [0], noise: false },
  C: { photo: "desk", dxs: [0], noise: false },
  D: { photo: "desk", dxs: [0], noise: false },
  E: { photo: "hair", dxs: [0], noise: true },
};

async function run(name) {
  const checks = [];
  const info = {};
  const check = (ok, what, detail = "") => checks.push({ ok: !!ok, what, detail: String(detail) });
  const t0 = now();
  const logFrom = probeLog.length;
  try {
    await scenarios[name]({ check, info });
  } catch (err) {
    checks.push({ ok: false, what: `${name} threw`, detail: String(err?.stack ?? err) });
  }
  const t1 = now();
  await sheet(name, t0, t1).catch(() => {});
  return {
    name,
    checks,
    info,
    timeline: timeline(sampler.samples.filter((s) => s.at >= t0 && s.at < t1), t0),
    status: statusLog.filter((s) => s.at >= t0).map((s) => `${s.phase}@${((s.at - t0) / 1000).toFixed(2)}`).join(" "),
    console: probeLog.slice(logFrom).map((l) => `${((l.at - t0) / 1000).toFixed(2)} ${l.level} ${l.text}${l.detail ? ` ${l.detail}` : ""}`),
  };
}

window.probe = {
  run,
  thresholds: (next) => Object.assign(T, next ?? {}),
  get T() {
    return { ...T };
  },
};

try {
  const setup = SESSIONS[SESSION];
  await Promise.all(
    Object.entries(PHOTOS).map(async ([name, p]) => {
      const res = await fetch(p.src);
      if (!res.ok) return;
      images[name] = await createImageBitmap(await res.blob());
    }),
  );
  if (!images[setup.photo]) throw new Error(`no ${setup.photo} photo was given`);
  cam.photo = setup.photo;
  await loadBackgrounds();
  await buildTruth(setup.photo, setup.dxs, setup.noise);
  /* Every label is measured inside the person or inside the room, so a photo with too little of
   * either measures nothing at all, and says so as a scatter of "fading" frames rather than as
   * the one sentence that would help. */
  for (const [key, r] of refs) {
    if (r.P.length < N * 0.03 || r.R.length < N * 0.03) {
      throw new Error(
        `MediaPipe finds ${r.P.length} person and ${r.R.length} room pixels of ${N} in ${key}; ` +
          "the probe needs a photo of one person, head and shoulders, with room around them",
      );
    }
  }
  const gl = new OffscreenCanvas(1, 1).getContext("webgl2");
  const info = gl?.getExtension("WEBGL_debug_renderer_info");
  window.__renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "unknown";
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
  window.__refs = [...refs.entries()].map(([k, r]) => ({ key: k, P: r.P.length, R: r.R.length, E: r.E.length, detR: r2(r.detR), detP: r2(r.detP) }));
  window.__ready = true;
} catch (err) {
  window.__ready = String(err?.stack ?? err);
}
