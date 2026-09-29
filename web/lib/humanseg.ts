"use client";

/* PP-HumanSegV2-Lite on the CPU, for the background — the one model, on every browser.
 *
 * The same shape as Zoom's web background: a small segmentation network at 256×144, a
 * frame-to-frame step that looks at the previous frame and the previous mask, and an edge
 * refinement that makes the mask follow the picture. None of it is Zoom's code or model:
 *
 *   model      PP-HumanSegV2-Lite (PaddleSeg, Apache-2.0), exported to ONNX and served from
 *              /models/humanseg.onnx — see public/models/README.md. Softmax over
 *              [background, person]; the person channel is the mask.
 *   temporal   block-matching motion between frames (luma at 160×90); the previous mask is
 *              moved along it, and where the new mask drops something the moved picture
 *              says is still there, most of the old value is kept. See Temporal.
 *   guided     off. The guided filter (He, Sun & Tang 2010) used to pull the 256×144 mask
 *              onto the picture's edges at 512×288. On a real camera that softened the
 *              person: shoulders and hair went translucent and parts of them disappeared
 *              into the background. The model's own cut, after the frame-to-frame step,
 *              is the edge. The filter is still in this file. See GUIDED_FILTER.
 *
 * Runtime: the onnxruntime-web build captions already ship (public/onnxruntime), on its
 * WebAssembly backend. WebAssembly runs everywhere, which is why this has no fallback: the
 * model is about 4 ms a frame on a laptop CPU, the whole step here about 10.
 *
 * The presenter lock runs between run() and refine(), on the model's own mask, as it did
 * for the models before this one.
 */

const ORT_WASM_PATH = "/onnxruntime/";
const MODEL_PATH = "/models/humanseg.onnx";

/** Model input. Fixed in the export. */
export const MODEL_W = 256;
export const MODEL_H = 144;
/** The refined mask handed to the compositor when the guided filter is on. */
export const OUT_W = 512;
export const OUT_H = 288;

/* The second filter, after the frame-to-frame step.
 *
 * Off. It made the mask follow luma edges, and on a webcam that reads as the person
 * blurred into the background or missing in patches. The model's mask is the cut. */
const GUIDED_FILTER = false;

/* Declared rather than imported: this onnxruntime-web build's package.json "exports" has
 * no "types" condition, so its own types cannot be reached. Only what is used here. */
type Tensor = { dims: readonly number[]; getData: () => Promise<unknown>; dispose: () => void };
type Session = {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run: (feeds: Record<string, Tensor>) => Promise<Record<string, Tensor>>;
};
type Ort = {
  env: { wasm: { wasmPaths?: string; numThreads?: number }; logLevel?: string };
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

/* One session per page, shared by every processor: the pre-join screen's and the room's
 * are alive together for a moment, and a model is not something to load twice. Runs are
 * queued, because a WebAssembly session runs one inference at a time. */
type Shared = { ort: Ort; session: Session; queue: Promise<unknown> };
let shared: Promise<Shared> | null = null;

/** The shared session. Rejects if it cannot be made; a later call tries again. */
function loadShared(): Promise<Shared> {
  shared ??= (async () => {
    const ort = await loadOrt();
    const began = performance.now();
    const session = await ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
      logSeverityLevel: 3,
    });
    console.info("[background] segmentation ready", {
      model: MODEL_PATH,
      ms: Math.round(performance.now() - began),
    });
    return { ort, session, queue: Promise.resolve() };
  })().catch((err: unknown) => {
    shared = null;
    throw err;
  });
  return shared;
}

/** A processor's own model: the shared session, with this processor's history. */
export async function loadHumanSeg(): Promise<HumanSeg> {
  return new HumanSeg(await loadShared());
}

function canvas2d(w: number, h: number): OffscreenCanvasRenderingContext2D {
  const ctx = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2D canvas for the background model");
  return ctx;
}

export class HumanSeg {
  private readonly shared: Shared;
  private readonly input = canvas2d(MODEL_W, MODEL_H);
  private readonly tensor = new Float32Array(3 * MODEL_W * MODEL_H);
  private readonly temporal = new Temporal(MODEL_W, MODEL_H);
  private readonly guided = GUIDED_FILTER ? new Guided(OUT_W, OUT_H, 4, 2e-3) : null;

