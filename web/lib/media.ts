"use client";

import {
  AudioPresets,
  type LocalVideoTrack,
  type RoomOptions,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
  type VideoPreset,
} from "livekit-client";
import { currentDisplayMediaHints } from "./share-hints";
import {
  isSafariUA,
  shareCaptureConstraints,
  shareCodec,
  shareContentHint,
  shareDegradation,
  shareEncoderHint,
  shareLayoutOfEncodings,
  noteShareMode,
  type ShareMode,
} from "./share-mode";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  asBackgroundChoice,
  asBackgroundEngine,
  asLowLight,
  type BackgroundChoice,
  type BackgroundEngine,
} from "./backgrounds";
// Camera and share layers live with the ladders that budget them, so publish defaults and
// applyLadder cannot drift. See CAMERA_* / SHARE_* in network.ts.
import {
  CAMERA_LAYERS,
  CAMERA_TOP,
  PHONE_PIXEL_DENSITY,
  SHARE_FLOOR_DESKTOP,
  SHARE_FLOOR_MOBILE,
  SHARE_LAYERS,
  SHARE_TOP,
  SPEECH_AUDIO,
  cameraCaptureOptions,
  cameraPublishDefaults,
  currentCameraPlan,
  shareCodecOfTrack,
  shareEncodingPlan,
  shareLayers,
  shareTop,
} from "./network";
import { currentIsMobile, deviceFormFactor } from "./device";
import { av1Now, primeAv1Probes } from "./codec-policy";
import { primeReceivePolicy } from "./receive-codecs";

export { canCaptureCamera1080, cameraCaptureOptions, cameraCapturePreset } from "./network";

/* Capture and publish quality.
 *
 * A webinar is asymmetric: a handful of publishers and up to 500 subscribers.
 * That shapes every choice here.
 *
 *   adaptiveStream  the SFU only sends a layer as large as the <video> element
 *                   actually is. Without it, a 240px tile still pulls 720p, and
 *                   a gallery of six tiles costs six full streams.
 *   dynacast        stops sending layers nobody is subscribed to at all. With
 *                   500 idle attendees this is the difference between paying for
 *                   what is watched and paying for what is published.
 *   simulcast       publishes several resolutions at once so a subscriber on a
 *                   phone gets a small layer instead of a stalling large one.
 *
 * All three are on for every role. An attendee publishes nothing, so the
 * publish-side settings are inert for them and there is no reason to branch.
 */

/* Publish quality is not a setting.
 *
 * There used to be a "Send video at" picker offering 360p through 1080p. It is gone, and
 * the reason is that it asked the wrong person. A presenter knows what their camera is; they
 * do not know their current uplink, and that is the number that decides whether 1080p
 * arrives as 1080p or as a stuttering mess. The app measures it every two seconds and can
 * change its mind mid-sentence — see the ladder in network.ts — which no dropdown can.
 *
 * What is left is one capture resolution and one published ladder. 1080p@30 is the
 * featured-speaker ceiling (Zoom Full HD is gated the same way — plan + CPU + large
 * speaker view). Most laptop cams that can do 1080p deliver it; those that cannot
 * negotiate down. Simulcast keeps 360p and 180p so grids and filmstrips do not pull
 * 1080. The ladder starts at the top and steps DOWN within four seconds of trouble,
 * then back up after a clear run, so a good connection is never punished for the
 * possibility of a bad one.
 *
 * Capture is deliberately not part of the adaptation. Changing it means republishing the
 * track, which costs a keyframe and a visible cut for the audience — during the moment the
 * connection is already struggling. The ladder works on the live sender's encodings instead.
 *
 * Low-power publishers and tablets skip the 1080p capture ideal via `cameraCapturePreset()` —
 * they still publish the same three-rung ladder shape so applyLadder indexing stays shared,
 * but their top encoding is CAMERA_720. Phones go further (31 Oct 2026): a capture CAPPED at
 * 720p and a 150 / 450 / 1200 kbps ladder at "low" priority, so the voice is never queued behind
 * the camera (cameraPlanFor in network.ts, which has the meeting-1865 numbers).
 */
