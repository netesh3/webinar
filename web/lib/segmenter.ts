"use client";

import {
  VideoTransformer,
  type TrackTransformerDestroyOptions,
  type VideoTransformerInitOptions,
} from "@livekit/track-processors";
import { LOW_LIGHT_GLSL } from "./low-light-curve";

/* Segmentation and compositing, done ourselves.
 *
 * This replaces @livekit/track-processors' BackgroundTransformer, because two of that
 * implementation's choices are not reachable through its API and both are visible on screen.
 * It asks MediaPipe for a CATEGORY mask — a hard 0 or 1 per pixel, which stretched from 256
 * pixels across a 1280-pixel frame is a staircase edge. And it runs the square 256×256 model
 * on a 16:9 frame, squashing away the horizontal detail an arm or a shoulder edge lives in.
 * Both are hardcoded after the point where their options are spread, so the fix has to be a
 * different transformer rather than different arguments.
 *
 * Per frame, all on the GPU, in one WebGL2 context that MediaPipe shares — so the mask is
 * never read back to the CPU, which would stall the pipeline every frame:
 *
 *   ingest      The confidence mask from the landscape model (256×144, so a widescreen webcam
 *               is not squashed), stored next to the frame's own colour at the same size. The
 *               colour is what the next two steps use to tell a moving person from a
 *               flickering mask, and a person's edge from the wall behind it.
 *   temporal    The mask averaged with the last one: heavily where the picture did not move,
 *               hardly at all where it did. A fixed blend has to trade a shimmer on a still
 *               shoulder against a smear on a moving hand; measured, this lets through about
 *               a quarter of the model's own shimmer at a still edge where the fixed 0.6
 *               let through half, and follows movement as closely. On the silhouette band
 *               the hold is tighter still, with a Schmitt gap so a few percent of confidence
 *               cannot flip the cut.
 *   edge        Joint-bilateral upsample to full resolution, softstep to opacity, then a
 *               second EMA on THAT alpha (not on the coarse confidence). Small frame-to-frame
 *               alpha changes are a deadzone — outline chatter freezes — while a limb crossing
 *               a pixel still takes the new value. Ping-ponged so the next frame blends the
 *               smoothed edge, not a fresh snap.
 *   room blur   The frame with the PERSON TAKEN OUT, blurred, and divided by how much room
 *               each neighbourhood had in it. A plain blur drags the person's own colours
 *               into the room around them, and that smear is the halo round their head.
 *   composite   Person over the room, using the smoothed full-res alpha. The silhouette band
 *               is then feathered a couple of pixels (a soft rim) so whatever crawl the model
 *               still produces reads as a blur rather than a crawling line. Spill suppression
 *               keeps that rim from painting the real room onto a still.
 *
 * And around the frames, the three things that made the old version look broken rather than
 * merely soft:
 *
 *   It is never torn down to change mode. The processor stays on the track and the mode is a
 *   uniform, so Off, Blur and a picture are one frame apart, not a rebuild apart.
 *   Nothing unprocessed goes out while a background is on. Until the model is ready the
 *   whole frame is blurred, and if the graphics context is lost it is blurred on a 2D canvas
 *   while a new one is built. The old path passed the raw camera through in both cases —
 *   the real room flashing up between one background and the next.
 *   Starting up is survivable. The model loads without blocking the camera, is retried, and
 *   the context is kept warm while it loads; a context the browser takes away is rebuilt.
 */

/** What to put behind the person. */
export type Background =
  | { kind: "none" }
  /** radius: the Gaussian's sigma in pixels of a 720p frame; scaled for other sizes. */
  | { kind: "blur"; radius: number }
  | { kind: "image"; src: string };

/* Where the processor is, for the UI.
 *
 *   idle        nothing asked for, so nothing to report
 *   preparing   asked for and not showing yet — the model or the picture is on its way, or a
 *               lost graphics context is being rebuilt. The outgoing video is veiled.
 *   ready       showing what was asked for
 *   failed      given up until retry(). `error` is the raw cause, for the caller to word.
 */
export type SegmenterStatus =
  | { phase: "idle" | "preparing" | "ready" }
  | { phase: "failed"; error: unknown };

export type SegmenterOptions = {
  background: Background;
  /** How hard to lift the shadows, 0..1, where 0 is off. See LOW_LIGHT_LIFT. */
  lowLight: number;
  /** Reports per-frame cost so the caller can back out on a slow device. */
  onFrame?: (stats: { totalMs: number; segmentMs: number }) => void;
  onStatus?: (status: SegmenterStatus) => void;
};

/* Where the vendored assets are. The landscape model is the important one — see the
 * note above. Both are served from our own origin so a webinar does not depend on a
 * CDN being reachable from a corporate network. */
const WASM_PATH = "/mediapipe/wasm";
const MODEL_PATH = "/mediapipe/selfie_segmenter_landscape.tflite";

/** The matte's long side: the landscape model's own width. More would be interpolation
 *  the model did not do; the joint upsample in the composite is what adds resolution. */
const MATTE_LONG_SIDE = 256;

/* How much of the new mask each frame takes, and what decides it.
 *
 * Where the picture is still, a quarter. Segmentation is independent per frame, so a still
 * edge flickers by a few percent of confidence frame to frame, and a quarter takes that to
 * about a quarter of itself — 24–29% over four runs of make test-background, on loose hair
 * against a plain wall with a webcam's sensor noise.
 *
 * Where the picture moved, almost the whole new answer. Nine tenths (K_MOVE 0.9) left a
 * visible trail on a head turning left/right or leaning toward the camera: at a moderate
 * colour change of 0.05 — a typical face turn, not a waving hand — the old MOTION_HI of 0.1
 * only reached ~0.29 along the blend, so k sat near 0.44 and the matte lagged by more than
 * half a frame of history. Raising K_MOVE to 0.97 and tightening MOTION_HI to 0.055 puts
 * that same turn near k ≈ 0.85, and a clear move near 0.97, without touching K_STILL (so the
 * still-edge shimmer trade measured above is unchanged).
 *
 * Colour alone still undersenses small fast limbs: a waving hand is only a few matte texels,
 * and at that resolution the RGB delta can sit mid-band while confidence jumps hard. Large
 * confidence deltas (above MASK_MOTION_FLOOR, so still-edge shimmer does not count) therefore
 * also drive the motion amount. Under high motion the blend snaps harder toward the new mask
 * (MOTION_SNAP) and prefers a rising confidence (hand arriving into this pixel). Translucent
 * palms from MASK_LO on mid-confidence skin are handled in the composite via HAND_MASK_*,
 * not by lifting mid-confidence here — that solidifies furniture whenever the whole frame
 * moves.
 *
 * Outstretched arms are a different failure: the landscape selfie model often zeros the hand
 * entirely once it leaves the torso silhouette (confidence ≈0, not the mid band #189 fixed).
 * Temporal recovery therefore also seeds low-confidence warm pixels that sit next to a solid
 * person neighbour (connected limb), with a mild skin-gated dilate so a finger-width gap at
 * the silhouette can fill without expanding cool chairs. Held-still sideways arms get a
 * partial seed; waving gets the full amount. Furniture stays gated by skin chroma + neighbour
 * person — a warm desk with no solid person in the 3×3 is untouched.
 *
 * Still-edge outline flicker is a third failure mode. Segmentation is independent per
 * frame, so confidence along the silhouette chatters by a few percent even when the
 * person is still. The composite's smoothstep(MASK_LO, MASK_HI) then turns that into a
 * large alpha swing — the boundary crawls. K_STILL alone is not enough there: webcam
 * RGB noise can also push the motion metric just over MOTION_LO and briefly unlock a
 * higher k, which lets the chatter through. So on the transition band, with little
 * motion, the blend holds history harder (K_EDGE_STILL) and a Schmitt-style hysteresis
 * resists flipping which side of MASK_LO the texel is on. Under real motion both open
 * fully, so this is not a ghosting trail.
 *
 * "Moved" is the largest colour — or significant mask — change in the 3×3 neighbourhood
 * between this frame and the last, at the matte's resolution.
 */
/* Production matte hyperparameters (Enhanced / SoftSegmenter).
 *
 * Tuned against Zoom/Meet-class expectations: stable still outlines, responsive limbs,
 * soft feather without furniture leaks, and no person-colour halo into blur/stills.
 *
 *   Temporal EMA (matte resolution)
 *     K_STILL        α toward new mask when still (interior)
 *     K_EDGE_STILL   α on the silhouette band when still (stronger hold)
 *     K_MOVE         α when motion is high
 *     MOTION_*       RGB/mask motion → blend amount
 *     EDGE_HYST      Schmitt pull across MASK_LO when still
 *
 *   Confidence → opacity
 *     MASK_LO/HI     cool pixels (furniture cut); softstep feather
 *     HAND_MASK_*    warm uncertain pixels (palms / seeded limbs)
 *     ROOM_LO        person exclusion from the room-blur prepass
 *
 *   Guided upsample (full resolution)
 *     SIGMA_SPACE    matte-texel neighbourhood for joint bilateral
 *     SIGMA_COLOR    RGB guide tightness (smaller = snappier to colour edges)
 *
 *   Display alpha (full-res, after bilateral + softstep — the edge pass)
 *     ALPHA_TEMP_*   EMA + deadzone on the upsampled alpha. Small |Δα| freezes (chatter);
 *                    large |Δα| takes the new edge (a limb actually moved).
 *     EDGE_FEATHER_* soft rim in screen pixels, silhouette band only
 *     SPILL_*        edge decontamination so FG lighting does not fringe onto BG
 *
 *   Blur / veil: BLUR_RADIUS lives in backgrounds.ts (720p-referenced sigma).
 */
const K_STILL = 0.2;
/** Stronger EMA hold on the silhouette band when still — where softstep amplifies chatter. */
const K_EDGE_STILL = 0.07;
/** How hard a still silhouette texel sticks to its previous side of MASK_LO (0..1). */
const EDGE_HYST = 0.72;
const K_MOVE = 0.97;
/** Floor for RGB/mask motion. Above typical webcam sensor noise so still edges
 *  are not unlocked into K_MOVE by grain alone. */
const MOTION_LO = 0.03;
const MOTION_HI = 0.055;
/** Confidence deltas below this are treated as model shimmer, not limb motion. */
const MASK_MOTION_FLOOR = 0.2;
/** How strongly a (floor-subtracted) confidence jump counts as motion, vs RGB. */
const MASK_MOTION_GAIN = 1.1;
/** Extra pull toward the new mask at full motion (on top of K_MOVE). */
const MOTION_SNAP = 0.65;
/** How hard to seed a missing warm limb texel toward person when a neighbour is solid. */
const EXTREMITY_SEED = 0.88;
/** Confidence floor a seeded extremity is lifted toward (into the HAND_MASK opaque zone). */
const EXTREMITY_FLOOR = 0.66;
/** Still-limb seed strength as a fraction of the moving-limb seed (held-outstretched arms). */
const EXTREMITY_STILL = 0.42;
/** Skin-gated max-dilate: keep this fraction of the neighbourhood person max. */
const EXTREMITY_DILATE_KEEP = 0.90;
/** How strongly the skin-gated dilate applies when a solid neighbour is present. */
const EXTREMITY_DILATE = 0.55;

/* Where the mask becomes opaque, and why it is not centred on a half.
 *
 * The model is not equally sure about everything it calls a person. Measured on a real
 * frame — someone at a desk with an office chair behind them and a throw over its back —
 * the confidences separate into two clusters:
 *
 *   shirt              median 1.00     99% above 0.80
 *   face               median 1.00     82% above 0.80
 *   chair back         median 0.63     31% above 0.80
 *   throw over chair   median 0.62     41% above 0.80
 *   clear wall         median 0.00      0% above 0.80
 *
 * The furniture is not noise. The model half-believes in it, because a fabric throw over a
 * chair beside a shoulder genuinely looks like clothing — the multiclass model was tried
 * and labels it `clothes` with 0.48 confidence, so a bigger model does not help.
 *
 * A transition from 0.35 to 0.65 has its midpoint at 0.5 and therefore keeps everything
 * the model half-believes: measured, it retained 76% of the chair. Placing a NARROW
 * transition just above the furniture's median instead cuts that to 41% while costing the
 * face 1% and the shirt nothing.
 *
 * Narrow, and not higher, is the important part. Going further looks better on this frame
 * and is a trap — the numbers below are mean alpha with the whole mask scaled down by 20%,
 * which is what a dim room or a backlit window does to the model's confidence:
 *
 *                  chair kept        face at 80% confidence
 *   0.35 - 0.65       76%                    83%
 *   0.62 - 0.75       41%                    82%      <- MASK_LO stays here
 *   0.68 - 0.88       33%                    52%
 *   0.75 - 0.92       30%                    17%      <- erases people in bad light
 *
 * MASK_HI is a little higher than the measured 0.75 cut (0.80) so the softstep feather
 * is ~Zoom-soft without lowering MASK_LO (which would reopen the chair). Erosion was
 * measured as the alternative and is worse at both ends: 14 mask pixels of it took the
 * chair to 36% but the face to 73%.
 *
 * Hands break the furniture trade: palms often land in the same mid band as the chair
 * (≈0.55–0.70), so MASK_LO punches translucent holes through them. Lowering MASK_LO
 * globally brings the chair back. The composite therefore keeps these thresholds for cool
 * pixels, and on warm (skin-chroma) uncertain pixels only, dips the band so a confidence
 * of ~0.40–0.55 reads nearly opaque — see HAND_MASK_* — without reopening cool furniture.
 * Hands the model zeros entirely (outstretched beyond the torso) are seeded in the temporal
 * pass first; the composite band alone cannot invent confidence from nothing.
 */
