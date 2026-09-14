"use client";

import { VideoTransformer } from "@livekit/track-processors";

/* Segmentation and compositing, done ourselves.
 *
 * This replaces @livekit/track-processors' BackgroundTransformer, and it exists
 * because two of that implementation's choices are not reachable through its API
 * and both are visible on screen.
 *
 *   It asks MediaPipe for `outputCategoryMask: true, outputConfidenceMasks: false`.
 *   A category mask is a HARD per-pixel classification — 0 or 1, nothing between.
 *   Upscaled from the model's 256×256 to a 1280×720 frame, every mask pixel becomes a
 *   5×3 block, so the edge of a person is a staircase. Their shader tries to recover
 *   a soft edge with a `dFdx/dFdy` gradient trick, and it cannot: the detail is not in
 *   the data. That is the jagged outline.
 *
 *   It runs the square 256×256 model on a 16:9 frame. The frame is squashed to fit,
 *   so horizontal detail — which is where an arm or a shoulder edge lives — is halved
 *   before inference even starts.
 *
 * Both are hardcoded after the point where their options are spread, so the fix has
 * to be a different transformer rather than different arguments. What this one does:
 *
 *   confidence mask       A float 0..1 per pixel — the probability that the pixel is
 *                         the person, which is the alpha directly. The model's own
 *                         uncertainty at the boundary becomes the softness, which is
 *                         what an anti-aliased edge actually is.
 *   landscape model       256×144, so a widescreen webcam is not squashed. Also 44%
 *                         fewer pixels than the square model, so it is FASTER — the
 *                         quality fix and the latency fix are the same change.
 *   temporal smoothing    Each mask is blended with the last one. Segmentation is
 *                         independent per frame, so edges shimmer; this costs one
 *                         texture and removes it.
 *   feathered edge        A small separable blur on the mask, then a smoothstep. Two
 *                         GPU passes over a 256×144 texture, which is nothing.
 *
 * All of it stays on the GPU in one WebGL2 context, including the mask: MediaPipe is
 * given our own canvas via `setOptions({ canvas })`, so `getAsWebGLTexture()` hands
 * back a texture we can sample directly. No pixels are ever read back to the CPU,
 * which is the single largest latency win available here — a `readPixels` on the
 * frame would stall the pipeline every frame waiting for the GPU.
 */

/** What to put behind the person. */
export type Background =
  | { kind: "none" }
  | { kind: "blur"; radius: number }
  | { kind: "image"; src: string };

export type SegmenterOptions = {
  background: Background;
  /** Reports per-frame cost so the caller can back out on a slow device. */
  onFrame?: (stats: { totalMs: number; segmentMs: number }) => void;
};

/* Where the vendored assets are. The landscape model is the important one — see the
 * note above. Both are served from our own origin so a webinar does not depend on a
 * CDN being reachable from a corporate network. */
const WASM_PATH = "/mediapipe/wasm";
const MODEL_PATH = "/mediapipe/selfie_segmenter_landscape.tflite";

/* How much the previous mask counts for.
 *
 * 0.6 current / 0.4 previous. High enough that a hand moving quickly is not smeared,
 * low enough that a still shoulder stops shimmering. This is the one number worth
 * tuning by eye; anything above ~0.8 brings the flicker back and anything below ~0.4
 * visibly lags real movement. */
const MASK_MIX = 0.6;

/** Half-width of the mask feather, in mask pixels. Two is about 10 output pixels at
 *  720p, which reads as an edge rather than a halo. */
const FEATHER = 2.0;

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
 * then cannot be got wrong by adding or removing a pass.
 */
const VERTEX_PASS = `#version 300 es
in vec2 position;
out vec2 uv;
void main() {
  // Offscreen. Row for row: whatever orientation came in, goes out.
  uv = (position + 1.0) * 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const VERTEX_PRESENT = `#version 300 es
