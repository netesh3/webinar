/* Tests for the composite's layout registry. Run with `make test-web`.
 *
 * The egress box is the one place nobody looks at while it runs, so these check the
 * properties a broken layout would quietly violate: every box inside the frame, nothing
 * overlapping except a PiP bubble, bounded tile counts, and each fallback. */

import assert from "node:assert/strict";
import {
  audienceLayoutFromMetadata,
  cameraIsOn,
  decodeParticipantLeft,
  GRID_MAX,
  hasLeft,
  gridRects,
  isEdgeTemplatePath,
  isStageTile,
  LAYOUTS,
  layoutById,
  noteJoined,
  noteLeft,
  placeStage,
  SHARE_ID,
  thumbnailFor,
  usesSpeakerView,
  type LayoutInput,
  type LayoutResult,
  type Rect,
  type StageTile,
} from "./composite-layouts.ts";
import { beaconCells, SV_SHARE, SV_SPEAKER, toPixels } from "./speaker-view.ts";

const FRAMES = [
  { w: 1920, h: 1080 },
  { w: 1280, h: 720 },
];

function cams(n: number, on = true): StageTile[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, cameraOn: on }));
}

const EPS = 0.5;
function inside(r: Rect, f: { w: number; h: number }): boolean {
  return r.x >= -EPS && r.y >= -EPS && r.x + r.w <= f.w + EPS && r.y + r.h <= f.h + EPS && r.w > 0 && r.h > 0;
}
function overlaps(a: Rect, b: Rect): boolean {
  return a.x + EPS < b.x + b.w && b.x + EPS < a.x + a.w && a.y + EPS < b.y + b.h && b.y + EPS < a.y + a.h;
}
function ids(r: LayoutResult): string[] {
  return r.placements.map((p) => p.id);
}

// Every layout, every stage shape: rects in frame, unique ids, no overlap on the base layer.
for (const def of LAYOUTS) {
  for (const frame of FRAMES) {
    for (const share of [false, true]) {
      for (const n of [0, 1, 2, 3, 5, 9, 16, 30]) {
        for (const edge of [false, true]) {
          const input: LayoutInput = { frame, share, cameras: cams(n), edge };
          const out = def.place(input);
          const label = `${def.id} ${frame.w}x${frame.h} share=${share} n=${n} edge=${edge}`;
          assert.equal(new Set(ids(out)).size, out.placements.length, `${label}: duplicate id`);
          for (const p of out.placements) {
            assert.ok(inside(p.rect, frame), `${label}: ${p.id} outside the frame ${JSON.stringify(p.rect)}`);
            if (p.id === SHARE_ID) assert.ok(share, `${label}: a share placed with no share`);
          }
          const base = out.placements.filter((p) => p.z === 0);
          for (let i = 0; i < base.length; i++) {
            for (let j = i + 1; j < base.length; j++) {
              assert.ok(!overlaps(base[i].rect, base[j].rect), `${label}: ${base[i].id} overlaps ${base[j].id}`);
            }
          }
          // Only a PiP is drawn over anything, and PiPs never overlap each other.
          const over = out.placements.filter((p) => p.z === 1);
          for (const p of over) assert.equal(p.role, "pip", `${label}: z=1 that is not a pip`);
          for (let i = 0; i < over.length; i++) {
            for (let j = i + 1; j < over.length; j++) {
              assert.ok(!overlaps(over[i].rect, over[j].rect), `${label}: pips overlap`);
            }
          }
          // Bounded: never more than one page of grid plus the share.
          assert.ok(out.placements.length <= GRID_MAX + 1, `${label}: ${out.placements.length} tiles`);
          // Nobody on stage and nothing shared is the waiting screen, for every layout.
          if (n === 0 && !share) assert.equal(out.placements.length, 0, `${label}: tiles from nothing`);
        }
      }
    }
  }
}

const F = { w: 1280, h: 720 };
const at = (id: string, share: boolean, n: number, edge = false, cameras = cams(n)) =>
  placeStage(id, { frame: F, share, cameras, edge });