const MASK_LO = 0.62;
const MASK_HI = 0.8;
/** Soften the person threshold on warm mid-confidence pixels (hands), not on cool chairs. */
const HAND_MASK_LO = 0.42;
const HAND_MASK_HI = 0.70;
/** Skin chroma (R−B) where the hand band fully replaces MASK_LO/HI. Kept high so warm
 *  wood/desk mid-confidence does not solidify as a person (that made the probe label
 *  whole frames "lifted" instead of the office still). */
const HAND_WARM_LO = 0.08;
const HAND_WARM_HI = 0.16;
/** Lower end of the "uncertain" band where HAND_MASK_* may apply. Slightly below the
 *  #189 mid-palm band so extremity-seeded confidence (~0.66) and weak limb fringe still
 *  read opaque on warm pixels without opening clear-room furniture. */
const HAND_UNCERTAIN_LO = 0.28;
const HAND_UNCERTAIN_MID = 0.50;

/** Below this the blur counts a pixel wholly as room. Between it and MASK_LO the pixel is
 *  shown as room but kept out of the blur, so furniture the model half-believes in is
 *  painted over by the wall around it rather than smeared into it. */
const ROOM_LO = 0.28;

/* The joint upsample. Spatial sigma in matte texels, colour sigma in 0..1 RGB distance.
 *
 * SIGMA_SPACE 1.15 keeps the vote on the nearest matte texels so the head does not
 * smear a skin-coloured shell onto the background. SIGMA_COLOR 0.09 snaps that
 * vote to the real colour boundary (skin against a wall) instead of averaging across it.
 */
const SIGMA_SPACE = 1.15;
const SIGMA_COLOR = 0.09;

/** Display-alpha temporal filter (after softstep + bilateral), in the edge pass.
 *  |Δα| below ALPHA_TEMP_LO is a deadzone: the outline holds still instead of crawling.
 *  |Δα| above ALPHA_TEMP_HI takes the new alpha in full, so a moving limb does not ghost.
 *  ALPHA_TEMP_STILL is the slow blend in between. */
const ALPHA_TEMP_STILL = 0.15;
const ALPHA_TEMP_LO = 0.08;
const ALPHA_TEMP_HI = 0.38;

/** Soft rim, in output pixels, applied only after the faint shell is choked off.
 *  Small on purpose: a wider blur copies the face onto the background beside the head. */
const EDGE_FEATHER_PX = 1.25;
const EDGE_FEATHER_MIX = 0.35;
/** Display alpha below LO is background (kills the skin-coloured shell around the head).
 *  Above HI the person is solid. The band between them is the only soft edge. */
const ALPHA_CHOKE_LO = 0.28;
const ALPHA_CHOKE_HI = 0.62;

/** Edge decontamination: mix FG toward BG on the remaining soft rim so skin does not
 *  fringe onto a still (stronger — the office is a different colour) or the room blur. */
const SPILL_IMAGE = 0.72;
const SPILL_BLUR = 0.45;

/** How strong the veil is, in the same units as a blur background's radius. Enough that the
 *  room is unreadable while the model starts; this is what a background looks like loading. */
const VEIL_RADIUS = 28;
/** How long the veil takes to lift once the matte is ready. A cut from a blurred frame to a
 *  sharp one reads as a glitch; a third of a second reads as it coming into focus. */
const VEIL_FADE_MS = 300;

/** Model load attempts, and how long to wait before each. The download is the part that
 *  fails, and a second try a moment later is usually the one that works. */
const MODEL_RETRY_MS = [0, 1000, 3000];
/** Graphics context rebuilds, likewise. Beyond three, whatever is taking the context away
 *  will take the next one too, and saying so beats fighting it. */
const REBUILD_RETRY_MS = [0, 1000, 3000];
/** A context that lasted this long was a one-off loss, so the rebuild count starts over. */
const ENGINE_SETTLED_MS = 10_000;
/** Consecutive segmentation errors before the MediaPipe instance is replaced, and how many
 *  replacements before giving up on it. */
const SEGMENT_ERROR_LIMIT = 5;
const SEGMENTER_RESTART_LIMIT = 2;

/** How long an engine outlives its processor, so the next one can take it over. See park. */
const PARK_MS = 30_000;
/** The 2D veil's long side. Blown back up to the frame, each of its pixels is a soft blob
 *  about 27 pixels across at 720p — nothing in a room survives that. */
const FLAT_LONG_SIDE = 48;

/* How much the still is zoomed past a plain object-fit: cover.
 *
 * 1.0 is edge-to-edge cover. The usable half-margin after cover is
 * (OVERSCALE - 1) / (2 * OVERSCALE): at 1.14 that is ~6.1% of UV on each side. Person
 * tracking pans the still inside that margin (see PAN_*), so the overscale must leave
 * room for the clamped pan — 1.10 was only enough for ~4.5% and the pan hit the clamp
 * band on a normal lean. Higher starts to look like a digital zoom on the photo. */
const COVER_OVERSCALE = 1.14;

/* Face/body-driven still pan.
 *
 * SoftSegmenter has no separate face-mesh tracker: the person centre is the alpha-weighted
 * centroid of the smoothed matte, read from a tiny downsample so left/right travel can
 * shift the still without a full-frame readback. Raw centroids jitter a few percent of UV
 * every frame (segmentation noise + temporal blend), which reads as stutter when applied
 * directly to cover UVs. The pan is therefore:
 *   1. deadzoned — sub-threshold motion holds the current pan
 *   2. exponentially smoothed — settles in about PAN_SMOOTH_MS
 *   3. speed-capped — no single frame can jump more than PAN_MAX_SPEED
 *   4. clamped — never asks for more margin than COVER_OVERSCALE provides
 * Gain is less than one so a walk to the frame edge does not burn the whole margin. */
const PAN_GAIN_X = 0.28;
const PAN_GAIN_Y = 0;
const PAN_MARGIN_FRAC = 0.85;
const PAN_SMOOTH_MS = 140;
const PAN_DEADZONE = 0.012;
const PAN_MAX_SPEED = 0.55;
/** Long side of the matte downsample used only to estimate the person centre. */
const TRACK_LONG_SIDE = 32;
/** Matte alpha below this does not vote for the centroid (skips clear room). */
const TRACK_ALPHA_LO = 0.2;

function panLimit(): number {
  return ((COVER_OVERSCALE - 1) / (2 * COVER_OVERSCALE)) * PAN_MARGIN_FRAC;
}

// ------------------------------------------------------------------- shaders

/* Two vertex shaders, and the difference between them was a bug that took a screenshot
 * to find. Read this before adding a pass.
 *
 * A framebuffer's row 0 is its BOTTOM. An uploaded image's row 0 is its TOP. So sampling
 * with `1.0 - y` inverts vertically, which is exactly what the final pass to the canvas
 * needs — and exactly what an intermediate pass must not do, because every pass would
 * invert again and the parity of the chain becomes load-bearing.
 *
 * It was, and it was wrong. Measured with a still of a person sitting low in frame, whose
 * mask reads [0,0,4,5,11,14] top-to-bottom straight out of `getAsFloat32Array`:
 *
 *   The mask reached the composite through three offscreen passes — feather across,
 *   feather down, blend. Three inversions is one inversion, so it arrived UPSIDE DOWN:
 *   frame one measured [14,11,5,4,0,0], the exact mirror. On screen that is a person's
 *   torso cutting a hole in the ceiling behind them.
 *
 *   Worse, the temporal blend re-inverted the PREVIOUS mask every frame, so the running
 *   average was the mask mixed with mirrored copies of itself. By frame four it had
 *   diffused to a flat [10,8,5,4,4,4], which the smoothstep below floors to nothing —
 *   the person disappeared completely rather than merely being upside down.
 *
 * So: offscreen passes pass V through untouched, and only the composite flips. Parity
 * then cannot be got wrong by adding or removing a pass. The passes that address texels
 * directly (texelFetch, gl_FragCoord) are row-for-row by construction, for the same reason.
 */
const VERTEX_PASS = `#version 300 es
layout(location = 0) in vec2 position;
out vec2 uv;
void main() {
  // Offscreen. Row for row: whatever orientation came in, goes out.
  uv = (position + 1.0) * 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const VERTEX_PRESENT = `#version 300 es
layout(location = 0) in vec2 position;
out vec2 uv;
void main() {
  // To the canvas. One flip, so image row 0 lands at the top of the picture.
  uv = vec2((position.x + 1.0) * 0.5, 1.0 - (position.y + 1.0) * 0.5);
  gl_Position = vec4(position, 0.0, 1.0);
}`;

/* The mask, and the colour under it, at the matte's resolution.
 *
 * The mask is read with texelFetch through a NEAREST sampler, and both are deliberate. It
 * may be a float texture, which is not filterable without an extension — and a texture that
 * cannot be filtered the way its sampler asks is incomplete, which reads as zero everywhere:
 * no person, silently. It may also be at the input's resolution rather than the model's,
 * so it is addressed by position rather than assumed to line up texel for texel.
 *
 * The colour comes from the frame's mip chain at the level that matches this target, which
 * is a box-filtered downsample for free — the average colour of the pixels each mask texel
 * speaks for, which is what the temporal and joint filters compare against. */
const INGEST = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D frame;
uniform sampler2D confidence;
uniform float lod;
out vec4 color;
void main() {
  vec2 size = vec2(textureSize(confidence, 0));
  float person = texelFetch(confidence, ivec2(min(uv * size, size - 1.0)), 0).r;
  color = vec4(textureLod(frame, uv, lod).rgb, person);
}`;

/* The mask, blended with the last one in proportion to how much the picture moved.
 *
 * Ping-pong, because a framebuffer cannot sample the texture it is writing to. `previous`
 * carries its own frame's colour, so the motion test compares like with like. This is a
 * running average, so it only works if what goes in comes out the same way up — see the
 * vertex shaders; a temporal filter amplifies a geometry error instead of hiding it.
 *
 * Fast limbs need more than a high K_MOVE: RGB motion at matte resolution can undershoot
 * on a small hand, so confidence jumps join the motion metric, the blend snaps harder, and
 * rising confidence is preferred under motion (hand entering this texel).
 *
 * Far outstretched hands that the model zeros are recovered only when a solid person
 * neighbour remains (connected limb) and the texel is warm skin — see EXTREMITY_*.
 *
 * Still silhouettes need the opposite of a high k: the opacity softstep amplifies a few
 * percent of confidence chatter into a crawling edge. On the transition band, with little
 * motion, k is capped at K_EDGE_STILL and a Schmitt pull resists flipping which side of
 * MASK_LO the texel is on. Extremity seeds disable that pull so a recovered limb is not
 * immediately glued back to "missing". */
