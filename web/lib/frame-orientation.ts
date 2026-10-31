/* Whether the background processor must copy each camera frame through a 2D canvas before
 * WebGL sees it, and back through one before it is sent. iPhone Safari is why.
 *
 * The bug: an iPhone presenter in portrait with blur or a virtual background on reached
 * every other speaker and the whole audience upside down. Without a background they were
 * upright, because then no processor runs and the camera goes out as WebKit captured it.
 *
 * With a processor, Safari has no MediaStreamTrackGenerator, so @livekit/track-processors
 * takes its canvas fallback: `new VideoFrame(<video playing the camera>)`, our transform,
 * then drawImage into a canvas that is captureStream()ed and published. A phone camera's
 * buffers are not stored the way up the phone is held — WebKit carries the rotation beside
 * the pixels — and two steps in that chain hand the raw buffer to the GPU directly:
 * texImage2D(VideoFrame) into SoftSegmenter's frame texture, and new VideoFrame(<WebGL
 * canvas>) out of it. Either getting the rotation (or WebGL's bottom-up rows) the other way
 * round is the half turn the audience saw. And nothing downstream can correct it: the
 * captureStream track is plain pixels, so the video-orientation (CVO) header WebRTC uses to
 * tell a receiver to rotate a phone's picture is not on it.
 *
 * Every other read of the frame in the processor — the segmentation model's input, face
 * detection, the low-light meter, the flat veil — is CanvasRenderingContext2D.drawImage,
 * which applies the rotation the way the <video> element does. So the fix is to make the
 * two GPU hand-offs use that too: draw the frame into a 2D canvas and upload the canvas,
 * and draw the WebGL canvas into a 2D canvas and send that. A 2D canvas has no rotation and
 * row 0 at the top, so there is nothing left for WebKit to interpret. It also guarantees
 * the colour and the mask are the same way up, which they were not when only the mask
 * went through drawImage.
 *
 * Scoped to WebKit — on EVERY path, not only the canvas fallback. #632 first gated the copy
 * on "no MediaStreamTrackProcessor", reasoning that the modern path hands over frames that
 * need no help. That holds for Chromium, but WebKit is shipping MediaStreamTrackProcessor and
 * WebCodecs' VideoFrame rotation/flip: a WebKit camera frame from either path can carry its
 * rotation beside the pixels, and the GPU hand-offs are what ignore it. Gating on the API meant
 * the first Safari to expose it would silently go back to the rotated picture. Chrome, Edge
 * and Firefox are unchanged; every iOS browser is WebKit (CriOS, FxiOS, EdgiOS included), and
 * desktop Safari is included at the cost of two blits a frame for a camera with no rotation.
 *
 * The copy is also sized the way the picture is shown (uprightSize), not by the frame's
 * displayWidth/displayHeight alone: with WebCodecs rotation those are the stored buffer's,
 * landscape for a portrait phone, and a 720x1280 picture drawn into a 1280x720 canvas is
 * squashed. And on an iPhone or iPad the copy is the cheap place to shrink the work
 * (PHONE_LONG_SIDE): ProcessorWrapper's canvas fallback scales the result back to the camera's
 * size before it is published, so the track keeps its resolution and simulcast layers.
 *
 * No imports, so the test can load this file with Node directly (lib/frame-orientation.test.mts).
 */

/** The engine behind this user agent is WebKit — Safari, and every browser on iOS/iPadOS. */
export function isWebKitEngine(ua: string): boolean {
  if (!/applewebkit/i.test(ua)) return false;
  // On iOS every browser is WebKit, whatever it calls itself.
  if (/iphone|ipad|ipod/i.test(ua)) return true;
  // Elsewhere Chromium also says AppleWebKit; Android is never WebKit proper.
  return !/chrome|chromium|crios|edg|android/i.test(ua);
}

/** An iPhone, iPad or iPod — iPadOS Safari included, which says "Macintosh" but has touch. */
export function isAppleMobile(ua: string, maxTouchPoints = 0): boolean {
  if (/iphone|ipad|ipod/i.test(ua)) return true;
  return /macintosh/i.test(ua) && maxTouchPoints > 1 && isWebKitEngine(ua);
}

/** Copy frames through a 2D canvas on their way into and out of the GPU: on WebKit, whether
 *  or not it has MediaStreamTrackProcessor (see the file comment). */
export function needsUprightCopy(input: { ua: string }): boolean {
  return isWebKitEngine(input.ua);
}

/** The longest side the background is drawn at on an Apple phone or tablet. 640 is 360x640 for
 *  a portrait 720p camera: a quarter of the pixels to copy, composite and read back, which is
 *  what an iPhone could not keep up with at full size (5-10fps out with blur on). */
export const PHONE_LONG_SIDE = 640;

