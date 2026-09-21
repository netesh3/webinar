"use client";

import { Track, type LocalVideoTrack } from "livekit-client";
import { useLocalParticipant } from "@livekit/components-react";
import {
  asLowLight,
  backgroundsSupported,
  describeLowLight,
  LOW_LIGHT_MAX,
  LOW_LIGHT_STEP,
} from "@/lib/backgrounds";
import { Alert } from "../controls";
import { useRoomUI } from "./context";

/* How much light to put on the presenter's face.
 *
 * A slider and not a toggle, and that is the one decision here worth defending. How much
 * lift looks right is a property of the room and the webcam — a kitchen at noon and a
 * bedroom at ten o'clock need different amounts, and the same person needs different
 * amounts on different days. A toggle would be us picking one number for every room in
 * the world, and it would be wrong in most of them. So the control is continuous and the
 * presenter can see their own tile while they set it.
 *
 * There is no applier component beside this one, unlike BackgroundPicker. The lift rides
 * on the same processor the background does, so VirtualBackground applies both and there
 * is nothing for this file to do but write the preference. See useVirtualBackground.
 */

/** The camera track this participant is publishing, if any. Same shape as the one in
 *  background-picker.tsx, and deliberately a copy: exporting it from there would make
 *  this file import the background catalogue to ask a question about the camera. */
function useCameraTrack(): LocalVideoTrack | undefined {
  const { localParticipant } = useLocalParticipant();
  const publication = localParticipant.getTrackPublication(Track.Source.Camera);
  return publication?.track as LocalVideoTrack | undefined;
}

export function LowLightSlider() {
  const { prefs, updatePrefs, permissions } = useRoomUI();
  const track = useCameraTrack();
  const value = asLowLight(prefs.lowLight);
  const supported = backgroundsSupported();

  if (!permissions.canShareCamera) return null;

  return (
    <section>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h3 className="text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
          Adjust for low light
        </h3>
        {/* The number, because a slider with no readout cannot be returned to. Somebody
            who found 40% right last week has no way to find it again from a handle
            position alone. */}
        <span className="text-[11.5px] tabular-nums text-ink-3">
          {describeLowLight(value)}
        </span>
      </div>

      {!supported ? (
        <Alert tone="warn">
          This browser can&apos;t adjust your video. It needs WebGL2 — Chrome, Edge,
          Firefox or Safari 17 and later.
        </Alert>
      ) : (
        <>
          <p className="mb-2 text-[11.5px] leading-relaxed text-ink-3">
            {track
              ? "Lifts the shadows on you without blowing out the light behind you. Your audience sees this, not just you."
              : "Start your camera to see the change. Your choice is saved either way."}
          </p>

          {/* A range input rather than a custom track: it is keyboard-operable and
              draggable for free, and this is not the place to reimplement that. Same
              reasoning as the seek bar in file-share-bar.tsx.

              No debounce on the way out. Each change is a uniform write on the next
              frame — see SoftSegmenter.setLowLight — so a drag is already as cheap as it
              can be, and holding the value back would only make the preview lag the
              handle. */}
          <input
            type="range"
            min={0}
            max={LOW_LIGHT_MAX}
            step={LOW_LIGHT_STEP}
            value={value}
            aria-label="Adjust for low light"
            onChange={(e) => updatePrefs({ lowLight: asLowLight(e.target.value) })}
            className="h-1 w-full cursor-pointer appearance-none rounded-full bg-surface-2 accent-brand outline-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:max-w-[22rem]"
          />

          <div className="mt-1 flex justify-between text-[10.5px] text-ink-3 sm:max-w-[22rem]">
            <span>Off</span>
            <span>Brighter</span>
          </div>

          {value > 0 && (
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
              {prefs.background.mode === "none"
                ? "Applied to the whole picture. Turn a background on and it lights you rather than the room."
                : "Applied to you only — the background behind you is left as it is."}
            </p>
          )}
        </>
      )}
    </section>
  );
}
