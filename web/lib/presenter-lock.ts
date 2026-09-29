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
/** Growth only counts this soon after a face was near, so leaning in or waving does not
 *  freeze the outline. */
const GROWTH_WINDOW_MS = 3000;
/** How far (face widths) and how much bigger or smaller (fraction) the presenter's face may
 *  be from where their frozen outline was taken, for the outline to still be theirs. */
const TEMPLATE_MAX_SHIFT = 0.5;
const TEMPLATE_MAX_SCALE = 0.15;
/** How recently the presenter's face must have been seen for the lock to act on where it
 *  is. Moving blurs the face and the detector drops it for a few frames; a position older
 *  than this may be on a hand, the shoulder, or the wall, and cutting by it is how the
 *  presenter gets cut. Past it, the lock only does what is safe without knowing: nothing
 *  to the presenter's region. */
const FRESH_MS = 350;
/** A region of its own this big (fraction of the frame), this tall (fraction of its height)
 *  and taller than wide is somebody else, face seen or not. See splitOwners. */
const OTHER_MIN_AREA = 0.02;
const OTHER_MIN_HEIGHT = 0.3;
/** Somebody else's share of the presenter's region must be at least this much of the frame
 *  to split it, and at most this much of the region — more is the tracking gone wrong. */
const OTHER_SEED_MIN = 0.004;
const OTHER_MAX_SHARE = 0.6;
/** How long somebody gone behind the presenter is looked for where they were heading. */
const GHOST_MS = 2500;
/** Template value from which a texel is inside the presenter's own outline. */
const PRESENTER_OUTLINE = 0.5;
/** How far (matte texels) a faint texel may be from the kept region and stay. */
const RIM_KEEP = 4;
/** How far (matte texels) past their recorded outline the presenter's side of a split
 *  reaches: an arm moved since, a lean. */