in vec2 position;
out vec2 uv;
void main() {
  // To the canvas. One flip, so image row 0 lands at the top of the picture.
  uv = vec2((position.x + 1.0) * 0.5, 1.0 - (position.y + 1.0) * 0.5);
  gl_Position = vec4(position, 0.0, 1.0);
}`;

/** One axis of a separable Gaussian. Used twice for the mask feather and twice for
 *  the background blur — separable because a 21×21 kernel is 441 samples per pixel
 *  in one pass and 42 in two. */
const BLUR = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D source;
uniform vec2 direction;   // texel step, one axis at a time
uniform float radius;     // in texels
out vec4 color;
void main() {
  if (radius <= 0.0) { color = texture(source, uv); return; }
  float total = 0.0;
  vec4 sum = vec4(0.0);
  // sigma = radius/2 puts ~95% of the kernel inside the sampled span.
  float sigma = max(radius * 0.5, 0.0001);
  float twoSigmaSq = 2.0 * sigma * sigma;
  for (int i = -16; i <= 16; i++) {
    float x = float(i);
    if (abs(x) > radius) continue;
    float w = exp(-(x * x) / twoSigmaSq);
    sum += texture(source, uv + direction * x) * w;
    total += w;
  }
  color = sum / total;
}`;

/** The composite. Foreground over background, with the mask as alpha. */
const COMPOSITE = `#version 300 es
precision highp float;
const float MASK_LO = ${MASK_LO.toFixed(3)};
const float MASK_HI = ${MASK_HI.toFixed(3)};
in vec2 uv;
uniform sampler2D frame;
uniform sampler2D background;   // blurred frame, or a still
uniform sampler2D mask;
uniform int mode;               // 0 = passthrough, 1 = blur, 2 = image
uniform vec2 frameSize;
uniform vec2 imageSize;
out vec4 color;

/* object-fit: cover. A 16:9 still behind a 4:3 webcam must crop, not squash. */
vec2 coverUv(vec2 p) {
  float frameAspect = frameSize.x / max(frameSize.y, 1.0);
  float imageAspect = imageSize.x / max(imageSize.y, 1.0);
  vec2 scale = imageAspect > frameAspect
    ? vec2(frameAspect / imageAspect, 1.0)
    : vec2(1.0, imageAspect / frameAspect);
  return (p - 0.5) * scale + 0.5;
}

void main() {
  vec3 fg = texture(frame, uv).rgb;
  if (mode == 0) { color = vec4(fg, 1.0); return; }

  vec2 bgUv = mode == 2 ? coverUv(uv) : uv;
  vec3 bg = texture(background, bgUv).rgb;

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
   * feel — see MASK_LO. The remaining softness comes from the spatial feather, which is
   * where an anti-aliased edge actually comes from. */
  float person = texture(mask, uv).r;
  float alpha = smoothstep(MASK_LO, MASK_HI, person);

  color = vec4(mix(bg, fg, alpha), 1.0);
}`;

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

/** A colour texture plus the framebuffer that renders into it. */
type Target = { texture: WebGLTexture; framebuffer: WebGLFramebuffer; w: number; h: number };

function target(gl: WebGL2RenderingContext, w: number, h: number): Target {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) throw new Error("could not allocate a render target");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  // LINEAR and CLAMP_TO_EDGE: the mask and the blur are both sampled at a different
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

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`background image failed to load: ${src}`));
    img.src = src;
  });
}

// ---------------------------------------------------------------- the transformer

/* Minimal shapes for the two MediaPipe types used here.
 *
 * Declared rather than imported so the module graph does not pull tasks-vision into
 * the main bundle: it is 9MB of WASM glue and it is only needed once somebody turns a
 * background on. The dynamic import in `init` is what keeps it out.
 */
type MPMask = { getAsWebGLTexture: () => WebGLTexture; close: () => void };
type SegmentResult = { confidenceMasks?: MPMask[]; close: () => void };
type Segmenter = {
  segmentForVideo: (
    frame: VideoFrame,
    timestampMs: number,
    callback: (result: SegmentResult) => void,
  ) => void;
  close: () => void;
};

