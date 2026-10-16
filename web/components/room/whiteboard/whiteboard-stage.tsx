"use client";

import dynamic from "next/dynamic";
import { useTracks, VideoTrack, type TrackReferenceOrPlaceholder } from "@livekit/components-react";
import { Track } from "livekit-client";
import { useWhiteboard } from "./whiteboard-context";

/* The whiteboard taking the stage.
 *
 * Laid over the stage rather than replacing it: <Stage /> stays mounted under
 * this, so its subscription budget, its pins and its layout choice are exactly as
 * they were when the board closes, and nothing about the stage had to change to
 * make room for a board. The cameras come along in a strip beside the board, the
 * way they sit beside a screen share, so a host drawing is still a face.
 *
 * Renders nothing unless a board is open — and nobody can open one unless the
 * host's `whiteboard` switch is on — so with the feature off this is inert.
 */

const WhiteboardCanvas = dynamic(() => import("./whiteboard-canvas"), {
  ssr: false,
  loading: () => (
    <div className="grid size-full place-items-center bg-white text-[13px] text-slate-500">
      Opening the whiteboard…
    </div>
  ),
});

/** How many cameras ride along beside the board. */
const STRIP_MAX = 4;

export function WhiteboardStage() {
  const wb = useWhiteboard();
  if (!wb?.state) return null;
  const { state, canDraw } = wb;

  return (
    <div
      data-whiteboard
      className="absolute inset-0 z-[5] flex flex-col gap-2 bg-stage p-2 md:flex-row"
    >
      <section
        aria-label="Whiteboard"
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl bg-white shadow-lg"
      >
        <WhiteboardCanvas link={wb.link} canDraw={canDraw} collaborators={wb.collaborators} />

        {/* Who is drawing, and the one way out — bottom-left, clear of
            Excalidraw's own toolbar (top) and menu (top-left). */}
        <div className="pointer-events-none absolute bottom-14 left-2 z-[3] flex md:bottom-2 md:left-1/2 md:-translate-x-1/2">
          <div
            role="status"
            className="pointer-events-auto flex items-center gap-2 rounded-full border border-white/10 bg-black/80 py-1 pr-1 pl-3 text-[12px] font-medium text-white shadow-lg"
          >
            <span className="size-2 rounded-full bg-ok" aria-hidden />
            {canDraw ? (
              <span>Everyone can see the board</span>
            ) : (
              <span>
                View only · {state.ownerName || "The host"} is drawing
              </span>
            )}
            {canDraw ? (
              <button
                type="button"
                onClick={wb.close}
                className="rounded-full bg-[#d93025] px-3 py-1 text-[12px] font-semibold text-white outline-none hover:bg-[#c5221f] focus-visible:ring-2 focus-visible:ring-white/60"
              >
                Stop whiteboard
              </button>
            ) : (
              <span className="pr-2" />
            )}
          </div>
        </div>
      </section>

      <CameraStrip />
    </div>
  );
}

function CameraStrip() {
  const cameras = useTracks([Track.Source.Camera], { onlySubscribed: true }).slice(0, STRIP_MAX);
  if (cameras.length === 0) return null;
  return (
    <aside
      aria-label="Cameras"
      className="flex h-24 shrink-0 gap-2 overflow-x-auto md:h-auto md:w-[200px] md:flex-col md:overflow-x-visible md:overflow-y-auto"
    >
      {cameras.map((ref) => (
        <CameraTile key={`${ref.participant.identity}:${ref.source}`} trackRef={ref} />
      ))}
    </aside>
  );
}

function CameraTile({ trackRef }: { trackRef: TrackReferenceOrPlaceholder }) {
  const name = trackRef.participant.name || trackRef.participant.identity;
  const live = !!trackRef.publication && !trackRef.publication.isMuted;
  return (
    <div className="relative aspect-video h-full shrink-0 overflow-hidden rounded-lg bg-surface md:h-auto md:w-full">
      {live && trackRef.publication ? (
        <VideoTrack
          trackRef={trackRef as Parameters<typeof VideoTrack>[0]["trackRef"]}
          className="size-full object-cover"
        />
      ) : (
        <div className="grid size-full place-items-center text-[18px] font-semibold text-white/70">
          {name.slice(0, 1).toUpperCase()}
        </div>
      )}
      <span className="absolute bottom-1 left-1 max-w-[90%] truncate rounded bg-black/60 px-1.5 py-px text-[10px] text-white">
        {trackRef.participant.isLocal ? "You" : name}
      </span>
    </div>
  );
}
