"use client";

import {
  createLocalAudioTrack,
  createLocalVideoTrack,
  type LocalAudioTrack,
  type LocalVideoTrack,
} from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { openCamera, useBackgroundsAvailable, useVirtualBackground } from "@/lib/backgrounds";
import { cameraCapturePreset, deviceLabel, useDevices, type MediaPreferences } from "@/lib/media";
import { describeMediaError } from "@/lib/media-errors";
import { measureMicLevel } from "@/lib/mic-level";
import { Alert, Select, Spinner } from "../controls";
import { BackgroundTiles } from "./background-picker";
import { LowLightControl } from "./low-light";
import { Button } from "../ui";
import { CameraIcon, CameraOffIcon, MicIcon, MicOffIcon } from "../icons";

/* The pre-join check, for people who are about to be on camera.
 *
 * Only publishers see this. An attendee publishes nothing, so a device preview
 * would be a pointless extra click between them and the webinar they came for.
 *
 * It exists because the alternative is finding out you were on the wrong
 * microphone once 400 people are already watching.
 */

export function PreJoin({
  topic,
  displayName,
  role,
  prefs,
  onUpdatePrefs,
  onJoin,
}: {
  topic: string;
  displayName: string;
  role: string;
  prefs: MediaPreferences;
  onUpdatePrefs: (patch: Partial<MediaPreferences>) => void;
  /** Called with the choices AND the tracks already open for the preview.
   *
   *  Handing the tracks over rather than releasing them is worth a second or two of
   *  the join: opening a camera is not instant, and doing it twice means the room
   *  waits on a device that was already running. It also removes a second
   *  getUserMedia call, which some browsers answer with another permission prompt.
   *
   *  Ownership transfers with them — from here on the room stops them, not this
   *  screen. */
  onJoin: (choices: {
    micEnabled: boolean;
    cameraEnabled: boolean;
    audioTrack: LocalAudioTrack | null;
    videoTrack: LocalVideoTrack | null;
  }) => void;
}) {
  const [micEnabled, setMicEnabled] = useState(prefs.micEnabled);
  const [cameraEnabled, setCameraEnabled] = useState(prefs.cameraEnabled);
  /* Why a device that would not open gets its OWN piece of state, one per device.
   *
   * These used to be one `error`, written at the end of the acquisition effect and cleared at
   * the start of it — and that could not survive the thing it was describing. A camera that
   * throws turns its own toggle off, turning the toggle off re-runs the effect, and the re-run
   * cleared the message before the run that produced it had finished writing it. So a Safari
   * presenter clicking the camera button saw it flick back to off and nothing else: no reason,
   * no suggestion, no indication that the click had been received at all.
   *
   * Per device, because they fail independently — a camera held by another tab while the
   * microphone is fine is the common case, and "couldn't open your camera" must not be worded
   * or cleared as though both were gone.
   *
   * Written before the state change that re-runs the effect, and NOT cleared when a device is
   * off: being off is what a failure looks like from the outside, so clearing the explanation
   * then is exactly when it is needed. Only the presenter's own click clears it, because only
   * they can say the problem is worth another try.
   */
  const [cameraFailure, setCameraFailure] = useState<string | null>(null);
  const [micFailure, setMicFailure] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  /* The open tracks, for rendering. The refs below are the ones that are acted on: these
   * exist so the preview and the level meter re-render when a track arrives or goes, and
   * nothing that acquires a track reads them — which would make it re-run on its own
   * result. */
  const [previewTrack, setPreviewTrack] = useState<LocalVideoTrack | null>(null);
  const [micTrack, setMicTrack] = useState<LocalAudioTrack | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const videoTrack = useRef<LocalVideoTrack | null>(null);
  const audioTrack = useRef<LocalAudioTrack | null>(null);
  /** Set once the tracks belong to the room, so unmount stops releasing them. */
  const handedOff = useRef(false);

  /* What the presenter has ASKED for, which is not the same as what is running.
   *
   * The two diverge when a device will not open: the toggle goes off, because this screen has
   * to tell the truth about what is about to be published. Writing THAT back as a preference
   * is the bug this ref exists to prevent. A camera that was busy in another tab once is not
   * a decision to present without a camera from then on, and nothing would ever tell the
   * presenter it had been read as one — the next webinar simply starts dark and silent, with
   * no error to explain it, because the failure being remembered happened days ago.
   *
   * A deliberate toggle does still persist, which is the point of having the preference: it
   * is the difference between a choice and an accident that only this file can tell apart.
   */
  const wanted = useRef({ mic: prefs.micEnabled, camera: prefs.cameraEnabled });

  const toggleMic = useCallback(() => {
    const next = !micEnabled;
    wanted.current.mic = next;
    // Their click is the one thing that clears a failure: it is a request to try again,
    // and a stale reason next to a button somebody just pressed reads as the press failing.
    setMicFailure(null);
    setMicEnabled(next);
  }, [micEnabled]);

  const toggleCamera = useCallback(() => {
    const next = !cameraEnabled;
    wanted.current.camera = next;
    setCameraFailure(null);
    setCameraEnabled(next);
  }, [cameraEnabled]);

  /* Applied to the preview track so the presenter sees both in real time — which for the
   * low-light lift is the whole point of having it here: the right amount is whatever
   * looks right in this room today, and this is the screen where they can still judge it
   * without an audience watching them decide. */
  /* The processor's own error, which used to be dropped on the floor here.
   *
   * useVirtualBackground has always returned one and neither caller read it. That is how a
   * brightness lift that fails to start becomes an unexplained black preview: the camera is
   * open, the toggle says on, the light is lit, and the only thing on screen that could
   * explain the dark square is a slider nobody would connect to it. The hook now puts the
   * raw camera back when this happens; this makes it say so as well. Most failures are said
   * under the background tiles, next to a button to try again; see BackgroundTiles.
   */
  const { error: enhanceError, retryable: enhanceRetryable } = useVirtualBackground(
    previewTrack ?? undefined,
    prefs.background,
    prefs.lowLight,
    () => {
      if (prefs.background.mode !== "none") {
        onUpdatePrefs({ background: { mode: "none" } });
        return;
      }
      onUpdatePrefs({ lowLight: 0 });
    },
  );

  /* Enumerate from the start, rather than only after something has been opened.
   *
   * Labels are blank until the page holds a permission, which is why this used to wait — but
   * a browser that has been granted this origin before reports them anyway, and deviceLabel
   * already falls back to "Camera 1" for the ones it cannot name. Waiting cost more than it
   * saved: a presenter arriving with their camera switched off got two pickers containing
   * nothing but "System default", so the one screen that exists for choosing a device could
   * not be used to choose one. Acquiring a permission later fires devicechange, and
   * useDevices re-reads on it, so the real labels still arrive.
   */
  const [permitted, setPermitted] = useState(false);
  const { devices, refresh: refreshDevices } = useDevices(true);
  const backgroundsOk = useBackgroundsAvailable();

  /* Whether this machine really has no camera — a claim, so it needs to be supportable.
   *
   * It used to be the length of the list above, which was empty for two quite different
   * reasons and only one of them was "there is no camera". A presenter who arrived with their
   * camera off was told their machine had none, which is worse than silence: it is a reason
   * not to turn it on. A browser with no permission for this origin also reports cameras
   * without a deviceId, which useDevices filters out, so an empty list on its own still
   * cannot carry the claim. Having opened SOMETHING is what makes the enumeration complete
   * enough to trust, and `permitted` is that.
   *
   * And a camera that is open and showing in the preview is proof on its own. The list is
   * read again once something opens (see startVideo), but a browser that answers that read
   * before it has caught up with the new permission used to leave "No camera detected"
   * under the presenter's own face.
   */
  const noCamera = permitted && devices.videoInput.length === 0 && !previewTrack;

  /* The background to open the camera with. A ref, read when the camera opens, because
   * changing the background is a call on the processor already running and must not
   * reopen the camera — which it would as a dependency of startVideo. */
  const look = useRef({ background: prefs.background, lowLight: prefs.lowLight });
  useEffect(() => {
    look.current = { background: prefs.background, lowLight: prefs.lowLight };
  }, [prefs.background, prefs.lowLight]);

  const stopVideo = useCallback(() => {
    videoTrack.current?.stop();
    videoTrack.current = null;
    setPreviewTrack(null);
  }, []);

  const stopAudio = useCallback(() => {
    audioTrack.current?.stop();
    audioTrack.current = null;
    setMicTrack(null);
  }, []);

  /** Opens the camera and attaches it to the preview.
   *
   *  One resolution, the same one the room publishes at — there is nothing to choose here
   *  any more, because what actually goes out is decided by the measured uplink rather than
   *  by a dropdown. See cameraCapturePreset in lib/media.ts.
   *
   *  `stale` is whether the caller has moved on while the camera was opening — another
   *  device chosen, or the camera turned off. Opening takes long enough for that to happen,
   *  and a track that arrived for a request nobody is waiting on would be a second live
   *  camera that nothing on screen shows and nothing will stop.
   *
   *  Opened with the background already on it, so the preview's first frame is not the
   *  room; see openCamera. */
  const startVideo = useCallback(
    async (stale: () => boolean) => {
      stopVideo();
      const { background, lowLight } = look.current;
      const track = await openCamera(background, lowLight, (processor) =>
        createLocalVideoTrack({
          deviceId: prefs.videoInput,
          resolution: cameraCapturePreset().resolution,
          processor,
        }),
      );
      if (stale()) {
        track.stop();
        return;
      }
      videoTrack.current = track;
      setPreviewTrack(track);
      if (videoRef.current) track.attach(videoRef.current);
      setPermitted(true);
      /* The labels and ids arrive with the permission, and not every browser says so with
       * a devicechange — Chrome often does not. Without this the camera picker went on
       * offering only "System default", beside a preview of the camera it could not name. */
      void refreshDevices();
    },
    [prefs.videoInput, stopVideo, refreshDevices],
  );

  /** Opens the microphone, for the level meter and to hand to the room. */
  const startAudio = useCallback(
    async (stale: () => boolean) => {
      stopAudio();
      const track = await createLocalAudioTrack({
        deviceId: prefs.audioInput,
        echoCancellation: true,
        // Off here too — see lib/media.ts's roomOptions for why. This track is
        // handed straight to the room on join (see join() below) and becomes the
        // published one, so it has to make the same choice roomOptions makes for
        // any track the room captures itself later.
        noiseSuppression: false,
      });
      if (stale()) {
        track.stop();
        return;
      }
      audioTrack.current = track;
      setMicTrack(track);
      setPermitted(true);
      void refreshDevices();
    },
    [prefs.audioInput, stopAudio, refreshDevices],
  );

  /* Acquire whatever is switched on — the camera and the microphone each in an effect of
   * its own, because they are independent devices and one effect for both made them
   * anything but.
   *
   * A blocked camera used to abort before the mic opened, which looked like "mic blocked"
   * even when only the camera was denied for this origin. And muting the microphone, or
   * choosing another one, re-ran the camera half as well: a new camera track, so the
   * background was attached from scratch and the preview showed the room while it loaded.
   * That was a large part of the flicker on this screen.
   */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!cameraEnabled) {
        stopVideo();
        setStarting(false);
        return;
      }
      setStarting(true);
      try {
        await startVideo(() => cancelled);
        // Cleared on success only. A device that opens has nothing left to explain.
        if (!cancelled) setCameraFailure(null);
      } catch (err) {
        if (!cancelled) {
          stopVideo();
          /* The message first, the toggle second, and the order is the whole fix.
           *
           * setCameraEnabled(false) re-runs this effect, whose cleanup sets `cancelled`
           * — so anything written after it was written by a run that had already been
           * told to stop, behind an `if (!cancelled)` that was false by then. That is
           * how the reason for a failure used to be lost between the failure and the
           * screen. */
          setCameraFailure(describeMediaError(err, "camera"));
          setCameraEnabled(false);
        }
      }
      if (!cancelled) setStarting(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [cameraEnabled, startVideo, stopVideo]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!micEnabled) {
        stopAudio();
        return;
      }
      try {
        await startAudio(() => cancelled);
        if (!cancelled) setMicFailure(null);
      } catch (err) {
        if (!cancelled) {
          stopAudio();
          // Message first, toggle second, for the reason given in the camera effect.
          setMicFailure(describeMediaError(err, "microphone"));
          setMicEnabled(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [micEnabled, startAudio, stopAudio]);

  // Release the preview on unmount — unless it was handed to the room, which owns
  // it from that point. Without the guard the camera light would go out a moment
  // after joining and the host would publish a dead track.
  useEffect(() => {
    return () => {
      if (handedOff.current) return;
      stopVideo();
      stopAudio();
    };
  }, [stopVideo, stopAudio]);

  function join() {
    // The previous version stopped both tracks here so the room could open its
    // own, because two tracks on one camera fails on some platforms. Handing them
    // over solves that the other way round: there is still only ever one track per
    // device, and the room does not pay to open it again.
    const audio = micEnabled ? audioTrack.current : null;
    const video = cameraEnabled ? videoTrack.current : null;

    // Anything the room is not taking is still ours to release.
    if (!audio) stopAudio();
    if (!video) stopVideo();

    // Drop our references before the unmount cleanup runs, or it would stop the
    // tracks we just gave away and the room would publish nothing.
    handedOff.current = true;
    audioTrack.current = null;
    videoTrack.current = null;
    setPreviewTrack(null);
    setMicTrack(null);

    // What was asked for is persisted; what is actually running is what gets published. See
    // `wanted` for why those cannot be the same value.
    onUpdatePrefs({
      micEnabled: wanted.current.mic,
      cameraEnabled: wanted.current.camera,
    });
    onJoin({ micEnabled, cameraEnabled, audioTrack: audio, videoTrack: video });
  }

  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-4xl place-items-center p-4 sm:p-6">
      <div className="w-full">
        <div className="mb-5 text-center">
          <h1 className="text-[19px] leading-snug font-semibold tracking-[-0.01em] text-ink sm:text-[22px]">
            {topic}
          </h1>
          <p className="mt-1.5 text-[13px] text-ink-2">
            Joining as <strong className="font-medium text-ink">{displayName}</strong> ·{" "}
            {role}
          </p>
        </div>

        {/* minmax(0, …) rather than bare fr, and min-w-0 on both columns. A bare fr track is
            never narrower than its widest unbreakable content, and one long error once made the
            right-hand column the whole page and the preview a thumbnail beside it. */}
        <div className="grid gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          {/* ---- preview ---- */}
          <div className="min-w-0">
            <div className="relative aspect-video overflow-hidden rounded-xl bg-stage-tile">
              {/* muted is required for autoplay; playsInline stops iOS opening it
                  full-screen the moment it starts. */}
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className={`size-full object-cover ${cameraEnabled ? "" : "hidden"}`}
              />
              {!cameraEnabled && (
                <div className="grid size-full place-items-center text-center">
                  <div>
                    <CameraOffIcon className="mx-auto size-7 text-white/40" />
                    <p className="mt-2 text-[12.5px] text-white/60">Camera is off</p>
                  </div>
                </div>
              )}
              {starting && cameraEnabled && (
                <div className="absolute inset-0 grid place-items-center bg-stage-tile/70">
                  <Spinner className="size-5 text-white/70" />
                </div>
              )}

              <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-gradient-to-t from-black/60 to-transparent p-2.5">
                <PreJoinToggle
                  on={micEnabled}
                  onClick={toggleMic}
                  label={micEnabled ? "Mute microphone" : "Unmute microphone"}
                  onIcon={<MicIcon className="size-4" />}
                  offIcon={<MicOffIcon className="size-4" />}
                />
                <PreJoinToggle
                  on={cameraEnabled}
                  onClick={toggleCamera}
                  label={cameraEnabled ? "Turn camera off" : "Turn camera on"}
                  onIcon={<CameraIcon className="size-4" />}
                  offIcon={<CameraOffIcon className="size-4" />}
                />
              </div>
            </div>

            {micEnabled && <MicMeter track={micTrack} />}
          </div>

          {/* ---- devices & background ---- */}
          <div className="min-w-0 space-y-3.5">
            {/* One per thing that went wrong, rather than one joined string. A presenter
                reading "couldn't open your camera" while their microphone works needs to
                see which sentence applies to which button. */}
            {cameraFailure && <Alert tone="warn">{cameraFailure}</Alert>}
            {micFailure && <Alert tone="warn">{micFailure}</Alert>}
            {/* Only a browser that cannot run backgrounds at all, which has no tiles to say
                it under — everything else is said beneath them with a Retry. Not for the
                lift on its own, whose control says the same thing in its own place. */}
            {enhanceError && !enhanceRetryable && prefs.background.mode !== "none" && (
              <Alert tone="warn">{enhanceError}</Alert>
            )}

            <Select
              label="Camera"
              value={prefs.videoInput ?? ""}
              onChange={(id) => onUpdatePrefs({ videoInput: id || undefined })}
            >
              <option value="">System default</option>
              {devices.videoInput.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {deviceLabel(d, i, "Camera")}
                </option>
              ))}
            </Select>

            <Select
              label="Microphone"
              value={prefs.audioInput ?? ""}
              onChange={(id) => onUpdatePrefs({ audioInput: id || undefined })}
            >
              <option value="">System default</option>
              {devices.audioInput.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {deviceLabel(d, i, "Microphone")}
                </option>
              ))}
            </Select>

            {/* Virtual Background Selection before joining */}
            {backgroundsOk && (
              <BackgroundTiles
                heading="Virtual background"
                choice={prefs.background}
                disabledReason={cameraEnabled ? undefined : "Camera is off"}
                onSelect={(bg) => onUpdatePrefs({ background: bg })}
              />
            )}

            {/* Under the backgrounds, and on this screen rather than only in Settings,
                because this is the one moment a presenter is looking at their own face on
                purpose. Finding out you were in shadow belongs here, next to the preview
                that shows it, not two clicks deep once an audience is already watching. */}
            <LowLightControl
              value={prefs.lowLight}
              disabled={!cameraEnabled}
              onChange={(lowLight) => onUpdatePrefs({ lowLight })}
              hint={
                cameraEnabled
                  ? "Too dark? This lifts the shadows on you without blowing out the light behind you."
                  : "Start your camera to see the change. Your choice is saved either way."
              }
            />

            <Button onClick={join} size="lg" className="w-full">
              Join the webinar
            </Button>
            <p className="text-center text-[11.5px] leading-relaxed text-ink-3">
              {noCamera && !starting
                ? "No camera detected — you can still present with your screen."
                : "You can change any of this once you're in."}
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