  constructor(shared: Shared) {
    this.shared = shared;
  }

  /** The frame, read into everything this needs. Synchronous, so the caller may close the
   *  frame as soon as it returns. */
  prepare(frame: VideoFrame): void {
    this.input.drawImage(frame, 0, 0, MODEL_W, MODEL_H);
    const px = this.input.getImageData(0, 0, MODEL_W, MODEL_H).data;
    const n = MODEL_W * MODEL_H;
    const t = this.tensor;
    // PaddleSeg's normalisation: (x/255 − 0.5) / 0.5, planar RGB.
    for (let i = 0; i < n; i++) {
      t[i] = px[i * 4]! / 127.5 - 1;
      t[n + i] = px[i * 4 + 1]! / 127.5 - 1;
      t[2 * n + i] = px[i * 4 + 2]! / 127.5 - 1;
    }
    this.temporal.see(frame);
    this.guided?.see(frame);
  }

  /** The model's mask of the last prepare()d frame, MODEL_W×MODEL_H, 0..1, row 0 at the top. */
  run(): Promise<Matte> {
    const { ort, session } = this.shared;
    const feeds = {
      [session.inputNames[0]!]: new ort.Tensor("float32", this.tensor.slice(), [1, 3, MODEL_H, MODEL_W]),
    };
    const turn = this.shared.queue.then(async () => {
      const out = await session.run(feeds);
      const t = out[session.outputNames[0]!]!;
      try {
        const data = (await t.getData()) as Float32Array;
        const n = MODEL_W * MODEL_H;
        return { alpha: Float32Array.from(data.subarray(n, 2 * n)), w: MODEL_W, h: MODEL_H };
      } finally {
        t.dispose();
      }
    });
    this.shared.queue = turn.catch(() => undefined);
    return turn;
  }

  /** The frame-to-frame step, then — only when GUIDED_FILTER is on — the edge refinement,
   *  on a mask from run() (after the lock has had it). The array is reused by the next call. */
  refine(mask: Matte): Matte {
    const held = this.temporal.step(mask.alpha);
    if (!this.guided) return { alpha: held, w: MODEL_W, h: MODEL_H };
    return { alpha: this.guided.run(held, MODEL_W, MODEL_H), w: OUT_W, h: OUT_H };
  }

  /** A new camera, or a gap: the last mask is not of this picture. */
  forget(): void {
    this.temporal.forget();
  }
}

/* The frame-to-frame step, in the spirit of Zoom's second network (previous frame and
 * previous mask in, mask out) but without a trained model:
 *   1. block-matching motion between the previous frame and this one, luma at LW×LH
 *   2. the previous output mask moved along that motion
 *   3. where the moved picture matches this one, a light blend with the moved mask, against
 *      shimmer; and where the new mask has dropped something that was confidently the person
 *      and the picture did not change there, most of the moved value is kept. Where the
 *      picture changed, the model's new answer is taken as it is — nothing trails. */
const LW = 160;
const LH = 90;
/** Block size and search radius, in luma pixels. */
const FLOW_BLOCK = 8;
const FLOW_RADIUS = 6;
/** Share of the moved mask blended in where nothing changed. */
const STILL_KEEP = 0.5;
/** Share of an unexplained drop that is held, of a texel at least HOLD_CORE person. */
const HOLD = 0.85;
const HOLD_CORE = 0.5;
/** Moved-luma mismatch from which the picture is trusted less (LO) and not at all (HI). */
const ERR_LO = 0.04;
const ERR_HI = 0.12;

class Temporal {
  private readonly gw: number;
  private readonly gh: number;
  private readonly luma = canvas2d(LW, LH);
  private readonly cur = new Float32Array(LW * LH);
  private prev: Float32Array | null = null;
  private prevMask: Float32Array | null = null;
  private readonly bw = Math.ceil(LW / FLOW_BLOCK);
  private readonly bh = Math.ceil(LH / FLOW_BLOCK);
  private readonly fx: Float32Array;
  private readonly fy: Float32Array;
  private readonly out: Float32Array;

