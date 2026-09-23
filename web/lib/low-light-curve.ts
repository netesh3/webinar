/* The low-light curve, as shader source, in a module with no imports.
 *
 * Its own file for one reason: e2e/probe-low-light.mjs imports this and compiles the exact
 * string below in a real WebGL2 context. probe-mask.mjs, testing the segmentation chain,
 * has to transcribe segmenter.ts's shaders by hand and says so — "a copy that drifts is
 * worse than no test". A transcription of THIS would be worse still, because every property
 * worth asserting about a tone curve is a property of the arithmetic: a copy that drifts is
 * a test that passes while the shipped curve clips.
 *
 * segmenter.ts cannot be imported by a probe — it pulls in @livekit/track-processors and
 * MediaPipe — so the curve moved here instead, where `node --experimental-strip-types` can
 * load it with nothing behind it.
 */

/* Why this is a curve and not a multiply.
 *
 * `rgb * gain` is the obvious way to brighten a dark face and it is the wrong one. It
 * scales the highlights by the same factor as the shadows, so a lit cheek — or a window
 * behind the person — reaches 1.0 and stays there. The detail in it is gone, and what the
 * audience sees is a white patch rather than more light.
 *
 * A gamma lift cannot do that. pow(c, 1/g) with g > 1 raises the shadows most, the midtones
 * some, and leaves 1.0 exactly where it was, because pow(1, x) == 1 for every x. Nothing
 * that was not already clipped becomes clipped.
 *
 * Per channel, rather than on luminance. Scaling three channels by a luminance ratio keeps
 * hue better in principle, but on a saturated pixel it pushes one channel past 1.0 and
 * clips that channel alone — which shifts the hue, the failure it was meant to avoid.
 * Per-channel gamma cannot leave [0,1] at all, so the slider has no bad end.
 *
 * LIFT is the gamma at the top of the slider. 1.0 here means gamma 2.0 at full, which takes
 * a midtone of 0.25 to 0.5 — about as far as a webcam frame goes before the sensor noise in
 * the shadows comes up with the face.
 */
export const LOW_LIGHT_LIFT = 1.0;

/* What the lift costs, and what puts it back.
 *
 * Raising the shadows raises black along with them. A frame whose black sits at 0.2 grey
 * reads as hazy — the washed-out fog every naive brightness control produces — and the face
 * looks lit but flat.
 *
 * A small S-curve about mid-grey restores the separation. x*x*(3-2x) is smoothstep: it
 * leaves 0, 0.5 and 1 where they are and steepens everything between, so the blacks go back
 * down without taking the face with them. Mixed in proportion to the slider, because the
 * flattening is proportional to the lift. Both ends of the mix are inside [0,1], so this
 * cannot clip either.
 */
export const LOW_LIGHT_CONTRAST = 0.35;

/**
 * The curve itself, for a fragment shader to include before it is used.
 *
 * Takes the amount as an argument rather than reading a uniform, so the composite can pass
 * its own uniform and the probe can pass a test value into the same code.
 */
export const LOW_LIGHT_GLSL = `
const float LOW_LIGHT_LIFT = ${LOW_LIGHT_LIFT.toFixed(4)};
const float LOW_LIGHT_RESTORE = ${LOW_LIGHT_CONTRAST.toFixed(4)};

/* Shadows up, highlights where they were. See lib/low-light-curve.ts for why each line
 * is the shape it is — none of it is adjustable by feel without reading that first. */
vec3 liftShadows(vec3 c, float amount) {
  if (amount <= 0.0) return c;
  vec3 lifted = pow(max(c, vec3(0.0)), vec3(1.0 / (1.0 + amount * LOW_LIGHT_LIFT)));
  vec3 restored = lifted * lifted * (3.0 - 2.0 * lifted);
  return mix(lifted, restored, amount * LOW_LIGHT_RESTORE);
}`;
