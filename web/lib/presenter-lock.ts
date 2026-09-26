/* Presenter lock: keep the one person presenting, drop everybody else.
 *
 * The segmentation models mark EVERY person in the frame. A webinar wants one: the presenter.
 * Faces are the handle on "which person". A face detector runs on each frame; the presenter's
 * face is locked on (the largest face when the lock is taken, then followed frame to frame),
 * and every other face is somebody to remove.
 *
 * Removal works on the matte, at matte resolution, on the CPU:
 *
 *   1. Blobs. Keep only the connected region holding the presenter's face. Anybody standing
 *      apart from the presenter is a different region and goes whole.
 *   2. Somebody touching the presenter's outline — walking close behind — is the hard case,
 *      because the two are one region. While nobody else is near, the presenter's own matte
 *      is remembered (the template). When another face comes near, or the presenter's region
 *      suddenly grows, the template is frozen and carried along with the presenter's face,
 *      and the output is the matte clipped to it. The presenter's outline is then neither cut
 *      into nor added to by the passer-by. The hold lasts a while past the last sighting,
 *      because a face directly behind the presenter's head is hidden from the detector.
 *   3. Before there is a template, a nearest-face split and a head box around each other face,
 *      never inside the presenter's own head box.
 *
 * Measured on a synthetic walk-past (a person crossing directly behind the presenter's head):
 * at most 1.4–1.9% of the presenter's outline lost on the worst frame and under 1% of the
 * walker let through, over three passes. See the PR that added this file.
 */

/** A face box in 0..1 frame units. */
export type FaceBox = { x: number; y: number; w: number; h: number };

type TrackedFace = FaceBox & { seen: number };

/** Max centre distance, in presenter face widths, to keep following the same face. */
const LOCK_MATCH = 1.6;
/** A face this much smaller or larger than the presenter's is somebody else, however close. */
const LOCK_SIZE_MIN = 0.65;
const LOCK_SIZE_MAX = 1.5;
/** How long a lost presenter keeps the lock before the largest face takes it again. */
const LOCK_HOLD_MS = 2000;
/** How long a lost other face is remembered (motion blur, a turned head). */
const OTHER_HOLD_MS = 600;
/** Head box around another face, in face sizes. */
const HEAD_BOX = { x: 1.0, up: 1.1, down: 1.4 };
/** How long the presenter's outline stays frozen after somebody was last near. */
const NEAR_HOLD_MS = 2500;
/** Growth of the presenter's region that counts as somebody touching it. */
const GROWTH = 1.04;
/** A region at least this fraction of the frame is a person, for busy(). */
const BUSY_MIN_AREA = 0.01;
/** How far the frozen outline may exceed the presenter's own, in matte texels. */
const TEMPLATE_GROW = 0;
/** Growth only counts this soon after a face was near, so leaning in does not freeze it. */
const GROWTH_WINDOW_MS = 3000;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function centre(f: FaceBox): { x: number; y: number } {
  return { x: f.x + f.w / 2, y: f.y + f.h / 2 };
}

export class PresenterLock {
  private presenter: TrackedFace | null = null;
  private others: TrackedFace[] = [];

  private labels: Int32Array | null = null;
  private queue: Int32Array | null = null;
  private template: Float32Array | null = null;
  private scratch: Float32Array | null = null;
  private templateAt: { x: number; y: number } | null = null;
  private templateArea = 0;
  private nearUntil = 0;
  private faceNearAt = -Infinity;

  /** How many other people the last frame removed, for logging. */
  removed = 0;
  private lastBlobs = 0;

  /** Whether there is anybody to take out, or an outline held for somebody who just was:
   *  the caller then runs apply every frame, and may run it less often otherwise. */
  busy(now: number): boolean {
    return this.others.length > 0 || this.lastBlobs > 1 || now < this.nearUntil;
  }

  /** Forget everybody: a new camera, or the lock asked to pick again. */
  reset(): void {
    this.presenter = null;
    this.others = [];
    this.templateAt = null;
    this.templateArea = 0;
    this.nearUntil = 0;
    this.faceNearAt = -Infinity;
  }