  constructor(gw: number, gh: number) {
    this.gw = gw;
    this.gh = gh;
    this.fx = new Float32Array(this.bw * this.bh);
    this.fy = new Float32Array(this.bw * this.bh);
    this.out = new Float32Array(gw * gh);
  }

  see(frame: VideoFrame): void {
    this.luma.drawImage(frame, 0, 0, LW, LH);
    const px = this.luma.getImageData(0, 0, LW, LH).data;
    for (let i = 0; i < LW * LH; i++) {
      this.cur[i] = (0.299 * px[i * 4]! + 0.587 * px[i * 4 + 1]! + 0.114 * px[i * 4 + 2]!) / 255;
    }
  }

  forget(): void {
    this.prev = null;
    this.prevMask = null;
  }

  step(mask: Float32Array): Float32Array {
    const { gw, gh, cur, out } = this;
    if (!this.prev || !this.prevMask) {
      this.prev = Float32Array.from(cur);
      this.prevMask = Float32Array.from(mask);
      out.set(mask);
      return out;
    }
    const prev = this.prev;
    const prevMask = this.prevMask;
    this.flow(prev);
    const sx = LW / gw;
    const sy = LH / gh;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const n = mask[i]!;
        const lx = (x + 0.5) * sx - 0.5;
        const ly = (y + 0.5) * sy - 0.5;
        const dx = this.flowAt(this.fx, lx, ly);
        const dy = this.flowAt(this.fy, lx, ly);
        const p = sample(prevMask, gw, gh, x + dx / sx, y + dy / sy);
        const err = Math.abs(sample(cur, LW, LH, lx, ly) - sample(prev, LW, LH, lx + dx, ly + dy));
        const trust = 1 - Math.min(1, Math.max(0, (err - ERR_LO) / (ERR_HI - ERR_LO)));
        let v = n + (p - n) * STILL_KEEP * trust;
        if (p > n && p >= HOLD_CORE) v = Math.max(v, n + (p - n) * HOLD * trust);
        out[i] = v;
      }
    }
    prev.set(cur);
    prevMask.set(out);
    return out;
  }

  /** For each block of this frame, where it came from in the previous one. */
  private flow(prev: Float32Array): void {
    const { cur, bw, bh } = this;
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const x0 = bx * FLOW_BLOCK;
        const y0 = by * FLOW_BLOCK;
        const x1 = Math.min(LW, x0 + FLOW_BLOCK);
        const y1 = Math.min(LH, y0 + FLOW_BLOCK);
        let best = Infinity;
        let bdx = 0;
        let bdy = 0;
        for (let dy = -FLOW_RADIUS; dy <= FLOW_RADIUS; dy++) {
          for (let dx = -FLOW_RADIUS; dx <= FLOW_RADIUS; dx++) {
            // A small preference for small motion, so a flat wall does not wander.
            let sad = 0.002 * (dx * dx + dy * dy);
            for (let y = y0; y < y1 && sad < best; y++) {
              const py = Math.min(LH - 1, Math.max(0, y + dy)) * LW;
              for (let x = x0; x < x1; x++) {
                sad += Math.abs(cur[y * LW + x]! - prev[py + Math.min(LW - 1, Math.max(0, x + dx))]!);
              }
            }
            if (sad < best) {
              best = sad;
              bdx = dx;
              bdy = dy;
            }
          }
        }
        this.fx[by * bw + bx] = bdx;
        this.fy[by * bw + bx] = bdy;
      }
    }
  }

  private flowAt(f: Float32Array, x: number, y: number): number {
    const { bw, bh } = this;
    const gx = Math.min(bw - 1, Math.max(0, x / FLOW_BLOCK - 0.5));
    const gy = Math.min(bh - 1, Math.max(0, y / FLOW_BLOCK - 0.5));
    return sample(f, bw, bh, gx, gy);
  }
}

function sample(img: Float32Array, w: number, h: number, x: number, y: number): number {
  x = Math.min(w - 1, Math.max(0, x));
  y = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const ax = x - x0;
  const ay = y - y0;
  return (
    (img[y0 * w + x0]! * (1 - ax) + img[y0 * w + x1]! * ax) * (1 - ay) +
    (img[y1 * w + x0]! * (1 - ax) + img[y1 * w + x1]! * ax) * ay
  );
}

