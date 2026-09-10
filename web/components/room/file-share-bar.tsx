"use client";

import { formatPosition } from "@/lib/file-share";
import { PlayIcon, StopIcon, VolumeIcon } from "../icons";
import { useRoomUI } from "./context";

/* Playback controls for a shared video file.
 *
 * Host-only, and structurally so: this component is rendered inside the presenter's
 * own room shell, and the frames the audience receives come from a hidden video
 * element captured elsewhere. There is no path by which any of this reaches a
 * subscriber — which is the requirement. The audience sees a screen share with the
 * ordinary webinar interface around it and no playback UI at all, because at their
 * end there is no player.
 *
 * Deliberately sparse. Pause, seek, monitor, stop. A presenter mid-session does not
 * want a media player, they want to not lose their place.
 */

export function FileShareBar() {
  const { fileShare } = useRoomUI();
  if (!fileShare.active) return null;

  const { position, duration, playing, monitor } = fileShare;
  const seekable = duration > 0;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-3 pb-3">
      <div className="pointer-events-auto flex w-full max-w-2xl items-center gap-2.5 rounded-xl border border-white/15 bg-ink/85 px-3 py-2 shadow-2xl backdrop-blur-sm">
        <button
          type="button"
          onClick={() => (playing ? fileShare.pause() : fileShare.play())}
          aria-label={playing ? "Pause the shared video" : "Resume the shared video"}
          title={playing ? "Pause" : "Resume"}
          className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 text-white transition-colors hover:bg-white/20 outline-none focus-visible:ring-2 focus-visible:ring-white/50"
        >
          {playing ? <PauseGlyph /> : <PlayIcon className="size-4" />}
        </button>

        <span className="shrink-0 text-[11.5px] tabular-nums text-white/70">
          {formatPosition(position)}
        </span>

        {/* A range input rather than a custom track: it is keyboard-operable and
            draggable for free, and this is not the place to reimplement that. */}
        <input
          type="range"
          min={0}
          max={seekable ? duration : 0}
          step={0.5}
          value={Math.min(position, duration || 0)}
          disabled={!seekable}
          aria-label="Playback position"
          onChange={(e) => fileShare.seek(Number(e.target.value))}
          className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-white/20 accent-brand outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:cursor-default"
        />

        <span className="shrink-0 text-[11.5px] tabular-nums text-white/70">
          {seekable ? formatPosition(duration) : "live"}
        </span>

        {/* Monitoring is off by default. The room hears the file either way — it is
            published as screen-share audio — and a presenter listening on speakers
            feeds it straight back through their own microphone. */}
        <button
          type="button"
          onClick={() => fileShare.setMonitor(!monitor)}
          aria-pressed={monitor}
          aria-label={monitor ? "Stop hearing the video here" : "Hear the video here"}
          title={
            monitor
              ? "You can hear it. Use headphones, or your mic will pick it up."
              : "Listen to what the room is hearing"
          }
          className={`hidden size-8 shrink-0 place-items-center rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/50 sm:grid ${
            monitor ? "bg-white/20 text-white" : "text-white/60 hover:bg-white/10 hover:text-white"
          }`}
        >
          <VolumeIcon className="size-4" />
        </button>

        <button
          type="button"
          onClick={() => void fileShare.stop()}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-live px-2.5 text-[12px] font-semibold text-white transition-colors hover:bg-live/90 outline-none focus-visible:ring-2 focus-visible:ring-white/50"
        >
          <StopIcon className="size-3.5" />
          <span className="hidden sm:inline">Stop sharing</span>
        </button>
      </div>
    </div>
  );
}

/** There is no pause glyph in the icon set, and two bars is not worth a round trip
 *  through the shared file for one use. */
function PauseGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="size-4" aria-hidden>
      <rect x="7" y="5" width="3.5" height="14" rx="1" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
    </svg>
  );
}