/* A real level meter, from the shared measurement in lib/mic-level.ts.
 *
 * The AnalyserNode used to be inline here, and then the control bar needed the same thing —
 * two copies of the same waveform maths is one of them quietly drifting. The measuring moved
 * out; this screen keeps its own state because it needs the NUMBER, for the bar's width and
 * for aria-valuenow.
 *
 * In a component of its own so that the number is the only thing that re-renders. It moves
 * sixty times a second while somebody talks, and held in PreJoin that was the whole screen
 * sixty times a second — the device lists, the background tiles, the background hook —
 * which is how a check that made a graphics context on every render once managed to make
 * the browser throw away the one the background was starting up in.
 *
 * Still the only way to tell a working microphone from one that is muted in hardware: a
 * device that opens successfully and delivers pure silence looks identical to a good one
 * until somebody tells you they cannot hear you.
 */
function MicMeter({ track }: { track: LocalAudioTrack | null }) {
  const [level, setLevel] = useState(0);
  /* Sticky hearing state with hysteresis. A single 0.04 threshold flipped the label on every
   * breath near the noise floor ("Hearing you" / "Say something"), which presenters read as
   * the pre-join screen thrashing alongside the background flicker. Enter high, leave low. */
  const [hearing, setHearing] = useState(false);

  useEffect(() => {
    if (!track) {
      setHearing(false);
      return;
    }
    return measureMicLevel(track.mediaStreamTrack, (next) => {
      setLevel(next);
      setHearing((was) => (was ? next > 0.02 : next > 0.06));
    });
  }, [track]);

  /* Zero while there is no track, DERIVED rather than stored.
   *
   * The obvious version calls setLevel(0) in the effect when the track goes, and that is a
   * synchronous setState inside an effect — a cascading render, and React's lint rule is right
   * to refuse it. Deriving costs nothing and cannot go stale: there is no path where the mic is
   * off and a leftover level is still on screen. */
  const shown = track ? level : 0;

  return (
    <div className="mt-2 flex items-center gap-2">
      <MicIcon className="size-3.5 shrink-0 text-ink-3" />
      <div
        className="h-1 flex-1 overflow-hidden rounded-full bg-line"
        role="meter"
        aria-label="Microphone activity"
        aria-valuenow={Math.round(shown * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-ok transition-[width] duration-150"
          style={{ width: `${Math.max(4, shown * 100)}%` }}
        />
      </div>
      <span className="shrink-0 text-[11px] text-ink-3">
        {!track ? "Starting…" : hearing ? "Hearing you" : "Say something"}
      </span>
    </div>
  );
}

function PreJoinToggle({
  on,
  onClick,
  label,
  onIcon,
  offIcon,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  onIcon: React.ReactNode;
  offIcon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      title={label}
      className={`grid size-9 place-items-center rounded-full backdrop-blur transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
        on ? "bg-white/20 text-white hover:bg-white/30" : "bg-live text-white hover:bg-live/90"
      }`}
    >
      {on ? onIcon : offIcon}
    </button>
  );
}