const PRESENTER_REACH = 8;

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
  private keep: Float32Array | null = null;
  private reach: Float32Array | null = null;
  private templateAt: { x: number; y: number } | null = null;
  private templateArea = 0;
  private templateFaceW = 0;
  private nearUntil = 0;
  private faceNearAt = -Infinity;
  /** Who each texel belonged to last frame (0 nobody, PRESENTER, OTHER), and a spare. */
  private owner: Uint8Array | null = null;
  private ownerNext: Uint8Array | null = null;
  /** The last sight of somebody else: x extent and centre (0..1), x speed per ms, when. */
  private ghost: { x0: number; x1: number; cx: number; vx: number; at: number } | null = null;

  /** How many other people the last frame removed, for logging. */
  removed = 0;
  private lastBlobs = 0;

  /** The presenter's face, 0..1 frame units, if it was seen within FRESH_MS — a position
   *  that can be trusted about this frame. Null otherwise. Used by the MODNet face check
   *  and by auto low light, which meters the face rather than the room. */
  presenterFace(now: number): FaceBox | null {
    const p = this.presenter;
    return p && now - p.seen < FRESH_MS ? { x: p.x, y: p.y, w: p.w, h: p.h } : null;
  }

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
    this.owner?.fill(0);
    this.ghost = null;
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
      this.keep = new Float32Array(n);
      this.reach = new Float32Array(n);
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

    /* 1. The presenter's region is the biggest person in the picture — the one at the
     * camera, usually touching the bottom edge. The body, not the face: a face box is lost
     * the moment somebody turns or moves quickly, and a stale one lands on a hand, a
     * shoulder or the wall. Choosing the region by it is what erased the presenter while
     * they gestured. So the face only has a say when it agrees with the body. */
    const score = (b: Blob) => b.area * (b.bottom >= h - 2 ? 2 : 1);
    const main = blobs.reduce((a, b) => (score(b) > score(a) ? b : a));
    const inMain = (f: FaceBox) => {
      const c = centre(f);
      const x = Math.min(w - 1, Math.max(0, Math.floor(c.x * w)));
      const y = Math.min(h - 1, Math.max(0, Math.floor(c.y * h)));
      return labels[y * w + x] === main.id;
    };
    /* A presenter face outside the presenter's region is following the wrong thing. If one
     * of the other faces is on the body, that is the presenter; otherwise nobody is. */
    if (this.presenter && !inMain(this.presenter)) {
      const onBody = this.others.filter(inMain).sort((a, b) => b.w * b.h - a.w * a.h)[0];
      this.others = this.others.filter((o) => o !== onBody);
      this.presenter = onBody ? { ...onBody } : null;
      this.templateAt = null;
      this.nearUntil = 0;
    }
    const P = this.presenter;
    const fresh = !!P && now - P.seen < FRESH_MS;
    if (!fresh) this.nearUntil = Math.min(this.nearUntil, now);

    /* 1b. Who each part of the picture belonged to last frame, carried forward.
     *
     * Somebody walking behind the presenter is usually too far back for the face detector,
     * so the lock cannot know them by face. It can know them by body: while they are a region
     * of their own they are marked as somebody else, and when their region runs into the
     * presenter's the mark goes with them — each texel of the joined region goes to whoever
     * owned it last frame, and the new ones to whichever side reaches them first inside the
     * region. Without this, the moment they touched they became part of the presenter. */
    const { owner, mainArea } = this.splitOwners(w, h, blobs, main, fresh ? P : null, now);

    // 2. Template: remembered while clear, frozen while somebody is near.
    const pc = P ? centre(P) : null;
    const others = this.others;
    const faceNear =
      fresh && !!pc && others.some((o) => Math.abs(centre(o).x - pc.x) < (P!.w + o.w) * 2.2);
    if (faceNear) this.faceNearAt = now;
    const grew =
      !!this.templateAt &&
      mainArea > this.templateArea * GROWTH &&
      now - this.faceNearAt < GROWTH_WINDOW_MS;
    if (faceNear || grew) this.nearUntil = now + NEAR_HOLD_MS;
    const near = fresh && now < this.nearUntil;
    const template = this.template!;
    if (fresh && pc && !near) {
      const fresh = !this.templateAt;
      for (let i = 0; i < n; i++) {
        const v = labels[i] === main.id && owner[i] !== OTHER ? matte[i]! : 0;
        template[i] = fresh ? v : template[i]! * 0.4 + v * 0.6;
      }
      if (TEMPLATE_GROW > 0) dilate(template, this.scratch!, w, h, TEMPLATE_GROW);
      this.templateAt = { x: pc.x, y: pc.y };
      this.templateFaceW = P!.w;
      this.templateArea = mainArea;
    }
    /* A frozen outline is the presenter's shape where it was taken. Carried further than a
     * little, it is the wrong shape — a lean, a turn, a step to the side — and clipping by it
     * cuts them into the outline's box. Past TEMPLATE_MAX_SHIFT (in face widths) or a face
     * size change of TEMPLATE_MAX_SCALE, it is not used; the split in step 1b is what keeps
     * the other person out then. */
    const shifted =
      !!this.templateAt &&
      !!pc &&
      (Math.hypot(pc.x - this.templateAt.x, ((pc.y - this.templateAt.y) * 9) / 16) > P!.w * TEMPLATE_MAX_SHIFT ||
        Math.abs(P!.w / Math.max(this.templateFaceW, 1e-3) - 1) > TEMPLATE_MAX_SCALE);
    const useTemplate = near && !!this.templateAt && !!pc && !shifted;
    const sdx = useTemplate ? Math.round((pc!.x - this.templateAt!.x) * w) : 0;
    const sdy = useTemplate ? Math.round((pc!.y - this.templateAt!.y) * h) : 0;

    // 3. Everything else.
    for (let y = 0; y < h; y++) {
      const fy = (y + 0.5) / h;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if ((labels[i] && labels[i] !== main.id) || owner[i] === OTHER) {
          matte[i] = 0;
          continue;
        }
        let a = matte[i]!;
        if (a <= 0) continue;
        if (!fresh || !pc) continue;
        const fx = (x + 0.5) / w;
        if (useTemplate) {
          // The presenter's own outline, carried with their face: nothing added to it.
          const tx = x - sdx;
          const ty = y - sdy;
          const t = tx >= 0 && tx < w && ty >= 0 && ty < h ? template[ty * w + tx]! : 0;
          a = Math.min(a, t);
        } else if (others.length) {
          /* The presenter's own head is never cut by somebody else's head box. */
          const hx = Math.abs(fx - pc.x) / P!.w;
          const hy = fy < pc.y ? (pc.y - fy) / (P!.h * 1.25) : (fy - pc.y) / (P!.h * 1.5);
          const protect = 1 - smooth(0.9, 1.1, Math.max(hx, hy));
          const dP = Math.hypot((fx - pc.x) / P!.w, (fy - pc.y) / P!.h);
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
    /* 4. The faint rim. Below regionLo nothing is a region, so a removed person's soft edge
     * was left: their outline, faint, on the background. Only faint texels near what was
     * kept stay — the presenter's own soft edge and hair. */
    const keep = this.keep!;
    for (let i = 0; i < n; i++) keep[i] = labels[i] === main.id && owner[i] !== OTHER ? 1 : 0;
    dilate(keep, this.scratch!, w, h, RIM_KEEP);
    for (let i = 0; i < n; i++) if (!labels[i] && !keep[i]) matte[i] = 0;

    this.removed = blobs.length - 1 + others.length;
    return true;
  }

  /* Step 1b of apply: this frame's owner for every texel of a region, from last frame's.
   *
   * A region apart from the main one keeps whoever owned most of it: a hand that came
   * away from the body stays the presenter's, so it is not taken for a stranger when it
   * comes back. A new region is somebody else only if it is person-sized and stands up
   * like a person — a speck or a sleeve is nobody.
   *
   * The main region is split only when enough of it was somebody else last frame. Then the
   * owners from last frame are seeds and grow through the region, one texel a step on each
   * side, so the new texels go to whoever is nearer through the body, not across the gap.
   * The presenter's head is theirs whatever last frame said, and a split that would take
   * their face, or most of their region, is not believed. */
  private splitOwners(
    w: number,
    h: number,
    blobs: Blob[],
    main: Blob,
    face: FaceBox | null,
    now: number,
  ): { owner: Uint8Array; mainArea: number } {
    const n = w * h;
    const labels = this.labels!;
    const queue = this.queue!;
    const prev = this.owner && this.owner.length === n ? this.owner : new Uint8Array(n);
    const next = this.ownerNext && this.ownerNext.length === n ? this.ownerNext : new Uint8Array(n);
    next.fill(0);

    const mine = new Int32Array(blobs.length + 1);
    const theirs = new Int32Array(blobs.length + 1);
    for (let i = 0; i < n; i++) {
      const l = labels[i]!;
      if (!l) continue;
      if (prev[i] === PRESENTER) mine[l]! += 1;
      else if (prev[i] === OTHER) theirs[l]! += 1;
    }
    const personLike = (b: Blob) =>
      b.area >= n * OTHER_MIN_AREA && b.maxY - b.minY + 1 >= h * OTHER_MIN_HEIGHT && b.maxY - b.minY >= (b.maxX - b.minX) * 0.9;
    const regionOwner = new Uint8Array(blobs.length + 1);
    for (const b of blobs) {
      if (b.id === main.id) continue;
      if (mine[b.id]! > theirs[b.id]!) regionOwner[b.id] = PRESENTER;
      else if (theirs[b.id]! > 0 || personLike(b)) regionOwner[b.id] = OTHER;
    }

    /* The presenter is in front. Anybody behind them is hidden where they are, so what lies
     * inside the presenter's own outline (remembered while nobody was near, carried with
     * their face) is theirs, whatever last frame said — or somebody who walked behind them
     * would leave their mark on the presenter's shirt. Before there is an outline, the head. */
    const t = this.template;
    const tAt = this.templateAt;
    const fc = face ? centre(face) : null;
    const tdx = t && tAt && fc ? Math.round((fc.x - tAt.x) * w) : 0;
    const tdy = t && tAt && fc ? Math.round((fc.y - tAt.y) * h) : 0;
    const headOf = (x: number, y: number) => {
      if (!face) return false;
      if (t && tAt) {
        const tx = x - tdx;
        const ty = y - tdy;
        if (tx >= 0 && tx < w && ty >= 0 && ty < h && t[ty * w + tx]! >= PRESENTER_OUTLINE) return true;
      }
      return (
        Math.abs((x + 0.5) / w - (face.x + face.w / 2)) < face.w * 0.6 &&
        (y + 0.5) / h > face.y - face.h * 0.25 &&
        (y + 0.5) / h < face.y + face.h * 1.5
      );
    };

    /* Somebody who went behind the presenter comes out the other side still touching them,
     * and with no owner from last frame they would be taken for part of the presenter. So
     * for GHOST_MS after the last sight of them, texels new to the presenter's region where
     * they were heading are theirs — if enough of them stand up like a person. */
    const g = this.ghost && now - this.ghost.at < GHOST_MS ? this.ghost : null;
    let gx0 = 0;
    let gx1 = -1;
    if (g) {
      const dt = now - g.at;
      const shift = g.vx * dt;
      const margin = (g.x1 - g.x0) * 0.25;
      gx0 = Math.min(g.x0, g.x0 + shift) - margin;
      gx1 = Math.max(g.x1, g.x1 + shift) + margin;
    }
    const ghostAt = (i: number) => {
      if (!g || prev[i]) return false;
      const x = ((i % w) + 0.5) / w;
      return x >= gx0 && x <= gx1;
    };
    let ghostNew = 0;
    let ghostTop = h;
    let ghostBottom = -1;
    if (g) {
      for (let i = 0; i < n; i++) {
        if (labels[i] !== main.id || !ghostAt(i)) continue;
        const y = (i / w) | 0;
        if (headOf(i - y * w, y)) continue;
        ghostNew++;
        if (y < ghostTop) ghostTop = y;
        if (y > ghostBottom) ghostBottom = y;
      }
    }
    const ghostSeeds = ghostNew >= n * OTHER_SEED_MIN && ghostBottom - ghostTop + 1 >= h * OTHER_MIN_HEIGHT;

    let mainArea = main.area;
    if (theirs[main.id]! >= n * OTHER_SEED_MIN || ghostSeeds) {
      // Seeds: last frame's owners inside the main region, and the presenter's head.
      let head = 0;
      let tail = 0;
      for (let i = 0; i < n; i++) {
        if (labels[i] !== main.id) continue;
        const y = (i / w) | 0;
        const o = headOf(i - y * w, y) ? PRESENTER : prev[i] || (ghostSeeds && ghostAt(i) ? OTHER : 0);
        if (o) {
          next[i] = o;
          queue[tail++] = i;
        }
      }
      if (tail === 0) {
        for (let i = 0; i < n; i++) if (labels[i] === main.id) next[i] = PRESENTER;
      }
      /* Breadth first from every seed at once: each texel goes to the side that got there
       * first. The presenter's side only spreads within their own outline and a margin
       * round it; somebody else's goes anywhere. Otherwise, where the two touch low down
       * (legs past a chair, a hip), the presenter's side is nearer and takes the stranger's
       * legs. Whatever neither reaches is the presenter's. */
      const reach = this.reach!;
      const haveOutline = !!(t && tAt && face);
      if (haveOutline) {
        for (let i = 0; i < n; i++) {
          const y = (i / w) | 0;
          const tx = i - y * w - tdx;
          const ty = y - tdy;
          reach[i] = tx >= 0 && tx < w && ty >= 0 && ty < h && t![ty * w + tx]! >= PRESENTER_OUTLINE ? 1 : 0;
        }
        dilate(reach, this.scratch!, w, h, PRESENTER_REACH);
      }
      const may = (q: number, o: number) => labels[q] === main.id && !next[q] && (o === OTHER || !haveOutline || reach[q]! > 0);
      while (head < tail) {
        const p = queue[head++]!;
        const o = next[p]!;
        const y = (p / w) | 0;
        const x = p - y * w;
        if (x > 0 && may(p - 1, o)) { next[p - 1] = o; queue[tail++] = p - 1; }
        if (x < w - 1 && may(p + 1, o)) { next[p + 1] = o; queue[tail++] = p + 1; }
        if (y > 0 && may(p - w, o)) { next[p - w] = o; queue[tail++] = p - w; }
        if (y < h - 1 && may(p + w, o)) { next[p + w] = o; queue[tail++] = p + w; }
      }
      for (let i = 0; i < n; i++) if (labels[i] === main.id && !next[i]) next[i] = PRESENTER;
      let other = 0;
      for (let i = 0; i < n; i++) if (labels[i] === main.id && next[i] === OTHER) other++;
      const faceTaken =
        !!fc && next[Math.min(h - 1, Math.floor(fc.y * h)) * w + Math.min(w - 1, Math.floor(fc.x * w))] === OTHER;
      if (other < n * OTHER_SEED_MIN || other > main.area * OTHER_MAX_SHARE || faceTaken) {
        for (let i = 0; i < n; i++) if (labels[i] === main.id) next[i] = PRESENTER;
      } else {
        mainArea = main.area - other;
      }
    } else {
      for (let i = 0; i < n; i++) if (labels[i] === main.id) next[i] = PRESENTER;
    }
    for (let i = 0; i < n; i++) {
      const l = labels[i]!;
      if (l && l !== main.id) next[i] = regionOwner[l]!;
    }
    this.ownerNext = prev;
    this.owner = next;
    this.noteOther(next, w, h, now);
    return { owner: next, mainArea };
  }

  /** Where somebody else is and which way they are going, for the ghost in splitOwners. */
  private noteOther(owner: Uint8Array, w: number, h: number, now: number): void {
    let count = 0;
    let sx = 0;
    let x0 = w;
    let x1 = -1;
    for (let i = 0; i < w * h; i++) {
      if (owner[i] !== OTHER) continue;
      const x = i % w;
      count++;
      sx += x;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
    }
    if (count < w * h * OTHER_SEED_MIN) return;
    const cx = (sx / count + 0.5) / w;
    const prev = this.ghost;
    let vx = 0;
    if (prev && now - prev.at < GHOST_MS && now > prev.at) {
      vx = prev.vx * 0.7 + ((cx - prev.cx) / (now - prev.at)) * 0.3;
    }
    this.ghost = { x0: (x0 + 0.5) / w, x1: (x1 + 0.5) / w, cx, vx, at: now };
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
      let minX = w;
      let maxX = 0;
      let minY = h;
      queue[tail++] = i;
      labels[i] = id;
      while (head < tail) {
        const p = queue[head++]!;
        area++;
        const y = (p / w) | 0;
        const x = p - y * w;
        if (y > bottom) bottom = y;
        if (y < minY) minY = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (x > 0 && !labels[p - 1] && matte[p - 1]! >= lo) { labels[p - 1] = id; queue[tail++] = p - 1; }
        if (x < w - 1 && !labels[p + 1] && matte[p + 1]! >= lo) { labels[p + 1] = id; queue[tail++] = p + 1; }
        if (y > 0 && !labels[p - w] && matte[p - w]! >= lo) { labels[p - w] = id; queue[tail++] = p - w; }
        if (y < h - 1 && !labels[p + w] && matte[p + w]! >= lo) { labels[p + w] = id; queue[tail++] = p + w; }
      }
      blobs.push({ id, area, bottom, minX, maxX, minY, maxY: bottom });
    }
    return blobs;
  }
}

type Blob = { id: number; area: number; bottom: number; minX: number; maxX: number; minY: number; maxY: number };

/** Owners of a texel in PresenterLock.splitOwners. */
const PRESENTER = 1;
const OTHER = 2;

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
