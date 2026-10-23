"use client";

import { useVolumeBoost } from "@/lib/volume-boost";
import { BOOST_MAX, BOOST_MIN, BOOST_STEP, boostBlockerText } from "@/lib/volume-boost-policy";

/* "Volume boost" in Settings, under the speaker: up to 200% for an attendee whose host is too
 * quiet on their speakers. What it does and where it is withheld is lib/volume-boost.ts.
 *
 * Renders nothing outside the live room (the engine is not mounted there) and nothing for
 * anyone with a microphone; elsewhere it says why it is not offered. Same markup as the
 * low-light slider (low-light.tsx), a plain range input: keyboard-operable and draggable for
 * free. */
export function VolumeBoostSetting() {
  const boost = useVolumeBoost();
  if (!boost.mounted) return null;

  if (boost.blocker) {
    const text = boostBlockerText(boost.blocker);
    return text ? (
      <div className="border-t border-line pt-3">
        <h3 className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">Volume boost</h3>
        <p className="text-[12px] leading-relaxed text-ink-3">{text}</p>
      </div>
    ) : null;
  }

  const percent = Math.round(boost.level * 100);
  return (
    <section className="border-t border-line pt-3">
      <div className="mb-1 flex items-baseline justify-between gap-3 sm:max-w-[22rem]">
        <h3 className="text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">Volume boost</h3>
        <span className="text-[11.5px] tabular-nums text-ink-2">{percent}%</span>
      </div>
      <input
        type="range"
        min={BOOST_MIN * 100}
        max={BOOST_MAX * 100}
        step={BOOST_STEP * 100}
        value={percent}
        aria-label="Volume boost"
        aria-valuetext={`${percent} percent`}
        onChange={(e) => boost.setLevel(Number(e.target.value) / 100)}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-surface-2 accent-brand outline-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:max-w-[22rem]"
      />
      <div className="mt-1 flex justify-between text-[10.5px] text-ink-3 sm:max-w-[22rem]">
        <span>Normal</span>
        <span>Twice as loud</span>
      </div>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
        Makes the speakers louder for you only. Nobody else hears a difference.
        {boost.level > BOOST_MIN && (
          <>
            {" "}
            <button
              type="button"
              onClick={() => boost.setLevel(BOOST_MIN)}
              className="font-medium text-brand underline-offset-2 hover:underline"
            >
              Back to normal
            </button>
          </>
        )}
      </p>
    </section>
  );
}