  /** This frame's faces, in 0..1 frame units. */
  updateFaces(faces: FaceBox[], now: number): void {
    let presenter = this.presenter;
    let pIdx = -1;
    if (presenter) {
      const pc = centre(presenter);
      let best = Infinity;
      faces.forEach((f, i) => {
        const size = f.w / Math.max(presenter!.w, 1e-3);
        if (size < LOCK_SIZE_MIN || size > LOCK_SIZE_MAX) return;
        const c = centre(f);
        // x and y in comparable units on a 16:9 frame.
        const d = Math.hypot(c.x - pc.x, ((c.y - pc.y) * 9) / 16) / Math.max(presenter!.w, 1e-3);
        if (d < best) {
          best = d;
          pIdx = i;
        }
      });
      if (best > LOCK_MATCH) pIdx = -1;
      if (pIdx < 0 && now - presenter.seen > LOCK_HOLD_MS) presenter = null;
    }
    if (!presenter && faces.length) {
      pIdx = faces.reduce((bi, f, i) => (f.w * f.h > faces[bi]!.w * faces[bi]!.h ? i : bi), 0);
    }
    if (pIdx >= 0) {
      const f = faces[pIdx]!;
      presenter = presenter
        ? {
            x: presenter.x + (f.x - presenter.x) * 0.6,
            y: presenter.y + (f.y - presenter.y) * 0.6,
            w: presenter.w + (f.w - presenter.w) * 0.6,
            h: presenter.h + (f.h - presenter.h) * 0.6,
            seen: now,
          }
        : { ...f, seen: now };
    }
    this.presenter = presenter;

    const fresh = faces.filter((_, i) => i !== pIdx).map((f) => ({ ...f, seen: now }));
    const kept = this.others.filter(
      (o) =>
        now - o.seen < OTHER_HOLD_MS &&
        !fresh.some((f) => {
          const a = centre(f);
          const b = centre(o);
          return Math.hypot(a.x - b.x, a.y - b.y) < Math.max(f.w, o.w) * 1.5;
        }),
    );
    this.others = [...fresh, ...kept].filter((o) => {
      // Never treat the presenter's own spot as somebody else's face.
      if (!presenter) return true;
      const a = centre(o);
      const b = centre(presenter);
      return Math.hypot(a.x - b.x, a.y - b.y) > presenter.w * 0.6;
    });
  }

