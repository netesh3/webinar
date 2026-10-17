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
 * CPU was squeezed: the browser dropped resolution to hold 30 fps. The choice is now
 * the presenter's, defaulting to sharp; file shares (lib/file-share.ts) are always
 * video.
 *
 * Pure: no React, no DOM beyond a guarded localStorage, so it runs under node tests.
 */

export type ShareMode = "sharp" | "video";

export const SHARE_MODE_KEY = "webinar.shareMode";

/** The fps ceiling each mode publishes at. */
export const SHARE_MODE_FPS: Record<ShareMode, number> = { sharp: 15, video: 30 };

/** Largest desktop capture asked for: a 1440p screen is not downscaled to 1080p. */
export const SHARE_CAPTURE_MAX = { width: 2560, height: 1440 } as const;

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
 * Desktop: up to 2560x1440 as an IDEAL (livekit-client turns `resolution` into
 * ideal constraints outside Safari), so a 1080p screen captures at 1080p and a
 * high-DPI one at 1440p rather than being scaled down before encoding.
 * Safari: unconstrained — Safari 17 treats a resolution as a hard max and picked a
 * tiny one; see isSafari in media.ts.
 * Mobile: the 360p floor, phones rarely share. */
export function shareCaptureResolution(
  mode: ShareMode,
  platform: { safari: boolean; mobile: boolean; mobileFloor: { width: number; height: number } },
): { width: number; height: number; frameRate: number } | undefined {
  if (platform.safari) return undefined;
  const frameRate = SHARE_MODE_FPS[mode];
  if (platform.mobile) {
    return { width: platform.mobileFloor.width, height: platform.mobileFloor.height, frameRate };
  }
  return { ...SHARE_CAPTURE_MAX, frameRate };
}

export function readShareMode(): ShareMode {
  try {
    return typeof localStorage !== "undefined" &&
      localStorage.getItem(SHARE_MODE_KEY) === "video"
      ? "video"
      : "sharp";
  } catch {
    return "sharp";
  }
}

export function writeShareMode(mode: ShareMode): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(SHARE_MODE_KEY, mode);
  } catch {
    // Private mode or a full store: the choice still applies to this share.
  }
}
