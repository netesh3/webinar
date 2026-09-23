"use client";

import { Track, type LocalVideoTrack } from "livekit-client";
import { useLocalParticipant } from "@livekit/components-react";
import { useEffect } from "react";
import {
  backgroundsSupported,
  useVirtualBackground,
  VIRTUAL_BACKGROUNDS,
  type BackgroundChoice,
} from "@/lib/backgrounds";
import { Alert } from "../controls";
import { CheckIcon, CameraOffIcon } from "../icons";
import { useToast } from "../providers";
import { useRoomUI } from "./context";

/* Choosing a background, and applying it.
 *
 * Two separate jobs that live together because they share the choice:
 *
 *   VirtualBackground   applies the stored choice to whatever camera track is
 *                       currently published. Mounted for the whole session, renders
 *                       nothing, and re-applies when the track is replaced — stopping
 *                       and starting the camera republishes it, and without this the
 *                       background would come off along with it.
 *   BackgroundPicker    Off, Blur, and a row of stills.
 *
 * The picker writes to the same persisted preference the applier reads, so there is
 * one source of truth and no message to pass between them.
 */

/** The camera track this participant is publishing, if any. */
function useCameraTrack(): LocalVideoTrack | undefined {
  const { localParticipant } = useLocalParticipant();
  const publication = localParticipant.getTrackPublication(Track.Source.Camera);
  return publication?.track as LocalVideoTrack | undefined;
}

/** Applies the stored background. Renders nothing. */
export function VirtualBackground() {
  const { prefs, updatePrefs } = useRoomUI();
  const { notify } = useToast();
  const track = useCameraTrack();

  const { error } = useVirtualBackground(track, prefs.background, prefs.lowLight, () => {
    /* The device cannot keep up. Turned off rather than left stuttering: the person
     * whose laptop is struggling cannot see the stutter, and the audience can.
     *
     * The background goes first and alone, because it is what costs — segmentation is
     * the inference, the lift is four instructions on a pixel already in a register. A
     * machine that cannot sustain both can usually sustain the lift, so taking it away
     * too would be removing the cheap thing to fix the expensive one. Only when there
     * was no background to drop does the lift go instead. */
    if (prefs.background.mode !== "none") {
      updatePrefs({ background: { mode: "none" } });
      notify(
        "Your device can't keep up with the virtual background, so it's been turned off.",
        "info",
      );
      return;
    }
    updatePrefs({ lowLight: 0 });
    notify(
      "Your device can't keep up with the low-light adjustment, so it's been turned off.",
      "info",
    );
  });

  /* The same failure the pre-join screen shows, said out loud in the room.
   *
   * There is no panel to put a sentence in here, and the consequence is the one the
   * pre-join screen has with an audience added: the hook has just taken the processor back
   * off and handed the raw camera over, so without this the presenter's video would change
   * for no stated reason in the middle of a webinar. Once per distinct message — `notify` is
   * memoised, so this cannot become a toast storm.
   */
  useEffect(() => {
    if (error) notify(error, "error");
  }, [error, notify]);

  return null;
}

export function BackgroundPicker() {
  const { prefs, updatePrefs, permissions } = useRoomUI();
  const track = useCameraTrack();
  const choice = prefs.background;
  const supported = backgroundsSupported();

  const set = (next: BackgroundChoice) => updatePrefs({ background: next });
  const isActive = (next: BackgroundChoice) =>
    choice.mode === next.mode &&
    ("id" in choice ? "id" in next && choice.id === next.id : true);

  if (!permissions.canShareCamera) return null;

  return (
    <section>
      <h3 className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
        Background
      </h3>

      {!supported ? (
        <Alert tone="warn">
          This browser can&apos;t run virtual backgrounds. They need WebGL2 — Chrome,
          Edge, Firefox or Safari 17 and later.
        </Alert>
      ) : (
        <>
          {/* Applied to the published track, so it is only reachable once there is
              one. Said rather than left as a disabled grid with no explanation. */}
          {!track && (
            <p className="mb-2 text-[11.5px] leading-relaxed text-ink-3">
              Start your camera to see the change. Your choice is saved either way.
            </p>
          )}

          <div className="grid grid-cols-4 gap-1.5 sm:max-w-[22rem]">
            <Tile
              label="Off"
              active={isActive({ mode: "none" })}
              onClick={() => set({ mode: "none" })}
            >
              <span className="grid size-full place-items-center bg-surface-2 text-ink-3">
                <CameraOffIcon className="size-4" />
              </span>
            </Tile>

            <Tile
              label="Blur"
              active={isActive({ mode: "blur" })}
              onClick={() => set({ mode: "blur" })}
            >
              {/* A blurred sketch of a room rather than the word "blur": the tile is
                  showing what the option does. */}
              <span className="relative grid size-full place-items-center overflow-hidden bg-stage-tile">
                <span className="absolute inset-0 bg-gradient-to-br from-white/25 via-white/5 to-transparent blur-[6px]" />
                <span className="absolute right-1 bottom-0 size-4 rounded-full bg-white/30 blur-[5px]" />
                <span className="relative size-3.5 rounded-full bg-white/80" />
              </span>
            </Tile>

            {VIRTUAL_BACKGROUNDS.map((bg) => (
              <Tile
                key={bg.id}
                label={bg.label}
                active={isActive({ mode: "image", id: bg.id })}
                onClick={() => set({ mode: "image", id: bg.id })}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={bg.src}
                  alt=""
                  className="size-full object-cover"
                  draggable={false}
                />
              </Tile>
            ))}
          </div>

          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
            Segmentation runs on your own device — the video is never sent anywhere to
            be processed. On a slower machine it will turn itself off rather than
            publish a stuttering picture.
          </p>
        </>
      )}
    </section>
  );
}

function Tile({
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
      className={`relative aspect-video overflow-hidden rounded-lg border-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
        active ? "border-brand" : "border-transparent hover:border-line-2"
      }`}
    >
      {children}
      {active && (
        <span className="absolute inset-0 grid place-items-center bg-brand/25">
          <span className="grid size-5 place-items-center rounded-full bg-brand text-white">
            <CheckIcon className="size-3" />
          </span>
        </span>
      )}
    </button>
  );
}