  /** Multiplies `matte` (w×h, 0..1, row 0 at the top) down to the presenter only, in place.
   *  `regionLo`: a value at or above this is part of a region — MediaPipe's confidence is
   *  noisy low down, so it wants about half; a matting model's alpha is clean near zero.
   *  Returns false when there was nothing to do (no regions). */
  apply(matte: Float32Array, w: number, h: number, now: number, regionLo = 0.1): boolean {
    const n = w * h;
    if (!this.labels || this.labels.length !== n) {
      this.labels = new Int32Array(n);
      this.queue = new Int32Array(n);
      this.template = new Float32Array(n);
      this.scratch = new Float32Array(n);
      this.templateAt = null;
    }
    const labels = this.labels;
    const blobs = this.label(matte, w, h, regionLo);
    // Specks are not people: only a region of some size says somebody else is there.
    this.lastBlobs = blobs.filter((b) => b.area > n * BUSY_MIN_AREA).length;
    if (!blobs.length) {
      this.removed = 0;
      return false;
    }

    // 1. The presenter's region: most of the face box, else the largest bottom-touching one.
    const P = this.presenter;
    let main: Blob | null = null;
    if (P) {
      const votes = new Map<number, number>();
      const x0 = Math.max(0, Math.floor(P.x * w));
      const x1 = Math.min(w, Math.ceil((P.x + P.w) * w));
      const y0 = Math.max(0, Math.floor(P.y * h));
      const y1 = Math.min(h, Math.ceil((P.y + P.h) * h));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const l = labels[y * w + x]!;
          if (l) votes.set(l, (votes.get(l) ?? 0) + 1);
        }
      }
      let best = 0;
      for (const [id, v] of votes) {
        if (v > best) {
          best = v;
          main = blobs[id - 1]!;
        }
      }
    }
    if (!main) {
      const score = (b: Blob) => b.area * (b.bottom >= h - 2 ? 2 : 1);
      main = blobs.reduce((a, b) => (score(b) > score(a) ? b : a));
    }

    // 2. Template: remembered while clear, frozen while somebody is near.
    const pc = P ? centre(P) : null;
    const others = this.others;
    const faceNear =
      !!P && !!pc && others.some((o) => Math.abs(centre(o).x - pc.x) < (P.w + o.w) * 2.2);
    if (faceNear) this.faceNearAt = now;
    const grew =
      !!this.templateAt &&
      main.area > this.templateArea * GROWTH &&
      now - this.faceNearAt < GROWTH_WINDOW_MS;
    if (faceNear || grew) this.nearUntil = now + NEAR_HOLD_MS;
    const near = !!P && now < this.nearUntil;
    const template = this.template!;
    if (P && pc && !near) {
      const fresh = !this.templateAt;
      for (let i = 0; i < n; i++) {
        const v = labels[i] === main.id ? matte[i]! : 0;
        template[i] = fresh ? v : template[i]! * 0.4 + v * 0.6;
      }
      if (TEMPLATE_GROW > 0) dilate(template, this.scratch!, w, h, TEMPLATE_GROW);
      this.templateAt = { x: pc.x, y: pc.y };
      this.templateArea = main.area;
    }
    const useTemplate = near && !!this.templateAt && !!pc;
    const sdx = useTemplate ? Math.round((pc!.x - this.templateAt!.x) * w) : 0;
    const sdy = useTemplate ? Math.round((pc!.y - this.templateAt!.y) * h) : 0;

    // 3. Everything else.
    for (let y = 0; y < h; y++) {
      const fy = (y + 0.5) / h;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (labels[i] && labels[i] !== main.id) {
          matte[i] = 0;
          continue;
        }
        let a = matte[i]!;
        if (a <= 0) continue;
        if (useTemplate) {
          const tx = x - sdx;
          const ty = y - sdy;
          const t = tx >= 0 && tx < w && ty >= 0 && ty < h ? template[ty * w + tx]! : 0;
          a = Math.min(a, t);
        } else if (others.length) {
          const fx = (x + 0.5) / w;
          let protect = 0;
          let dP = Infinity;
          if (P && pc) {
            const hx = Math.abs(fx - pc.x) / P.w;
            const hy = fy < pc.y ? (pc.y - fy) / (P.h * 1.25) : (fy - pc.y) / (P.h * 1.5);
            protect = 1 - smooth(0.9, 1.1, Math.max(hx, hy));
            dP = Math.hypot((fx - pc.x) / P.w, (fy - pc.y) / P.h);
          }
          const a0 = a;
          for (const o of others) {
            const oc = centre(o);
            const dO = Math.hypot((fx - oc.x) / o.w, (fy - oc.y) / o.h);
            a *= smooth(0.8, 1.2, dO / Math.max(dP, 1e-3));
            const bx = Math.abs(fx - oc.x) / (o.w * HEAD_BOX.x);
            const by = fy < oc.y ? (oc.y - fy) / (o.h * HEAD_BOX.up) : (fy - oc.y) / (o.h * HEAD_BOX.down);
            a *= smooth(0.85, 1.05, Math.max(bx, by));
            if (a <= 0) break;
          }
          a = Math.max(a, a0 * protect);
        }
        matte[i] = a;
      }
    }
    this.removed = blobs.length - 1 + others.length;
    return true;
  }

  private label(matte: Float32Array, w: number, h: number, lo: number): Blob[] {
    const labels = this.labels!;
    const queue = this.queue!;
    labels.fill(0);
    const blobs: Blob[] = [];
    const n = w * h;
    for (let i = 0; i < n; i++) {
      if (labels[i] || matte[i]! < lo) continue;
      const id = blobs.length + 1;
      let head = 0;
      let tail = 0;
      let area = 0;
      let bottom = 0;
      queue[tail++] = i;
      labels[i] = id;
      while (head < tail) {
        const p = queue[head++]!;
        area++;
        const y = (p / w) | 0;
        const x = p - y * w;
        if (y > bottom) bottom = y;
        if (x > 0 && !labels[p - 1] && matte[p - 1]! >= lo) { labels[p - 1] = id; queue[tail++] = p - 1; }
        if (x < w - 1 && !labels[p + 1] && matte[p + 1]! >= lo) { labels[p + 1] = id; queue[tail++] = p + 1; }
        if (y > 0 && !labels[p - w] && matte[p - w]! >= lo) { labels[p - w] = id; queue[tail++] = p - w; }
        if (y < h - 1 && !labels[p + w] && matte[p + w]! >= lo) { labels[p + w] = id; queue[tail++] = p + w; }
      }
      blobs.push({ id, area, bottom });
    }
    return blobs;
  }
}

type Blob = { id: number; area: number; bottom: number };

/** Separable max filter of radius r, in place. */
function dilate(a: Float32Array, scratch: Float32Array, w: number, h: number, r: number): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, a[y * w + k]!);
      scratch[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, scratch[k * w + x]!);
      a[y * w + x] = m;
    }
  }
}
