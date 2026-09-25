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
 *               let through half, and follows movement as closely.
 *   room blur   The frame with the PERSON TAKEN OUT, blurred, and divided by how much room
 *               each neighbourhood had in it. A plain blur drags the person's own colours
 *               into the room around them, and that smear is the halo round their head.
 *   composite   The mask upsampled against the full-resolution frame with a joint bilateral
 *               filter, so the edge lands where the edge is in the picture rather than on a
 *               256-pixel grid. Then the person over the room.
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
 * half a frame of history. Raising K_MOVE to 0.97 and tightening MOTION_HI to 0.065 puts
 * that same turn near k ≈ 0.8, and a clear move near 0.97, without touching K_STILL (so the
 * still-edge shimmer trade measured above is unchanged). MOTION_LO drops slightly so a
 * gentle turn starts leaving the still weight sooner.
 *
 * "Moved" is the largest colour change in the 3×3 neighbourhood between this frame and the
 * last, at the matte's resolution — which averages away sensor noise (well under MOTION_LO
 * even in a dim room) and keeps real movement.
 */
const K_STILL = 0.25;
const K_MOVE = 0.97;
const MOTION_LO = 0.025;
const MOTION_HI = 0.065;

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
 *   0.62 - 0.75       41%                    82%      <- here
 *   0.68 - 0.88       33%                    52%
 *   0.75 - 0.92       30%                    17%      <- erases people in bad light
 *
 * Reaching full opacity by 0.75 is what keeps a less-confident person solid. Erosion was
 * measured as the alternative and is worse at both ends: 14 mask pixels of it took the
 * chair to 36% but the face to 73%.
 */
const MASK_LO = 0.62;
const MASK_HI = 0.75;

/** Below this the blur counts a pixel wholly as room. Between it and MASK_LO the pixel is
 *  shown as room but kept out of the blur, so furniture the model half-believes in is
 *  painted over by the wall around it rather than smeared into it. */
const ROOM_LO = 0.3;

/* The joint upsample. Spatial sigma in matte texels, colour sigma in 0..1 RGB distance.
 *
 * SIGMA_SPACE 1.15 (was 1.0) gives the edge one more matte texel of neighbourhood to vote
 * with when the person has moved between frames — the guide colour is still what snaps the
 * boundary, so this is not a soft blob. SIGMA_COLOR 0.11 (was 0.12) is a touch tighter so
 * skin against a wall still separates; two colours 0.11 apart count ~60%, 0.33 apart ~1%.
 */
const SIGMA_SPACE = 1.15;
const SIGMA_COLOR = 0.11;

/** How strong the veil is, in the same units as a blur background's radius. Enough that the
 *  room is unreadable while the model starts; this is what a background looks like loading. */
const VEIL_RADIUS = 24;
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
 * vertex shaders; a temporal filter amplifies a geometry error instead of hiding it. */
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
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      ivec2 q = clamp(p + ivec2(x, y), ivec2(0), last);
      vec3 d = abs(texelFetch(current, q, 0).rgb - texelFetch(previous, q, 0).rgb);
      motion = max(motion, max(d.r, max(d.g, d.b)));
    }
  }
  float k = mix(${K_STILL.toFixed(3)}, ${K_MOVE.toFixed(3)},
                smoothstep(${MOTION_LO.toFixed(3)}, ${MOTION_HI.toFixed(3)}, motion));
  color = vec4(now.rgb, mix(before, now.a, max(k, restart)));
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