export const CAPTURE = CAMERA_TOP;

/* The simulcast ladder, stated rather than inferred.
 *
 * `simulcast: true` alone leaves the layer set to the client library's defaults, which are
 * sensible and also free to change under us. In a room where one publisher feeds five
 * hundred subscribers on wildly different connections, the ladder IS the adaptive bitrate
 * strategy — so it is written down.
 *
 * Three layers: 180p (big grids, filmstrips), 360p (grids of 3–9, weak links), 1080p (large
 * speaker tile; 720p on devices that capture 720). The 180p rung is back and the 720p one is
 * gone, for big rooms: see the camera ladder in network.ts.
 *
 * VP8 by default; AV1 where the publisher's device can afford it (lib/codec-policy.ts),
 * as rid simulcast on the same three layers at ~30% less bitrate (cameraPublishDefaults in
 * network.ts), with a VP8 backup the SFU switches any subscriber to that cannot decode AV1 —
 * Safari, iOS, older Android. The recorder template (the edge mix) and weak subscribers (≤ 4
 * cores, phones without hardware AV1 decode) leave AV1 out of their receive codecs and get that
 * backup too (lib/receive-codecs.ts), so AV1 is decoded only where it is cheap.
 */
export const SIMULCAST_LAYERS: VideoPreset[] = CAMERA_LAYERS;

/**
 * How a screen share is captured.
 *
 * `contentHint` is the important part, and it depends on the share's mode (lib/share-mode.ts).
 * Encoded as motion, captured screen content is protected for frame rate under any bitrate
 * pressure by blurring — so the text on a slide goes soft exactly when somebody is trying to
 * read it. Every share starts "sharp", which asks for "detail": hold the pixels, drop frames.
 * It is switched to "motion" (smoother playback) only while the share is detected playing a
 * video — lib/auto-share-mode.ts — and back once it settles.
 *
 * Resolution: up to 1920x1080, ideal and max (SHARE_CAPTURE_MAX), on desktops and tablets;
 * 1280x720 on phones; Safari is left unconstrained (shareCaptureConstraints, share-mode.ts).
 * The constraints go in `video`, not `resolution`: livekit-client turns `resolution` into
 * ideal-only constraints, or max-only on Safari, and fills an undefined one with its own 1080p
 * preset, which on Safari 18+ is the WebKit bug that captured a presenter at 640 wide
 * (31 Oct 2026). `resolution` {0, 0} is its "uncapped": it adds nothing of its own.
 *
 * Audio IS captured, and it did not used to be. `audio: false` was defended here on the
 * grounds that presenters share slides and terminals more often than video — true, and
 * irrelevant to somebody who has just played a clip to five hundred people in silence. A slide
 * has no sound to lose, so asking for audio costs a slide-sharer nothing; a video-sharer
 * without it has no way to succeed.
 *
 * The three constraints below are microphone processing and every one of them damages music.
 * Echo cancellation subtracts what it thinks is a loop, noise suppression removes steady tones
 * — which is what a bassline is — and automatic gain control pumps the level between quiet and
 * loud passages. They default to ON for a getUserMedia capture, so they are turned off here
 * explicitly rather than left to the browser.
 *
 * What this does NOT fix is a platform limit: see SHARE_AUDIO_SURFACES.
 */
export function shareCaptureOptions(mode: ShareMode): ScreenShareCaptureOptions {
  return {
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    contentHint: shareContentHint(mode),
    video: shareVideoConstraints(),
    resolution: { width: 0, height: 0 },
    // The picker hints, for the Chromium versions that know them (lib/share-hints.ts):
    // surfaceSwitching offers a control to swap the shared window mid-share instead of
    // stopping and starting again — which, in a webinar, means a gap the audience sees;
    // selfBrowserSurface "exclude" hides this tab, which is almost never what a presenter
    // means to share and produces the infinite-mirror effect when it is; preferCurrentTab
    // false and systemAudio "include" round it off.
    ...currentDisplayMediaHints(),
  };
}