export class SoftSegmenter extends VideoTransformer<Record<string, never>> {
  private options: SegmenterOptions;
  private segmenter: Segmenter | null = null;
  private ctx: WebGL2RenderingContext | null = null;

  private compositeProgram: WebGLProgram | null = null;
  private blurProgram: WebGLProgram | null = null;
  private quad: WebGLBuffer | null = null;

  private frameTexture: WebGLTexture | null = null;

  /** Two ping-pong targets for the mask, so the previous one survives to be blended
   *  with the next. Plus one scratch for the separable blur. */
  private maskA: Target | null = null;
  private maskB: Target | null = null;
  private maskScratch: Target | null = null;
  private maskReadsA = true;
  private hasPreviousMask = false;

  /** Two half-resolution targets for the background blur. Half resolution because a
   *  blurred background has no detail to lose and it quarters the work. */
  private blurA: Target | null = null;
  private blurB: Target | null = null;

  /** The still behind the person, uploaded once and reused until the choice changes. */
  private imageTexture: WebGLTexture | null = null;
  private imageSrc: string | null = null;
  private imageW = 1;
  private imageH = 1;

  /** So a persistent per-frame fault is reported once rather than 30 times a second. */
  private reportedFailure = false;
  /** The frame size the render targets were built for. Zero means nothing is built. */
  private allocatedW = 0;
  private allocatedH = 0;

  constructor(options: SegmenterOptions) {
    super();
    this.options = options;
  }

  update(): void {
    // The base class requires the method. Background changes go through
    // setBackground, which is typed; a bag of unknown keys is not something to
    // accept here, so this takes no arguments and does nothing.
  }

  /** Changes the background without rebuilding anything. Republishing the track to
   *  change a colour would drop a frame for the audience. Image loads finish before
   *  the mode switches, so the previous background stays up rather than a black flash. */
  async setBackground(background: Background): Promise<void> {
    if (background.kind === "image") {
      await this.loadImageTexture(background.src);
    }
    this.options = { ...this.options, background };
  }

