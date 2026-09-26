"use client";

/* MODNet portrait matting on WebGPU, for the Enhanced background.
 *
 * MediaPipe's selfie model gives a confidence per 256×144 texel and our pipeline turns that
 * into an edge. MODNet is a matting model: it gives a soft alpha at 512×288, so hair and
 * shoulders come out as a real edge rather than a guessed one. It needs a GPU to be fast
 * enough, so it runs only where WebGPU does; everywhere else — and on any failure here —
 * the MediaPipe path is used, with the presenter lock on either.
 *
 * Runtime: the onnxruntime-web build captions already ship (public/onnxruntime; its JSEP
 * files are the WebGPU backend), pinned in package.json to the version Transformers.js brings, so there is one copy. Its WebGPU
 * backend has been seen returning garbage masks for this model in other versions (1.30.0
 * gave empty or noisy alpha, raising nothing), so a session is only trusted after it agrees
 * with MediaPipe on the camera's own frames — see agreesWithReference.
 *
 * Model: MODNet (Apache-2.0), the ONNX export from onnx-community/modnet-webnn, served
 * from this origin at /matting/modnet.onnx. See public/matting/README.md.
 */

const ORT_WASM_PATH = "/onnxruntime/";
const MODEL_PATH = "/matting/modnet.onnx";

/** Model input. Multiples of 32 for MODNet's encoder; 16:9 so a webcam is not squashed. */
export const MODNET_W = 512;
export const MODNET_H = 288;

/* Declared rather than imported, as segmenter.ts does for MediaPipe: this dev build's
 * package.json "exports" has no "types" condition, so its own types.d.ts cannot be reached
 * from an import. Only what is used here. */
type Tensor = { dims: readonly number[]; getData: () => Promise<unknown>; dispose: () => void };
type Session = {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run: (feeds: Record<string, Tensor>) => Promise<Record<string, Tensor>>;
};
type Ort = {
  env: { wasm: { wasmPaths?: string }; logLevel?: string };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => Tensor;
  InferenceSession: {
    create: (
      url: string,
      options: { executionProviders: string[]; graphOptimizationLevel: string; logSeverityLevel: number },
    ) => Promise<Session>;
  };
};

export type Matte = { alpha: Float32Array; w: number; h: number };

let ortModule: Promise<Ort> | null = null;
function loadOrt(): Promise<Ort> {
  ortModule ??= (
    import(
      // @ts-expect-error -- no reachable types; see Ort above.
      "onnxruntime-web"
    ) as Promise<Ort>
  ).then((ort) => {
    ort.env.wasm.wasmPaths = ORT_WASM_PATH;
    ort.env.logLevel = "error";
    return ort;
  });
  return ortModule;
}

/** Whether this browser could run it at all. Cheap; does not create anything. */
export function modnetPossible(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator && typeof OffscreenCanvas !== "undefined";
}

/* One session per page, shared by every processor. ORT's WebGPU backend refuses a second
 * session being created while one is, and a 25 MB model is not something to load twice. */
let shared: Promise<Modnet | null> | null = null;

/** The shared MODNet, or null when this browser cannot run it. Never rejects. */
export function loadModnet(): Promise<Modnet | null> {
  shared ??= (async () => {
    if (!modnetPossible()) return null;
    try {
      const gpu = (navigator as unknown as { gpu: { requestAdapter: () => Promise<unknown> } }).gpu;
      if (!(await gpu.requestAdapter())) return null;
      const ort = await loadOrt();
      const began = performance.now();
      const session = await ort.InferenceSession.create(MODEL_PATH, {
        executionProviders: ["webgpu"],
        graphOptimizationLevel: "all",
        // Errors only: it otherwise warns, harmlessly, that shape ops stay on the CPU.
        logSeverityLevel: 3,
      });
      console.info("[background] MODNet ready", { ms: Math.round(performance.now() - began) });
      return new Modnet(ort, session);
    } catch (err) {
      console.warn("[background] MODNet unavailable; using MediaPipe", err);
      return null;
    }
  })();
  return shared;
}

export class Modnet {
  private readonly ort: Ort;
  private readonly session: Session;
  private readonly input: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private readonly tensor = new Float32Array(3 * MODNET_W * MODNET_H);

  constructor(ort: Ort, session: Session) {
    this.ort = ort;
    this.session = session;
    this.input = new OffscreenCanvas(MODNET_W, MODNET_H);
    const ctx = this.input.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2D canvas for MODNet input");
    this.ctx = ctx;
  }

  /** The frame at model size, as a canvas the face detector can read too. Synchronous, so
   *  the caller may close the frame as soon as this returns. */
  prepare(frame: VideoFrame): OffscreenCanvas {
    this.ctx.drawImage(frame, 0, 0, MODNET_W, MODNET_H);
    const px = this.ctx.getImageData(0, 0, MODNET_W, MODNET_H).data;
    const n = MODNET_W * MODNET_H;
    const t = this.tensor;
    // MODNet's normalisation: (x/255 − 0.5) / 0.5, planar RGB.
    for (let i = 0; i < n; i++) {
      t[i] = px[i * 4]! / 127.5 - 1;
      t[n + i] = px[i * 4 + 1]! / 127.5 - 1;
      t[2 * n + i] = px[i * 4 + 2]! / 127.5 - 1;
    }
    return this.input;
  }

  /** Runs the model on the last prepare()d frame. */
  async run(): Promise<Matte> {
    const feeds = {
      [this.session.inputNames[0]!]: new this.ort.Tensor("float32", this.tensor, [1, 3, MODNET_H, MODNET_W]),
    };
    const out = await this.session.run(feeds);
    const t = out[this.session.outputNames[0]!]!;
    try {
      const data = (await t.getData()) as Float32Array;
      const [, , h, w] = t.dims;
      return { alpha: Float32Array.from(data), w: w!, h: h! };
    } finally {
      t.dispose();
    }
  }
}

/* Does this matte look like the same person MediaPipe sees?
 *
 * The guard against a runtime that computes nonsense without saying so. Both are thresholded
 * at half and compared on MediaPipe's grid; intersection over union above AGREE_IOU is a
 * match. Frames with too little person in either are no evidence, so they return null. */
const AGREE_IOU = 0.6;
const AGREE_MIN_FRAC = 0.03;

export function agreesWithReference(
  matte: Matte,
  reference: Float32Array,
  rw: number,
  rh: number,
): boolean | null {
  let inter = 0;
  let union = 0;
  let a = 0;
  let b = 0;
  for (let y = 0; y < rh; y++) {
    const my = Math.min(matte.h - 1, Math.floor(((y + 0.5) * matte.h) / rh));
    for (let x = 0; x < rw; x++) {
      const mx = Math.min(matte.w - 1, Math.floor(((x + 0.5) * matte.w) / rw));
      const m = matte.alpha[my * matte.w + mx]! > 0.5;
      const r = reference[y * rw + x]! > 0.5;
      if (m) a++;
      if (r) b++;
      if (m && r) inter++;
      if (m || r) union++;
    }
  }
  const n = rw * rh;
  if (a < n * AGREE_MIN_FRAC && b < n * AGREE_MIN_FRAC) return null;
  return union > 0 && inter / union >= AGREE_IOU;
}