/* How a screen share is published, which is not how a camera is published.
 *
 * Audio: `publishDefaults` tunes for speech (AudioPresets.speech, DTX on). Both are wrong for a
 * shared clip — 24 kbps mono sounds like a phone call, and DTX cuts quiet passages. Override
 * those here. Stereo is not forced: the SDK reads the capture's channel count.
 *
 * Video codec: cameras go out as VP8 (publishDefaults.videoCodec). Chrome on macOS often
 * encodes getDisplayMedia as H264 anyway — hardware screen encode — while AddTrack still
 * lists only VP8. The SFU then logs `could not find codec for webrtc receiver` with
 * `isReceiverAdded: false`, the share looks "on" for the host (OwnShareNotice), and
 * attendees never get frames. File-share avoids this by publishing a canvas/element track
 * as VP8 explicitly; desktop share has to match what the browser actually sends.
 *
 * Primary H264 matches the wire. VP8 stays as backup for subscribers that need it.
 *
 * Except on desktop Chromium, which now shares as VP9 (shareCodec in share-mode.ts, with the
 * measurements), H264 as the backup. Chrome on macOS was measured sending the VP9 it was
 * asked for, not H264.
 *
 * Encodings (shareEncodingPlan in network.ts — the same functions the share ladder reads, so
 * the two cannot drift):
 *   every mode, every room (webinar stage, panelists, co-hosts, meetings: all publish here):
 *          ONE encoding at the capture's resolution (1080p at most), maintain-resolution,
 *          VP9 L1T3 SVC (temporal layers the SFU drops per viewer) or H264 single. No 720p
 *          layer for anyone to be switched onto.
 *            sharp  15 fps, VP9 2.5 / H264 4 Mbps
 *            video  30 fps, VP9 4 / H264 5 Mbps (a played clip, a file share)
 *   SHARE_KEEP_RESOLUTION=0 puts every mode back on the 720p floor + capture simulcast
 *   (VP9 rid L1T1, or H264), video on maintain-framerate.
 * Priority over the camera is set on the live senders by prioritiseShare (network.ts), since
 * there is no reliable publish option for it.
 *
 * Degradation (simulcast layout only; the single layout is maintain-resolution in both
 * modes): "sharp" is maintain-resolution — slides and terminals must not blur to hold a
 * frame rate, and contentHint "detail" asks the same of the encoder (except VP9 L1T3, which
 * must be "motion" — share-mode.ts). "video" is
 * maintain-framerate, for a smooth clip (and a smooth recording of one). Either way the
 * network ladder (judgeShare) prefers cutting fps / turning off the top layer over dropping
 * below SHARE_FLOOR_DESKTOP.
 */
export function sharePublishOptions(mode: ShareMode): TrackPublishOptions {
  // AV1 where the gate allows it (codec-policy.ts); never on Safari / iOS; VP9 / H264 otherwise.
  const codec = shareCodec(typeof navigator === "undefined" ? "" : navigator.userAgent, av1Now("share").av1);
  // Layout, codec, scalability, degradation and bitrates: shareEncodingPlan (network.ts). Every
  // share is ONE full-resolution encoding (VP9 L1T3 / H264 single) that drops frames, not
  // pixels, in both modes. See SHARE_KEEP_RESOLUTION.
  const plan = shareEncodingPlan(mode, codec);
  return {
    audioPreset: AudioPresets.musicStereo,
    dtx: false,
    videoCodec: plan.videoCodec,
    backupCodec: { codec: plan.backupCodec, encoding: plan.backupEncoding },
    ...(plan.simulcast === undefined ? {} : { simulcast: plan.simulcast }),
    ...(plan.scalabilityMode ? { scalabilityMode: plan.scalabilityMode } : {}),
    degradationPreference: plan.degradationPreference,
    screenShareEncoding: plan.screenShareEncoding,
    screenShareSimulcastLayers: plan.screenShareSimulcastLayers,
  };
}