  async init(opts: { outputCanvas: OffscreenCanvas | HTMLCanvasElement; inputElement: HTMLVideoElement }): Promise<void> {
    await super.init(opts);

    const canvas = this.canvas;
    if (!canvas) throw new Error("the transformer was initialised without a canvas");

    /* One context for everything, including MediaPipe.
     *
     * `premultipliedAlpha: false` because we composite to full opacity ourselves and
     * do not want the browser doing it again. `preserveDrawingBuffer: false` lets the
     * driver discard the buffer after each frame, which is the fast path. */
    const gl = canvas.getContext("webgl2", {
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      alpha: false,
      desynchronized: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 is not available");
    this.ctx = gl;

    // The composite is the only pass that reaches the canvas, so it is the only one that
    // flips. Everything else — the mask feather, the mask blend, the background blur —
    // renders into a texture and must leave the orientation alone. See the shaders.
    this.compositeProgram = program(gl, VERTEX_PRESENT, COMPOSITE);
    this.blurProgram = program(gl, VERTEX_PASS, BLUR);

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );

    this.frameTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Loaded here rather than at module scope: 9MB of WASM that nobody who never
    // turns a background on should download.
    const vision = await import("@mediapipe/tasks-vision");
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_PATH);
    this.segmenter = (await vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_PATH, delegate: "GPU" },
      runningMode: "VIDEO",
      // The whole point. A confidence mask is a float 0..1 per pixel; the category
      // mask the previous implementation used is a hard 0/1 with no edge to soften.
      outputConfidenceMasks: true,
      outputCategoryMask: false,
      /* Our canvas — the reason the mask never leaves the GPU.
       *
       * The context was created above, and a second getContext("webgl2") on the same
       * canvas returns the same context rather than a new one. So MediaPipe renders
       * the mask into OUR context and `getAsWebGLTexture()` hands back a texture we
       * can sample. The alternative is `getAsFloat32Array()`, which is a readPixels
       * — a full GPU pipeline stall, every frame. */
      canvas,
    })) as unknown as Segmenter;

    if (this.options.background.kind === "image") {
      await this.loadImageTexture(this.options.background.src);
    }

    // One line, at info level. Whether the processor attached at all is the first
    // question anybody asks when a background looks wrong, and it was previously
    // unanswerable from outside the tab.
    console.info("[background] segmenter ready", {
      model: MODEL_PATH,
      background: this.options.background.kind,
    });
  }

  async destroy(): Promise<void> {
    await super.destroy();
    this.segmenter?.close();
    this.segmenter = null;
    const gl = this.ctx;
    if (gl) {
      for (const p of [this.compositeProgram, this.blurProgram]) if (p) gl.deleteProgram(p);
      if (this.frameTexture) gl.deleteTexture(this.frameTexture);
      if (this.imageTexture) gl.deleteTexture(this.imageTexture);
      for (const t of [this.maskA, this.maskB, this.maskScratch, this.blurA, this.blurB]) {
        if (!t) continue;
        gl.deleteTexture(t.texture);
        gl.deleteFramebuffer(t.framebuffer);
      }
      if (this.quad) gl.deleteBuffer(this.quad);
    }
    this.ctx = null;
    this.hasPreviousMask = false;
    this.maskA = null;
    this.maskB = null;
    this.maskScratch = null;
    this.blurA = null;
    this.blurB = null;
    this.imageTexture = null;
    this.imageSrc = null;
    // Or a restart would think the targets it just deleted are still there.
    this.allocatedW = 0;
    this.allocatedH = 0;
  }


  /** Draws the bound program over the whole of the current framebuffer. */
  private drawQuad(gl: WebGL2RenderingContext, p: WebGLProgram, w: number, h: number): void {
    const position = gl.getAttribLocation(p, "position");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /* One separable Gaussian: horizontal into `scratch`, then vertical from there into
   * `out`. Two passes, and neither changes the orientation — see the vertex shaders.
   *
   * `scratch` is genuinely scratch: callers pass a target whose contents they are about
   * to overwrite anyway. `updateMask` passes the same target it is building into, which
   * is safe because the horizontal pass has finished with it before the blend starts. */
  private blurInto(
    gl: WebGL2RenderingContext,
    source: WebGLTexture,
    scratch: Target,
    out: Target,
    radius: number,
  ): void {
    const p = this.blurProgram!;
    gl.useProgram(p);
    gl.uniform1f(gl.getUniformLocation(p, "radius"), radius);
    gl.uniform1i(gl.getUniformLocation(p, "source"), 0);
    gl.activeTexture(gl.TEXTURE0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, scratch.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform2f(gl.getUniformLocation(p, "direction"), 1 / scratch.w, 0);
    this.drawQuad(gl, p, scratch.w, scratch.h);

    gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, scratch.texture);
    gl.uniform2f(gl.getUniformLocation(p, "direction"), 0, 1 / out.h);
    this.drawQuad(gl, p, out.w, out.h);
  }

  transform(frame: VideoFrame, controller: TransformStreamDefaultController<VideoFrame>): void {
    const gl = this.ctx;
    const canvas = this.canvas;
    const background = this.options.background;

    // Nothing to do, and nothing to pay for: the frame goes straight through
    // without touching the GPU or the segmenter.
    if (!gl || !canvas || !this.segmenter || background.kind === "none") {
      controller.enqueue(frame);
      return;
    }
    if (frame.codedWidth === 0 || frame.codedHeight === 0) {
      frame.close();
      return;
    }

    const started = performance.now();
    const w = frame.displayWidth;
    const h = frame.displayHeight;

    try {
      /* Allocate against what WE have allocated for, not against the canvas.
       *
       * Keying this on `canvas.width !== w` was a real bug and an instructive one:
       * ProcessorWrapper sizes the canvas itself before it starts piping frames, so
       * the condition was already false on the very first frame, `resize` never ran,
       * and every render target stayed null. The result was a TypeError inside the
       * segmentation callback on every single frame — caught, and at the time
       * silently swallowed, so the camera passed through untouched and the feature
       * looked like it did nothing at all. */
      if (!this.maskA || this.allocatedW !== w || this.allocatedH !== h) {
        canvas.width = w;
        canvas.height = h;
        this.resize(gl, w, h);
      }

      // The frame, uploaded once and sampled by every pass.
      gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);

      /* Segmentation, awaited before compositing.
       *
       * `segmentForVideo` with a callback is synchronous — the callback runs before
       * it returns — so this reads sequentially and there is no stale-mask window.
       * The mask must be consumed inside the callback: MediaPipe frees it on
       * `result.close()`, and holding the texture past that point renders garbage. */
      const segmentStart = performance.now();
      let segmented = false;
      this.segmenter.segmentForVideo(frame, segmentStart, (result) => {
        const mask = result.confidenceMasks?.[0];
        if (mask) {
          this.updateMask(gl, mask.getAsWebGLTexture());
          segmented = true;
        }
        result.close();
      });
      const segmentMs = performance.now() - segmentStart;

      if (!segmented && !this.hasPreviousMask) {
        /* No mask yet and nothing to fall back on. Passing the frame through
         * unmodified for a frame or two is better than a black rectangle.
         *
         * A CLONE, not the frame itself: `finally` closes the original, and a
         * consumer handed an already-closed VideoFrame gets nothing. That mistake is
         * invisible — the track stays alive and simply shows the unprocessed camera,
         * which reads as "the feature does not work". */
        controller.enqueue(frame.clone());
        return;
      }

      this.composite(gl, background, w, h);

      const output = new VideoFrame(canvas as unknown as CanvasImageSource, {
        timestamp: frame.timestamp ?? 0,
        alpha: "discard",
      });
      controller.enqueue(output);
      this.options.onFrame?.({ totalMs: performance.now() - started, segmentMs });
    } catch (err) {
      /* One bad frame must not tear the track down — a driver fault, a lost context,
       * a frame the segmenter refused — so the original goes through and the next
       * frame tries again.
       *
       * But it is reported. Swallowing this in silence is what made a broken
       * pipeline indistinguishable from a working one with nothing to do: every
       * frame fell through to the raw camera and nothing anywhere said why. Once per
       * session, because at 30fps a persistent fault would otherwise be 1800 lines a
       * minute. */
      if (!this.reportedFailure) {
        this.reportedFailure = true;
        console.warn("[background] frame processing failed, passing the camera through", err);
      }
      controller.enqueue(frame.clone());
    } finally {
      frame.close();
    }
  }

  private resize(gl: WebGL2RenderingContext, w: number, h: number): void {
    for (const t of [this.maskA, this.maskB, this.maskScratch, this.blurA, this.blurB]) {
      if (!t) continue;
      gl.deleteTexture(t.texture);
      gl.deleteFramebuffer(t.framebuffer);
    }
    /* Mask targets at the model's own resolution, not the frame's.
     *
     * The mask carries 256×144 of information however large the frame is, so
     * feathering it at 1280×720 would blur four times as many pixels to produce the
     * same edge. Sampling it with LINEAR filtering at composite time is what scales
     * it up, and that is free. */
    const mw = 256;
    const mh = 144;
    this.maskA = target(gl, mw, mh);
    this.maskB = target(gl, mw, mh);
    this.maskScratch = target(gl, mw, mh);
    // Background blur at half resolution: it is a blur, there is no detail to keep.
    this.blurA = target(gl, Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.blurB = target(gl, Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.maskReadsA = true;
    this.hasPreviousMask = false;
    this.allocatedW = w;
    this.allocatedH = h;
  }

  /* Feather the new mask, then blend it with the previous one.
   *
   * Ping-pong, because a framebuffer cannot sample the texture it is writing to. The
   * blend is done by drawing the feathered mask over the previous one with fixed-
   * function alpha blending rather than in a shader — one less program, and the
   * hardware does exactly the mix we want.
   *
   * This is a running average, so it only works if a mask copied through it comes out
   * the way it went in. When the copy below still inverted V, the "previous mask" was a
   * mirror of itself one frame older, and the average converged on mush. A temporal
   * filter amplifies a per-pass geometry error instead of hiding it. */
  private updateMask(gl: WebGL2RenderingContext, raw: WebGLTexture): void {
    const write = this.maskReadsA ? this.maskB! : this.maskA!;
    const read = this.maskReadsA ? this.maskA! : this.maskB!;

    // Feather into the scratch target.
    this.blurInto(gl, raw, write, this.maskScratch!, FEATHER);

    gl.bindFramebuffer(gl.FRAMEBUFFER, write.framebuffer);
    gl.viewport(0, 0, write.w, write.h);

    if (this.hasPreviousMask) {
      // previous, then the new one at MASK_MIX over it.
      gl.disable(gl.BLEND);
      this.copy(gl, read.texture, write);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
      gl.blendColor(0, 0, 0, MASK_MIX);
      this.copy(gl, this.maskScratch!.texture, write);
      gl.disable(gl.BLEND);
    } else {
      gl.disable(gl.BLEND);
      this.copy(gl, this.maskScratch!.texture, write);
      this.hasPreviousMask = true;
    }

    this.maskReadsA = !this.maskReadsA;
  }

  /** A straight texture copy into a target, via the blur program with radius 0. */
  private copy(gl: WebGL2RenderingContext, source: WebGLTexture, into: Target): void {
    const p = this.blurProgram!;
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
    gl.uniform1f(gl.getUniformLocation(p, "radius"), 0);
    gl.uniform2f(gl.getUniformLocation(p, "direction"), 0, 0);
    gl.uniform1i(gl.getUniformLocation(p, "source"), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    this.drawQuad(gl, p, into.w, into.h);
  }

  private composite(gl: WebGL2RenderingContext, background: Background, w: number, h: number): void {
    // The blurred background, when that is what is behind the person.
    if (background.kind === "blur") {
      this.blurInto(gl, this.frameTexture!, this.blurA!, this.blurB!, background.radius);
    }

    const mode = background.kind === "blur" ? 1 : background.kind === "image" ? 2 : 0;
    const bgTexture =
      background.kind === "blur"
        ? this.blurB!.texture
        : background.kind === "image" && this.imageTexture
          ? this.imageTexture
          : this.frameTexture;

    const p = this.compositeProgram!;
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    gl.uniform1i(gl.getUniformLocation(p, "frame"), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bgTexture);
    gl.uniform1i(gl.getUniformLocation(p, "background"), 1);

    gl.activeTexture(gl.TEXTURE2);
    const mask = this.maskReadsA ? this.maskA! : this.maskB!;
    gl.bindTexture(gl.TEXTURE_2D, mask.texture);
    gl.uniform1i(gl.getUniformLocation(p, "mask"), 2);

    gl.uniform1i(gl.getUniformLocation(p, "mode"), mode);
    gl.uniform2f(gl.getUniformLocation(p, "frameSize"), w, h);
    gl.uniform2f(gl.getUniformLocation(p, "imageSize"), this.imageW, this.imageH);

    this.drawQuad(gl, p, w, h);
  }

  /** Uploads a still into `imageTexture`. Same src is a no-op so switching away
   *  and back does not re-fetch. */
  private async loadImageTexture(src: string): Promise<void> {
    if (this.imageSrc === src && this.imageTexture) return;
    const gl = this.ctx;
    if (!gl) return;

    const img = await loadImage(src);
    if (!this.ctx) return;

    if (!this.imageTexture) {
      this.imageTexture = gl.createTexture();
      if (!this.imageTexture) throw new Error("could not allocate a background texture");
      gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    this.imageW = img.naturalWidth || img.width;
    this.imageH = img.naturalHeight || img.height;
    this.imageSrc = src;
  }
}
