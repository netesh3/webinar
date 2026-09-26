"use client";

import { Track, type LocalVideoTrack } from "livekit-client";
import { useLocalParticipant } from "@livekit/components-react";
import {
  asLowLight,
  describeLowLight,
  LOW_LIGHT_DEFAULT_ON,
  LOW_LIGHT_MAX,
  LOW_LIGHT_STEP,
  useBackgroundsSupported,
  useVirtualBackgroundsEnabled,
} from "@/lib/backgrounds";
import { Alert, Toggle } from "../controls";
import { useRoomUI } from "./context";

/* How much light to put on the presenter's face.
 *
 * A switch AND a slider, which is one more control than either alone deserves and the right
 * number for this. They answer different questions:
 *
 *   the switch    "I'm too dark, fix it" — one click, no judgement asked for, and the
 *                 answer is LOW_LIGHT_DEFAULT_ON because it is the amount that is right
 *                 more often than any other.
 *   the slider    "not that much" / "more than that" — which is a real disagreement to
 *                 have, because how much lift looks right is a property of the room and
 *                 the camera. A switch alone would be one number chosen here for every
 *                 room in the world, and wrong in most of them.
 *
 * So the slider is revealed by the switch rather than sitting beside it: nobody has to
 * decide on an amount to get the benefit, and nobody who wants to is stopped.
 *
 * There is no applier component in this file, unlike BackgroundPicker. The lift rides on
 * the same processor the background does, so VirtualBackground applies both and there is
 * nothing to do here but write the preference. See useVirtualBackground.
 */

/* The amount to return to when the switch goes back on, for this tab's lifetime.
 *
 * Module scope so the three places this control appears — the join screen, the camera
 * menu and the settings window — agree about it without threading state between them.
 *
 * Deliberately NOT a preference. Storing it would mean a second persisted field whose only
 * job is memory, and the thing worth remembering across sessions is already remembered:
 * `lowLight` itself holds whatever amount was left on. This only covers off-then-on inside
 * one visit, where landing back on 50 after carefully choosing 20 is the annoyance.
 */
let remembered = LOW_LIGHT_DEFAULT_ON;

/**
 * The next amount when the switch is clicked.
 *
 * Off remembers where it was first, so a presenter who dials in 20, switches off to compare,
 * and switches back on gets their 20 rather than the default.
 */
export function lowLightToggled(current: number): number {
  const now = asLowLight(current);
  if (now > 0) {
    remembered = now;
    return 0;
  }
  return remembered;
}

/* The next amount when the slider moves. Keeps the switch's memory in step with it.
 *
 * Takes unknown because it is fed straight from a DOM input, whose value is a string:
 * asLowLight is the normaliser either way, and converting at the call site would put a
 * Number() in front of a function whose whole job is to be handed raw values. */
export function lowLightMoved(next: unknown): number {
  const value = asLowLight(next);
  if (value > 0) remembered = value;
  return value;
}

/** The camera track this participant is publishing, if any. Same shape as the one in
 *  background-picker.tsx, and deliberately a copy: exporting it from there would make
 *  this file import the background catalogue to ask a question about the camera. */
function useCameraTrack(): LocalVideoTrack | undefined {
  const { localParticipant } = useLocalParticipant();
  const publication = localParticipant.getTrackPublication(Track.Source.Camera);
  return publication?.track as LocalVideoTrack | undefined;
}

/**
 * The switch and the slider, taking the value as props.
 *
 * Props rather than context because the join screen has no room yet — PreJoin is rendered
 * before the connection and holds the preferences itself — and the same control has to work
 * on both sides of that line.
 */
export function LowLightControl({
  value: raw,
  onChange,
  /** Shown when there is no live camera to judge the effect against. */
  hint,
  disabled = false,
}: {
  value: number;
  onChange: (next: number) => void;
  hint?: string;
  disabled?: boolean;
}) {
  const value = asLowLight(raw);
  const on = value > 0;
  const enabled = useVirtualBackgroundsEnabled();
  const supported = useBackgroundsSupported();

  /* Kill switch: hide entirely. Do not claim the browser needs WebGL2. */
  if (!enabled) return null;

  if (!supported) {
    return (
      <Alert tone="warn">
        This browser can&apos;t adjust your video. It needs WebGL2 — Chrome, Edge, Firefox
        or Safari 17 and later.
      </Alert>
    );
  }

  return (
    <div>
      <Toggle
        checked={on}
        disabled={disabled}
        onChange={() => onChange(lowLightToggled(value))}
        label="Adjust for low light"
        description={
          hint ??
          "Lifts the shadows on you without blowing out the light behind you. Your audience sees this, not just you."
        }
      />

      {/* Only once it is on. A slider for a feature that is off is a control with nothing
          to control, and it would make the common case — one click — look like a decision
          about a number. */}
      {on && (
        <div className="mt-1 pl-1">
          <div className="mb-1 flex items-baseline justify-between gap-3 sm:max-w-[22rem]">
            <span className="text-[11.5px] text-ink-3">Amount</span>
            <span className="text-[11.5px] tabular-nums text-ink-2">
              {describeLowLight(value)}
            </span>
          </div>

          {/* A range input rather than a custom track: it is keyboard-operable and
              draggable for free, and this is not the place to reimplement that. Same
              reasoning as the seek bar in file-share-bar.tsx.

              No debounce on the way out. Each change is a uniform write on the next
              frame — see SoftSegmenter.setLowLight — so a drag is already as cheap as it
              can be, and holding the value back would only make the preview lag the
              handle. */}
          <input
            type="range"
            min={LOW_LIGHT_STEP}
            max={LOW_LIGHT_MAX}
            step={LOW_LIGHT_STEP}
            value={value}
            disabled={disabled}
            aria-label="Low light amount"
            onChange={(e) => onChange(lowLightMoved(e.target.value))}
            className="h-1 w-full cursor-pointer appearance-none rounded-full bg-surface-2 accent-brand outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-default sm:max-w-[22rem]"
          />

          <div className="mt-1 flex justify-between text-[10.5px] text-ink-3 sm:max-w-[22rem]">
            <span>Subtle</span>
            <span>Brighter</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** The settings-window version, reading the room's preferences. */
export function LowLightSetting() {
  const { prefs, updatePrefs, permissions } = useRoomUI();
  const track = useCameraTrack();
  const enabled = useVirtualBackgroundsEnabled();

  if (!permissions.canShareCamera || !enabled) return null;

  return (
    <section>
      <h3 className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
        Lighting
      </h3>
      <LowLightControl
        value={prefs.lowLight}
        onChange={(lowLight) => updatePrefs({ lowLight })}
        hint={
          track
            ? undefined
            : "Start your camera to see the change. Your choice is saved either way."
        }
      />
    </section>
  );
}