/* Switch a live share between sharp and video without republishing.
 *
 * contentHint is writable on a live MediaStreamTrack and takes effect on the next
 * frames; degradationPreference goes through the sender (livekit's
 * setDegradationPreference wraps RTCRtpSender.setParameters); the per-layer fps cap is
 * set on the same sender. Browsers that refuse a part of it keep the old value for that
 * part; useAutoShareMode re-applies on the next change, and the ladder reapplies the fps. */
export async function applyShareMode(track: LocalVideoTrack, mode: ShareMode): Promise<void> {
  const media = track.mediaStreamTrack;
  const sender = track.sender;
  const codec = shareCodecOfTrack(track.codec);
  // The published layout, off the sender: one encoding is the keep-resolution single layout.
  const layout = shareLayoutOfEncodings(sender?.getParameters().encodings?.length);
  noteShareMode(media, mode);
  // VP9 L1T3 stays "motion" in both modes (share-mode.ts): its frame rate depends on it.
  if (media) media.contentHint = shareEncoderHint(mode, codec, layout);
  // maintain-resolution in both modes on the single layout: a clip loses frames, not pixels.
  await track.setDegradationPreference(shareDegradation(mode, layout));
  if (!sender) return;
  try {
    const params = sender.getParameters();
    const layers = shareLayers(mode, codec, layout);
    const top = shareTop(mode, codec, layout);
    params.encodings?.forEach((encoding, i) => {
      if (encoding.active === false) return;
      encoding.maxFramerate = (i < layers.length ? layers[i] : top).encoding.maxFramerate;
    });
    await sender.setParameters(params);
  } catch {
    // Left as it was; the network ladder's next pass reapplies the mode's fps.
  }
}

/* Which shared surfaces can actually carry sound.
 *
 * This is a browser and OS limit, not something the app can arrange, and it is the reason a
 * presenter can enable everything above and still be inaudible:
 *
 *   a Chrome tab      audio travels. Every desktop platform.
 *   a window          no audio on macOS. Windows and ChromeOS can.
 *   the whole screen  the same.
 *
 * So somebody on a Mac who shares their entire screen to show a video gets a silent video no
 * matter what is set here — they have to share the TAB the video is playing in. Saying so in
 * the picker is the only fix available, and it is a better one than a support ticket.
 */
export const SHARE_AUDIO_SURFACES = {
  /** True where a non-tab surface can carry audio. */
  systemAudio: !isMac(),
} as const;

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  // userAgentData where it exists, userAgent where it does not. Only used to choose a
  // sentence, so a wrong guess costs a slightly less helpful hint and nothing else.
  const platform =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData
      ?.platform ??
    navigator.platform ??
    "";
  return /mac/i.test(platform);
}

/* The share's `video` constraints: shareCaptureConstraints for this browser, or `true` (no
 * constraints) on Safari. Phone, tablet and desktop are told apart (deviceFormFactor): a tablet
 * shares like a desktop, a phone at 720p (31 Oct 2026). livekit-client's type for `video` only
 * names displaySurface, but it hands the object to getDisplayMedia as the video constraints. */
function shareVideoConstraints(): ScreenShareCaptureOptions["video"] {
  if (typeof navigator === "undefined") return true;
  const constraints = shareCaptureConstraints({
    safari: isSafari(),
    formFactor: deviceFormFactor(navigator.userAgent, navigator.maxTouchPoints ?? 0),
  });
  return constraints ? (constraints as ScreenShareCaptureOptions["video"]) : true;
}

/* Real Safari, which is asked only so a screen share can avoid constraining it (isSafariUA in
 * share-mode.ts has the test). iPad Safari, desktop mode included, is Safari here.
 *
 * Not narrowed to Safari 17, which is the version livekit-client exempts. A version test would
 * need maintaining as Safari moves, and being wrong in the cautious direction costs one
 * presenter some CPU while being wrong in the other direction sends 250 people a
 * low-resolution slide; Safari 27 still captured at 640 wide under constraints (31 Oct 2026).
 * False on the server, where the answer is never used.
 */
