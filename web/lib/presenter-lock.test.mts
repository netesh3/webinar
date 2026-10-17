/* Tests for the presenter lock: keep the presenter whole, take everybody else out.
 *
 * Run with `make test-web`.
 *
 * Synthetic 256×144 mattes, the size lib/humanseg.ts hands over, run through the real
 * PresenterLock over a second of frames. The cases that matter on a call:
 *
 *   a raised or gesturing hand the mask has separated from the arm — must stay
 *   somebody standing apart, or sitting beside the presenter — must go
 *   a person walking behind, who touches the presenter's outline — must not join them
 */

import { PresenterLock, type FaceBox } from "./presenter-lock.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
}

const W = 256;
const H = 144;
const N = W * H;
const LOCK_REGION = 0.5; // what lib/segmenter.ts passes for PP-HumanSeg

type Shape = (x: number, y: number) => boolean;
const ellipse = (cx: number, cy: number, rx: number, ry: number): Shape => (x, y) =>
  ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1;
/** A head and shoulders reaching the bottom edge, centred on cx. */
const person = (cx: number, top = 12, scale = 1): Shape => {
  const head = ellipse(cx, top + 23 * scale, 20 * scale, 24 * scale);
  return (x, y) => head(x, y) || (y > top + 43 * scale && Math.abs(x - cx) < (30 + (y - top - 43 * scale) * 0.3) * scale);
};
const faceOf = (cx: number, top = 12, scale = 1): FaceBox => ({
  x: (cx - 18 * scale) / W,
  y: (top + 2 * scale) / H,
  w: (36 * scale) / W,
  h: (40 * scale) / H,
});

function paint(...shapes: Shape[]): Float32Array {
  const m = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (shapes.some((s) => s(x, y))) m[y * W + x] = 1;
  return m;
}
/** How much of `shape` the matte still has, 0..1. */
function kept(m: Float32Array, shape: Shape): number {
  let inside = 0;
  let sum = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!shape(x, y)) continue;
    inside++;
    sum += m[y * W + x]!;
  }
  return inside ? sum / inside : 1;
}
/** A second of video at 30 fps, faces every other frame as lib/segmenter.ts does. */
function run(frames: (i: number) => { matte: Float32Array; faces: FaceBox[] }, count = 30): Float32Array {
  const lock = new PresenterLock();
  let out: Float32Array = new Float32Array(N);
  for (let i = 0; i < count; i++) {
    const now = 1000 + i * 33;
    const f = frames(i);
    if (i % 2 === 0) lock.updateFaces(f.faces, now);
    out = f.matte;
    lock.apply(out, W, H, now, LOCK_REGION);
  }
  return out;
}
/** How many separate regions the matte has at LOCK_REGION, and the gap (texels, Chebyshev)
 *  between two shapes — so each case is checked to be the situation it says it is. */
function regions(m: Float32Array): number {
  const seen = new Uint8Array(N);
  let count = 0;
  for (let s = 0; s < N; s++) {
    if (seen[s] || m[s]! < LOCK_REGION) continue;
    count++;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) {
        if (q < 0 || q >= N || seen[q] || m[q]! < LOCK_REGION) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
  }
  return count;
}
function gap(a: Shape, b: Shape): number {
  const bs: [number, number][] = [];
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) if (b(u, v)) bs.push([u, v]);
  let best = Infinity;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!a(x, y)) continue;
    for (const [u, v] of bs) best = Math.min(best, Math.max(Math.abs(u - x), Math.abs(v - y)));
    if (best <= 1) return best;
  }
  return best;
}
const pct = (v: number) => `${Math.round(v * 100)}%`;

const me = person(128);
const myFace = faceOf(128);
// Raised beside the shoulder, a few texels off it: the forearm between is what went faint.
const hand = ellipse(170, 45, 7, 9);
const forearm: Shape = (x, y) => x >= 150 && x < 166 && Math.abs(y - (60 - (x - 150) * 0.8)) < 4;

console.log("\nthe cases are what they say");
ok(regions(paint(me, hand)) === 2, "the hand is its own region");
ok(gap(me, hand) <= 8, "…a few texels from the body", `gap ${gap(me, hand)}`);
ok(regions(paint(me, hand, forearm)) === 1, "with the forearm it is one region");