/* The guided filter: a coarse mask refined so its edges follow the frame's. Grey guide, box
 * means by integral image, so the cost does not depend on the radius. */
class Guided {
  private readonly W: number;
  private readonly H: number;
  private readonly r: number;
  private readonly eps: number;
  private readonly guide: OffscreenCanvasRenderingContext2D;
  private readonly I: Float32Array;
  private readonly P: Float32Array;
  private readonly out: Float32Array;
  private readonly mI: Float32Array;
  private readonly mP: Float32Array;
  private readonly mIP: Float32Array;
  private readonly mII: Float32Array;
  private readonly A: Float32Array;
  private readonly B: Float32Array;
  private readonly tmp: Float32Array;
  private readonly S: Float64Array;

  constructor(W: number, H: number, r: number, eps: number) {
    this.W = W;
    this.H = H;
    this.r = r;
    this.eps = eps;
    this.guide = canvas2d(W, H);
    const n = W * H;
    this.I = new Float32Array(n);
    this.P = new Float32Array(n);
    this.out = new Float32Array(n);
    this.mI = new Float32Array(n);
    this.mP = new Float32Array(n);
    this.mIP = new Float32Array(n);
    this.mII = new Float32Array(n);
    this.A = new Float32Array(n);
    this.B = new Float32Array(n);
    this.tmp = new Float32Array(n);
    this.S = new Float64Array((W + 1) * (H + 1));
  }

  see(frame: VideoFrame): void {
    const { W, H, I } = this;
    this.guide.drawImage(frame, 0, 0, W, H);
    const px = this.guide.getImageData(0, 0, W, H).data;
    for (let i = 0; i < W * H; i++) I[i] = (0.299 * px[i * 4]! + 0.587 * px[i * 4 + 1]! + 0.114 * px[i * 4 + 2]!) / 255;
  }

  run(mask: Float32Array, mw: number, mh: number): Float32Array {
    const { W, H, I, P, out, mI, mP, mIP, mII, A, B, tmp } = this;
    const n = W * H;
    for (let y = 0; y < H; y++) {
      const sy = ((y + 0.5) * mh) / H - 0.5;
      for (let x = 0; x < W; x++) P[y * W + x] = sample(mask, mw, mh, ((x + 0.5) * mw) / W - 0.5, sy);
    }
    this.box(I, mI);
    this.box(P, mP);
    for (let i = 0; i < n; i++) tmp[i] = I[i]! * P[i]!;
    this.box(tmp, mIP);
    for (let i = 0; i < n; i++) tmp[i] = I[i]! * I[i]!;
    this.box(tmp, mII);
    for (let i = 0; i < n; i++) {
      const v = mII[i]! - mI[i]! * mI[i]!;
      const cov = mIP[i]! - mI[i]! * mP[i]!;
      A[i] = cov / (v + this.eps);
      B[i] = mP[i]! - A[i]! * mI[i]!;
    }
    // mI and mP are done with: the means of A and B go there.
    this.box(A, mI);
    this.box(B, mP);
    for (let i = 0; i < n; i++) out[i] = Math.min(1, Math.max(0, mI[i]! * I[i]! + mP[i]!));
    return out;
  }

  private box(src: Float32Array, dst: Float32Array): void {
    const { W, H, r, S } = this;
    const w1 = W + 1;
    for (let y = 0; y < H; y++) {
      let row = 0;
      for (let x = 0; x < W; x++) {
        row += src[y * W + x]!;
        S[(y + 1) * w1 + x + 1] = S[y * w1 + x + 1]! + row;
      }
    }
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(H, y + r + 1);
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - r);
        const x1 = Math.min(W, x + r + 1);
        const s = S[y1 * w1 + x1]! - S[y0 * w1 + x1]! - S[y1 * w1 + x0]! + S[y0 * w1 + x0]!;
        dst[y * W + x] = s / ((y1 - y0) * (x1 - x0));
      }
    }
  }
}