export function isSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  return isSafariUA(navigator.userAgent);
}

/** Re-export floors so callers/tests do not reach into network for capture constants alone. */
export { SHARE_FLOOR_DESKTOP, SHARE_FLOOR_MOBILE };

export type DeviceChoices = {
  audioInput?: string;
  videoInput?: string;
  audioOutput?: string;
};

export type MediaPreferences = DeviceChoices & {
  /** Remembered across sessions so somebody who always joins muted stays muted. */
  micEnabled: boolean;
  cameraEnabled: boolean;
  noiseSuppression: boolean;
  /** The virtual background, remembered for the same reason as the mute state:
   *  somebody who blurs their room does not want to remember to do it every week. */
  background: BackgroundChoice;
  /** Which virtual-background pipeline to run: our SoftSegmenter ("enhanced") or
   *  LiveKit's built-in BackgroundProcessor ("livekit"). Persisted so A/B comparison
   *  survives a reload. See lib/backgrounds.ts. */
  backgroundEngine: BackgroundEngine;
  /** How much to lift the shadows on the camera, 0..LOW_LIGHT_MAX. Remembered for the
   *  same reason again, and more strongly: a room's lighting is a property of the room,
   *  so somebody who needed 40% last Thursday needs it again this Thursday. */
  lowLight: number;
  /** With low light on: pick the amount from the face's brightness (Auto) rather than use
   *  `lowLight` as set (Manual). See the auto low light note in lib/segmenter.ts. */
  lowLightAuto: boolean;
};

export const DEFAULT_PREFERENCES: MediaPreferences = {
  micEnabled: true,
  cameraEnabled: true,
  // On by default: a laptop fan getting through is the more common complaint than
  // the WASM download / per-frame AudioWorklet cost (lib/noise-suppression.ts) is
  // worth optimising away for. Still a per-browser preference, so anyone who
  // turns it off from Settings stays off.
  noiseSuppression: true,
  // Off by default. It costs a WASM download and a GPU pass per frame, and nobody
  // should pay either without asking for it.
  background: { mode: "none" },
  // SoftSegmenter remains the default; LiveKit is opt-in for A/B comparison.
  backgroundEngine: "enhanced",
  /* Off by default too, and for a reason that survives the cost argument — the lift
   * costs no download and no segmentation, so it is nearly free. But a webcam in a
   * well-lit room does not need it, and applying it unasked would brighten every
   * presenter who was already fine and make them look washed out instead. */
  lowLight: 0,
  // Once somebody turns low light on, Auto is what they get unless they choose an amount.
  lowLightAuto: true,
};

/* Phones count each CSS pixel as PHONE_PIXEL_DENSITY device pixels, not the screen's real 3.
 *
 * With "screen", a 390-point-wide iPhone asks for 1170 pixels and so pulls the 1080p
 * layer — 2–3 Mbps onto a six-inch screen, over 4G, warming the phone and buffering
 * the moment the signal dips. At 2 a portrait stage asks for ~780 and gets 720p
 * (the featured speaker), and a landscape or fullscreen one still reaches 1080p.
 * Capture stays 720p on phones (canCaptureCamera1080) so we do not encode empty
 * 1080. Screen shares keep their own 720p floor (shareLayers). */

/**
 * roomOptions builds the LiveKit Room configuration for one participant.
 *
 * `canPublish` only affects the capture defaults, not adaptiveStream or dynacast:
 * a view-only attendee is the biggest beneficiary of both.
 */
