/* How a screen share trades sharpness against smoothness.
 *
 * One encoder, two jobs that pull in opposite directions:
 *
 *   sharp  slides, code, documents, dashboards — the default. Text has to stay
 *          legible, so under pressure the encoder drops frames and keeps pixels:
 *          contentHint "detail" + degradationPreference "maintain-resolution",
 *          at most 15 fps. This is what Zoom and Meet do for content share.
 *   video  a clip, a demo with motion, anything played into the share. Smoothness
 *          matters more than the last pixel of text, so the opposite trade:
 *          contentHint "motion" + "maintain-framerate", up to 30 fps.
 *
 * Why "detail" rather than "text": both ask the encoder to hold resolution, but
 * "text" is specifically for text-only content and lets encoders spend less on
 * everything else; a share is usually slides with images, charts and screenshots
 * in them as well. "detail" covers all of that.
 *
 * Shares used to go out as "motion" + "maintain-framerate" unconditionally (to make
 * played videos smooth), which is why slides went soft whenever the uplink or the
 * CPU was squeezed: the browser dropped resolution to hold 30 fps. Every share now
 * starts sharp and is switched automatically while it runs — lib/auto-share-mode.ts
 * watches the share for sustained motion or audio (lib/share-motion.ts) and applies
 * video, then sharp again once it settles. It used to be a presenter checkbox,
 * "Optimize for video", which nobody knew when to tick. File shares
 * (lib/file-share.ts) are always video.
 *
 * Pure: no React, no DOM, so it runs under node tests.
 */

export type ShareMode = "sharp" | "video";

/** The fps ceiling each mode publishes at. */
export const SHARE_MODE_FPS: Record<ShareMode, number> = { sharp: 15, video: 30 };

/* Largest desktop capture asked for: 1080p.
 *
 * It was briefly 1440p (with a 7.5 Mbps top layer), and production showed why not: on an
 * India→EU path the browser could not hold that bitrate, so the top layer was paused far
 * more than it was sent. A 1080p capture at 4 Mbps is sharp and sustainable. */
export const SHARE_CAPTURE_MAX = { width: 1920, height: 1080 } as const;

export function shareContentHint(mode: ShareMode): "detail" | "motion" {
  return mode === "video" ? "motion" : "detail";
}

export function shareDegradation(
  mode: ShareMode,
): "maintain-resolution" | "maintain-framerate" {
  return mode === "video" ? "maintain-framerate" : "maintain-resolution";
}

/** Which mode a live share is in, read back off its track's contentHint. */
export function shareModeOfHint(hint: string | undefined): ShareMode {
  return hint === "motion" ? "video" : "sharp";
}

/* What resolution to ask getDisplayMedia for.
 *
 * Always captured at video's frame rate (30), whatever the share starts in: the mode
 * can switch mid-share without a new capture, and sharp's 15 fps ceiling is applied
 * by the encoder (the layers' maxFramerate), not by the capture.
 *
 * Desktop: up to 1920x1080 as an IDEAL (livekit-client turns `resolution` into
 * ideal constraints outside Safari), so a smaller screen or window is not upscaled
 * and a larger one is captured at 1080p.
 * Safari: unconstrained — Safari 17 treats a resolution as a hard max and picked a
 * tiny one; see isSafari in media.ts.
 * Mobile: the 360p floor, phones rarely share. */
export function shareCaptureResolution(
  platform: { safari: boolean; mobile: boolean; mobileFloor: { width: number; height: number } },
): { width: number; height: number; frameRate: number } | undefined {
  if (platform.safari) return undefined;
  const frameRate = SHARE_MODE_FPS.video;
  if (platform.mobile) {
    return { width: platform.mobileFloor.width, height: platform.mobileFloor.height, frameRate };
  }
  return { ...SHARE_CAPTURE_MAX, frameRate };
}
