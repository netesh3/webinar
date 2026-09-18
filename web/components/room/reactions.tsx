"use client";

import { REACTIONS, type Reaction } from "@/lib/realtime";
import { useRoomUI } from "./context";

/* Floating reactions.
 *
 * One tap sends one message and floats one emoji up the RIGHT-HAND EDGE of the video
 * area.
 *
 * The right-hand column is the change that matters. They used to rise across the full width,
 * which puts emoji over the presenter's face and over shared slides — the two things the
 * audience is actually looking at. Zoom keeps them in a narrow lane at the edge for that
 * reason: a reaction is peripheral information and belongs in the periphery.
 *
 * z-[45], not the z-10 this used to be: SidePanel (Chat/Q&A/Polls/Participants) is an
 * opaque overlay docked to that same right edge at z-40, and rendering below it meant
 * a reaction anyone sent was invisible to every viewer who had a panel open — which,
 * for a host running a session with Chat or Participants open the whole time, was
 * effectively always. z-[45] clears that opaque panel while staying under every actual
 * popup/menu/dialog in the room (z-50), so a reaction is never mistaken for something
 * that needs a click — see stage.tsx and side-panel.tsx for the two overlays this sits
 * between.
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
      className="pointer-events-none absolute inset-0 z-[45] overflow-hidden"
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
          className="absolute drop-shadow-lg motion-safe:animate-[reaction-rise_var(--duration)_linear_forwards] motion-reduce:animate-[reaction-fade_2.4s_ease-out_forwards]"
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
              // Drift halved. The full sway was tuned for the open stage and would carry an
              // emoji out of a 5rem lane and off the edge.
              "--drift": `${Math.round(r.drift / 2)}px`,
            } as React.CSSProperties
          }
        >
          {r.emoji}
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