const TEMPORAL = `#version 300 es
precision highp float;
uniform sampler2D current;    // guide colour, raw confidence
uniform sampler2D previous;   // guide colour, smoothed confidence
uniform float restart;        // 1 when there is no previous worth blending with
out vec4 color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 last = textureSize(current, 0) - 1;
  vec4 now = texelFetch(current, p, 0);
  float before = texelFetch(previous, p, 0).a;
  float motion = 0.0;
  float nbrPerson = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      ivec2 q = clamp(p + ivec2(x, y), ivec2(0), last);
      vec4 cq = texelFetch(current, q, 0);
      vec4 pq = texelFetch(previous, q, 0);
      vec3 d = abs(cq.rgb - pq.rgb);
      motion = max(motion, max(d.r, max(d.g, d.b)));
      // Limb enter/leave moves confidence hard; still-edge shimmer stays under the floor.
      float da = abs(cq.a - pq.a);
      motion = max(motion, max(0.0, da - ${MASK_MOTION_FLOOR.toFixed(3)})
                          * ${MASK_MOTION_GAIN.toFixed(3)});
      // Connected-limb cue: solid person nearby in this frame or the smoothed history.
      nbrPerson = max(nbrPerson, max(cq.a, pq.a));
    }
  }
  float moveAmt = smoothstep(${MOTION_LO.toFixed(3)}, ${MOTION_HI.toFixed(3)}, motion);
  float k = mix(${K_STILL.toFixed(3)}, ${K_MOVE.toFixed(3)}, moveAmt);
  // Quadratic snap: leave still edges alone, chase waving hands to the new mask.
  k = mix(k, 1.0, moveAmt * moveAmt * ${MOTION_SNAP.toFixed(3)});
  // Silhouette band: where softstep(MASK_LO, MASK_HI) turns small confidence chatter
  // into large alpha swings. Hold history harder there when the picture is still.
  float bandSrc = max(before, now.a);
  float edgeBand = smoothstep(0.48, 0.56, bandSrc) * (1.0 - smoothstep(0.80, 0.90, bandSrc));
  float still = 1.0 - moveAmt;
  k = mix(k, min(k, ${K_EDGE_STILL.toFixed(3)}), still * edgeBand);
  float a = mix(before, now.a, max(k, restart));
  // Prefer rising person confidence under motion (hand arriving); clearing uses high k.
  a = mix(a, max(a, now.a), moveAmt * moveAmt);
  // Under clear limb motion, lift warm mid-confidence toward opaque before MASK_LO.
  // Gated by moveAmt² and skin chroma so still edges and cool furniture are untouched.
  float skin = smoothstep(${HAND_WARM_LO.toFixed(3)}, ${HAND_WARM_HI.toFixed(3)}, now.r - now.b)
             * smoothstep(0.0, 0.05, now.r - now.g);
  float mid = smoothstep(0.45, 0.58, a) * (1.0 - smoothstep(0.72, 0.88, a));
  a = mix(a, max(a, mix(a, 0.82, mid)), moveAmt * moveAmt * skin);

  // Extremity recovery for hands the model dropped outside the torso silhouette.
  // Requires warm skin + a solid person neighbour; still limbs get a partial seed so a
  // held-outstretched arm is not only recoverable while waving. Left/right frame edges
  // (typical reach) get a mild boost; cool furniture never qualifies as skin.
  float connected = smoothstep(0.55, 0.78, nbrPerson);
  float missing = 1.0 - smoothstep(0.18, 0.48, a);
  float limbMotion = mix(${EXTREMITY_STILL.toFixed(3)}, 1.0, moveAmt * moveAmt);
  vec2 uv = (vec2(p) + 0.5) / vec2(last + 1);
  float side = max(smoothstep(0.30, 0.05, uv.x), smoothstep(0.70, 0.95, uv.x));
  float seed = skin * connected * missing * limbMotion
             * mix(1.0, 1.2, side) * ${EXTREMITY_SEED.toFixed(3)};
  a = max(a, mix(a, ${EXTREMITY_FLOOR.toFixed(3)}, seed));
  // Close a finger-width hole only. The same dilate on a solid neighbour grows the
  // head: every warm texel beside the skull inherits the skull and the face appears
  // again, faint, on the background at the sides and above the hair.
  float dilate = max(a, nbrPerson * ${EXTREMITY_DILATE_KEEP.toFixed(3)});
  a = mix(a, max(a, dilate), skin * connected * missing * ${EXTREMITY_DILATE.toFixed(3)});

  // Schmitt hold on the furniture/person cut when still. History must be crossed by a
  // gap (~0.07 confidence) before a still texel is allowed to flip; a few percent of
  // model chatter stays on the side it already chose. Opens under motion; skipped where
  // an extremity seed just filled a hole.
  float cut = ${MASK_LO.toFixed(3)};
  float histOn = smoothstep(cut - 0.015, cut + 0.015, before);
  float dip = histOn * (1.0 - smoothstep(cut - 0.07, cut + 0.015, a));
  float hyst = still * edgeBand * ${EDGE_HYST.toFixed(3)} * clamp(1.0 - seed, 0.0, 1.0);
  a = mix(a, max(a, before), dip * hyst);
  float rise = (1.0 - histOn) * smoothstep(cut - 0.015, cut + 0.07, a);
  a = mix(a, min(a, before), rise * hyst);

  color = vec4(now.rgb, a);
}`;

/* The room, with the person taken out, ready to blur: colour premultiplied by how much of
 * the pixel is room. Blurring this and dividing by the blurred weight gives each pixel the
 * average of the ROOM around it, where a plain blur would give it the average of everything
 * — the person included, which is the halo. Quarter resolution, because a blur has no
 * detail to keep and it is a sixteenth of the work. Under the veil, all of it is room. */
const PREP = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D frame;
uniform sampler2D matte;
uniform float lod;
uniform float veil;
out vec4 color;
void main() {
  vec3 c = textureLod(frame, uv, lod).rgb;
  float person = texture(matte, uv).a * (1.0 - veil);
  float room = 1.0 - smoothstep(${ROOM_LO.toFixed(3)}, ${MASK_LO.toFixed(3)}, person);
  color = vec4(c * room, room);
}`;

/* One axis of a separable Gaussian.
 *
 * Taps in pairs, each pair one bilinear fetch placed between two texels at the point that
 * weights them correctly, so a kernel reaching 3 sigma costs 1.5 sigma fetches a side. The
 * loop bound is a constant with a break, which every GLSL ES 3 compiler unrolls or runs. */
const BLUR = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D source;
uniform vec2 texel;       // one texel along the axis being blurred
uniform float sigma;      // in texels
out vec4 color;
void main() {
  vec4 sum = texture(source, uv);
  float total = 1.0;
  float twoSigmaSq = 2.0 * sigma * sigma;
  int pairs = int(ceil(sigma * 1.5));
  for (int i = 0; i < 24; i++) {
    if (i >= pairs) break;
    float a = float(2 * i + 1);
    float b = a + 1.0;
    float wa = exp(-a * a / twoSigmaSq);
    float wb = exp(-b * b / twoSigmaSq);
    float w = wa + wb;
    vec2 offset = texel * ((a * wa + b * wb) / w);
    sum += (texture(source, uv + offset) + texture(source, uv - offset)) * w;
    total += 2.0 * w;
  }
  color = sum / total;
}`;

/* Matte alpha into a tiny target for the person-centre estimate.
 *
 * LINEAR sampling from the full matte is a free box downsample; the CPU then takes the
 * alpha-weighted centroid of those few hundred texels. Kept as its own pass so the
 * composite never blocks on a 256×144 readPixels. */
const TRACK = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D matte;
out vec4 color;
void main() {
  color = vec4(texture(matte, uv).a, 0.0, 0.0, 1.0);
}`;

/* Subtle polish on the PERSON only, after the low-light lift.
 *
 * Not a beauty filter: a mild S-curve so the presenter reads clearer against blur/stills,
 * plus a light midtone soften so skin is less harsh under webcam noise. Both are applied
 * inside the composite, after liftShadows and before alpha mix — background pixels never
 * see them. Contrast is scaled down by lowLight so it does not stack on LOW_LIGHT_CONTRAST
 * (the restore already in liftShadows): at amount 0 the full FG_CONTRAST applies; at 1 it
 * is nearly off. Soften likewise backs off when the lift has already flattened midtones.
 */
const FG_CONTRAST = 0.12;
const FG_SOFTEN = 0.28;
const FG_SOFT_LOD = 1.25;

/* Full-resolution person coverage, temporally filtered.
 *
 * The matte-resolution EMA cannot see the bilateral snap: that snap is recomputed from
 * this frame's RGB, so a still shoulder crawls by a pixel even when confidence is calm.
 * This pass is where that coverage is born (joint upsample → softstep → EMA), and the
 * result is what the next frame blends against. Veil is NOT baked in — the composite
 * applies it — so a loading fade does not poison the history.
 *
 * Offscreen, so VERTEX_PASS: same orientation as the matte. The composite flips once. */
const EDGE = `#version 300 es
precision highp float;
const float MASK_LO = ${MASK_LO.toFixed(3)};
const float MASK_HI = ${MASK_HI.toFixed(3)};
const float HAND_MASK_LO = ${HAND_MASK_LO.toFixed(3)};
const float HAND_MASK_HI = ${HAND_MASK_HI.toFixed(3)};
const float HAND_WARM_LO = ${HAND_WARM_LO.toFixed(3)};
const float HAND_WARM_HI = ${HAND_WARM_HI.toFixed(3)};
const float HAND_UNCERTAIN_LO = ${HAND_UNCERTAIN_LO.toFixed(3)};
const float HAND_UNCERTAIN_MID = ${HAND_UNCERTAIN_MID.toFixed(3)};
const float SIGMA_SPACE = ${SIGMA_SPACE.toFixed(3)};
const float SIGMA_COLOR = ${SIGMA_COLOR.toFixed(3)};
const float ALPHA_TEMP_STILL = ${ALPHA_TEMP_STILL.toFixed(3)};
const float ALPHA_TEMP_LO = ${ALPHA_TEMP_LO.toFixed(3)};
const float ALPHA_TEMP_HI = ${ALPHA_TEMP_HI.toFixed(3)};
in vec2 uv;
uniform sampler2D frame;
uniform sampler2D matte;
uniform sampler2D prevAlpha;
uniform float hasHistory;
out vec4 color;

/* Joint bilateral upsample. 4×4 matte texels vote by distance and by colour match to
 * this pixel, so a shoulder lands on the shirt/wall boundary rather than the 256-grid. */
float matteAt(vec2 p) {
  float coarse = texture(matte, p).a;
  if (coarse < 0.02 || coarse > 0.98) return coarse;
  vec2 size = vec2(textureSize(matte, 0));
  vec2 pos = p * size - 0.5;
  vec2 base = floor(pos);
  vec2 f = pos - base;
  ivec2 last = ivec2(size) - 1;
  vec3 ref = textureLod(frame, p, 1.0).rgb;
  float sum = 0.0;
  float total = 0.0;
  for (int y = -1; y <= 2; y++) {
    for (int x = -1; x <= 2; x++) {
      vec4 t = texelFetch(matte, clamp(ivec2(base) + ivec2(x, y), ivec2(0), last), 0);
      vec2 d = vec2(float(x), float(y)) - f;
      vec3 dc = t.rgb - ref;
      float w = exp(-dot(d, d) / (2.0 * SIGMA_SPACE * SIGMA_SPACE)
                    - dot(dc, dc) / (2.0 * SIGMA_COLOR * SIGMA_COLOR));
      sum += t.a * w;
      total += w;
    }
  }
  return mix(coarse, sum / max(total, 1e-6), smoothstep(0.02, 0.2, total));
}

