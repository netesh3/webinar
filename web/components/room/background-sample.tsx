"use client";

import { createLocalVideoTrack, type LocalVideoTrack } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  openCamera,
  useAutoLowLight,
  useVirtualBackground,
  type BackgroundChoice,
} from "@/lib/backgrounds";
import { cameraCapturePreset } from "@/lib/media";
import { describeMediaError } from "@/lib/media-errors";
import { Alert, Spinner } from "../controls";
import { CameraOffIcon } from "../icons";
import { BackgroundTiles } from "./background-picker";
import { LowLightControl } from "./low-light";

/* Local look at the virtual background on a live camera.
 *
 * The same openCamera / useVirtualBackground path the pre-join screen uses, without
 * a room, a microphone, or a join button. The choice stays on this page so it does
 * not overwrite the background remembered for a real webinar.
 */

export function BackgroundSample() {
  const [choice, setChoice] = useState<BackgroundChoice>({ mode: "blur" });
  const [lowLight, setLowLight] = useState(0);
  const [lowLightAuto, setLowLightAuto] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<LocalVideoTrack | null>(null);
  const [track, setTrack] = useState<LocalVideoTrack | undefined>();
  const [failure, setFailure] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);

  useAutoLowLight(lowLightAuto);
  useVirtualBackground(track, choice, lowLight, "enhanced");

  const stop = useCallback(() => {
    trackRef.current?.stop();
    trackRef.current = null;
    setTrack(undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setStarting(true);
      try {
        const opened = await openCamera(
          { mode: "blur" },
          0,
          (processor) =>
            createLocalVideoTrack({
              resolution: cameraCapturePreset().resolution,
              processor,
            }),
          "enhanced",
        );
        if (cancelled) {
          opened.stop();
          return;
        }
        trackRef.current = opened;
        setTrack(opened);
        if (videoRef.current) opened.attach(videoRef.current);
        setFailure(null);
      } catch (err) {
        if (!cancelled) setFailure(describeMediaError(err, "camera"));
      } finally {
        if (!cancelled) setStarting(false);
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, [stop]);

  useEffect(() => {
    const el = videoRef.current;
    if (!track || !el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-4xl place-items-center p-4 sm:p-6">
      <div className="w-full">
        <div className="mb-5 text-center">
          <h1 className="text-[19px] leading-snug font-semibold tracking-[-0.01em] text-ink sm:text-[22px]">
            Virtual background
          </h1>
          <p className="mt-1.5 text-[13px] text-ink-2">
            Your camera, with the same blur and stills used before joining a webinar.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <div className="relative aspect-video overflow-hidden rounded-xl bg-stage-tile">
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className={`size-full object-cover ${track ? "" : "hidden"}`}
              />
              {!track && !starting && (
                <div className="grid size-full place-items-center text-center">
                  <div>
                    <CameraOffIcon className="mx-auto size-7 text-white/40" />
                    <p className="mt-2 text-[12.5px] text-white/60">Camera is off</p>
                  </div>
                </div>
              )}
              {starting && (
                <div className="absolute inset-0 grid place-items-center bg-stage-tile/70">
                  <Spinner className="size-5 text-white/70" />
                </div>
              )}
            </div>
          </div>

          <div className="min-w-0 space-y-3.5">
            {failure && <Alert tone="warn">{failure}</Alert>}
            <BackgroundTiles
              heading="Virtual background"
              choice={choice}
              disabledReason={track ? undefined : "Camera is off"}
              onSelect={setChoice}
            />
            <LowLightControl
              value={lowLight}
              auto={lowLightAuto}
              disabled={!track}
              onAutoChange={setLowLightAuto}
              onChange={setLowLight}
              hint={track ? undefined : "Start the camera to see the change."}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
