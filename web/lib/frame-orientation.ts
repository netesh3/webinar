/* Whether the background processor must copy each camera frame through a 2D canvas before
 * WebGL sees it, and back through one before it is sent. iPhone Safari is why.
 *
 * The bug: an iPhone presenter in portrait with blur or a virtual background on reached
 * every other speaker and the whole audience upside down. Without a background they were
 * upright, because then no processor runs and the camera goes out as WebKit captured it.
 *
 * With a processor, Safari has no MediaStreamTrackProcessor, so @livekit/track-processors
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
 * Scoped to WebKit on the fallback path. Chrome and Edge feed the processor from
 * MediaStreamTrackProcessor and are unchanged; Firefox's fallback has never shown this, and
 * the copy is two blits a frame that nobody else should pay for. Every iOS browser is WebKit
 * (CriOS, FxiOS, EdgiOS included). Desktop Safari is included: it takes the same fallback,
 * and for a laptop camera, which has no rotation, the copy changes nothing but the cost.
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

/** Copy frames through a 2D canvas on their way into and out of the GPU. */
export function needsUprightCopy(input: {
  ua: string;
  /** MediaStreamTrackProcessor and MediaStreamTrackGenerator both exist (the modern path). */
  hasTrackProcessor: boolean;
}): boolean {
  return !input.hasTrackProcessor && isWebKitEngine(input.ua);
}

/** needsUprightCopy for this browser. False on the server. */
export function browserNeedsUprightCopy(): boolean {
  if (typeof navigator === "undefined") return false;
  const g = globalThis as Record<string, unknown>;
  return needsUprightCopy({
    ua: navigator.userAgent,
    hasTrackProcessor:
      typeof g.MediaStreamTrackProcessor !== "undefined" &&
      typeof g.MediaStreamTrackGenerator !== "undefined",
  });
}