console.log("\nhands and arms stay");
{
  const out = run(() => ({ matte: paint(me, hand), faces: [myFace] }));
  ok(kept(out, hand) > 0.95, "a raised hand the mask cut off from the arm is kept", `kept ${pct(kept(out, hand))}`);
  ok(kept(out, me) > 0.98, "…and the presenter with it", `kept ${pct(kept(out, me))}`);
}
{
  const out = run((i) => ({ matte: i < 15 ? paint(me, hand, forearm) : paint(me, hand), faces: [myFace] }));
  ok(kept(out, hand) > 0.95, "a hand that comes away from the arm mid-gesture is kept", `kept ${pct(kept(out, hand))}`);
}
{
  const out = run(() => ({ matte: paint(me, hand, forearm), faces: [myFace] }));
  ok(kept(out, hand) > 0.95 && kept(out, forearm) > 0.95, "a hand still joined by the arm is kept (control)");
}
{
  // Face not seen — turned away, blurred — and the hand is still the presenter's.
  const out = run(() => ({ matte: paint(me, hand), faces: [] }));
  ok(kept(out, hand) > 0.95, "a detached hand is kept while the face is not detected", `kept ${pct(kept(out, hand))}`);
}
{
  const fingers = ellipse(77, 95, 4, 6); // a hand stretched out to the side, off the body's edge
  ok(regions(paint(me, fingers)) === 2 && gap(me, fingers) <= 8, "(set-up) the outstretched hand is separate but close", `gap ${gap(me, fingers)}`);
  const out = run(() => ({ matte: paint(me, fingers), faces: [myFace] }));
  ok(kept(out, fingers) > 0.95, "an outstretched hand beside the body is kept", `kept ${pct(kept(out, fingers))}`);
}

console.log("\nother people still go");
{
  const other = person(25, 40, 0.5); // standing apart, well clear of the presenter
  ok(gap(me, other) > 12, "(set-up) the other person is apart", `gap ${gap(me, other)}`);
  const out = run(() => ({ matte: paint(me, other), faces: [myFace, faceOf(25, 40, 0.5)] }));
  ok(kept(out, other) < 0.05, "somebody standing apart is removed", `kept ${pct(kept(out, other))}`);
  ok(kept(out, me) > 0.98, "…and the presenter is untouched", `kept ${pct(kept(out, me))}`);
}
{
  // Head and shoulders a few texels from the presenter's: near enough to pass for a hand
  // by distance, but a face of their own says otherwise.
  const beside = person(218, 50, 0.55);
  ok(regions(paint(me, beside)) === 2 && gap(me, beside) <= 8, "(set-up) the neighbour is separate but close", `gap ${gap(me, beside)}`);
  const out = run(() => ({ matte: paint(me, beside), faces: [myFace, faceOf(218, 50, 0.55)] }));
  ok(kept(out, beside) < 0.05, "somebody sitting right beside the presenter is removed", `kept ${pct(kept(out, beside))}`);
}
{
  // A small head, somebody far behind, in exactly the place a raised hand would be.
  const far = ellipse(163, 44, 5, 6);
  ok(regions(paint(me, far)) === 2 && gap(me, far) <= 8, "(set-up) the far head is where a hand would be", `gap ${gap(me, far)}`);
  const out = run(() => ({ matte: paint(me, far), faces: [myFace, { x: 157 / W, y: 37 / H, w: 12 / W, h: 14 / H }] }));
  ok(kept(out, far) < 0.05, "a small far-away head next to the presenter is not taken for a hand", `kept ${pct(kept(out, far))}`);
}
{
  // Somebody walks in from the right, behind the presenter, while their face is too far
  // back for the detector: apart at first, then touching the presenter's outline.
  ok(gap(me, person(236, 20, 0.75)) > 8, "(set-up) the walker starts apart");
  ok(regions(paint(me, person(178, 20, 0.75))) === 1, "(set-up) …and ends touching the presenter");
  let walkerAt = 0;
  const out = run((i) => {
    walkerAt = 236 - i * 2;
    return { matte: paint(me, person(walkerAt, 20, 0.75)), faces: [myFace] };
  }, 30);
  const walker = person(walkerAt, 20, 0.75);
  const visible: Shape = (x, y) => walker(x, y) && !me(x, y);
  ok(kept(out, visible) < 0.1, "somebody walking behind the presenter is not let in", `kept ${pct(kept(out, visible))}`);
  ok(kept(out, me) > 0.97, "…and the presenter keeps their outline", `kept ${pct(kept(out, me))}`);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
