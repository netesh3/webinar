"use client";

import { REACTIONS, type Reaction } from "@/lib/realtime";
import { useRoomUI } from "./context";

/* Floating reactions.
 *
 * One tap sends one message and floats a handful of emoji up the RIGHT-HAND EDGE of the video
 * area, each with a small tally beside it — see REACTION_BURST in lib/realtime.ts.
 *
 * The right-hand column is the change that matters. They used to rise across the full width,
 * which puts emoji over the presenter's face and over shared slides — the two things the
 * audience is actually looking at. Zoom keeps them in a narrow lane at the edge for that
 * reason: a reaction is peripheral information and belongs in the periphery.
 *
 * Deliberately ephemeral and anonymous: a persistent list of who clapped is a
 * distraction during a talk, and the point of a reaction is that five hundred people
 * can respond at once without interrupting or identifying themselves.
 *
 * The travel distance is in `cqh` — 1% of this container's height — which is what
 * makes a full-height rise possible with a transform. A percentage in translateY
 * resolves against the ELEMENT's own box, so `translateY(-100%)` on a 30px emoji
 * moves it 30 pixels; that was the old behaviour and the reason they barely drifted.
 * Transforms stay on the compositor, which two hundred of them need.
 */

export function ReactionOverlay() {
  const { realtime, controls } = useRoomUI();
  if (!controls.reactionsEnabled || realtime.reactions.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
      // Establishes the container the emoji measure their rise against.
      style={{ containerType: "size" }}
      // Decorative, and intentionally not announced. The old single-emoji overlay
      // was a live region; twenty announcements per tap would make a screen reader
      // unusable during exactly the moment this feature is for.
      aria-hidden="true"
    >
      {realtime.reactions.map((r) => (
        <span
          key={r.id}
          className="absolute flex items-center gap-1 motion-safe:animate-[reaction-rise_var(--duration)_linear_var(--delay)_forwards] motion-reduce:animate-[reaction-fade_2.4s_ease-out_forwards]"
          style={
            {
              // Below the bottom edge, so each one rises into view rather than
              // appearing from nothing.
              bottom: "-3rem",
              /* A lane on the RIGHT, not the full width.
               *
               * `right` rather than `left` so the lane stays pinned to the edge at every
               * stage width — anchoring with left would put it in the middle of a narrow
               * viewport. 1rem clears the edge; the offset gives each emoji its own line
               * within a 5rem lane, which is enough for the jitter to look organic and
               * narrow enough to stay out of the picture. */
              right: `calc(1rem + ${r.offset * 5}rem)`,
              fontSize: `${r.size}px`,
              lineHeight: 1,
              "--duration": `${r.duration}ms`,
              "--delay": `${r.delay}ms`,
              // Drift halved. The full sway was tuned for the open stage and would carry an
              // emoji out of a 5rem lane and off the edge.
              "--drift": `${Math.round(r.drift / 2)}px`,
              // Nothing is painted until the animation's delay has elapsed.
              opacity: 0,
            } as React.CSSProperties
          }
        >
          <span className="drop-shadow-lg">{r.emoji}</span>
          {/* The tally. Scaled off the emoji's own size so a big one does not get a tiny
              badge, and mid-grey on translucent black so it reads over both a bright slide
              and a dark camera feed without a border. */}
          <span
            className="rounded-full bg-black/55 px-1.5 font-semibold text-white tabular-nums backdrop-blur-sm"
            style={{ fontSize: `${Math.round(r.size * 0.42)}px`, lineHeight: 1.6 }}
          >
            {r.count}
          </span>
        </span>
      ))}
    </div>
  );
}

/** The reaction picker, opened from the control bar. */
export function ReactionPicker({ onPick }: { onPick: (emoji: Reaction) => void }) {
  return (
    <div className="flex items-center gap-1">
      {REACTIONS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={() => onPick(emoji)}
          aria-label={`React with ${emoji}`}
          className="grid size-9 place-items-center rounded-lg text-[19px] transition-transform hover:scale-110 hover:bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