/** The longest side to draw the background at here, or null for the camera's own size. */
export function processingLongSide(input: {
  ua: string;
  maxTouchPoints?: number;
  /** MediaStreamTrackProcessor and MediaStreamTrackGenerator both exist: the engine's canvas
   *  is then the published frame, with nothing to scale it back up, so it stays full size. */
  hasTrackProcessor: boolean;
}): number | null {
  if (input.hasTrackProcessor) return null;
  return isAppleMobile(input.ua, input.maxTouchPoints ?? 0) ? PHONE_LONG_SIDE : null;
}

/** The size of a frame the way it is shown.
 *
 * `rotation` is WebCodecs' VideoFrame.rotation (0, 90, 180, 270), where the browser has it:
 * a quarter turn means displayWidth/displayHeight are the stored buffer's and swap. Without
 * it, `shown` — the <video> element playing the camera, which is always the way up the phone
 * is held — settles it: if it is portrait and the frame landscape (or the other way round),
 * the frame's numbers are the buffer's.
 *
 * On an iPhone, `shown` is usually the same landscape as the buffer: HTMLVideoElement.videoWidth
 * is the sensor, and ProcessorWrapper's dummy video is sized to the 1280×720 capture. Turning
 * a background on then published that landscape (the tile "flips to horizontal") because the
 * WebRTC CVO header that had been rotating the raw camera is not on a processed track.
 * `held` is how the phone is actually oriented (the viewport) and swaps in that case.
 *
 * Either way, the aspect is what is corrected, never the pixel count. */
export function uprightSize(
  frame: { displayWidth: number; displayHeight: number; rotation?: number },
  shown?: { width: number; height: number } | null,
  held?: { width: number; height: number } | null,
): { w: number; h: number } {
  const w = frame.displayWidth;
  const h = frame.displayHeight;
  const turn = (((frame.rotation ?? 0) % 360) + 360) % 360;
  if (turn === 90 || turn === 270) return { w: h, h: w };
  if (shown && shown.width > 0 && shown.height > 0 && w !== h && shown.width !== shown.height) {
    if (shown.width > shown.height !== w > h) return { w: h, h: w };
  }
  if (held && held.width > 0 && held.height > 0 && w !== h && held.width !== held.height) {
    if (held.width > held.height !== w > h) return { w: h, h: w };
  }
  return { w, h };
}

/** Viewport of an Apple phone or tablet, or null on desktop (a tall Safari window is not a
 *  portrait camera). */
export function heldViewport(input: {
  ua: string;
  maxTouchPoints?: number;
  width: number;
  height: number;
}): { width: number; height: number } | null {
  if (!isAppleMobile(input.ua, input.maxTouchPoints ?? 0)) return null;
  if (input.width <= 0 || input.height <= 0) return null;
  return { width: input.width, height: input.height };
}

/** heldViewport for this browser. Off on the server and on desktop Safari. */
export function browserHeldViewport(): { width: number; height: number } | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;
  const vv = window.visualViewport;
  return heldViewport({
    ua: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    width: vv?.width || window.innerWidth,
    height: vv?.height || window.innerHeight,
  });
}

/** Size to publish a processed frame at: the camera's long side, processed aspect.
 *
 * ProcessorWrapper's canvas.captureStream fallback otherwise stretches the picture into
 * videoWidth×videoHeight (the landscape sensor). Scaling this way keeps 720p on the wire
 * and the portrait aspect the phone is held at. */
export function publishSize(
  processed: { w: number; h: number },
  camera: { w: number; h: number },
): { w: number; h: number } {
  const trackLong = Math.max(camera.w, camera.h);
  const frameLong = Math.max(processed.w, processed.h);
  if (!frameLong || !trackLong) return processed.w ? processed : camera;
  const k = trackLong / frameLong;
  const even = (n: number) => Math.max(2, Math.round((n * k) / 2) * 2);
  return { w: even(processed.w), h: even(processed.h) };
}

/** `size` shrunk so its longer side is at most `max` (never grown), in even pixels. */
export function capLongSide(size: { w: number; h: number }, max: number | null): { w: number; h: number } {
  const long = Math.max(size.w, size.h);
  if (!max || long <= max) return size;
  const k = max / long;
  const even = (n: number) => Math.max(2, Math.round((n * k) / 2) * 2);
  return { w: even(size.w), h: even(size.h) };
}

/** needsUprightCopy and processingLongSide for this browser. Off on the server. */
export function browserUprightPlan(): { copy: boolean; longSide: number | null } {
  if (typeof navigator === "undefined") return { copy: false, longSide: null };
  const ua = navigator.userAgent;
  const g = globalThis as Record<string, unknown>;
  const copy = needsUprightCopy({ ua });
  const hasTrackProcessor =
    typeof g.MediaStreamTrackProcessor !== "undefined" &&
    typeof g.MediaStreamTrackGenerator !== "undefined";
  return {
    copy,
    // Only where the copy runs: it is the step that draws at the smaller size.
    longSide: copy
      ? processingLongSide({ ua, maxTouchPoints: navigator.maxTouchPoints ?? 0, hasTrackProcessor })
      : null,
  };
}
