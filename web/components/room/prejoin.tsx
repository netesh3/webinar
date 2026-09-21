"use client";

import {
  createLocalAudioTrack,
  createLocalVideoTrack,
  type LocalAudioTrack,
  type LocalVideoTrack,
} from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  backgroundsSupported,
  useVirtualBackground,
  VIRTUAL_BACKGROUNDS,
  type BackgroundChoice,
} from "@/lib/backgrounds";
import { cameraCapturePreset, deviceLabel, useDevices, type MediaPreferences } from "@/lib/media";
import { describeMediaError } from "@/lib/media-errors";
import { measureMicLevel } from "@/lib/mic-level";
import { Alert, Select, Spinner } from "../controls";
import { LowLightControl } from "./low-light";
import { Button } from "../ui";
import {
  CameraIcon,
  CameraOffIcon,
  CheckIcon,
  MicIcon,
  MicOffIcon,
} from "../icons";

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
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [level, setLevel] = useState(0);
  const [previewTrack, setPreviewTrack] = useState<LocalVideoTrack | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const videoTrack = useRef<LocalVideoTrack | null>(null);
  const audioTrack = useRef<LocalAudioTrack | null>(null);
  /** Set once the tracks belong to the room, so unmount stops releasing them. */
  const handedOff = useRef(false);

  /* Applied to the preview track so the presenter sees both in real time — which for the
   * low-light lift is the whole point of having it here: the right amount is whatever
   * looks right in this room today, and this is the screen where they can still judge it
   * without an audience watching them decide. */
  useVirtualBackground(previewTrack ?? undefined, prefs.background, prefs.lowLight, () => {
    if (prefs.background.mode !== "none") {
      onUpdatePrefs({ background: { mode: "none" } });
      return;
    }
    onUpdatePrefs({ lowLight: 0 });
  });

  // Device labels stay blank until the page holds a permission, so enumeration is
  // deliberately gated on having acquired a preview track first.
  const [permitted, setPermitted] = useState(false);
  const { devices } = useDevices(permitted);

  const stopVideo = useCallback(() => {
    videoTrack.current?.stop();
    videoTrack.current = null;
    setPreviewTrack(null);
  }, []);

  const stopAudio = useCallback(() => {
    audioTrack.current?.stop();
    audioTrack.current = null;
  }, []);

  /** Opens the camera and attaches it to the preview.
   *
   *  One resolution, the same one the room publishes at — there is nothing to choose here
   *  any more, because what actually goes out is decided by the measured uplink rather than
   *  by a dropdown. See cameraCapturePreset in lib/media.ts. */
  const startVideo = useCallback(async () => {
    stopVideo();
    const track = await createLocalVideoTrack({
      deviceId: prefs.videoInput,
      resolution: cameraCapturePreset().resolution,
    });
    videoTrack.current = track;
    setPreviewTrack(track);
    if (videoRef.current) track.attach(videoRef.current);
    setPermitted(true);
  }, [prefs.videoInput, stopVideo]);

  // Bumped whenever a new audio track is acquired, so the level meter's effect
  // re-runs. The track itself lives in a ref: putting it in state would retrigger
  // the acquisition effect that created it.
  const [micGeneration, setMicGeneration] = useState(0);

  const startAudio = useCallback(async () => {
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
    audioTrack.current = track;
    setPermitted(true);
    setMicGeneration((n) => n + 1);
  }, [prefs.audioInput, stopAudio]);

  // Acquire whatever is switched on. Camera and mic are independent — a blocked
  // camera used to abort before the mic opened, which looked like "mic blocked"
  // even when only the camera was denied for this origin.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setStarting(true);
      setError(null);
      const failures: string[] = [];

      if (!cameraEnabled) stopVideo();
      else {
        try {
          await startVideo();
        } catch (err) {
          if (!cancelled) {
            stopVideo();
            setCameraEnabled(false);
            failures.push(describeMediaError(err, "camera"));
          }
        }
      }

      if (!micEnabled) stopAudio();
      else {
        try {
          await startAudio();
        } catch (err) {
          if (!cancelled) {
            stopAudio();
            setMicEnabled(false);
            failures.push(describeMediaError(err, "microphone"));
          }
        }
      }

      if (!cancelled) {
        setError(failures.length > 0 ? failures.join(" ") : null);
        setStarting(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cameraEnabled, micEnabled, startVideo, startAudio, stopVideo, stopAudio]);

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

  /* A real level meter, from the shared measurement in lib/mic-level.ts.
   *
   * The AnalyserNode used to be inline here, and then the control bar needed the same thing —
   * two copies of the same waveform maths is one of them quietly drifting. The measuring moved
   * out; this screen keeps its own state because it needs the NUMBER, for the bar's width and
   * for aria-valuenow, and because nothing else is rendering on a pre-join screen.
   *
   * Still the only way to tell a working microphone from one that is muted in hardware: a
   * device that opens successfully and delivers pure silence looks identical to a good one
   * until somebody tells you they cannot hear you.
   */
  useEffect(() => {
    if (!micEnabled) return;
    return measureMicLevel(audioTrack.current?.mediaStreamTrack, setLevel);
  }, [micEnabled, micGeneration]);

  /* Zero when the microphone is off, DERIVED rather than stored.
   *
   * The obvious version calls setLevel(0) in the effect when the mic is disabled, and that is a
   * synchronous setState inside an effect — a cascading render, and React's lint rule is right
   * to refuse it. Deriving costs nothing and cannot go stale: there is no path where the mic is
   * off and a leftover level is still on screen. */
  const shownLevel = micEnabled ? level : 0;

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

    onUpdatePrefs({ micEnabled, cameraEnabled });
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

        <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
          {/* ---- preview ---- */}
          <div>
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
                  onClick={() => setMicEnabled((v) => !v)}
                  label={micEnabled ? "Mute microphone" : "Unmute microphone"}
                  onIcon={<MicIcon className="size-4" />}
                  offIcon={<MicOffIcon className="size-4" />}
                />
                <PreJoinToggle
                  on={cameraEnabled}
                  onClick={() => setCameraEnabled((v) => !v)}
                  label={cameraEnabled ? "Turn camera off" : "Turn camera on"}
                  onIcon={<CameraIcon className="size-4" />}
                  offIcon={<CameraOffIcon className="size-4" />}
                />
              </div>
            </div>

            {micEnabled && (
              <div className="mt-2 flex items-center gap-2">
                <MicIcon className="size-3.5 shrink-0 text-ink-3" />
                <div
                  className="h-1 flex-1 overflow-hidden rounded-full bg-line"
                  role="meter"
                  aria-label="Microphone activity"
                  aria-valuenow={Math.round(shownLevel * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="h-full rounded-full bg-ok transition-[width] duration-150"
                    style={{ width: `${Math.max(4, shownLevel * 100)}%` }}
                  />
                </div>
                <span className="shrink-0 text-[11px] text-ink-3">
                  {micGeneration === 0
                    ? "Starting…"
                    : shownLevel > 0.04
                      ? "Hearing you"
                      : "Say something"}
                </span>
              </div>
            )}
          </div>

          {/* ---- devices & background ---- */}
          <div className="space-y-3.5">
            {error && <Alert tone="warn">{error}</Alert>}

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
            <PreJoinBackgroundPicker
              choice={prefs.background}
              disabled={!cameraEnabled}
              onSelect={(bg) => onUpdatePrefs({ background: bg })}
            />

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
              {devices.videoInput.length === 0 && !starting
                ? "No camera detected — you can still present with your screen."
                : "You can change any of this once you're in."}
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

function PreJoinBackgroundPicker({
  choice,
  onSelect,
  disabled,
}: {
  choice: BackgroundChoice;
  onSelect: (next: BackgroundChoice) => void;
  disabled?: boolean;
}) {
  const supported = backgroundsSupported();
  if (!supported) return null;

  const isActive = (next: BackgroundChoice) =>
    choice.mode === next.mode &&
    ("id" in choice ? "id" in next && choice.id === next.id : true);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="block text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
          Virtual Background
        </label>
        {disabled && (
          <span className="text-[11px] text-ink-3">Camera is off</span>
        )}
      </div>

      <div className={`grid grid-cols-4 gap-1.5 ${disabled ? "opacity-50 pointer-events-none" : ""}`}>
        <PreJoinBgTile
          label="Off"
          active={isActive({ mode: "none" })}
          onClick={() => onSelect({ mode: "none" })}
        >
          <span className="grid size-full place-items-center bg-surface-2 text-ink-3">
            <CameraOffIcon className="size-3.5" />
          </span>
        </PreJoinBgTile>

        <PreJoinBgTile
          label="Blur"
          active={isActive({ mode: "blur" })}
          onClick={() => onSelect({ mode: "blur" })}
        >
          <span className="relative grid size-full place-items-center overflow-hidden bg-stage-tile">
            <span className="absolute inset-0 bg-gradient-to-br from-white/25 via-white/5 to-transparent blur-[4px]" />
            <span className="absolute right-1 bottom-0 size-3.5 rounded-full bg-white/30 blur-[4px]" />
            <span className="relative size-3 rounded-full bg-white/80" />
          </span>
        </PreJoinBgTile>

        {VIRTUAL_BACKGROUNDS.map((bg) => (
          <PreJoinBgTile
            key={bg.id}
            label={bg.label}
            active={isActive({ mode: "image", id: bg.id })}
            onClick={() => onSelect({ mode: "image", id: bg.id })}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={bg.src}
              alt=""
              className="size-full object-cover"
              draggable={false}
            />
          </PreJoinBgTile>
        ))}
      </div>
    </div>
  );
}

function PreJoinBgTile({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`relative aspect-video overflow-hidden rounded-lg border-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 cursor-pointer ${
        active ? "border-brand" : "border-line/60 hover:border-line-2"
      }`}
    >
      {children}
      {active && (
        <span className="absolute inset-0 grid place-items-center bg-brand/25">
          <span className="grid size-4 place-items-center rounded-full bg-brand text-white">
            <CheckIcon className="size-2.5" />
          </span>
        </span>
      )}
    </button>
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