void main() {
  vec3 raw = textureLod(frame, uv, 0.0).rgb;
  float conf = matteAt(uv);
  // A solid person in this matte neighbourhood is the head or torso. The confidence
  // falloff around that core is warm skin, and the palm threshold would treat it as a
  // hand — widening the mask so the face shows through on the left, the right, and
  // above the hair. Palms stay on the lower threshold: their neighbours are mid
  // confidence, not a solid core.
  vec2 mTex = 1.0 / vec2(textureSize(matte, 0));
  float core = texture(matte, uv).a;
  core = max(core, texture(matte, uv + vec2(mTex.x, 0.0)).a);
  core = max(core, texture(matte, uv - vec2(mTex.x, 0.0)).a);
  core = max(core, texture(matte, uv + vec2(0.0, mTex.y)).a);
  core = max(core, texture(matte, uv - vec2(0.0, mTex.y)).a);
  core = max(core, texture(matte, uv + vec2(mTex.x, mTex.y)).a);
  core = max(core, texture(matte, uv + vec2(-mTex.x, mTex.y)).a);
  core = max(core, texture(matte, uv + vec2(mTex.x, -mTex.y)).a);
  core = max(core, texture(matte, uv + vec2(-mTex.x, -mTex.y)).a);
  float notHead = 1.0 - smoothstep(0.88, 0.97, core);
  // Skin-like: red above blue AND red above green. Wood desks often fail the second.
  float warm = smoothstep(HAND_WARM_LO, HAND_WARM_HI, raw.r - raw.b)
             * smoothstep(0.0, 0.05, raw.r - raw.g);
  float uncertain = smoothstep(HAND_UNCERTAIN_LO, HAND_UNCERTAIN_MID, conf)
                  * (1.0 - smoothstep(0.72, 0.88, conf));
  float handAmt = warm * uncertain * notHead;
  float lo = mix(MASK_LO, HAND_MASK_LO, handAmt);
  float hi = mix(MASK_HI, HAND_MASK_HI, handAmt);
  float alphaRaw = smoothstep(lo, hi, conf);
  float prevA = texture(prevAlpha, uv).r;
  float dA = abs(alphaRaw - prevA);
  float takeNew = smoothstep(ALPHA_TEMP_LO, ALPHA_TEMP_HI, dA);
  // Deadzone: changes smaller than ALPHA_TEMP_LO are outline chatter, not motion.
  float hold = 1.0 - smoothstep(0.0, ALPHA_TEMP_LO, dA);
  float k = mix(ALPHA_TEMP_STILL, 1.0, takeNew);
  k = mix(k, 0.0, hold * (1.0 - takeNew));
  float alpha = mix(prevA, alphaRaw, max(k, 1.0 - hasHistory));
  color = vec4(alpha, 0.0, 0.0, 1.0);
}`;

/** The composite. Foreground over background, with the edge-pass alpha as coverage. */
const COMPOSITE = `#version 300 es
precision highp float;
const float FG_CONTRAST = ${FG_CONTRAST.toFixed(3)};
const float FG_SOFTEN = ${FG_SOFTEN.toFixed(3)};
const float FG_SOFT_LOD = ${FG_SOFT_LOD.toFixed(3)};
const float SPILL_IMAGE = ${SPILL_IMAGE.toFixed(3)};
const float SPILL_BLUR = ${SPILL_BLUR.toFixed(3)};
const float EDGE_FEATHER_PX = ${EDGE_FEATHER_PX.toFixed(3)};
const float EDGE_FEATHER_MIX = ${EDGE_FEATHER_MIX.toFixed(3)};
const float ALPHA_CHOKE_LO = ${ALPHA_CHOKE_LO.toFixed(3)};
const float ALPHA_CHOKE_HI = ${ALPHA_CHOKE_HI.toFixed(3)};
in vec2 uv;
uniform sampler2D frame;     // the camera, with mips
uniform sampler2D room;      // the room blur, premultiplied
uniform sampler2D image;     // a still
uniform sampler2D alphaMap;  // smoothed person coverage, 0..1 in R
uniform int mode;            // 0 = low light only, 1 = blur, 2 = image
uniform float veil;          // 1 = nothing usable yet: show the room blur, person and all
uniform vec2 frameSize;
uniform vec2 imageSize;
uniform vec2 bgPan;          // smoothed person-centre offset applied to still UVs
uniform float lowLight;      // 0 = off, 1 = the full lift
out vec4 color;
${LOW_LIGHT_GLSL}

/* Mild contrast + skin soften for the lifted person. softSample is the same lift at a
 * coarser mip — already alpha-gated by the caller, so the room/still is untouched. */
vec3 polishPerson(vec3 lifted, vec3 softSample) {
  float contrastAmt = FG_CONTRAST * (1.0 - lowLight * 0.85);
  vec3 contrasted = lifted * lifted * (3.0 - 2.0 * lifted);
  vec3 c = mix(lifted, contrasted, contrastAmt);
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Midtones only: leave dark hair/eyes and bright speculars sharp.
  float mid = smoothstep(0.12, 0.28, y) * (1.0 - smoothstep(0.62, 0.82, y));
  // Prefer warm skin-ish chroma over cool walls that leaked into the matte.
  float warm = smoothstep(0.0, 0.06, c.r - c.b);
  float softAmt = FG_SOFTEN * mid * warm * (1.0 - 0.5 * lowLight);
  return mix(c, softSample, softAmt);
}

/* object-fit: cover, then a little overscale.
 *
 * Cover alone maps frame UV onto the still so a 16:9 photo behind a 4:3 webcam crops
 * rather than squashes. Sampling exactly edge-to-edge leaves no slack: any pan (or the
 * person walking toward a frame edge and revealing more of the still) asks the sampler
 * for UVs past 0..1. With CLAMP_TO_EDGE that stretches the border texel into a flat band;
 * with REPEAT it tiles. Neither looks like a background.
 *
 * COVER_OVERSCALE zooms in a few percent so typical left/right travel still lands on the
 * image. bgPan is the smoothed person-centre offset (see Engine.updatePan): subtracting it
 * after the scale moves the still with the person without changing cover crop. Order is
 * load-bearing: scale about the centre, then translate — never the other way, which walks
 * off one edge while leaving unused margin on the other. */
const float COVER_OVERSCALE = ${COVER_OVERSCALE.toFixed(3)};
vec2 coverUv(vec2 p) {
  float frameAspect = frameSize.x / max(frameSize.y, 1.0);
  float imageAspect = imageSize.x / max(imageSize.y, 1.0);
  vec2 cover = imageAspect > frameAspect
    ? vec2(frameAspect / imageAspect, 1.0)
    : vec2(1.0, imageAspect / frameAspect);
  vec2 scale = cover / COVER_OVERSCALE;
  return (p - 0.5) * scale + 0.5 - bgPan;
}

/* The room behind the person: their neighbourhood's room colour, or — deep inside the
 * person, where there is no room nearby to average — a very coarse mip of the frame. That
 * only shows where the person is anyway, so it only has to be the right sort of colour. */
vec3 roomAt(vec2 p) {
  vec4 r = texture(room, p);
  return mix(textureLod(frame, p, 5.0).rgb, r.rgb / max(r.a, 1e-4), smoothstep(0.02, 0.2, r.a));
}

/* Coverage with the faint shell removed, then a 1px antialias.
 *
 * smoothstep(CHOKE) turns a wide semi-transparent ring — the face showing again just
 * outside the head — into background. The feather is narrower than that ring so it
 * softens the cut without painting the face back onto the office. */
float coverage(vec2 p) {
  return smoothstep(ALPHA_CHOKE_LO, ALPHA_CHOKE_HI, texture(alphaMap, p).r);
}
float featherAlpha(vec2 p) {
  float a0 = coverage(p);
  vec2 px = vec2(EDGE_FEATHER_PX) / frameSize;
  float soft = a0 * 0.52;
  soft += coverage(p + vec2(px.x, 0.0)) * 0.12;
  soft += coverage(p - vec2(px.x, 0.0)) * 0.12;
  soft += coverage(p + vec2(0.0, px.y)) * 0.12;
  soft += coverage(p - vec2(0.0, px.y)) * 0.12;
  float rim = smoothstep(0.04, 0.18, a0) * (1.0 - smoothstep(0.82, 0.96, a0));
  return mix(a0, soft, rim * EDGE_FEATHER_MIX);
}

void main() {
  /* Lifted once, here, and applied to the PERSON only.
   *
   * With a background on, bg below is the blurred room or a still and is left alone: the
   * person gets the light and their room does not, which is a key light rather than an
   * exposure change. With no background there is no mask to confine it to, so mode 0
   * lifts the whole frame — still the thing somebody dark on camera asked for. */
  vec3 raw = textureLod(frame, uv, 0.0).rgb;
  vec3 fg = liftShadows(raw, lowLight);
  if (mode == 0) { color = vec4(fg, 1.0); return; }

  /* Person polish only when a background is on. Mode 0 (low-light alone) stays a pure
   * lift — no soften, no extra contrast — so Off + low light does not change look. */
  fg = polishPerson(fg, liftShadows(textureLod(frame, uv, FG_SOFT_LOD).rgb, lowLight));

  vec3 bg;
  if (mode == 2 && veil <= 0.0) bg = texture(image, coverUv(uv)).rgb;
  else if (mode == 2) bg = mix(texture(image, coverUv(uv)).rgb, roomAt(uv), veil);
  else bg = roomAt(uv);
  if (veil >= 1.0) { color = vec4(bg, 1.0); return; }

  /* Coverage comes from the edge pass (bilateral + softstep + temporal deadzone).
   * Feather only the silhouette, then spill-kill so the soft rim does not paint the
   * presenter's real room onto a still or smear person colour into the blur. */
  float alpha = featherAlpha(uv) * (1.0 - veil);
  float spillStr = mode == 2 ? SPILL_IMAGE : SPILL_BLUR;
  float spill = (1.0 - alpha) * smoothstep(0.04, 0.42, alpha) * spillStr;
  fg = mix(fg, bg, spill);
  color = vec4(mix(bg, fg, alpha), 1.0);
}`;

/* One MediaPipe start-up or teardown at a time, across every instance of this class.
 *
 * A per-instance guard is enough to stop ONE transformer loading the model twice and is not
 * enough for the failure this exists to prevent: two transformers doing it at once.
 * Emscripten does not survive that. Module start-up drains shared callback arrays with
 *
 *     var callRuntimeCallbacks = callbacks => { while (callbacks.length > 0) {
 *       callbacks.shift()(Module)
 *     }};
 *
 * which is a check followed by an act. A second initialisation can empty the array between
 * the two, and the first then calls `undefined(Module)` — surfacing as "callbacks.shift(...)
 * is not a function", intermittently, depending on nothing but timing. Which is how it was
 * reported: "sometime works sometime fails".
 *
 * Two at once is less likely now that a processor is handed from the pre-join screen to the
 * room rather than rebuilt, and is still reachable: a camera switched off and on in the
 * pre-join closes one track's engine while the next track's is starting.
 *
 * A queue rather than a mutex, so no caller has to handle being refused — everyone waits and
 * everyone proceeds. A rejection does not wedge the chain: `turn` is what the caller sees and
 * keeps the error, while the swallowed copy is what the next caller waits on.
 */
let mediapipeTurn: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  // Both arms are `work`: a previous turn that failed must not stop this one from running.
  const turn = mediapipeTurn.then(work, work);
  mediapipeTurn = turn.catch(() => undefined);
  return turn;
}

/* What the graphics context being gone means, as an error.
 *
 * Worded for a presenter rather than for a graphics programmer: browsers cap how many pages
 * may use the GPU at once, and a machine with a dozen tabs open is over that cap. "WebGL
 * context lost" would be accurate and useless. backgrounds.ts recognises this message and
 * words the sentence the presenter actually sees.
 */
const CONTEXT_LOST =
  "your browser ran out of graphics capacity — too many open tabs are using it. " +
  "Close a few and try again.";

// --------------------------------------------------------------------- helpers

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("could not create a shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader failed to compile: ${log}`);
  }
  return shader;
}

function program(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error("could not create a program");
  const vs = compile(gl, gl.VERTEX_SHADER, vertex);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`program failed to link: ${log}`);
  }
  return p;
}

/** A program with its uniform locations looked up once, rather than on every frame. */
type Pass = { program: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

/** Builds a pass. `samplers` are bound to texture units in order, once: MediaPipe never
 *  touches our programs, so what is set here stays set. */
function pass(
  gl: WebGL2RenderingContext,
  vertex: string,
  fragment: string,
  samplers: string[],
  uniforms: string[],
): Pass {
  const p = program(gl, vertex, fragment);
  gl.useProgram(p);
  samplers.forEach((name, unit) => gl.uniform1i(gl.getUniformLocation(p, name), unit));
  const u: Pass["u"] = {};
  for (const name of uniforms) u[name] = gl.getUniformLocation(p, name);
  return { program: p, u };
}

/** A colour texture plus the framebuffer that renders into it. */
type Target = { texture: WebGLTexture; framebuffer: WebGLFramebuffer; w: number; h: number };

function target(gl: WebGL2RenderingContext, w: number, h: number): Target {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) throw new Error("could not allocate a render target");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  // LINEAR and CLAMP_TO_EDGE: the matte and the blur are both sampled at a different
  // resolution from the one they were rendered at, and NEAREST here is the difference
  // between a feathered edge and a staircase.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { texture, framebuffer, w, h };
}

/** A texture with a full mip chain, for the frame and the stills. Immutable storage, so it
 *  is always complete whatever state the levels above zero are in.
 *
 * CLAMP_TO_EDGE is required for stills: cover UVs can sit near 0/1 after overscale, and any
 * wrap mode that repeats or mirrors would show a seam if a future pan walked into the
 * margin. MediaPipe shares this context and may leave wrap state dirty on a bound unit, so
 * wrap is set here at allocation and again when a still is uploaded. */
function mipmapped(gl: WebGL2RenderingContext, w: number, h: number): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("could not allocate a texture");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(w, h))) + 1, gl.RGBA8, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/* An upload from an image or a frame, with the pixel-store state it assumes.
 *
 * The context is shared with MediaPipe, which sets unpack state for its own uploads. A
 * buffer left bound to PIXEL_UNPACK_BUFFER makes an upload from a frame an error, and the
 * SKIP parameters select a sub-rectangle of it, so both are cleared for our upload and put
 * back for theirs. UNPACK_ALIGNMENT is deliberately not touched: it does not apply to images,
 * and Emscripten caches its value, so changing it behind the WASM's back would break
 * MediaPipe's own uploads. */