export function roomOptions(
  prefs: MediaPreferences,
  canPublish: boolean,
): RoomOptions {
  // Phone, tablet or desktop: what the camera captures, publishes and adapts on (network.ts).
  const plan = currentCameraPlan();
  const capture = plan.top;
  const phone = currentIsMobile();
  // Answered while the pre-join screen is up; the room applies it to the publish defaults when
  // it arrives (the AV1 effect in webinar-room.tsx), before or after the first camera publish.
  if (canPublish) primeAv1Probes();
  // And whether this device should receive AV1 at all, before the Room negotiates anything.
  void primeReceivePolicy("participant");
  return {
    /* Measured in DEVICE pixels, not CSS pixels.
     *
     * livekit-client's default counts a retina laptop (devicePixelRatio 2) as 1, so a
     * shared screen shown 1200 CSS pixels wide asked the SFU for 1200x675 and got the 720p
     * layer — upscaled twice on the display, which is what soft text on a Mac was. And with
     * adaptiveStream on, the smaller of these dimensions and the layer the stage asks for
     * (setVideoQuality, applyBudget in layout.ts) is what is sent, so "Always HIGH" for a
     * share was being overruled. "screen" uses the real ratio. Cameras stay bounded by the
     * stage's own per-tile caps (qualityFor, LOW for strips), so this does not turn every
     * grid tile on a retina screen into a 1080p download.
     */
    adaptiveStream: { pixelDensity: phone ? PHONE_PIXEL_DENSITY : "screen" },
    dynacast: true,

    // The ideal resolution, and on a phone hard caps beside it (cameraCaptureOptions).
    videoCaptureDefaults: {
      deviceId: prefs.videoInput,
      ...cameraCaptureOptions(plan),
    },

    audioCaptureDefaults: {
      deviceId: prefs.audioInput,
      echoCancellation: true,
      // Always off here, even when prefs.noiseSuppression is true: that preference
      // now drives an RNNoise TrackProcessor instead (see
      // components/room/noise-suppression.tsx), which wants the rawest signal it
      // can get rather than the browser's own — much weaker — spectral one on top
      // of it. See lib/noise-suppression.ts for the reasoning in full.
      noiseSuppression: false,
      autoGainControl: true,
    },

    publishDefaults: {
      // Simulcast matters most in exactly this shape of call: one publisher,
      // many subscribers on wildly different networks.
      simulcast: true,
      // A phone's own lighter layers (PHONE_CAMERA_LAYERS), everyone else's SIMULCAST_LAYERS.
      videoSimulcastLayers: plan.layers,
      // Top encoding: 1080p, or 720p on a device that captures 720 (cameraCapturePreset); a
      // phone's 720p at 1.2 Mbps, 24 fps, "low" priority.
      videoEncoding: capture.encoding,

      /* What to give up first when there is not enough upstream.
       *
       * "maintain-framerate" for a camera: a face at a lower resolution still reads as a
       * person talking, while a sharp face at eight frames a second reads as a bad
       * connection and is unpleasant to watch. The browser's default is
       * "balanced", which splits the difference and gets neither.
       *
       * A screen share wants the opposite by default and gets it from its own publish
       * options (sharePublishOptions): "sharp" is contentHint "detail" + maintain-resolution,
       * where dropping frames to hold the pixels is what keeps a terminal legible.
       */
      degradationPreference: plan.degradationPreference,

      /* A screen share is not a camera and must not be encoded like one.
       *
       * ScreenSharePresets exists for this: a 15fps preset spends its bitrate on pixels
       * rather than frames, which is what keeps a terminal or a slide legible. A camera
       * preset at 30fps has to throw away detail to hit its frame rate, and the first
       * thing to go is small text.
       *
       * 1080p is the CEILING; SHARE_FLOOR_DESKTOP (720p) is the floor on desktop. The share
       * ladder in network.ts (judgeShare) turns off 1080p and may cut fps before it ever
       * starves the 720p@~3 Mbps layer — camera still uses the stricter judge() with sharing:true,
       * and is capped at `reduced` while a share is live so the two do not fight for uplink.
       *
       * Egress at scale is still linear in the audience: see docs/CAPACITY.md, and cap
       * MAX_ATTENDEES rather than the resolution if a single node has to carry hundreds.
       *
       * Geography: a single EU SFU cannot match Zoom's nearby PoPs on India RTT; richer
       * encode closes the quality gap that bitrate left open, not the path itself.
       */
      screenShareEncoding: SHARE_TOP.encoding,

      screenShareSimulcastLayers: SHARE_LAYERS,

      // VP8, or AV1 + VP8 backup where codec-policy.ts allows (cameraPublishDefaults).
      ...cameraPublishDefaults(canPublish && av1Now("camera").av1 ? "av1" : "vp8", capture),

      /* Audio is the thing that must not break.
       *
       * Video degrading is a nuisance; audio degrading ends the session for everyone
       * listening. Three settings protect it, and all three cost bandwidth that is worth
       * spending because audio is a rounding error next to video:
       *
       *   red    Every Opus packet carries a copy of the previous one, so a single lost
       *          packet is reconstructed rather than heard as a gap. Roughly doubles a
       *          negligible bitrate. Attendees on hotel wifi are the normal case.
       *   dtx    Silence is not transmitted. With five publishers and one person
       *          speaking, this is most of the audio bandwidth in the room — and it also
       *          means a muted-but-live microphone costs nothing.
       *   speech Opus tuned for voice at 24kbps mono instead of the library default of
       *          music at 48. Doubled by red, that is ~48kbps against ~96, and it is
       *          multiplied by every publisher for every one of five hundred subscribers.
       *          The trade is a presenter playing a music clip through their microphone,
       *          which is rare enough to be the right thing to lose.
       *
       * And a fourth, on the sender: "high" priority (SPEECH_AUDIO), against the camera's "low",
       * so a full uplink queues video and not voice. meeting-1865 (31 Oct 2026) was two phones
       * whose 1080p camera crowded their audio out until it arrived ~100 ms late and robotic.
       */
      red: true,
      dtx: true,
      audioPreset: SPEECH_AUDIO,
    },

    audioOutput: prefs.audioOutput
      ? { deviceId: prefs.audioOutput }
      : undefined,

    // Publishing nothing means there is no local track worth keeping alive.
    stopLocalTrackOnUnpublish: !canPublish,
  };
}

