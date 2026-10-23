"use client";

import {
  createLocalAudioTrack,
  createLocalVideoTrack,
  type LocalAudioTrack,
  type LocalVideoTrack,
} from "livekit-client";
import { useEffect, useRef, useState } from "react";
import { cameraCapturePreset, deviceLabel, useDevices, useMediaPreferences } from "@/lib/media";
import { describeMediaError } from "@/lib/media-errors";
import { saveGoLiveChoice, type GoLiveChoice } from "@/lib/simulive-golive";
import { Alert, Modal, Select } from "../controls";
import { CameraIcon, CameraOffIcon, MicIcon, MicOffIcon } from "../icons";
import { Button } from "../ui";
import { MicMeter } from "./prejoin";

/* "After the replay: go live with your camera" — the host team getting ready while the
 * recording plays (lib/simulive-golive.ts).
 *
 * Everything here is LOCAL. The preview's camera and microphone are opened in this browser
 * only and never handed to the room: the simulive grant could not publish them anyway
 * (lk.Spec.NoMedia), and the audience sees nothing but the recording until the live part.
 * What it keeps is the choice — camera on or off, mic on or off, and which devices (the
 * media preferences every room opens from) — for the live room to walk on with. Closing the
 * dialog stops both devices. */
export function SimuliveGoLiveSetup({
  slug,
  open,
  initial,
  onClose,
  onSaved,
}: {
  slug: string;
  open: boolean;
  initial: Pick<GoLiveChoice, "camera" | "mic"> | null;
  onClose: () => void;
  onSaved: (choice: Pick<GoLiveChoice, "camera" | "mic">) => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Go live with your camera after the replay"
      description="Check your camera and mic here. Only you can see this preview: nothing is sent to the audience while the replay plays."
      size="md"
      dark
    >
      {/* Mounted only while open, so the devices are held only while the dialog is. */}
      {open && <SetupBody slug={slug} initial={initial} onClose={onClose} onSaved={onSaved} />}
    </Modal>
  );
}

function SetupBody({
  slug,
  initial,
  onClose,
  onSaved,
}: {
  slug: string;
  initial: Pick<GoLiveChoice, "camera" | "mic"> | null;
  onClose: () => void;
  onSaved: (choice: Pick<GoLiveChoice, "camera" | "mic">) => void;
}) {
  const { prefs, update } = useMediaPreferences();
  const { devices, refresh } = useDevices(true);
  // Camera on is the point of this dialog; the mic starts off unless they chose it before.
  const [camera, setCamera] = useState(initial?.camera ?? true);
  const [mic, setMic] = useState(initial?.mic ?? false);
  const [videoTrack, setVideoTrack] = useState<LocalVideoTrack | null>(null);
  const [audioTrack, setAudioTrack] = useState<LocalAudioTrack | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // The preview camera: opened for the chosen device while the toggle is on, stopped otherwise.
  useEffect(() => {
    if (!camera) return;
    let stale = false;
    let opened: LocalVideoTrack | null = null;
    createLocalVideoTrack({ deviceId: prefs.videoInput, resolution: cameraCapturePreset().resolution })
      .then((track) => {
        if (stale) {
          track.stop();
          return;
        }
        opened = track;
        setCameraError(null);
        setVideoTrack(track);
        void refresh();
      })
      .catch((err: unknown) => {
        if (!stale) setCameraError(describeMediaError(err, "camera"));
      });
    return () => {
      stale = true;
      opened?.stop();
      setVideoTrack(null);
    };
  }, [camera, prefs.videoInput, refresh]);

  useEffect(() => {
    const el = videoRef.current;
    if (!videoTrack || !el) return;
    videoTrack.attach(el);
    return () => {
      videoTrack.detach(el);
    };
  }, [videoTrack]);

  // The preview microphone, for the level meter only.
  useEffect(() => {
    if (!mic) return;
    let stale = false;
    let opened: LocalAudioTrack | null = null;
    createLocalAudioTrack({ deviceId: prefs.audioInput, echoCancellation: true, noiseSuppression: false })
      .then((track) => {
        if (stale) {
          track.stop();
          return;
        }
        opened = track;
        setMicError(null);
        setAudioTrack(track);
        void refresh();
      })
      .catch((err: unknown) => {
        if (!stale) setMicError(describeMediaError(err, "microphone"));
      });
    return () => {
      stale = true;
      opened?.stop();
      setAudioTrack(null);
    };
  }, [mic, prefs.audioInput, refresh]);

  const save = () => {
    const choice = { camera, mic };
    saveGoLiveChoice(slug, choice);
    // The live room opens its devices from these, the same as every room.
    update({ cameraEnabled: camera, micEnabled: mic });
    onSaved(choice);
    onClose();
  };

  const toggle =
    "grid size-10 place-items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/60";

  return (
    <div className="space-y-3">
      <div className="relative aspect-video overflow-hidden rounded-xl bg-black">
        {camera && videoTrack ? (
          <video ref={videoRef} muted playsInline className="size-full -scale-x-100 object-cover" />
        ) : (
          <div className="grid size-full place-items-center text-[13px] text-white/60">
            {camera ? "Starting camera…" : "Camera off"}
          </div>
        )}
        <span className="absolute top-2 left-2 rounded-md bg-black/60 px-2 py-0.5 text-[11px] font-medium text-white">
          Preview · not sent
        </span>
        <div className="absolute inset-x-0 bottom-2 flex justify-center gap-2">
          <button
            type="button"
            aria-pressed={mic}
            aria-label={mic ? "Go live with mic off" : "Go live with mic on"}
            title={mic ? "Mic on when you go live" : "Mic off when you go live"}
            onClick={() => setMic((v) => !v)}
            className={`${toggle} ${mic ? "bg-white/20 text-white hover:bg-white/30" : "bg-live text-white hover:bg-live/90"}`}
          >
            {mic ? <MicIcon className="size-4" /> : <MicOffIcon className="size-4" />}
          </button>
          <button
            type="button"
            aria-pressed={camera}
            aria-label={camera ? "Go live with camera off" : "Go live with camera on"}
            title={camera ? "Camera on when you go live" : "Camera off when you go live"}
            onClick={() => setCamera((v) => !v)}
            className={`${toggle} ${camera ? "bg-white/20 text-white hover:bg-white/30" : "bg-live text-white hover:bg-live/90"}`}
          >
            {camera ? <CameraIcon className="size-4" /> : <CameraOffIcon className="size-4" />}
          </button>
        </div>
      </div>

      {mic && <MicMeter track={audioTrack} />}
      {cameraError && <Alert tone="warn">{cameraError}</Alert>}
      {micError && <Alert tone="warn">{micError}</Alert>}

      <Select
        label="Camera"
        value={prefs.videoInput ?? ""}
        onChange={(id) => update({ videoInput: id || undefined })}
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
        onChange={(id) => update({ audioInput: id || undefined })}
      >
        <option value="">System default</option>
        {devices.audioInput.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {deviceLabel(d, i, "Microphone")}
          </option>
        ))}
      </Select>

      <p className="text-[12px] text-ink-3">
        The replay keeps playing. When it ends — or when you choose End replay early and go live —
        everyone moves to the live room and you come on as set here. Headphones stop the
        replay&apos;s sound reaching your mic while you check it.
      </p>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save}>Use these when I go live</Button>
      </div>
    </div>
  );
}
