"use client";

import {
  AudioPresets,
  ScreenSharePresets,
  type RoomOptions,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
  type VideoPreset,
} from "livekit-client";
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
  SHARE_FLOOR_DESKTOP,
  SHARE_FLOOR_MOBILE,
  SHARE_LAYERS,
  SHARE_TOP,
  cameraCapturePreset,
} from "./network";

export { canCaptureCamera1080, cameraCapturePreset } from "./network";

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
 * negotiate down. Simulcast keeps 720p and 360p so grids and filmstrips do not pull
 * 1080. The ladder starts at the top and steps DOWN within four seconds of trouble,
 * then back up after a clear run, so a good connection is never punished for the
 * possibility of a bad one.
 *
 * Capture is deliberately not part of the adaptation. Changing it means republishing the
 * track, which costs a keyframe and a visible cut for the audience — during the moment the
 * connection is already struggling. The ladder works on the live sender's encodings instead.
 *
 * Low-power / mobile publishers skip the 1080p capture ideal via `cameraCapturePreset()` —
 * they still publish the same three-rung ladder shape so applyLadder indexing stays shared,
 * but the top encoding is capped at 720p so we do not ask a phone to encode empty 1080.
 */
export const CAPTURE = CAMERA_TOP;

/* The simulcast ladder, stated rather than inferred.
 *
 * `simulcast: true` alone leaves the layer set to the client library's defaults, which are
 * sensible and also free to change under us. In a room where one publisher feeds five
 * hundred subscribers on wildly different connections, the ladder IS the adaptive bitrate
 * strategy — so it is written down.
 *
 * Three layers: 360p (filmstrip / weak links), 720p (grids), 1080p (large speaker tile).
 * Dropping the old 180p rung is deliberate — with a 1080 top, MEDIUM is 720p, so small
 * grids no longer land on soft 360p-upscaled faces.
 *
 * Not SVC. VP9 and AV1 would give better quality per bit and let the SFU drop temporal
 * layers more finely, but decode cost lands on the SUBSCRIBER — and in an audience of five
 * hundred there are always low-end Android phones and locked-down laptops that
 * software-decode VP9 at a crawl or not at all. VP8 simulcast wastes some upstream bandwidth
 * on the one publisher to guarantee the five hundred can watch, which is the right way round
 * for a webinar. H264 is reserved for screen share (Chrome's getDisplayMedia path).
 */
export const SIMULCAST_LAYERS: VideoPreset[] = CAMERA_LAYERS;

/**
 * How a screen share is captured.
 *
 * `contentHint: "text"` is the important one. Without it the browser encodes
 * captured screen content as if it were motion video, and under any bitrate
 * pressure it protects the frame rate by blurring — so the text on a slide goes
 * soft exactly when somebody is trying to read it. "text" tells the encoder to
 * do the opposite: hold the pixels, drop frames (stronger than "detail" for decks).
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
export const SCREEN_SHARE_OPTIONS: ScreenShareCaptureOptions = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
  contentHint: "motion",

  /* Capture floors: desktop 1080p@30fps for smooth video playback & sharp presentations. */
  resolution: isSafari()
    ? undefined
    : isMobilePublisher()
      ? {
          width: SHARE_FLOOR_MOBILE.width,
          height: SHARE_FLOOR_MOBILE.height,
          frameRate: 30,
        }
      : ScreenSharePresets.h1080fps30.resolution,

  // Offer a control to swap the shared window mid-share instead of stopping and
  // starting again — which, in a webinar, means a gap the audience sees.
  surfaceSwitching: "include",
  // The current tab is almost never what a presenter means to share, and picking
  // it produces the infinite-mirror effect.
  selfBrowserSurface: "exclude",
};

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
 * screenShareEncoding / simulcast layers still come from publishDefaults via the merge —
 * do not restate them here or a drift with SHARE_LADDER is easy to miss.
 *
 * maintain-resolution: slides and terminals must not blur to hold a frame rate; contentHint
 * "text" asks the same of the encoder, and this matches it on the sender. The network
 * ladder for share (judgeShare) prefers cutting fps / turning off 1080p over dropping below
 * SHARE_FLOOR_DESKTOP.
 */
export const SCREEN_SHARE_PUBLISH: TrackPublishOptions = {
  audioPreset: AudioPresets.musicStereo,
  dtx: false,
  videoCodec: "h264",
  backupCodec: { codec: "vp8" },
  degradationPreference: "maintain-framerate",
};

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

/** Coarse mobile check for capture floors — phones rarely share, but must not go below 360p. */
function isMobilePublisher(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/android|iphone|ipod|ipad/i.test(ua)) return true;
  // iPadOS 13+ may report as Macintosh with a touchscreen.
  const maxTouch =
    typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0;
  return /macintosh/i.test(ua) && maxTouch > 1;
}

/* Real Safari, which is asked only so a screen share can avoid constraining it.
 *
 * The negative clauses are the whole test: Chrome, Edge, and every iOS browser put
 * "Safari" in their user agent, because on iOS they are all WebKit wearing a different
 * name. What survives the filter is Safari proper, desktop or mobile.
 *
 * Not narrowed to Safari 17, which is the version with the bug. A version test would need
 * maintaining as Safari moves, and being wrong in the cautious direction costs one
 * presenter some CPU while being wrong in the other direction sends 250 people a
 * low-resolution slide. False on the server, where the answer is never used.
 */
export function isSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return (
    /safari/i.test(ua) && !/chrome|chromium|crios|fxios|edg|android/i.test(ua)
  );
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
};

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
  const capture = cameraCapturePreset();
  return {
    adaptiveStream: true,
    dynacast: true,

    videoCaptureDefaults: {
      deviceId: prefs.videoInput,
      resolution: capture.resolution,
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
      videoSimulcastLayers: SIMULCAST_LAYERS,
      // Top encoding is always the 1080 rung of the shared ladder. Low-power
      // devices capture at 720 and keep this rung inactive (see canCaptureCamera1080).
      videoEncoding: CAMERA_TOP.encoding,

      /* What to give up first when there is not enough upstream.
       *
       * "maintain-framerate" for a camera: a face at a lower resolution still reads as a
       * person talking, while a sharp face at eight frames a second reads as a bad
       * connection and is unpleasant to watch. The browser's default is
       * "balanced", which splits the difference and gets neither.
       *
       * A screen share wants the opposite and gets it from contentHint: "text" —
       * there, dropping frames to hold the pixels is what keeps a terminal legible.
       */
      degradationPreference: "maintain-framerate",

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

      videoCodec: "vp8",

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
       */
      red: true,
      dtx: true,
      audioPreset: AudioPresets.speech,
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