// ------------------------------------------------------------------ storage

/* localStorage is an external store, so it is read through useSyncExternalStore
 * rather than copied into state inside an effect. That is what keeps the server
 * render ("we don't know yet") and the client render ("here are your choices")
 * from disagreeing, and it means a change in one tab reaches the others. */

const STORAGE_KEY = "webcast.media.v1";

let cache: MediaPreferences | null = null;
const listeners = new Set<() => void>();

function readPreferences(): MediaPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<MediaPreferences>;
    /* A `quality` key from a build that still had the picker is simply ignored: the field
     * is gone from the type, so it lands in the object and nothing reads it. Deleting it
     * from storage would be tidier and is not worth a migration. */
    return {
      ...DEFAULT_PREFERENCES,
      ...parsed,
      /* The background, however, DOES need narrowing rather than ignoring.
       *
       * Colour and image modes have been removed, and a browser that chose one still has it
       * in storage. Spread unchecked it would reach the compositor, match no branch, and
       * leave the presenter with an unprocessed frame — their room on show, with nothing in
       * the UI to explain why. */
      background: asBackgroundChoice(parsed.background),
      backgroundEngine: asBackgroundEngine(parsed.backgroundEngine),
      /* And the lift needs it for a sharper version of the same reason: this value is
       * the gamma exponent the shader divides by. A negative one out of hand-edited
       * storage inverts the picture and a huge one flattens it to white, either of which
       * a presenter would be looking at with nothing in the UI to explain it. */
      lowLight: asLowLight(parsed.lowLight),
      lowLightAuto: typeof parsed.lowLightAuto === "boolean" ? parsed.lowLightAuto : true,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function getSnapshot(): MediaPreferences {
  cache ??= readPreferences();
  return cache;
}

/** null on the server: "not known yet", which is the signal to wait rather than
 *  to join a room with the wrong camera. */
function getServerSnapshot(): MediaPreferences | null {
  return null;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) {
      cache = null;
      listeners.forEach((l) => l());
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function writePreferences(next: MediaPreferences): void {
  cache = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private browsing or a full quota. The in-memory copy still applies to this
    // session.
  }
  listeners.forEach((l) => l());
}

/**
 * useMediaPreferences persists device and quality choices.
 *
 * `ready` is false until the first client-side read: localStorage does not exist
 * during the server render, and joining a room with the defaults before the
 * stored choices load would open the wrong camera and then visibly swap.
 */
export function useMediaPreferences() {
  const stored = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const update = useCallback((patch: Partial<MediaPreferences>) => {
    writePreferences({ ...getSnapshot(), ...patch });
  }, []);

  return {
    prefs: stored ?? DEFAULT_PREFERENCES,
    update,
    ready: stored !== null,
  };
}

// ------------------------------------------------------------------ devices

export type DeviceList = {
  audioInput: MediaDeviceInfo[];
  videoInput: MediaDeviceInfo[];
  audioOutput: MediaDeviceInfo[];
};

const EMPTY_DEVICES: DeviceList = {
  audioInput: [],
  videoInput: [],
  audioOutput: [],
};

/**
 * useDevices enumerates cameras, microphones and speakers.
 *
 * Device labels are hidden until the page holds a media permission, so this is
 * called again after a preview track is acquired — before that, a browser
 * reports "" for every label and the picker is a list of blanks.
 */
export function useDevices(enabled: boolean) {
  const [devices, setDevices] = useState<DeviceList>(EMPTY_DEVICES);

  const refresh = useCallback(async () => {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.enumerateDevices
    ) {
      return;
    }
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices({
        // Filter out entries with no deviceId: some browsers report a phantom
        // default with an empty id that then fails to open.
        audioInput: all.filter((d) => d.kind === "audioinput" && d.deviceId),
        videoInput: all.filter((d) => d.kind === "videoinput" && d.deviceId),
        audioOutput: all.filter((d) => d.kind === "audiooutput" && d.deviceId),
      });
    } catch {
      setDevices(EMPTY_DEVICES);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.enumerateDevices
    ) {
      return;
    }

    let active = true;
    // Enumerated in a promise callback rather than by awaiting a helper in the
    // effect body, so nothing sets state synchronously during the effect.
    const read = () => {
      navigator.mediaDevices
        .enumerateDevices()
        .then((all) => {
          if (!active) return;
          setDevices({
            audioInput: all.filter(
              (d) => d.kind === "audioinput" && d.deviceId,
            ),
            videoInput: all.filter(
              (d) => d.kind === "videoinput" && d.deviceId,
            ),
            audioOutput: all.filter(
              (d) => d.kind === "audiooutput" && d.deviceId,
            ),
          });
        })
        .catch(() => {
          if (active) setDevices(EMPTY_DEVICES);
        });
    };
    read();

    // Plugging in a headset mid-session should update the picker.
    const mediaDevices = navigator.mediaDevices;
    mediaDevices.addEventListener?.("devicechange", read);
    return () => {
      active = false;
      mediaDevices.removeEventListener?.("devicechange", read);
    };
  }, [enabled]);

  return { devices, refresh };
}

/** A readable label for a device, since browsers leave it blank without
 *  permission and some report only "default". */
export function deviceLabel(
  device: MediaDeviceInfo,
  index: number,
  kind: string,
): string {
  if (device.label) return device.label;
  return `${kind} ${index + 1}`;
}

/** True when this browser can actually route audio to a chosen speaker.
 *  Firefox and iOS Safari cannot, so the picker is hidden rather than offered
 *  and silently ignored. */
export function supportsOutputSelection(): boolean {
  return (
    typeof HTMLMediaElement !== "undefined" &&
    "setSinkId" in HTMLMediaElement.prototype
  );
}