// auto, standard share: the share beside a strip down the right; every camera that fits.
{
  const out = at("auto", true, 3);
  assert.deepEqual(ids(out), [SHARE_ID, "p0", "p1", "p2"]);
  const share = out.placements[0].rect;
  assert.ok(share.w < F.w * 0.8 && share.h > F.h * 0.95);
  assert.equal(at("auto", true, 0).note !== undefined, true, "empty strip says no camera");
}
// auto, edge share: speaker view, the default when the host has not chosen a layout.
{
  assert.deepEqual(at("auto", true, 5, true), at("speaker_view", true, 5, true));
  assert.deepEqual(at("auto", true, 0, true), at("speaker_view", true, 0, true));
}
// speaker view: the share and ONE speaker at the fixed geometry, with the beacon.
{
  const out = at("speaker_view", true, 4);
  assert.deepEqual(ids(out), [SHARE_ID, "p0"], "only the lead camera");
  assert.deepEqual(out.placements[0].rect, toPixels(SV_SHARE, F));
  assert.deepEqual(out.placements[1].rect, toPixels(SV_SPEAKER, F));
  assert.equal(out.placements[1].bare, true);
  assert.equal(out.beacon?.length, beaconCells().length);
  // Same in the edge mix and the recording: the recorded file is the sidebar variant.
  assert.deepEqual(at("speaker_view", true, 4, true), out);
  // Nobody on stage beside the share: the share alone, no beacon (nothing for a phone to split).
  const alone = at("speaker_view", true, 0);
  assert.deepEqual(alone.placements.map((p) => p.rect), [{ x: 0, y: 0, w: F.w, h: F.h }]);
  assert.equal(alone.beacon, undefined);
  // No share: speaker view's no-share fallback is the speaker layout, no beacon.
  assert.deepEqual(at("speaker_view", false, 3), at("speaker", false, 3));
  // No other layout paints the beacon.
  for (const def of LAYOUTS) {
    if (def.id === "speaker_view" || def.id === "auto") continue;
    for (const share of [false, true]) assert.equal(at(def.id, share, 3, true).beacon, undefined, def.id);
  }
  assert.equal(at("auto", true, 3, false).beacon, undefined, "auto in a standard recording");
  assert.equal(at("auto", false, 3, true).beacon, undefined);
}
// usesSpeakerView: when the page puts the sticky speaker first.
{
  assert.equal(usesSpeakerView("speaker_view", true, false), true);
  assert.equal(usesSpeakerView("auto", true, true), true);
  assert.equal(usesSpeakerView("auto", true, false), false);
  assert.equal(usesSpeakerView("speaker_view", false, true), false);
  assert.equal(usesSpeakerView("grid", true, true), false);
  assert.equal(usesSpeakerView("bogus", true, true), true, "unknown reads as auto");
}
// auto without a share is the same in both modes: speaker main, the others along the top.
{
  assert.deepEqual(at("auto", false, 3, true), at("auto", false, 3, false));
  const out = at("auto", false, 3);
  assert.equal(out.placements[0].id, "p0");
  assert.equal(out.placements[0].role, "main");
  for (const p of out.placements.slice(1)) assert.ok(p.rect.y < out.placements[0].rect.y);
}

// speaker: the lead large, the others smaller, the share in the filmstrip.
{
  const out = at("speaker", true, 3);
  assert.equal(out.placements[0].id, "p0");
  assert.ok(ids(out).includes(SHARE_ID));
  const main = out.placements[0].rect;
  for (const p of out.placements.slice(1)) assert.ok(p.rect.w < main.w / 2);
  // Only a share: it fills the frame.
  assert.deepEqual(ids(at("speaker", true, 0)), [SHARE_ID]);
}

// grid: equal tiles, one page at most, share first.
{
  const out = at("grid", true, 30);
  assert.equal(out.placements.length, GRID_MAX);
  assert.equal(out.placements[0].id, SHARE_ID);
  const w0 = out.placements[0].rect.w;
  for (const p of out.placements) assert.ok(Math.abs(p.rect.w - w0) < 0.01);
  assert.equal(gridRects(0, { x: 0, y: 0, w: 100, h: 100 }).length, 0);
}

// share_only: the share alone; speaker view when nobody shares.
assert.deepEqual(ids(at("share_only", true, 4)), [SHARE_ID]);
assert.deepEqual(at("share_only", false, 3), at("speaker", false, 3));

// share_speaker: the share full frame, the lead in a bubble bottom-right; speaker otherwise.
{
  const out = at("share_speaker", true, 3);
  assert.deepEqual(ids(out), [SHARE_ID, "p0"]);
  const pip = out.placements[1];
  assert.equal(pip.role, "pip");
  assert.equal(pip.z, 1);
  assert.ok(pip.rect.x > F.w / 2 && pip.rect.y > F.h / 2);
  assert.deepEqual(at("share_speaker", false, 2), at("speaker", false, 2));
  assert.deepEqual(ids(at("share_speaker", true, 0)), [SHARE_ID]);
}

// side_by_side: share on the left two thirds, the lead on the right; speaker otherwise.
{
  const out = at("side_by_side", true, 3);
  assert.deepEqual(ids(out), [SHARE_ID, "p0"]);
  const [share, lead] = out.placements.map((p) => p.rect);
  assert.ok(share.x + share.w <= (F.w * 2) / 3 + EPS);
  assert.ok(lead.x >= (F.w * 2) / 3 - EPS);
  assert.deepEqual(at("side_by_side", false, 2), at("speaker", false, 2));
}