/** The composite. Foreground over background, with the matte as alpha. */
const COMPOSITE = `#version 300 es
precision highp float;
const float MASK_LO = ${MASK_LO.toFixed(3)};
const float MASK_HI = ${MASK_HI.toFixed(3)};
const float SIGMA_SPACE = ${SIGMA_SPACE.toFixed(3)};
const float SIGMA_COLOR = ${SIGMA_COLOR.toFixed(3)};
const float FG_CONTRAST = ${FG_CONTRAST.toFixed(3)};
const float FG_SOFTEN = ${FG_SOFTEN.toFixed(3)};
const float FG_SOFT_LOD = ${FG_SOFT_LOD.toFixed(3)};
in vec2 uv;
uniform sampler2D frame;     // the camera, with mips
uniform sampler2D matte;     // guide colour, smoothed confidence
uniform sampler2D room;      // the room blur, premultiplied
uniform sampler2D image;     // a still
uniform int mode;            // 0 = low light only, 1 = blur, 2 = image
uniform float veil;          // 1 = nothing usable yet: show the room blur, person and all
uniform vec2 frameSize;
uniform vec2 imageSize;
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

/* object-fit: cover. A 16:9 still behind a 4:3 webcam must crop, not squash. */
vec2 coverUv(vec2 p) {
  float frameAspect = frameSize.x / max(frameSize.y, 1.0);
  float imageAspect = imageSize.x / max(imageSize.y, 1.0);
  vec2 scale = imageAspect > frameAspect
    ? vec2(frameAspect / imageAspect, 1.0)
    : vec2(1.0, imageAspect / frameAspect);
  return (p - 0.5) * scale + 0.5;
}

/* The matte at full resolution: a joint bilateral upsample.
 *
 * Each of the 4×4 matte texels around this pixel votes with its confidence, weighted by how
 * near it is and by how close ITS colour is to THIS pixel's colour. At a shoulder the texels
 * on the wall side are wall-coloured and the pixel is shirt-coloured, so the wall's votes
 * barely count and the edge snaps to where the colours change — at full resolution, from a
 * 256-pixel mask. Where nothing nearby matches (a highlight, say) it falls back to plain
 * bilinear rather than trusting a vote nobody cast. Away from any edge the answer is the
 * same either way, so it is skipped there. */
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

/* The room behind the person: their neighbourhood's room colour, or — deep inside the
 * person, where there is no room nearby to average — a very coarse mip of the frame. That
 * only shows where the person is anyway, so it only has to be the right sort of colour. */
vec3 roomAt(vec2 p) {
  vec4 r = texture(room, p);
  return mix(textureLod(frame, p, 5.0).rgb, r.rgb / max(r.a, 1e-4), smoothstep(0.02, 0.2, r.a));
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

  /* The mask is a confidence, not a decision — and it is the PERSON's confidence.
   *
   * Worth stating because the obvious assumption is wrong and it inverts the image.
   * The selfie segmenter emits ONE confidence channel, not one per category:
   * measured against both the landscape and the square model, confidenceMasks has
   * length 1 and its value is the probability that a pixel is the person. So this is
   * the alpha directly; reading it as background confidence and subtracting from one
   * composites the person into the background and the background over the person,
   * which looks -- confusingly -- like the feature simply not working.
   *
   * The transition band is narrow and sits above the middle rather than across it, which
   * is a measured choice about what the model is confidently wrong about rather than a
   * feel — see MASK_LO. The softness of the edge comes from matteAt, which is where an
   * anti-aliased edge that follows the picture comes from. */
  float alpha = smoothstep(MASK_LO, MASK_HI, matteAt(uv)) * (1.0 - veil);
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
 *  is always complete whatever state the levels above zero are in. */
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
  /** The room blur's two halves. The result always ends in roomA. */
  private roomA: Target | null = null;
  private roomB: Target | null = null;
  private image: WebGLTexture | null = null;
  private imageW = 1;
  private imageH = 1;

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
      desynchronized: true,
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
      // The only pass that reaches the canvas, so the only one that flips.
      this.composite = pass(
        gl,
        VERTEX_PRESENT,
        COMPOSITE,
        ["frame", "matte", "room", "image"],
        ["mode", "veil", "frameSize", "imageSize", "lowLight"],
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

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    const c = this.composite;
    gl.useProgram(c.program);
    gl.uniform1i(c.u.mode, mode);
    gl.uniform1f(c.u.veil, veil);
    gl.uniform2f(c.u.frameSize, this.w, this.h);
    gl.uniform2f(c.u.imageSize, this.imageW, this.imageH);
    // Read fresh every frame, which is what makes setLowLight free.
    gl.uniform1f(c.u.lowLight, lowLight);
    // Every unit the program samples gets a real texture, even ones this mode ignores:
    // an empty unit is a console warning per frame.
    this.bindTextures(this.frame, matte.texture, this.roomA!.texture, this.image ?? this.frame);
    this.draw();
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
        for (const p of [this.ingest, this.temporal, this.prep, this.blur, this.composite]) {
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
    this.hasHistory = false;
  }

  private releaseTargets(): void {
    const gl = this.gl;
    if (this.frame) gl.deleteTexture(this.frame);
    for (const t of [this.current, this.matte, this.spare, this.roomA, this.roomB]) {
      if (!t) continue;
      gl.deleteTexture(t.texture);
      gl.deleteFramebuffer(t.framebuffer);
    }
    this.frame = null;
    this.current = this.matte = this.spare = this.roomA = this.roomB = null;
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

async function createSegmenter(engine: Engine): Promise<Segmenter> {
  /* Checked before and after the download, because a download is seconds and the context
   * can be taken in between. MediaPipe is handed our context below; if it is dead, the
   * failure surfaces from inside the WASM as "Error querying for GL extensions" or a null
   * property read, which is unreadable and unactionable. */
  if (!engine.alive) throw new Error(CONTEXT_LOST);
  // Loaded here rather than at module scope: 9MB of WASM that nobody who never
  // turns a background on should download.
  const vision = await import("@mediapipe/tasks-vision");
  const fileset = await vision.FilesetResolver.forVisionTasks(WASM_PATH);
  if (!engine.alive) throw new Error(CONTEXT_LOST);
  try {
    return (await vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_PATH, delegate: "GPU" },
      runningMode: "VIDEO",
      // The whole point. A confidence mask is a float 0..1 per pixel; the category
      // mask the previous implementation used is a hard 0/1 with no edge to soften.
      outputConfidenceMasks: true,
      outputCategoryMask: false,
      /* Our canvas — the reason the mask never leaves the GPU.
       *
       * A second getContext("webgl2") on a canvas returns the context it already has, so
       * MediaPipe renders into OUR context and `getAsWebGLTexture()` hands back a texture we
       * can sample. The alternative is `getAsFloat32Array()`, which is a readPixels — a full
       * GPU pipeline stall, every frame. */
      canvas: engine.canvas,
    })) as unknown as Segmenter;
  } catch (err) {
    if (engine.gl.isContextLost()) throw new Error(CONTEXT_LOST, { cause: err });
    throw err;
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
    this.engineFailure = null;
    this.modelFailure = null;
    this.imageFailure = null;
    this.rebuilds = 0;
    this.rebuildAt = 0;
    this.segmentErrors = 0;
    this.segmenterRestarts = 0;
    this.reportedFrameFailure = false;
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
    const warm = setInterval(() => engine.keepWarm(), 100);
    let failure: unknown = null;
    try {
      for (const delay of MODEL_RETRY_MS) {
        if (delay) await sleep(delay);
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
        }
      }
      this.modelFailure = failure ?? new Error("the segmentation model did not load");
    } finally {
      clearInterval(warm);
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