function upload(gl: WebGL2RenderingContext, source: TexImageSource): void {
  const buffer = gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING) as WebGLBuffer | null;
  const skipPixels = gl.getParameter(gl.UNPACK_SKIP_PIXELS) as number;
  const skipRows = gl.getParameter(gl.UNPACK_SKIP_ROWS) as number;
  if (buffer) gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
  if (skipPixels) gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  if (skipRows) gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  try {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
  } finally {
    if (skipRows) gl.pixelStorei(gl.UNPACK_SKIP_ROWS, skipRows);
    if (skipPixels) gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, skipPixels);
    if (buffer) gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, buffer);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`background image failed to load: ${src}`));
    img.src = src;
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/* Calls a listener, and keeps whatever it throws out of the frame path.
 *
 * Both listeners are the UI's code — they write preferences, raise toasts, notify React —
 * and both are called from inside transform(). An exception there errors the stream, and
 * ProcessorWrapper answers any stream error but an abort by destroying itself: the
 * audience's picture of the presenter would stop because a toast could not be shown. Said
 * once, for the same reason reportedFrameFailure is. */
let listenerThrew = false;

function safely(listener: () => void): void {
  try {
    listener();
  } catch (err) {
    if (listenerThrew) return;
    listenerThrew = true;
    console.error("[background] a status or frame listener threw", err);
  }
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type Canvas2D = { canvas: AnyCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D };

function newCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function canvas2d(w: number, h: number): Canvas2D {
  const canvas = newCanvas(w, h);
  const ctx = canvas.getContext("2d", { alpha: false }) as Canvas2D["ctx"] | null;
  if (!ctx) throw new Error("2D canvas is not available");
  return { canvas, ctx };
}

// ------------------------------------------------------------------- the engine

/* Minimal shapes for the two MediaPipe types used here.
 *
 * Declared rather than imported so the module graph does not pull tasks-vision into
 * the main bundle: it is 9MB of WASM glue and it is only needed once somebody turns a
 * background on. The dynamic import in createSegmenter is what keeps it out.
 */
type MPMask = {
  getAsWebGLTexture: () => WebGLTexture;
  width: number;
  height: number;
  close: () => void;
};
type SegmentResult = { confidenceMasks?: MPMask[]; close: () => void };
type Segmenter = {
  segmentForVideo: (
    frame: VideoFrame,
    timestampMs: number,
    callback: (result: SegmentResult) => void,
  ) => void;
  close: () => void;
};

/** 0 = low light only, 1 = blur, 2 = image. The composite's `mode`. */
type Mode = 0 | 1 | 2;

/* Everything that lives in one WebGL context: the canvas, the programs, the render targets,
 * the still, and the MediaPipe instance built on top of it.
 *
 * One object because they live and die together. A lost context takes every one of them
 * with it, MediaPipe included, so recovering is building a new Engine rather than repairing
 * pieces of an old one. It is also the unit that is handed on when a processor ends — see
 * park — because the expensive parts, the model above all, are in here.
 */
class Engine {
  readonly canvas: AnyCanvas;
  readonly gl: WebGL2RenderingContext;
  segmenter: Segmenter | null = null;
  /** The model load in flight, so nothing starts a second one. */
  loading: Promise<void> | null = null;
  /** The still currently uploaded, if any. */
  imageSrc: string | null = null;
  /** Whether the matte holds a mask of the current picture, rather than of nothing or of
   *  a stream that has since changed. */
  hasHistory = false;
  /** Whether the edge pass has a previous full-res alpha worth blending. Reset with the
   *  matte history: a new camera must not EMA against the last person's outline. */
  private alphaHistory = false;
  disposed = false;

  private lastTimestamp = 0;
  private describedMask = false;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quad: WebGLBuffer;
  private readonly nearest: WebGLSampler;
  private readonly ingest: Pass;
  private readonly temporal: Pass;
  private readonly prep: Pass;
  private readonly blur: Pass;
  private readonly track: Pass;
  private readonly edge: Pass;
  private readonly composite: Pass;

  private frame: WebGLTexture | null = null;
  private w = 0;
  private h = 0;
  private matteLod = 0;
  private roomLod = 0;
  private current: Target | null = null;
  /** The latest smoothed matte, and the one the next frame writes into. */
  private matte: Target | null = null;
  private spare: Target | null = null;
  /** Full-res coverage ping-pong. After renderEdge, alphaB is the latest smoothed alpha. */
  private alphaA: Target | null = null;
  private alphaB: Target | null = null;
  /** The room blur's two halves. The result always ends in roomA. */
  private roomA: Target | null = null;
  private roomB: Target | null = null;
  /** Tiny matte downsample + CPU buffer for the person-centre pan. */
  private trackTarget: Target | null = null;
  private trackPixels: Uint8Array | null = null;
  private image: WebGLTexture | null = null;
  private imageW = 1;
  private imageH = 1;
  /** Smoothed still pan in UV units (applied as coverUv − bgPan). */
  private panX = 0;
  private panY = 0;
  private panAt = 0;

  constructor() {
    const canvas = newCanvas(1, 1);
    /* No alpha, because we composite to full opacity ourselves. No depth, stencil or
     * antialiasing, because nothing here needs them and each is memory. And no drawing
     * buffer preserved: each frame is read out once, straight after it is drawn. */
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      antialias: false,
      depth: false,
      stencil: false,
      /* desynchronized:false — MediaPipe shares this context. A desynchronized hint on
       * Chrome/Mac (ANGLE Metal) has been seen to race createFromOptions and surface as
       * callbacks.shift / "effect engine was interrupted". Latency here is one composite
       * frame, not input lag that needs the hint. */
      desynchronized: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 is not available");
    this.canvas = canvas;
    this.gl = gl;

    try {
      /* A context can arrive already lost, and asking is the only way to know. Past the
       * browser's limit getContext still returns an object — a dead one — and everything
       * downstream then fails somewhere less obvious than here. */
      if (gl.isContextLost()) throw new Error(CONTEXT_LOST);

      this.ingest = pass(gl, VERTEX_PASS, INGEST, ["frame", "confidence"], ["lod"]);
      this.temporal = pass(gl, VERTEX_PASS, TEMPORAL, ["current", "previous"], ["restart"]);
      this.prep = pass(gl, VERTEX_PASS, PREP, ["frame", "matte"], ["lod", "veil"]);
      this.blur = pass(gl, VERTEX_PASS, BLUR, ["source"], ["texel", "sigma"]);
      this.track = pass(gl, VERTEX_PASS, TRACK, ["matte"], []);
      // Bilateral + temporal coverage. Offscreen, so it does not flip.
      this.edge = pass(
        gl,
        VERTEX_PASS,
        EDGE,
        ["frame", "matte", "prevAlpha"],
        ["hasHistory"],
      );
      // The only pass that reaches the canvas, so the only one that flips.
      this.composite = pass(
        gl,
        VERTEX_PRESENT,
        COMPOSITE,
        ["frame", "room", "image", "alphaMap"],
        ["mode", "veil", "frameSize", "imageSize", "bgPan", "lowLight"],
      );
      gl.useProgram(null);

      /* The quad, in a vertex array of its own. MediaPipe draws with whatever vertex state
       * it set up, and a shared context shares that state: pointing attribute 0 at our
       * buffer outside a VAO would be pointing theirs at it too. */
      const vao = gl.createVertexArray();
      const quad = gl.createBuffer();
      const nearest = gl.createSampler();
      if (!vao || !quad || !nearest) throw new Error("could not allocate the quad");
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.samplerParameteri(nearest, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.samplerParameteri(nearest, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.samplerParameteri(nearest, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.samplerParameteri(nearest, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.vao = vao;
      this.quad = quad;
      this.nearest = nearest;
    } catch (err) {
      // Handed back rather than left for the garbage collector. See release.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      throw err;
    }
  }

  get alive(): boolean {
    return !this.disposed && !this.gl.isContextLost();
  }

  /* Touches the context so the browser does not pick it to evict.
   *
   * Chrome keeps about sixteen WebGL contexts per renderer and, asked for a seventeenth,
   * drops the one that has gone longest without a flush. A context waiting seconds for a
   * model download has done nothing at all, so it is the obvious choice — and losing it
   * mid-load is the "kGpuService" failure presenters were shown. */
  keepWarm(): void {
    if (this.alive) this.gl.flush();
  }

  forgetHistory(): void {
    this.hasHistory = false;
    this.alphaHistory = false;
    this.panX = 0;
    this.panY = 0;
    this.panAt = 0;
  }

  /** The frame, uploaded once and sampled by every pass. Mips only when a pass reads them. */
  upload(frame: VideoFrame, mips: boolean): void {
    const gl = this.gl;
    this.fit(frame.displayWidth, frame.displayHeight);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frame);
    upload(gl, frame);
    if (mips) gl.generateMipmap(gl.TEXTURE_2D);
  }

  /* Segmentation, straight into the matte.
   *
   * `segmentForVideo` with a callback is synchronous — the callback runs before it returns —
   * so there is no stale-mask window. The mask must be consumed inside the callback:
   * MediaPipe frees it on `result.close()`, and holding the texture past that point renders
   * garbage. So the ingest pass runs in there, and the temporal pass straight after.
   *
   * Timestamps must strictly increase for as long as the MediaPipe instance lives, which is
   * longer than any one track — hence the engine keeps the counter, not the processor. */
  segment(segmenter: Segmenter, frame: VideoFrame): boolean {
    const timestamp = Math.max(performance.now(), this.lastTimestamp + 1);
    this.lastTimestamp = timestamp;
    let got = false;
    segmenter.segmentForVideo(frame, timestamp, (result) => {
      try {
        const mask = result.confidenceMasks?.[0];
        if (!mask) return;
        this.ingestMask(mask.getAsWebGLTexture());
        got = true;
        if (!this.describedMask) {
          this.describedMask = true;
          console.info("[background] first mask", { width: mask.width, height: mask.height });
        }
      } finally {
        result.close();
      }
    });
    if (got) this.smooth();
    return got;
  }

  /** Uploads a still. Same src is a no-op, so switching away and back does not re-upload. */
  setImage(src: string, img: HTMLImageElement): void {
    if (this.imageSrc === src) return;
    const gl = this.gl;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error(`background image failed to load: ${src}`);
    gl.activeTexture(gl.TEXTURE0);
    const texture = mipmapped(gl, w, h);
    upload(gl, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    // Re-assert wrap after upload: the still is sampled with cover UVs that sit near the
    // edges once overscaled, and a shared-context neighbour leaving REPEAT on this unit
    // would tile the photo into the margin instead of holding the border texel.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.image) gl.deleteTexture(this.image);
    this.image = texture;
    this.imageSrc = src;
    this.imageW = w;
    this.imageH = h;
  }

  /** Draws the frame to the canvas: the room blur if anything shows it, then the composite. */
  render(mode: Mode, veil: number, lowLight: number, blurRadius: number): void {
    this.resetState();
    try {
      this.renderPasses(mode, veil, lowLight, blurRadius);
    } finally {
      this.endState();
    }
  }

  private renderPasses(mode: Mode, veil: number, lowLight: number, blurRadius: number): void {
    const gl = this.gl;
    const matte = this.matte!;
    if (mode === 1 || (mode === 2 && veil > 0)) {
      const a = this.roomA!;
      const b = this.roomB!;
      this.bindTarget(a);
      gl.useProgram(this.prep.program);
      gl.uniform1f(this.prep.u.lod, this.roomLod);
      gl.uniform1f(this.prep.u.veil, veil);
      this.bindTextures(this.frame, matte.texture);
      this.draw();

      /* Sigma is given at 720p and scaled to the frame, so a blur looks the same strength
       * whatever the camera delivers, then into quarter-resolution texels. Capped where the
       * shader's loop runs out, which is past 4K. */
      const radius = mode === 1 ? blurRadius : VEIL_RADIUS;
      const sigma = Math.min(16, ((radius * Math.min(this.w, this.h)) / 720) * (a.w / this.w));
      gl.useProgram(this.blur.program);
      gl.uniform1f(this.blur.u.sigma, sigma);
      this.bindTarget(b);
      gl.uniform2f(this.blur.u.texel, 1 / a.w, 0);
      this.bindTextures(a.texture);
      this.draw();
      this.bindTarget(a);
      gl.uniform2f(this.blur.u.texel, 0, 1 / b.h);
      this.bindTextures(b.texture);
      this.draw();
    }

    // Coverage for blur/image. Low-light-only skips the bilateral: nothing on screen uses
    // it. Drop the history too, so coming back to a background does not feather against
    // an outline from before the person moved.
    let coverage: WebGLTexture | null;
    if (mode === 0) {
      this.alphaHistory = false;
      coverage = this.alphaB?.texture ?? this.frame;
    } else {
      coverage = this.renderEdge();
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    const c = this.composite;
    gl.useProgram(c.program);
    gl.uniform1i(c.u.mode, mode);
    gl.uniform1f(c.u.veil, veil);
    gl.uniform2f(c.u.frameSize, this.w, this.h);
    gl.uniform2f(c.u.imageSize, this.imageW, this.imageH);
    gl.uniform2f(c.u.bgPan, this.panX, this.panY);
    // Read fresh every frame, which is what makes setLowLight free.
    gl.uniform1f(c.u.lowLight, lowLight);
    // Every unit the program samples gets a real texture, even ones this mode ignores:
    // an empty unit is a console warning per frame.
    this.bindTextures(this.frame, this.roomA!.texture, this.image ?? this.frame, coverage);
    this.draw();
  }

  /** Bilateral upsample + temporal deadzone into the alpha ping-pong. Returns the texture
   *  the composite should sample (the one just written). */
  private renderEdge(): WebGLTexture {
    const gl = this.gl;
    const next = this.alphaA!;
    const prev = this.alphaB!;
    this.bindTarget(next);
    gl.useProgram(this.edge.program);
    gl.uniform1f(this.edge.u.hasHistory, this.alphaHistory ? 1 : 0);
    this.bindTextures(this.frame, this.matte!.texture, prev.texture);
    this.draw();
    this.alphaA = prev;
    this.alphaB = next;
    this.alphaHistory = true;
    return next.texture;
  }

  /* Gone, and everything in it.
   *
   * MediaPipe's turn first — see oneAtATime — including when there is not yet a segmenter,
   * so an in-flight createSegmenter finishes against a live context. The context only goes
   * after that turn.
   */
  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    const segmenter = this.segmenter;
    this.segmenter = null;
    /* close AND loseContext must be the same oneAtATime turn.
     *
     * #175 queued only the close, then called release() from `.finally()` on the
     * returned promise. That finally runs as a sibling microtask of the *next*
     * queued createSegmenter — so loseContext could interleave with Module
     * start-up and leave Emscripten's shared callback arrays half-drained
     * ("callbacks.shift(...) is not a function"). Putting release inside the
     * turn means the next create cannot start until this context is gone.
     *
     * Returned so SoftSegmenter.destroy can await teardown before openCamera
     * builds a replacement processor. */
    return oneAtATime(async () => {
      try {
        if (segmenter) await segmenter.close();
      } finally {
        this.release();
      }
    }).catch(() => {});
  }

  /* And then the context itself, explicitly. Deleting every resource in it is not the same
   * thing and this omission was a real bug.
   *
   * A WebGL context is not freed when the last reference to it goes; it is freed when the
   * canvas is collected, which is whenever the garbage collector gets round to it. Chrome
   * allows about sixteen live contexts per process and silently drops the OLDEST when a
   * seventeenth is asked for — and a context that is merely waiting to be collected counts.
   *
   * loseContext() is the only way to hand one back deliberately. It is an extension and may
   * be absent, which is survivable: without it this leaks as it always did.
   */
  private release(): void {
    const gl = this.gl;
    try {
      if (!gl.isContextLost()) {
        this.releaseTargets();
        for (const p of [this.ingest, this.temporal, this.prep, this.blur, this.track, this.edge, this.composite]) {
          gl.deleteProgram(p.program);
        }
        gl.deleteVertexArray(this.vao);
        gl.deleteBuffer(this.quad);
        gl.deleteSampler(this.nearest);
        if (this.image) gl.deleteTexture(this.image);
      }
    } finally {
      this.image = null;
      this.imageSrc = null;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }

  /* Render targets sized for the frame. Rebuilt when the frame size changes — a different
   * camera, or the browser renegotiating resolution — and not otherwise. */
  private fit(w: number, h: number): void {
    if (this.frame && this.w === w && this.h === h) return;
    const gl = this.gl;
    this.releaseTargets();
    this.canvas.width = w;
    this.canvas.height = h;
    this.w = w;
    this.h = h;
    gl.activeTexture(gl.TEXTURE0);
    this.frame = mipmapped(gl, w, h);

    /* The matte at the model's resolution, not the frame's. It carries 256×144 of
     * information however large the frame is; the joint upsample is what brings it to the
     * frame, and filtering four times as many pixels first would add nothing. */
    const long = Math.min(MATTE_LONG_SIDE, Math.max(w, h));
    const mw = w >= h ? long : Math.max(1, Math.round((long * w) / h));
    const mh = w >= h ? Math.max(1, Math.round((long * h) / w)) : long;
    this.current = target(gl, mw, mh);
    this.matte = target(gl, mw, mh);
    this.spare = target(gl, mw, mh);
    this.matteLod = Math.max(0, Math.log2(w / mw));

    const rw = Math.max(1, Math.round(w / 4));
    const rh = Math.max(1, Math.round(h / 4));
    this.roomA = target(gl, rw, rh);
    this.roomB = target(gl, rw, rh);
    this.roomLod = Math.max(0, Math.log2(w / rw));

    const trackLong = Math.min(TRACK_LONG_SIDE, Math.max(mw, mh));
    const tw = mw >= mh ? trackLong : Math.max(1, Math.round((trackLong * mw) / mh));
    const th = mw >= mh ? Math.max(1, Math.round((trackLong * mh) / mw)) : trackLong;
    this.trackTarget = target(gl, tw, th);
    this.trackPixels = new Uint8Array(tw * th * 4);

    // Full-res coverage history. Two buffers: the edge pass cannot sample the texture
    // it is writing. RGBA8 is enough — sub-1/255 alpha steps are the chatter we want to drop.
    this.alphaA = target(gl, w, h);
    this.alphaB = target(gl, w, h);

    this.hasHistory = false;
    this.alphaHistory = false;
    this.panX = 0;
    this.panY = 0;
    this.panAt = 0;
  }

  private releaseTargets(): void {
    const gl = this.gl;
    if (this.frame) gl.deleteTexture(this.frame);
    for (const t of [
      this.current,
      this.matte,
      this.spare,
      this.alphaA,
      this.alphaB,
      this.roomA,
      this.roomB,
      this.trackTarget,
    ]) {
      if (!t) continue;
      gl.deleteTexture(t.texture);
      gl.deleteFramebuffer(t.framebuffer);
    }
    this.frame = null;
    this.current = this.matte = this.spare = this.alphaA = this.alphaB = this.roomA = this.roomB = this.trackTarget = null;
    this.trackPixels = null;
    this.w = 0;
    this.h = 0;
  }

  /** The mask, and the frame's colour under it, into `current`. Runs inside MediaPipe's
   *  callback, so it leaves the context the way MediaPipe would expect to find it. */
  private ingestMask(mask: WebGLTexture): void {
    const gl = this.gl;
    this.resetState();
    try {
      this.bindTarget(this.current!);
      gl.useProgram(this.ingest.program);
      gl.uniform1f(this.ingest.u.lod, this.matteLod);
      this.bindTextures(this.frame, mask);
      // Unit 1 is MediaPipe's texture. The sampler overrides its filtering for this one draw
      // and comes straight off again — left bound, it would override MediaPipe's own
      // sampling on that unit too.
      gl.bindSampler(1, this.nearest);
      this.draw();
    } finally {
      gl.bindSampler(1, null);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.endState();
    }
  }

  /** The temporal blend, from `current` and the last matte into the next one. */
  private smooth(): void {
    const gl = this.gl;
    const previous = this.matte!;
    const next = this.spare!;
    this.resetState();
    try {
      this.bindTarget(next);
      gl.useProgram(this.temporal.program);
      gl.uniform1f(this.temporal.u.restart, this.hasHistory ? 0 : 1);
      this.bindTextures(this.current!.texture, previous.texture);
      this.draw();
    } finally {
      this.endState();
    }
    this.matte = next;
    this.spare = previous;
    this.hasHistory = true;
    this.updatePan();
  }

  /* Person centre → smoothed still pan.
   *
   * Downsamples the matte, reads a few hundred alphas, and takes their weighted centroid.
   * Applied only to image backgrounds (the uniform is ignored in blur/low-light modes). The
   * raw (cx − 0.5) jumps every frame from mask noise; deadzone + exp smooth + speed cap is
   * what keeps left/right travel from stuttering while still following a real lean. */
  private updatePan(): void {
    const gl = this.gl;
    const track = this.trackTarget;
    const pixels = this.trackPixels;
    const matte = this.matte;
    if (!track || !pixels || !matte) return;

    this.resetState();
    try {
      this.bindTarget(track);
      gl.useProgram(this.track.program);
      this.bindTextures(matte.texture);
      this.draw();
      gl.readPixels(0, 0, track.w, track.h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    } finally {
      this.endState();
    }

    let mass = 0;
    let sx = 0;
    let sy = 0;
    const tw = track.w;
    const th = track.h;
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const a = pixels[(y * tw + x) * 4]! / 255;
        if (a < TRACK_ALPHA_LO) continue;
        // Square the confidence so a solid torso/face outvotes a soft fringe.
        const w = a * a;
        sx += (x + 0.5) * w;
        sy += (y + 0.5) * w;
        mass += w;
      }
    }
    if (mass < 1e-3) return;

    const limit = panLimit();
    const rawX = Math.max(-limit, Math.min(limit, (sx / mass / tw - 0.5) * PAN_GAIN_X));
    const rawY = Math.max(-limit, Math.min(limit, (sy / mass / th - 0.5) * PAN_GAIN_Y));

    const now = performance.now();
    const dt = this.panAt > 0 ? Math.min(100, Math.max(0, now - this.panAt)) : 1000 / 30;
    this.panAt = now;

    this.panX = this.smoothAxis(this.panX, rawX, dt);
    this.panY = this.smoothAxis(this.panY, rawY, dt);
  }

  private smoothAxis(current: number, raw: number, dtMs: number): number {
    const target = Math.abs(raw - current) < PAN_DEADZONE ? current : raw;
    const alpha = 1 - Math.exp(-dtMs / PAN_SMOOTH_MS);
    let next = current + (target - current) * alpha;
    const maxStep = PAN_MAX_SPEED * (dtMs / 1000);
    const delta = next - current;
    if (delta > maxStep) next = current + maxStep;
    else if (delta < -maxStep) next = current - maxStep;
    return next;
  }

  /* The state our passes assume, set rather than hoped for.
   *
   * MediaPipe runs in this context between our passes and sets whatever it needs; nothing
   * says it puts anything back. Each of these, left on, would silently change what a pass
   * draws — a scissor clips it, blending mixes it with the last frame. */
  private resetState(): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    gl.bindVertexArray(this.vao);
  }

  /** And ours off again, so MediaPipe's default vertex array is its own. */
  private endState(): void {
    const gl = this.gl;
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  private bindTarget(t: Target): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, t.framebuffer);
    this.gl.viewport(0, 0, t.w, t.h);
  }

  private bindTextures(...textures: (WebGLTexture | null)[]): void {
    const gl = this.gl;
    textures.forEach((t, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
    });
  }

  private draw(): void {
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }
}

/* The last engine to be let go, held for a while in case another processor wants it.
 *
 * Switching the camera off and on in the pre-join, or picking another camera there, stops
 * one track and opens another, and each track gets its own processor. Without this the new
 * one would build a context and bring MediaPipe up from cold — a second of veiled preview —
 * to replace the one that was closed a moment earlier. With it, the model is still warm.
 *
 * One at most, and never one with a model load still in flight: a load reports to the
 * processor that started it, and that processor is gone.
 */
let parked: { engine: Engine; timer: ReturnType<typeof setTimeout> } | null = null;

function park(engine: Engine): void {
  if (parked) {
    clearTimeout(parked.timer);
    parked.engine.dispose();
  }
  const timer = setTimeout(() => {
    if (parked?.engine !== engine) return;
    parked = null;
    engine.dispose();
  }, PARK_MS);
  parked = { engine, timer };
}

function unpark(): Engine | null {
  const held = parked;
  parked = null;
  if (!held) return null;
  clearTimeout(held.timer);
  if (held.engine.alive) return held.engine;
  held.engine.dispose();
  return null;
}

/** True when MediaPipe/Emscripten start-up was corrupted mid-create (Chrome Mac often). */
export function isMediaPipeInterrupted(err: unknown): boolean {
  const text = (err instanceof Error ? `${err.name} ${err.message}` : String(err ?? "")).toLowerCase();
  /* Narrow on purpose: a bare "is not a function" is too common in unrelated JS errors.
   * callbacks.shift is the stable Emscripten signature we map to the presenter copy in
   * describeBackgroundError. */
  return /callbacks\.shift/.test(text) || /runtime.?callback/.test(text);
}

/* One shared module evaluation. Parallel `import("@mediapipe/tasks-vision")` from two
 * SoftSegmenters (or SoftSegmenter + LiveKit BackgroundProcessor) can race Emscripten
 * glue before oneAtATime even runs createFromOptions. */
let visionModule: Promise<typeof import("@mediapipe/tasks-vision")> | null = null;
function loadVision() {
  visionModule ??= import("@mediapipe/tasks-vision");
  return visionModule;
}

async function createSegmenter(engine: Engine): Promise<Segmenter> {
  /* Checked before and after the download, because a download is seconds and the context
   * can be taken in between. MediaPipe is handed our context below; if it is dead, the
   * failure surfaces from inside the WASM as "Error querying for GL extensions" or a null
   * property read, which is unreadable and unactionable. */
  if (!engine.alive) throw new Error(CONTEXT_LOST);
  // Loaded here rather than at module scope: 9MB of WASM that nobody who never
  // turns a background on should download.
  const vision = await loadVision();
  const fileset = await vision.FilesetResolver.forVisionTasks(WASM_PATH);
  if (!engine.alive) throw new Error(CONTEXT_LOST);

  const options = {
    runningMode: "VIDEO" as const,
    outputConfidenceMasks: true,
    outputCategoryMask: false,
    /* Our canvas — the reason the mask never leaves the GPU.
     *
     * A second getContext("webgl2") on a canvas returns the context it already has, so
     * MediaPipe renders into OUR context and `getAsWebGLTexture()` hands back a texture we
     * can sample. The alternative is `getAsFloat32Array()`, which is a readPixels — a full
     * GPU pipeline stall, every frame. */
    canvas: engine.canvas,
  };

  try {
    return (await vision.ImageSegmenter.createFromOptions(fileset, {
      ...options,
      baseOptions: { modelAssetPath: MODEL_PATH, delegate: "GPU" },
    })) as unknown as Segmenter;
  } catch (gpuErr) {
    if (engine.gl.isContextLost()) throw new Error(CONTEXT_LOST, { cause: gpuErr });
    /* A half-drained Emscripten Module will fail CPU the same way — skip the second
     * createFromOptions so we do not dig the hole deeper. Reload / Beta is the recovery. */
    if (isMediaPipeInterrupted(gpuErr)) throw gpuErr;
    /* GPU create fails on some Chrome/Mac Metal setups with a quieter GL init error.
     * CPU on the same canvas still feeds getAsWebGLTexture. */
    console.warn("[background] GPU segmenter failed; trying CPU delegate", gpuErr);
    if (!engine.alive) throw new Error(CONTEXT_LOST, { cause: gpuErr });
    try {
      return (await vision.ImageSegmenter.createFromOptions(fileset, {
        ...options,
        baseOptions: { modelAssetPath: MODEL_PATH, delegate: "CPU" },
      })) as unknown as Segmenter;
    } catch (cpuErr) {
      if (engine.gl.isContextLost()) throw new Error(CONTEXT_LOST, { cause: cpuErr });
      throw cpuErr;
    }
  }
}

// ---------------------------------------------------------------- the transformer

export class SoftSegmenter extends VideoTransformer<Record<string, never>> {
  private options: { background: Background; lowLight: number };
  private onFrame?: SegmenterOptions["onFrame"];
  private onStatus?: SegmenterOptions["onStatus"];
  private status: SegmenterStatus = { phase: "idle" };
  private disposed = false;

  private engine: Engine | null = null;
  private engineBorn = 0;
  private rebuilds = 0;
  private rebuildAt = 0;
  /** Given up on, until retry(). null is "not failed". */
  private engineFailure: unknown = null;
  private modelFailure: unknown = null;
  private segmentErrors = 0;
  private segmenterRestarts = 0;

  /** The still asked for, once decoded — kept so a rebuilt engine can upload it again. */
  private image: { src: string; img: HTMLImageElement } | null = null;
  private imageLoading: string | null = null;
  private imageFailure: { src: string; error: unknown } | null = null;
  /** Whether the last frame showed a still, so the next still can wait behind it. */
  private showingImage = false;

  /** 1 while there is no matte to composite with, easing to 0 once there is. */
  private veil = 1;
  private lastFrameAt = 0;
  /** The 2D veil's canvases, made only if it is ever needed. */
  private flat: { small: Canvas2D; big: Canvas2D } | null = null;
  /** So a persistent per-frame fault is reported once rather than 30 times a second. */
  private reportedFrameFailure = false;

  constructor(options: SegmenterOptions) {
    super();
    this.options = { background: options.background, lowLight: options.lowLight };
    this.onFrame = options.onFrame;
    this.onStatus = options.onStatus;
  }

  update(): void {
    // The base class requires the method. Changes go through setBackground and
    // setLowLight, which are typed; a bag of unknown keys is not something to accept
    // here, so this takes no arguments and does nothing.
  }

  /* Changes the background without rebuilding anything, and without awaiting anything.
   *
   * The next frame shows it if it can. If it cannot yet — the model is still loading, or the
   * still is — the frame is veiled or keeps the previous background, so the switch is never
   * a flash of the raw room or a black frame. The status says what is still on its way.
   */
  setBackground(background: Background): void {
    this.options = { ...this.options, background };
    if (background.kind === "image") this.requestImage(background.src);
    if (background.kind !== "none") {
      const engine = this.liveEngine();
      if (engine) this.ensureModel(engine);
    }
    this.refreshStatus();
  }

  /* Changes the lift, and does not await anything.
   *
   * A slider fires on every pixel of the drag. Anything that rebuilt the pipeline — or
   * even re-entered the attach path — thirty times between 0 and 60 would drop frames
   * the audience can see and the person dragging cannot. This writes a number that the
   * next frame's uniform read picks up, so a drag costs nothing at all.
   */
  setLowLight(lowLight: number): void {
    this.options = { ...this.options, lowLight };
    this.refreshStatus();
  }

  /** Whoever is showing this processor's cost now. The processor outlives the screen that
   *  attached it — it goes from the pre-join into the room — so the listener is replaceable. */
  setOnFrame(onFrame: SegmenterOptions["onFrame"]): void {
    this.onFrame = onFrame;
  }

  /** Likewise for the status, which is reported to the new listener straight away. */
  setOnStatus(onStatus: SegmenterOptions["onStatus"]): void {
    this.onStatus = onStatus;
    onStatus?.(this.status);
  }

  /** Forgets every failure and tries again: the presenter's "Retry". */
  retry(): void {
    /* An interrupted MediaPipe Module may have half-initialized into this engine's
     * context. createFromOptions on the same canvas fails forever — drop the engine
     * (do not park it) so the next liveEngine builds a clean WebGL2 context. */
    const hardReset =
      isMediaPipeInterrupted(this.modelFailure) || isMediaPipeInterrupted(this.engineFailure);
    const stale = hardReset ? this.engine : null;
    if (hardReset) this.engine = null;

    this.engineFailure = null;
    this.modelFailure = null;
    this.imageFailure = null;
    this.rebuilds = 0;
    this.rebuildAt = 0;
    this.segmentErrors = 0;
    this.segmenterRestarts = 0;
    this.reportedFrameFailure = false;
    if (stale) void stale.dispose();
    const { background } = this.options;
    if (background.kind === "image") this.requestImage(background.src);
    if (this.needsEngine()) {
      const engine = this.liveEngine();
      if (engine && background.kind !== "none") this.ensureModel(engine);
    }
    this.refreshStatus();
  }

  /* Called by ProcessorWrapper on setProcessor, and again on every restart — the camera
   * unmuted, or a different device chosen, in the room.
   *
   * Deliberately WITHOUT the output canvas the wrapper offers. Given one, the base class
   * builds its own WebGL pipeline on it — a second context's worth of programs we never
   * use — and it rebuilds that on every restart. The engine brings its own canvas, and keeps
   * it across restarts, so an unmute is the next frame rather than a model load.
   */
  async init({ inputElement }: VideoTransformerInitOptions): Promise<void> {
    await super.init({ inputElement } as VideoTransformerInitOptions);
    this.disposed = false;
    // A restart can be a different camera, whose picture the old matte is not of.
    this.engine?.forgetHistory();
    if (this.needsEngine()) this.liveEngine();
    this.refreshStatus();

    // One line, at info level. Whether the processor attached at all is the first
    // question anybody asks when a background looks wrong, and it was previously
    // unanswerable from outside the tab.
    console.info("[background] processor ready", {
      model: this.engine?.segmenter
        ? MODEL_PATH
        : this.options.background.kind === "none"
          ? "none (low light only)"
          : "loading",
      background: this.options.background.kind,
      lowLight: this.options.lowLight,
    });
  }

  async restart(options: VideoTransformerInitOptions): Promise<void> {
    await this.init(options);
  }

  /* The end of this processor, or only of its current stream.
   *
   * `willProcessorRestart` is the wrapper saying the same processor comes straight back with
   * a new track — mute and unmute, a device change. Everything is kept for that: the engine,
   * the model, the still. Otherwise it is the end, and the engine goes to park rather than
   * being torn down, in case the next processor can use it.
   */
  async destroy(options?: TrackTransformerDestroyOptions): Promise<void> {
    await super.destroy();
    if (options?.willProcessorRestart) return;
    await this.dispose();
  }

  transform(frame: VideoFrame, controller: TransformStreamDefaultController<VideoFrame>): void {
    if (this.disposed) {
      frame.close();
      return;
    }
    const { background, lowLight } = this.options;
    const wantsBackground = background.kind !== "none";

    /* Nothing asked for, so the frame goes straight through without touching the GPU. The
     * processor stays attached for this — taking it off and putting it back is a flash of
     * black for the audience each way — and costs nothing but a pass through a stream. */
    if (!wantsBackground && lowLight <= 0) {
      this.engine?.forgetHistory();
      controller.enqueue(frame);
      return;
    }
    if (frame.codedWidth === 0 || frame.codedHeight === 0) {
      frame.close();
      return;
    }

    const engine = this.liveEngine();
    if (!engine) {
      this.fallback(frame, controller, wantsBackground && this.canHide());
      return;
    }

    /* The model has been given up on. Say so (the status does) and send the camera — with
     * the lift if one is on, since that needs no model. A permanently blurred camera would
     * look like a broken one, and there is an error on screen explaining this. */
    const withoutModel = wantsBackground && this.modelFailure !== null;
    if (withoutModel && lowLight <= 0) {
      engine.forgetHistory();
      controller.enqueue(frame);
      return;
    }

    const started = performance.now();
    let segmentMs = 0;
    let output: VideoFrame | null = null;
    try {
      let mode: Mode = 0;
      if (wantsBackground && !withoutModel) {
        this.ensureModel(engine);
        engine.upload(frame, true);
        const segmenter = engine.segmenter;
        if (segmenter) {
          segmentMs = this.segmentWith(engine, segmenter, frame);
        } else {
          engine.forgetHistory();
        }
        mode = this.modeFor(engine, background);
        this.easeVeil(engine.hasHistory, started);
      } else {
        engine.upload(frame, false);
        engine.forgetHistory();
      }
      engine.render(
        mode,
        this.veil,
        lowLight,
        background.kind === "blur" ? background.radius : VEIL_RADIUS,
      );
      output = new VideoFrame(engine.canvas as unknown as CanvasImageSource, {
        timestamp: frame.timestamp,
        alpha: "discard",
      });
      // Lost while drawing: what was drawn went nowhere and the frame is black.
      if (engine.gl.isContextLost()) throw new Error(CONTEXT_LOST);
    } catch (err) {
      output?.close();
      output = null;
      if (engine.gl.isContextLost()) {
        this.lost(engine);
      } else if (!this.reportedFrameFailure) {
        /* Once per session, because at 30fps a persistent fault would otherwise be 1800
         * lines a minute. Reported at all, because swallowing it is what once made a broken
         * pipeline indistinguishable from a working one with nothing to do. */
        this.reportedFrameFailure = true;
        console.warn("[background] frame processing failed", err);
      }
    }

    if (!output) {
      this.fallback(frame, controller, wantsBackground && this.canHide());
      return;
    }
    frame.close();
    controller.enqueue(output);
    safely(() => this.onFrame?.({ totalMs: performance.now() - started, segmentMs }));
  }

  // ------------------------------------------------------------------ internals

  private needsEngine(): boolean {
    return this.options.background.kind !== "none" || this.options.lowLight > 0;
  }

  /** Whether a veil is still honest: something is on its way, rather than given up on. */
  private canHide(): boolean {
    return this.engineFailure === null && this.modelFailure === null;
  }

  /** The engine, if there is a live one — building one if it is time to. */
  private liveEngine(): Engine | null {
    const engine = this.engine;
    if (engine && !engine.gl.isContextLost()) return engine;
    if (engine) this.lost(engine);
    if (this.disposed || this.engineFailure !== null) return null;
    if (performance.now() < this.rebuildAt) return null;
    return this.buildEngine();
  }

  private buildEngine(): Engine | null {
    try {
      const engine = unpark() ?? new Engine();
      engine.forgetHistory();
      this.engine = engine;
      this.engineBorn = performance.now();
      this.segmentErrors = 0;
      if (this.options.background.kind !== "none") this.ensureModel(engine);
      return engine;
    } catch (err) {
      // Could not even build one. Retried on the same schedule as a loss, then given up on.
      this.scheduleRebuild(err);
      return null;
    } finally {
      this.refreshStatus();
    }
  }

  /* The context was taken away. Everything in it went too, MediaPipe included, so the whole
   * engine goes and a new one is built — straight away the first time, then more slowly.
   * Until then, frames go out under the 2D veil. */
  private lost(engine: Engine): void {
    if (this.engine !== engine) return;
    this.engine = null;
    engine.dispose();
    if (performance.now() - this.engineBorn > ENGINE_SETTLED_MS) this.rebuilds = 0;
    console.warn("[background] graphics context lost; rebuilding", { rebuilds: this.rebuilds });
    this.scheduleRebuild(new Error(CONTEXT_LOST));
    this.refreshStatus();
  }

  private scheduleRebuild(err: unknown): void {
    if (this.rebuilds >= REBUILD_RETRY_MS.length) {
      this.engineFailure = err ?? new Error(CONTEXT_LOST);
      return;
    }
    this.rebuildAt = performance.now() + REBUILD_RETRY_MS[this.rebuilds];
    this.rebuilds += 1;
  }

  /* MediaPipe, loaded at most once per engine however many callers ask. */
  private ensureModel(engine: Engine): void {
    if (engine.segmenter || engine.loading || this.modelFailure !== null || this.disposed) return;
    engine.loading = this.loadModel(engine).finally(() => {
      engine.loading = null;
      this.refreshStatus();
    });
    this.refreshStatus();
  }

  /* The model load, retried, with the context kept warm throughout.
   *
   * A failure while the context is alive is a failure of the load — the download, usually —
   * and is retried here. A failure because the context died is not this function's to retry:
   * the next frame sees the loss, builds a new engine, and that engine loads its own model.
   */
  private async loadModel(engine: Engine): Promise<void> {
    const began = performance.now();
    /* keepWarm only BETWEEN attempts — never during createFromOptions.
     *
     * The interval used to flush the shared WebGL context every 100 ms while MediaPipe was
     * still inside ImageSegmenter.createFromOptions on that same context. On Chrome/Mac
     * (ANGLE Metal) that interleave can half-drain Emscripten's start-up callbacks and
     * surface as callbacks.shift(...) / "effect engine was interrupted". Holding the
     * context with flushes between retries is enough to stop eviction during the download. */
    let failure: unknown = null;
    try {
      for (const delay of MODEL_RETRY_MS) {
        if (delay) {
          const warm = setInterval(() => engine.keepWarm(), 100);
          try {
            await sleep(delay);
          } finally {
            clearInterval(warm);
          }
        }
        if (!engine.alive || this.engine !== engine) return;
        try {
          // In MediaPipe's turn as well as behind the per-engine guard: the two answer
          // different questions, and only oneAtATime covers two engines at once.
          const segmenter = await oneAtATime(() => createSegmenter(engine));
          /* Disposed or replaced while the import was in the air. Closed here rather than
           * kept: nothing else will see this one, and it would hold its GPU memory until
           * the tab closed. Awaited so SoftSegmenter.dispose — which waits on this load —
           * does not release the context before the close has taken its turn. */
          if (!engine.alive || this.engine !== engine) {
            await oneAtATime(async () => segmenter.close()).catch(() => {});
            return;
          }
          engine.segmenter = segmenter;
          console.info("[background] segmentation ready", {
            model: MODEL_PATH,
            ms: Math.round(performance.now() - began),
          });
          return;
        } catch (err) {
          if (!engine.alive) return;
          failure = err;
          console.warn("[background] segmentation model failed to load", err);
          /* Interrupted Module: further retries on this context will not recover. Drop the
           * engine now so Retry / a later SoftSegmenter does not unpark poisoned GL state. */
          if (isMediaPipeInterrupted(err)) {
            if (this.engine === engine) this.engine = null;
            await engine.dispose().catch(() => {});
            break;
          }
        }
      }
      this.modelFailure = failure ?? new Error("the segmentation model did not load");
    } finally {
      /* no persistent warm interval */
    }
  }

  /* One frame's segmentation, surviving MediaPipe having a bad moment.
   *
   * A single error is a frame with the previous matte, which nobody can see. A run of them
   * means its graph is wedged, and the cure is a fresh instance — a couple of times, and then
   * the model is given up on like any other failure to load. Returns the time it took. */
  private segmentWith(engine: Engine, segmenter: Segmenter, frame: VideoFrame): number {
    const t0 = performance.now();
    try {
      engine.segment(segmenter, frame);
      this.segmentErrors = 0;
    } catch (err) {
      if (engine.gl.isContextLost()) throw err;
      this.segmentErrors += 1;
      if (this.segmentErrors >= SEGMENT_ERROR_LIMIT) {
        this.segmentErrors = 0;
        engine.segmenter = null;
        void oneAtATime(async () => segmenter.close()).catch(() => {});
        engine.forgetHistory();
        if (this.segmenterRestarts >= SEGMENTER_RESTART_LIMIT) {
          this.modelFailure = err ?? new Error("segmentation kept failing");
        } else {
          this.segmenterRestarts += 1;
          console.warn("[background] segmentation kept failing; restarting it", err);
          this.ensureModel(engine);
        }
        this.refreshStatus();
      }
    }
    return performance.now() - t0;
  }

  /* Which composite this frame gets.
   *
   * A still that has not arrived does not get a black frame or the raw room while it
   * loads: the previous still stays up if there was one, and the blur stands in if not. */
  private modeFor(engine: Engine, background: Background): Mode {
    if (background.kind !== "image") {
      this.showingImage = false;
      return 1;
    }
    const src = background.src;
    if (this.image?.src === src && engine.imageSrc !== src) {
      try {
        engine.setImage(src, this.image.img);
      } catch (err) {
        if (engine.gl.isContextLost()) throw err;
        this.image = null;
        this.imageFailure = { src, error: err };
        this.refreshStatus();
      }
    }
    if (engine.imageSrc === src) {
      this.showingImage = true;
      return 2;
    }
    if (this.showingImage && engine.imageSrc && this.imageFailure?.src !== src) return 2;
    this.showingImage = false;
    return 1;
  }

  private easeVeil(hasMatte: boolean, now: number): void {
    const dt = this.lastFrameAt ? Math.min(100, now - this.lastFrameAt) : 0;
    this.lastFrameAt = now;
    if (hasMatte) {
      this.veil = Math.max(0, this.veil - dt / VEIL_FADE_MS);
      return;
    }
    /* Ease back up rather than snap to 1.
     *
     * A hard reset was the severe preview flicker with a background (and especially with
     * low light) on: fit() clears history on a size change, and a single missed mask does
     * the same, so every drop painted a fully veiled frame between sharp ones. The dissolve
     * up matches the dissolve down, so a brief miss is a soft pulse instead of a flash. */
    if (dt === 0) {
      this.veil = 1;
      return;
    }
    this.veil = Math.min(1, this.veil + dt / VEIL_FADE_MS);
  }

  private requestImage(src: string): void {
    if (this.image?.src === src || this.imageLoading === src) return;
    // A still that failed stays failed until retry(), rather than refetching every frame.
    if (this.imageFailure?.src === src) return;
    this.imageLoading = src;
    loadImage(src)
      .then(
        (img) => {
          if (this.imageLoading === src) this.image = { src, img };
        },
        (err: unknown) => {
          if (this.imageLoading === src) this.imageFailure = { src, error: err };
        },
      )
      .finally(() => {
        if (this.imageLoading === src) this.imageLoading = null;
        this.refreshStatus();
      });
  }

  /* No GL to draw with, so the frame goes out as it can.
   *
   * With a background on, that is a 2D veil: shrunk to a thumbnail and blown back up, which is
   * a blur that needs no GPU context. It is the room hidden while the engine is rebuilt, which
   * is a second or so. Without one, or once everything has been given up on, the frame itself.
   */
  private fallback(
    frame: VideoFrame,
    controller: TransformStreamDefaultController<VideoFrame>,
    hide: boolean,
  ): void {
    if (hide) {
      const veiled = this.flatVeil(frame);
      if (veiled) {
        frame.close();
        controller.enqueue(veiled);
        return;
      }
    }
    controller.enqueue(frame);
  }

  private flatVeil(frame: VideoFrame): VideoFrame | null {
    try {
      const w = frame.displayWidth;
      const h = frame.displayHeight;
      const sw = w >= h ? FLAT_LONG_SIDE : Math.max(1, Math.round((FLAT_LONG_SIDE * w) / h));
      const sh = w >= h ? Math.max(1, Math.round((FLAT_LONG_SIDE * h) / w)) : FLAT_LONG_SIDE;
      this.flat ??= { small: canvas2d(sw, sh), big: canvas2d(w, h) };
      const { small, big } = this.flat;
      if (small.canvas.width !== sw || small.canvas.height !== sh) {
        small.canvas.width = sw;
        small.canvas.height = sh;
      }
      if (big.canvas.width !== w || big.canvas.height !== h) {
        big.canvas.width = w;
        big.canvas.height = h;
      }
      small.ctx.imageSmoothingEnabled = true;
      small.ctx.imageSmoothingQuality = "high";
      small.ctx.drawImage(frame, 0, 0, sw, sh);
      big.ctx.imageSmoothingEnabled = true;
      big.ctx.imageSmoothingQuality = "high";
      big.ctx.drawImage(small.canvas, 0, 0, w, h);
      return new VideoFrame(big.canvas as unknown as CanvasImageSource, {
        timestamp: frame.timestamp,
        alpha: "discard",
      });
    } catch {
      return null;
    }
  }

  private dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    const engine = this.engine;
    this.engine = null;
    let teardown = Promise.resolve();
    if (engine) {
      /* A model load still in flight owns the context inside oneAtATime. Disposing it
       * now would loseContext mid-createSegmenter — see Engine.dispose. Wait for the
       * load to settle (it will orphan-close the segmenter because this.engine is
       * already null), then tear down. Parking is only safe once nothing is loading.
       *
       * Always awaited: openCamera's failed-start path destroys then opens again, and
       * useVirtualBackground may create a replacement in the same tick — both must see
       * MediaPipe fully torn down first. */
      const loading = engine.loading;
      if (loading) {
        teardown = loading.finally(() => engine.dispose()).then(() => undefined);
      } else if (engine.alive) {
        park(engine);
      } else {
        teardown = engine.dispose();
      }
    }
    this.flat = null;
    // Said once more, as idle, so no screen is left showing "preparing" for a processor
    // that no longer exists.
    this.refreshStatus();
    this.onFrame = undefined;
    this.onStatus = undefined;
    return teardown;
  }

  private refreshStatus(): void {
    const next = this.currentStatus();
    const prev = this.status;
    if (
      prev.phase === next.phase &&
      (prev.phase !== "failed" || next.phase !== "failed" || prev.error === next.error)
    ) {
      return;
    }
    this.status = next;
    if (next.phase === "failed") {
      /* The whole error, not just its sentence — the UI words it for a presenter, and the
       * wording is not enough to act on. The console expands the stack; whoever hits this
       * can screenshot that, and the answer is in it. */
      console.error("[background] gave up", next.error);
    }
    safely(() => this.onStatus?.(next));
  }

  private currentStatus(): SegmenterStatus {
    const { background, lowLight } = this.options;
    if (this.disposed || (background.kind === "none" && lowLight <= 0)) return { phase: "idle" };

    let failure: unknown = this.engineFailure;
    if (failure === null && background.kind !== "none") failure = this.modelFailure;
    if (failure === null && background.kind === "image" && this.imageFailure?.src === background.src) {
      failure = this.imageFailure.error;
    }
    if (failure !== null) return { phase: "failed", error: failure };

    const engine = this.engine;
    if (!engine) return { phase: "preparing" };
    if (background.kind === "none") return { phase: "ready" };
    if (!engine.segmenter) return { phase: "preparing" };
    if (
      background.kind === "image" &&
      engine.imageSrc !== background.src &&
      this.image?.src !== background.src
    ) {
      return { phase: "preparing" };
    }
    return { phase: "ready" };
  }
}