// video_only: the share never appears; one camera is speaker, a few are a grid.
{
  for (const n of [0, 1, 2, 5, 16, 20]) assert.ok(!ids(at("video_only", true, n)).includes(SHARE_ID), `n=${n}`);
  assert.deepEqual(ids(at("video_only", true, 1)), ["p0"]);
  assert.ok(at("video_only", true, 4).placements.every((p) => p.role === "grid"));
  assert.equal(at("video_only", true, 20).placements[0].role, "main");
  assert.equal(at("video_only", true, 0).placements.length, 0);
}

// Registry: unknown ids are auto; the thumbnail is the layout's own boxes.
assert.equal(layoutById("mosaic").id, "auto");
assert.equal(layoutById(undefined).id, "auto");
assert.deepEqual(
  LAYOUTS.map((l) => l.id),
  ["auto", "speaker", "grid", "share_only", "speaker_view", "share_speaker", "side_by_side", "video_only"],
);
for (const def of LAYOUTS) {
  const t = thumbnailFor(def);
  assert.ok(t.placements.length > 0, `${def.id} thumbnail is empty`);
  for (const p of t.placements) assert.ok(inside(p.rect, { w: 160, h: 90 }), `${def.id} thumbnail`);
}

// Room metadata.
assert.equal(audienceLayoutFromMetadata(JSON.stringify({ controls: { audienceLayout: "grid" } })), "grid");
assert.equal(audienceLayoutFromMetadata(JSON.stringify({ controls: { audienceLayout: "nope" } })), "auto");
assert.equal(audienceLayoutFromMetadata(JSON.stringify({ controls: {} })), "auto");
assert.equal(audienceLayoutFromMetadata("{not json"), "auto");
assert.equal(audienceLayoutFromMetadata(""), "auto");

// Who is a tile: not the egress, not an agent, not a plain attendee.
const who = { isLocal: false, isAgentOrEgress: false, hasVideoPublication: false, canPublishVideo: false };
assert.equal(isStageTile({ ...who, isLocal: true, hasVideoPublication: true }), false);
assert.equal(isStageTile({ ...who, isAgentOrEgress: true, canPublishVideo: true }), false);
assert.equal(isStageTile(who), false);
assert.equal(isStageTile({ ...who, hasVideoPublication: true }), true);
assert.equal(isStageTile({ ...who, canPublishVideo: true }), true);

// Who has left, by the SFU's word (participant-left): the connection that left, not a rejoin.
assert.deepEqual(decodeParticipantLeft({ kind: "participant-left", identity: "att_A", sid: "PA_1" }), {
  identity: "att_A",
  sid: "PA_1",
});
assert.equal(decodeParticipantLeft({ kind: "participant-left", identity: "att_A" }), null);
assert.equal(decodeParticipantLeft({ kind: "chat", identity: "att_A", sid: "PA_1" }), null);
assert.equal(decodeParticipantLeft(null), null);
{
  let left = noteLeft(new Map(), "att_A", "PA_1");
  // That connection, camera or not, is gone.
  assert.equal(hasLeft({ identity: "att_A", sid: "PA_1", hasPublications: true }, left), true);
  // A stale copy with nothing published, under a sid the packet never named: gone too.
  assert.equal(hasLeft({ identity: "att_A", sid: "PA_0", hasPublications: false }, left), true);
  // ...but one still publishing is a live connection, not a ghost.
  assert.equal(hasLeft({ identity: "att_A", sid: "PA_0", hasPublications: true }, left), false);
  // Nobody else is touched.
  assert.equal(hasLeft({ identity: "att_B", sid: "PA_9", hasPublications: false }, left), false);
  // A late join event for the sid that left changes nothing...
  assert.equal(noteJoined(left, "att_A", "PA_1"), left);
  // ...a rejoin, a new sid, forgets the departure, camera off or on.
  left = noteJoined(left, "att_A", "PA_2");
  assert.equal(hasLeft({ identity: "att_A", sid: "PA_2", hasPublications: false }, left), false);
  assert.equal(left.has("att_A"), false);
}

// Kept from composite-layout.test.mts.
assert.equal(cameraIsOn({ publication: { isMuted: false, isSubscribed: true } }), true);
assert.equal(cameraIsOn({ publication: { isMuted: true, isSubscribed: true } }), false);
assert.equal(cameraIsOn({ publication: { isMuted: false, isSubscribed: false } }), false);
assert.equal(cameraIsOn({ publication: undefined }), false);
assert.equal(cameraIsOn({}), false);
assert.equal(isEdgeTemplatePath("/recorder-template/edge"), true);
assert.equal(isEdgeTemplatePath("/recorder-template/edge/clock"), true);
assert.equal(isEdgeTemplatePath("/recorder-template/clock"), false);
assert.equal(isEdgeTemplatePath("/recorder-template"), false);
assert.equal(isEdgeTemplatePath("/recorder-template/edgewise"), false);

console.log("composite-layouts ok");
