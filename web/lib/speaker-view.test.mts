/* Tests for speaker view's pure helpers. Run with `make test-web`.
 *
 * The geometry the egress draws and the phone cuts along, the beacon, the sticky active
 * speaker, the PiP's corners and the crop maths: all things a phone in someone's hand is the
 * only other place to check. */

import assert from "node:assert/strict";
import {
  BEACON_AGREE,
  BEACON_OFF,
  BEACON_PATTERN,
  beaconCells,
  beaconStrip,
  cornerPosition,
  cropTransform,
  DEFAULT_PIP,
  isTap,
  mayBeSpeakerView,
  nearestCorner,
  nextBeacon,
  NO_PICK,
  parsePipPrefs,
  pickRecheckDelay,
  pickSpeaker,
  PIP_INSETS,
  pipSize,
  PROBE_H,
  PROBE_W,
  readBeacon,
  sourceRect,
  SPEAKER_HOLD_MS,
  SPEAKER_STICKY_MS,
  splitsMix,
  SV_SHARE,
  SV_SPEAKER,
  toPixels,
  type NRect,
  type SpeakerCandidate,
} from "./speaker-view.ts";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const inUnit = (r: NRect) => r.x >= 0 && r.y >= 0 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9;
const overlaps = (a: NRect, b: NRect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ------------------------------------------------------------------ geometry
{
  for (const r of [SV_SHARE, SV_SPEAKER, beaconStrip(), ...beaconCells()]) assert.ok(inUnit(r));
  assert.ok(!overlaps(SV_SHARE, SV_SPEAKER), "share and speaker apart");
  for (const c of beaconCells()) {
    assert.ok(!overlaps(c, SV_SHARE) && !overlaps(c, SV_SPEAKER), "beacon in the empty corner");
  }
  // Both regions are 16:9 on a 16:9 frame.
  for (const f of [{ w: 1280, h: 720 }, { w: 1920, h: 1080 }]) {
    for (const r of [SV_SHARE, SV_SPEAKER]) {
      const p = toPixels(r, f);
      near(p.w / p.h, 16 / 9, 1e-3);
    }
  }
  // The beacon cells are 16 px at 720p, on the macroblock grid, flush with the bottom right.
  const cells = beaconCells().map((c) => toPixels(c, { w: 1280, h: 720 }));
  assert.equal(cells.length, BEACON_PATTERN.length);
  for (const c of cells) {
    near(c.w, 16);
    near(c.h, 16);
    near(c.x % 16, 0, 1e-6);
    near(c.y, 704);
  }
  near(cells[cells.length - 1].x + 16, 1280);
}

// ------------------------------------------------------------------ the beacon
function probe(lumas: number[]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(PROBE_W * PROBE_H * 4);
  const cell = PROBE_W / lumas.length;
  for (let y = 0; y < PROBE_H; y++) {
    for (let x = 0; x < PROBE_W; x++) {
      const v = lumas[Math.floor(x / cell)];
      const o = (y * PROBE_W + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return data;
}
{
  const lit = BEACON_PATTERN.map((on) => (on ? 160 : 0));
  assert.equal(readBeacon(probe(lit)), true);
  // Encoder noise: a little brighter dark, a little dimmer lit.
  assert.equal(readBeacon(probe(BEACON_PATTERN.map((on) => (on ? 120 : 30)))), true);
  assert.equal(readBeacon(probe([0, 0, 0, 0])), false, "black corner");
  assert.equal(readBeacon(probe([255, 255, 255, 255])), false, "a white slide's corner");
  assert.equal(readBeacon(probe(BEACON_PATTERN.map((on) => (on ? 0 : 160)))), false, "inverted");
  assert.equal(readBeacon(new Uint8ClampedArray(0), 0, 0), false);
}
{
  // Hysteresis: BEACON_AGREE reads in a row to change, a lone read changes nothing.
  let s = BEACON_OFF;
  s = nextBeacon(s, true);
  assert.equal(s.on, BEACON_AGREE <= 1);
  s = nextBeacon(s, false);
  assert.equal(s.on, false);
  assert.equal(s.streak, 0, "a disagreeing read resets the streak");
  for (let i = 0; i < BEACON_AGREE; i++) s = nextBeacon(s, true);
  assert.equal(s.on, true);
  s = nextBeacon(s, false);
  assert.equal(s.on, true, "one smeared frame does not turn it off");
  s = nextBeacon(s, true);
  for (let i = 0; i < BEACON_AGREE; i++) s = nextBeacon(s, false);
  assert.equal(s.on, false);
  assert.equal(nextBeacon(BEACON_OFF, false), BEACON_OFF, "steady state is the same object");
}

// ------------------------------------------------------------------ the sticky speaker
const cand = (id: string, o: Partial<SpeakerCandidate> = {}): SpeakerCandidate => ({
  id,
  cameraOn: true,
  sharing: false,
  host: false,
  ...o,
});
{
  const stage = [cand("host", { host: true }), cand("sharer", { sharing: true }), cand("pan")];
  // Nobody speaking: the sharer first.
  let p = pickSpeaker(NO_PICK, stage, [], 0);
  assert.equal(p.current, "sharer");
  // Sharer's camera off: the host.
  const offSharer = [cand("host", { host: true }), cand("sharer", { sharing: true, cameraOn: false }), cand("pan")];
  assert.equal(pickSpeaker(NO_PICK, offSharer, [], 0).current, "host");
  // Nobody sharing or hosting with a camera: anyone with a camera.
  assert.equal(pickSpeaker(NO_PICK, [cand("a", { cameraOn: false, host: true }), cand("b")], [], 0).current, "b");
  // Nobody has a camera: the sharer, as an initials tile.
  assert.equal(
    pickSpeaker(NO_PICK, [cand("h", { host: true, cameraOn: false }), cand("s", { sharing: true, cameraOn: false })], [], 0)
      .current,
    "s",
  );
  assert.equal(pickSpeaker(NO_PICK, [], ["x"], 0).current, null, "empty stage");
  // Somebody speaking at the start takes it at once.
  assert.equal(pickSpeaker(NO_PICK, stage, ["pan"], 0).current, "pan");
  // A speaker with the camera off is skipped for one with a camera.
  assert.equal(pickSpeaker(NO_PICK, offSharer, ["sharer", "pan"], 0).current, "pan");

  // Stickiness: the panelist talks right after the sharer took the tile.
  p = pickSpeaker(NO_PICK, stage, [], 0);
  p = pickSpeaker(p, stage, ["pan"], 100);
  assert.equal(p.current, "sharer", "not before the sticky window");
  p = pickSpeaker(p, stage, ["pan"], SPEAKER_STICKY_MS - 1);
  assert.equal(p.current, "sharer");
  p = pickSpeaker(p, stage, ["pan"], SPEAKER_STICKY_MS);
  assert.equal(p.current, "pan", "after the window, held long enough");
  // A cough: the host is loudest for less than the hold.
  const t = SPEAKER_STICKY_MS * 3;
  p = pickSpeaker(p, stage, ["host"], t);
  p = pickSpeaker(p, stage, ["host"], t + SPEAKER_HOLD_MS - 1);
  assert.equal(p.current, "pan");
  p = pickSpeaker(p, stage, [], t + SPEAKER_HOLD_MS + 10);
  assert.equal(p.current, "pan", "silence keeps the last speaker");
  // Interrupted readings restart the hold.
  p = pickSpeaker(p, stage, ["host"], t + 5000);
  p = pickSpeaker(p, stage, [], t + 5200);
  p = pickSpeaker(p, stage, ["host"], t + 5300);
  p = pickSpeaker(p, stage, ["host"], t + 5300 + SPEAKER_HOLD_MS - 1);
  assert.equal(p.current, "pan");
  p = pickSpeaker(p, stage, ["host"], t + 5300 + SPEAKER_HOLD_MS);
  assert.equal(p.current, "host");
  // The current speaker leaves the stage: a fallback at once, no waiting.
  const gone = stage.filter((c) => c.id !== "host");
  p = pickSpeaker(p, gone, [], t + 5301 + SPEAKER_HOLD_MS);
  assert.equal(p.current, "sharer");
  // The current speaker turns the camera off while others have one: replaced.
  p = pickSpeaker(p, [cand("sharer", { sharing: true, cameraOn: false }), cand("pan")], [], t + 9000);
  assert.equal(p.current, "pan");
}
{
  // The recheck timer: due when both the hold and the sticky window have passed.
  const stage = [cand("a", { sharing: true }), cand("b")];
  let p = pickSpeaker(NO_PICK, stage, [], 1000);
  assert.equal(pickRecheckDelay(p, 1000), null, "nothing pending");
  p = pickSpeaker(p, stage, ["b"], 1100);
  assert.equal(pickRecheckDelay(p, 1100), 1000 + SPEAKER_STICKY_MS - 1100);
  p = pickSpeaker(p, stage, ["b"], 1000 + SPEAKER_STICKY_MS);
  assert.equal(p.current, "b");
  assert.equal(pickRecheckDelay(p, 1000 + SPEAKER_STICKY_MS), null);
}

// ------------------------------------------------------------------ layout by viewport
{
  assert.equal(splitsMix({ w: 390, h: 844 }), true, "phone portrait");
  assert.equal(splitsMix({ w: 844, h: 390 }), true, "phone landscape");
  assert.equal(splitsMix({ w: 820, h: 1180 }), true, "tablet portrait");
  assert.equal(splitsMix({ w: 1180, h: 820 }), false, "tablet landscape: the sidebar");
  assert.equal(splitsMix({ w: 1440, h: 900 }), false, "laptop: the sidebar");
  assert.equal(splitsMix({ w: 0, h: 0 }), false, "not measured yet");
  assert.equal(mayBeSpeakerView("speaker_view"), true);
  assert.equal(mayBeSpeakerView("auto"), true);
  assert.equal(mayBeSpeakerView(undefined), true);
  assert.equal(mayBeSpeakerView("grid"), false);
  assert.equal(mayBeSpeakerView("side_by_side"), false);
}

// ------------------------------------------------------------------ crop maths
{
  // A 16:9 video in a 16:9 box: the share region (16:9) fills the box exactly.
  const box = { w: 400, h: 225 };
  const video = { w: 1280, h: 720 };
  const t = cropTransform(box, video, SV_SHARE);
  const map = (x: number, y: number) => ({ x: t.k * x + t.tx, y: t.k * y + t.ty });
  // Region corners, in element px before the transform (object-contain, no bars here).
  const s = box.w / video.w;
  const tl = map(SV_SHARE.x * video.w * s, SV_SHARE.y * video.h * s);
  const br = map((SV_SHARE.x + SV_SHARE.w) * video.w * s, (SV_SHARE.y + SV_SHARE.h) * video.h * s);
  near(tl.x, 0);
  near(tl.y, 0);
  near(br.x, box.w);
  near(br.y, box.h);
  near(t.k, 1 / 0.75);
  // A taller box (phone stage): letterboxed video; the region is contained and centred.
  const tall = { w: 390, h: 300 };
  const t2 = cropTransform(tall, video, SV_SPEAKER);
  const s2 = Math.min(tall.w / video.w, tall.h / video.h);
  const oy = (tall.h - video.h * s2) / 2;
  const rx = SV_SPEAKER.x * video.w * s2;
  const ry = oy + SV_SPEAKER.y * video.h * s2;
  const rw = SV_SPEAKER.w * video.w * s2;
  const rh = SV_SPEAKER.h * video.h * s2;
  const a = { x: t2.k * rx + t2.tx, y: t2.k * ry + t2.ty };
  const b = { x: t2.k * (rx + rw) + t2.tx, y: t2.k * (ry + rh) + t2.ty };
  near(a.x, 0);
  near(b.x, tall.w);
  near((a.y + b.y) / 2, tall.h / 2);
  assert.ok(b.y - a.y <= tall.h + 1e-6);
  // Nothing measured: identity.
  assert.deepEqual(cropTransform({ w: 0, h: 0 }, video, SV_SHARE), { k: 1, tx: 0, ty: 0 });
  assert.deepEqual(cropTransform(box, { w: 0, h: 0 }, SV_SHARE), { k: 1, tx: 0, ty: 0 });
}
{
  // drawImage source rects: whole pixels, inside the region.
  const r = sourceRect({ w: 1280, h: 720 }, SV_SPEAKER);
  assert.deepEqual(r, { x: 967, y: 90, w: 306, h: 172 });
  for (const v of [Object.values(r)]) for (const n of v) assert.ok(Number.isInteger(n));
  const strip = sourceRect({ w: 1280, h: 720 }, beaconStrip());
  assert.deepEqual(strip, { x: 1216, y: 704, w: 64, h: 16 });
  assert.deepEqual(sourceRect({ w: 0, h: 0 }, SV_SHARE), { x: 0, y: 0, w: 0, h: 0 });
}

// ------------------------------------------------------------------ the PiP
{
  const box = { w: 390, h: 300 };
  const size = pipSize(box);
  near(size.w / size.h, 16 / 9, 0.05);
  assert.ok(size.w >= 96 && size.w <= 240);
  // Every corner inside the box and clear of the chrome insets.
  for (const c of ["tl", "tr", "bl", "br"] as const) {
    const p = cornerPosition(c, size, box);
    assert.ok(p.x >= PIP_INSETS.left && p.x + size.w <= box.w - PIP_INSETS.right + 1e-6, c);
    assert.ok(p.y >= PIP_INSETS.top && p.y + size.h <= box.h - PIP_INSETS.bottom + 1e-6, c);
    // Dropped at its own corner, it snaps back to it.
    assert.equal(nearestCorner(p, size, box), c);
  }
  // Dropped near the bottom left: bottom left.
  assert.equal(nearestCorner({ x: 10, y: 250 }, size, box), "bl");
  assert.equal(nearestCorner({ x: 300, y: 5 }, size, box), "tr");
  // A short stage shrinks the PiP to fit between the insets.
  const short = { w: 390, h: 160 };
  const small = pipSize(short);
  assert.ok(small.h <= short.h - PIP_INSETS.top - PIP_INSETS.bottom);
  // Wide screens: capped.
  assert.equal(pipSize({ w: 2000, h: 1200 }).w, 240);
  // Tap versus drag.
  assert.equal(isTap(2, 3), true);
  assert.equal(isTap(10, 0), false);
}
{
  assert.deepEqual(parsePipPrefs(null), DEFAULT_PIP);
  assert.deepEqual(parsePipPrefs("not json"), DEFAULT_PIP);
  assert.deepEqual(parsePipPrefs('{"corner":"bl","minimised":true}'), { corner: "bl", minimised: true });
  assert.deepEqual(parsePipPrefs('{"corner":"middle"}'), { corner: DEFAULT_PIP.corner, minimised: false });
  assert.deepEqual(parsePipPrefs("null"), DEFAULT_PIP);
}

console.log("speaker-view: all tests passed");
