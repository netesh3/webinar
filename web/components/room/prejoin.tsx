"use client";

import {
  createLocalAudioTrack,
  createLocalVideoTrack,
  type LocalAudioTrack,
  type LocalVideoTrack,
} from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CAPTURE, deviceLabel, useDevices, type MediaPreferences } from "@/lib/media";
import { measureMicLevel } from "@/lib/mic-level";
import { Alert, Select, Spinner } from "../controls";
import { Button } from "../ui";
import {
  CameraIcon,
  CameraOffIcon,
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

  const videoRef = useRef<HTMLVideoElement>(null);
  const videoTrack = useRef<LocalVideoTrack | null>(null);
  const audioTrack = useRef<LocalAudioTrack | null>(null);
  /** Set once the tracks belong to the room, so unmount stops releasing them. */
  const handedOff = useRef(false);

  // Device labels stay blank until the page holds a permission, so enumeration is
  // deliberately gated on having acquired a preview track first.
  const [permitted, setPermitted] = useState(false);
  const { devices } = useDevices(permitted);

  const stopVideo = useCallback(() => {
    videoTrack.current?.stop();
    videoTrack.current = null;
  }, []);

  const stopAudio = useCallback(() => {
    audioTrack.current?.stop();
    audioTrack.current = null;
  }, []);

  /** Opens the camera and attaches it to the preview.
   *
   *  One resolution, the same one the room publishes at — there is nothing to choose here
   *  any more, because what actually goes out is decided by the measured uplink rather than
   *  by a dropdown. See CAPTURE in lib/media.ts. */
  const startVideo = useCallback(async () => {
    stopVideo();
    const track = await createLocalVideoTrack({
      deviceId: prefs.videoInput,
      resolution: CAPTURE.resolution,
    });
    videoTrack.current = track;
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
      noiseSuppression: prefs.noiseSuppression,
    });
    audioTrack.current = track;
    setPermitted(true);
    setMicGeneration((n) => n + 1);
  }, [prefs.audioInput, prefs.noiseSuppression, stopAudio]);

  // Acquire whatever is switched on. Runs again when a device or the resolution
  // changes, because capture constraints are fixed when a track is created.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setStarting(true);
      setError(null);
      try {
        if (cameraEnabled) await startVideo();
        else stopVideo();
        if (micEnabled) await startAudio();
        else stopAudio();
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "";
        setError(
          /permission|denied|NotAllowed/i.test(message)
            ? "Your browser blocked the camera or microphone. Allow them for this site, then reload."
            : /NotFound|DevicesNotFound/i.test(message)
              ? "No camera or microphone was found. You can still join and present with your screen."
              : `Couldn't open your devices. ${message}`,
        );
      } finally {
        if (!cancelled) setStarting(false);
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

          {/* ---- devices ---- */}
          <div className="space-y-3">
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

            {/* Nothing here about arriving with camera or microphone on.
                A "Send video at" resolution picker used to sit in this spot; it was replaced
                by a pair of Join-with-video / Join-with-audio toggles, and those were then
                removed too, because the preview already carries exactly those two controls
                as buttons on the image. Two places to set one thing is worse than either
                place alone — the mic and camera buttons over the preview are the ones people
                reach for, since that is where they can see the effect. */}

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
