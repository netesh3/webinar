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
 *          contentHint "motion", up to 30 fps. With SHARE_KEEP_RESOLUTION (the default)
 *          it still holds resolution — "maintain-resolution" in both modes, so a weak
 *          network costs frames, never pixels; only the old simulcast layout used
 *          "maintain-framerate" here.
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

/* The single layout (SHARE_KEEP_RESOLUTION, below) holds resolution in BOTH modes: a played
 * clip under pressure loses frames, never pixels. Only the old simulcast layout still trades
 * by mode. */
export function shareDegradation(
  mode: ShareMode,
  layout: ShareLayout = "simulcast",
): "maintain-resolution" | "maintain-framerate" {
  if (layout === "single") return "maintain-resolution";
  return mode === "video" ? "maintain-framerate" : "maintain-resolution";
}

/* Which codec a share is encoded in: VP9 on desktop Chromium, H264 everywhere else.
 *
 * H264 was the share codec everywhere, and it is the blur that never clears. Measured in
 * Chrome 155 on macOS (2026-10-21, a 1080p slide of small text, contentHint "detail", held
 * still for four seconds): at 500 kbps — what a presenter on a weak uplink really sends —
 * H264 arrived at 41.0 dB PSNR against VP9's 46.3, and used under half of the bitrate it was
 * allowed. At 1.5 Mbps it was 46.2 against 48.6. Chrome's H264 spends its first frame on a
 * new slide and then barely refines it; libvpx keeps sharpening static screen content.
 *
 * Desktop Chromium only, because only there is it published the way the share ladder needs:
 * as rid simulcast (L1T1, the same two encodings as before, so SHARE_LADDER's indexes hold).
 * Safari reads several VP9 encodings as SVC, and livekit-client falls back to one L1T3
 * encoding with contentHint forced to "motion" — the opposite of sharp. Firefox was not
 * measured. Phones encode VP9 in software and rarely share. Those keep H264, unchanged.
 * A subscriber that cannot decode VP9 gets the H264 backup publication. */
export type ShareCodec = "vp9" | "h264";

export function shareCodec(ua: string): ShareCodec {
  const chromium = /\b(Chrome|Chromium)\/\d+/.test(ua);
  const mobile = /android|iphone|ipad|ipod|mobile|crios|edgios/i.test(ua);
  return chromium && !mobile ? "vp9" : "h264";
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

/* Keep resolution, drop frame rate: how a sharp share is laid out on the wire.
 *
 * The blur that came and went was not the encoder, it was the 1080p simulcast layer. Under
 * uplink pressure the browser switched that layer off and every viewer fell to 720p; on a weak
 * downlink the SFU moved that one viewer to 720p. Either way text went soft to hold the frame
 * rate — the opposite of what a slide wants.
 *
 * So a sharp share now goes out as ONE encoding at the capture's full resolution, with
 * degradationPreference "maintain-resolution": a thin uplink costs frames, not pixels.
 *   VP9 (desktop Chromium)   L1T3 SVC: one spatial layer, three temporal layers (15 / 7.5 /
 *                            3.75 fps). The SFU (dependency descriptor) moves a congested
 *                            viewer to a lower TEMPORAL layer — fewer fps, same 1080p —
 *                            instead of to a 720p layer, because there is none.
 *   H264 (Safari, Firefox,   one encoding, full resolution, no 720p layer. No temporal layers
 *         phones)            for the SFU to pick between, so a congested viewer gets the same
 *                            1080p stream at whatever rate the encoder manages.
 *
 * contentHint on VP9 L1T3 has to be "motion", not "detail". libwebrtc's VP9 screen-content
 * config (svc_config.cc, ConfigureSvcScreenSharing) caps a single spatial layer at 5 fps with
 * ONE temporal layer — it would undo the temporal layers this is for. livekit-client forces
 * "motion" on SVC screen shares for the same reason (LocalParticipant: "forcing contentHint to
 * motion for screenshare with SVC codecs"). Resolution is still held: that is the
 * degradationPreference's job, and it is "maintain-resolution". H264 keeps "detail".
 *
 * EVERY share is laid out this way — sharp and video mode, desktop and file shares, in webinars
 * and meetings alike (all of them publish through sharePublishOptions in media.ts). Video mode
 * (a played clip, a file share) is the same single full-resolution encoding, also
 * maintain-resolution, with a higher ceiling: 30 fps and more bitrate (SHARE_SINGLE_BITRATES in
 * network.ts). On VP9 its L1T3 temporal layers are 30 / 15 / 7.5 fps, so a weak viewer gets
 * fewer frames of the same 1080p. A share that switches mode mid-share keeps its encoding and
 * changes fps and bitrate on it; the degradation preference stays maintain-resolution.
 * The network ladder (shareLadder) only ever lowers fps and bitrate on it, never resolution.
 *
 * NEXT_PUBLIC_SHARE_KEEP_RESOLUTION=0 at build time puts every share back on the old
 * 720p + 1080p simulcast (and video mode back on maintain-framerate). */
export const SHARE_KEEP_RESOLUTION: boolean =
  (typeof process === "undefined" ? undefined : process.env.NEXT_PUBLIC_SHARE_KEEP_RESOLUTION) !== "0";

/** "single": one full-resolution encoding. "simulcast": the 720p floor plus the capture. */
export type ShareLayout = "single" | "simulcast";

/** The same for every mode: the switch alone decides. */
export function shareLayout(keepResolution: boolean = SHARE_KEEP_RESOLUTION): ShareLayout {
  return keepResolution ? "single" : "simulcast";
}

/** The layout a live share was published with, read off its sender: one encoding is single. */
export function shareLayoutOfEncodings(count: number | undefined): ShareLayout {
  return count === 1 ? "single" : "simulcast";
}

/** VP9's scalabilityMode for a layout; H264 takes none. */
export function shareScalabilityMode(codec: ShareCodec, layout: ShareLayout): "L1T3" | "L1T1" | undefined {
  if (codec !== "vp9") return undefined;
  return layout === "single" ? "L1T3" : "L1T1";
}

/** What the encoder is told the content is. VP9 L1T3 needs "motion" (see above). */
export function shareEncoderHint(
  mode: ShareMode,
  codec: ShareCodec,
  layout: ShareLayout,
): "detail" | "motion" {
  if (codec === "vp9" && layout === "single") return "motion";
  return shareContentHint(mode);
}

/* Which mode a live share is in.
 *
 * contentHint used to say, but a VP9 L1T3 share is "motion" in both modes. So the mode is
 * remembered per track when it is applied (applyShareMode, and file-share.ts at publish), and
 * a track nobody has noted a mode for yet is read off its hint — except a single-layout VP9
 * one, whose hint says nothing: a desktop share starts sharp, so that is the answer (a file
 * share, always video, is noted before it is published). Keyed by the MediaStreamTrack, which
 * survives a republish. */
const liveModes = new WeakMap<object, ShareMode>();

export function noteShareMode(track: object | undefined, mode: ShareMode): void {
  if (track) liveModes.set(track, mode);
}

export function liveShareMode(
  track: { contentHint?: string } | undefined,
  singleVp9 = false,
): ShareMode {
  const known = track ? liveModes.get(track) : undefined;
  if (known) return known;
  if (singleVp9) return "sharp";
  return shareModeOfHint(track?.contentHint);
}
