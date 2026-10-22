"use client";

import { Component, Suspense, useEffect, useState, useMemo, useRef, useSyncExternalStore } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { EdgeClock } from "@/components/room/edge-clock";
import { useServerClockOffset } from "@/lib/edge-events";
import {
  audienceLayoutFromMetadata,
  cameraIsOn,
  isEdgeTemplatePath,
  isStageTile,
  placeStage,
  SHARE_ID,
  type AudienceLayoutId,
} from "@/lib/composite-layouts";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useTracks,
  useRoomContext,
  VideoTrack,
  isTrackReference,
  type TrackReference,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import {
  Track,
  RoomEvent,
  ParticipantKind,
  VideoQuality,
  type Participant,
  type Room,
} from "livekit-client";

export default function RecorderTemplatePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen w-screen items-center justify-center bg-black text-zinc-500 font-mono text-sm">
          Loading recorder template...
        </div>
      }
    >
      <RecorderTemplateInner />
    </Suspense>
  );
}

function RecorderTemplateInner() {
  /* Read during render, not stored in state from an effect.
   *
   * Holding them in state meant one render with no credentials, an effect, and
   * only then the render that connects. Egress abandons a job that has not
   * signalled START_RECORDING in time ("Start signal not received", which this
   * template has produced), so a wasted round trip before connecting is not
   * free. */
  const searchParams = useSearchParams();
  /* <template>/clock is the edge latency aid (EDGE_DEBUG_CLOCK, docs/edge-delivery.md): the
   * server sends edge webinars' egress here, and this page draws a server-synced clock that
   * the edge player shows too. A path segment because LiveKit appends its own query. */
  const path = usePathname() ?? "";
  const debugClock = /\/clock\/?$/.test(path);
  /* <template>/edge is an edge webinar's mix. Only the auto layout draws it differently (the
   * share fills the frame, cameras over a corner); see lib/composite-layouts.ts. */
  const edgeLayout = isEdgeTemplatePath(path);
  let url = searchParams.get("url") || "";
  let token = searchParams.get("token") || "";
  if ((!url || !token) && typeof window !== "undefined") {
    const sp = new URLSearchParams(window.location.search);
    url = url || sp.get("url") || "";
    token = token || sp.get("token") || "";
  }

  if (!url || !token) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black text-zinc-600 font-mono text-sm">
        Waiting for LiveKit Egress parameters (?url=...&token=...)
      </div>
    );
  }

  return (
    /* No audio or video props: those make LiveKitRoom publish a microphone and
       a camera on connect. This participant is a recorder — it has no devices,
       and its token is not permitted to publish — so all that produced was a
       failed getUserMedia and a permission error on every job. */
    <LiveKitRoom
      serverUrl={url}
      token={token}
      connect={true}
      onConnected={() => {
        console.log("START_RECORDING");
      }}
      onDisconnected={() => {
        console.log("END_RECORDING");
      }}
      className="fixed inset-0 h-screen w-screen overflow-hidden bg-black select-none"
    >
      <RoomAudioRenderer />
      {/* Around the stage only, so that a render error costs the picture and
          not the rest of the session. Outside this boundary the room stays
          connected and RoomAudioRenderer keeps playing, which is the difference
          between a recording with a broken stretch and no recording at all. */}
      <StageBoundary>
        <ZoomRecordingStage edgeLayout={edgeLayout} />
      </StageBoundary>
      {debugClock && <CompositeClock />}
    </LiveKitRoom>
  );
}

class StageBoundary extends Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    // Reaches the egress logs, which is the only place anyone can read it from.
    console.error("recorder stage failed:", error?.message ?? error);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="flex h-full w-full items-center justify-center bg-black text-zinc-600 font-mono text-sm">
          Reconnecting to the stage...
        </div>
      );
    }
    return this.props.children;
  }
}

function ZoomRecordingStage({ edgeLayout = false }: { edgeLayout?: boolean }) {
  const room = useRoomContext();
  const [activeSpeakerId, setActiveSpeakerId] = useState<string>("");
  const startedRef = useRef(false);
  const layoutId = useAudienceLayout(room);
  const frame = useFrameSize();

  useEffect(() => {
    if (!room) return;

    const signalStart = () => {
      if (!startedRef.current) {
        startedRef.current = true;
        console.log("START_RECORDING");
      }
    };

    if (room.state === "connected") {
      signalStart();
    } else {
      room.once(RoomEvent.Connected, signalStart);
    }

    const onSpeakers = (speakers: Participant[]) => {
      if (speakers.length > 0) {
        setActiveSpeakerId(speakers[0].identity);
      }
    };
    room.on(RoomEvent.ActiveSpeakersChanged, onSpeakers);

    const onDisconnected = () => {
      console.log("END_RECORDING");
    };
    room.once(RoomEvent.Disconnected, onDisconnected);

    /* Detach the listeners and nothing else. Logging END_RECORDING here ended
       the job on any re-run of this effect, not just a real disconnect — and
       egress treats that line as "stop now", so a remount silently finished a
       live recording. A genuine disconnect still reports it, from the handler
       above and from LiveKitRoom's own onDisconnected. */
    return () => {
      room.off(RoomEvent.Connected, signalStart);
      room.off(RoomEvent.ActiveSpeakersChanged, onSpeakers);
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [room]);

  // Subscribe to all camera and screenshare tracks
  const trackRefs = useTracks([Track.Source.ScreenShare, Track.Source.Camera], {
    onlySubscribed: false,
  });

  // Separate screen share and camera tracks
  const screenShareRef = trackRefs.find(
    (ref): ref is TrackReference =>
      isTrackReference(ref) &&
      ref.source === Track.Source.ScreenShare &&
      Boolean(ref.publication?.isSubscribed),
  );

  /* The tiles: who is on the stage (lib/composite-layouts.ts isStageTile) — not this egress,
   * not the caption agent, not an attendee watching over WebRTC. useTracks with
   * onlySubscribed false returns a placeholder for every participant, this one included. */
  const cameraRefs = useMemo(() => {
    const cams = trackRefs.filter(
      (ref) => ref.source === Track.Source.Camera && onStage(ref.participant),
    );
    // Sort cameras: active speaker on top, then by identity
    return [...cams].sort((a, b) => {
      const aActive = a.participant.identity === activeSpeakerId || a.participant.isSpeaking;
      const bActive = b.participant.identity === activeSpeakerId || b.participant.isSpeaking;
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return 1;
      return a.participant.identity.localeCompare(b.participant.identity);
    });
  }, [trackRefs, activeSpeakerId]);

  /* The host's layout (SessionControls.audienceLayout, from room metadata) turns the stage
   * into boxes, and every box is drawn in ONE tree of absolutely positioned elements keyed by
   * identity, in a stable order.
   *
   * These used to be two separate trees returned from two branches. Swapping
   * between them unmounted and remounted every VideoTrack, so each time a share
   * started or stopped, every tile detached its track and attached a new
   * element — seconds of black frames, on the one machine with no CPU to spare,
   * while RoomAudioRenderer carried on. That is the moment hosts reported the
   * recording breaking and the audio drifting out of step. With one keyed tree, a
   * share toggle or a layout switch only moves boxes. Someone the layout leaves out is
   * not drawn at all, which bounds what the egress decodes (one page of grid at most). */
  const tiles = cameraRefs.map((ref) => ({ id: ref.participant.identity, cameraOn: cameraIsOn(ref) }));
  const result = placeStage(layoutId, {
    frame,
    share: Boolean(screenShareRef),
    cameras: tiles,
    edge: edgeLayout,
  });

  if (result.placements.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black text-zinc-600 font-mono text-sm">
        Waiting for webinar presenter to start video...
      </div>
    );
  }

  const byId = new Map(cameraRefs.map((ref) => [ref.participant.identity, ref]));
  // DOM order by id, never by layout: React moving a <video> is what this tree avoids.
  const ordered = [...result.placements].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      {ordered.map((p) => {
        const style = {
          left: p.rect.x,
          top: p.rect.y,
          width: p.rect.w,
          height: p.rect.h,
          zIndex: p.z,
        };
        if (p.id === SHARE_ID) {
          return screenShareRef ? (
            <div key={p.id} className="absolute flex items-center justify-center bg-black" style={style}>
              <VideoTrack trackRef={screenShareRef} className="size-full object-contain" />
            </div>
          ) : null;
        }
        const ref = byId.get(p.id);
        if (!ref) return null;
        const isSpeaking = ref.participant.identity === activeSpeakerId || ref.participant.isSpeaking;
        const small = p.rect.h < SMALL_TILE_PX;
        return (
          <div
            key={p.id}
            className={`absolute ${p.role === "pip" ? "shadow-[0_2px_10px_rgba(0,0,0,0.6)]" : ""}`}
            style={style}
          >
            <SpeakerTile
              trackRef={ref}
              isSpeaking={isSpeaking}
              aspect=""
              className={`size-full ${p.role === "pip" ? "rounded-2xl" : ""}`}
              compact={small}
              fit={p.role === "main" ? "contain" : "cover"}
              small={small}
            />
          </div>
        );
      })}
      {result.note && (
        <div
          className="absolute flex items-center justify-center text-xs text-zinc-600"
          style={{ left: result.note.x, top: result.note.y, width: result.note.w, height: result.note.h }}
        >
          No camera published
        </div>
      )}
    </div>
  );
}

/** Below this height a tile asks for the low simulcast layer (about 180p): the egress decodes
 *  every tile it draws, and a thumbnail does not need a full-size camera. */
const SMALL_TILE_PX = 300;

function onStage(p: Participant): boolean {
  const kind = p.kind;
  const perm = p.permissions;
  const sources = (perm?.canPublishSources ?? []).map((s) => Track.sourceFromProto(s));
  return isStageTile({
    isLocal: p.isLocal,
    isAgentOrEgress: kind === ParticipantKind.EGRESS || kind === ParticipantKind.AGENT,
    hasVideoPublication:
      Boolean(p.getTrackPublication(Track.Source.Camera)) ||
      Boolean(p.getTrackPublication(Track.Source.ScreenShare)),
    // An empty list means every source.
    canPublishVideo:
      Boolean(perm?.canPublish) && (sources.length === 0 || sources.includes(Track.Source.Camera)),
  });
}

/** The host's layout, from room metadata, live: RoomMetadataChanged re-lays the composite
 *  without restarting the egress. */
function useAudienceLayout(room: Room | undefined): AudienceLayoutId {
  const [id, setId] = useState<AudienceLayoutId>(() => audienceLayoutFromMetadata(room?.metadata));
  useEffect(() => {
    if (!room) return;
    const read = (raw?: string) => setId(audienceLayoutFromMetadata(raw || room.metadata));
    const onConnected = () => read();
    read();
    room.on(RoomEvent.RoomMetadataChanged, read);
    room.on(RoomEvent.Connected, onConnected);
    return () => {
      room.off(RoomEvent.RoomMetadataChanged, read);
      room.off(RoomEvent.Connected, onConnected);
    };
  }, [room]);
  return id;
}

function subscribeResize(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}
const readFrame = () => `${window.innerWidth}x${window.innerHeight}`;
const readFrameOnServer = () => "1920x1080";

/** The egress viewport in CSS pixels: what the layout's rects are measured in. */
function useFrameSize(): { w: number; h: number } {
  const raw = useSyncExternalStore(subscribeResize, readFrame, readFrameOnServer);
  return useMemo(() => {
    const [w, h] = raw.split("x").map(Number);
    return { w: w || 1920, h: h || 1080 };
  }, [raw]);
}

function SpeakerTile({
  trackRef,
  isSpeaking,
  aspect = "aspect-video",
  className = "",
  compact = false,
  fit = "cover",
  small = false,
}: {
  trackRef: TrackReferenceOrPlaceholder;
  isSpeaking: boolean;
  aspect?: string;
  className?: string;
  compact?: boolean;
  /* The main speaker is "contain": its box fills the main area, whatever shape that is (about
   * 1280×1056 at 1080p before, with max-w-7xl), so "cover" cut a third off a 16:9 camera and
   * the audience saw a zoomed, cropped picture of what the host sees whole. Strip tiles are
   * 16:9 boxes, where "cover" only trims a camera that is not 16:9. */
  fit?: "cover" | "contain";
  /** A thumbnail: ask for the low simulcast layer rather than decoding a full camera. */
  small?: boolean;
}) {
  const { participant, publication } = trackRef;
  useEffect(() => {
    if (publication && "setVideoQuality" in publication && typeof publication.setVideoQuality === "function") {
      publication.setVideoQuality(small ? VideoQuality.LOW : VideoQuality.HIGH);
    }
  }, [publication, small]);
  const hasVideo = publication?.isSubscribed && !publication?.isMuted && publication?.track;
  const name = participant.name || participant.identity || "Speaker";
  const initials = getInitials(name);
  const isMicMuted = !participant.isMicrophoneEnabled;

  return (
    <div
      className={`relative ${aspect} rounded-lg overflow-hidden bg-zinc-900 border transition-all duration-200 ${
        isSpeaking
          ? "border-emerald-500 ring-2 ring-emerald-500/70 shadow-[0_0_12px_rgba(16,185,129,0.3)]"
          : "border-zinc-800/80"
      } ${className}`}
    >
      {hasVideo && isTrackReference(trackRef) ? (
        <VideoTrack
          trackRef={trackRef}
          className={`size-full ${fit === "contain" ? "object-contain" : "object-cover"}`}
        />
      ) : (
        <div className="size-full flex flex-col items-center justify-center bg-gradient-to-b from-zinc-800 to-zinc-900">
          <div
            className={`flex items-center justify-center rounded-full bg-zinc-700/80 text-white font-semibold shadow-inner ${
              compact ? "size-10 text-sm" : "size-16 text-xl"
            }`}
          >
            {initials}
          </div>
          {!compact && (
            <span className="mt-2 text-xs font-medium text-zinc-400 truncate max-w-[80%]">
              {name}
            </span>
          )}
        </div>
      )}

      {/* Zoom-style semi-transparent nameplate at bottom left */}
      <div
        className={`absolute bottom-1.5 left-1.5 max-w-[90%] flex items-center gap-1.5 rounded bg-black/75 backdrop-blur-xs px-2 py-0.5 text-white shadow-xs ${
          compact ? "text-[10px]" : "text-xs"
        }`}
      >
        {isMicMuted ? (
          <MutedMicIcon className="size-3 text-red-400 shrink-0" />
        ) : (
          <ActiveMicIcon
            className={`size-3 shrink-0 ${isSpeaking ? "text-emerald-400" : "text-zinc-300"}`}
          />
        )}
        <span className="truncate font-medium">{name}</span>
      </div>
    </div>
  );
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function ActiveMicIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1Z" />
      <path d="M3.5 7.5a.75.75 0 0 0-1.5 0 6 6 0 0 0 5.25 5.95v1.3a.75.75 0 0 0 1.5 0v-1.3A6 6 0 0 0 14 7.5a.75.75 0 0 0-1.5 0 4.5 4.5 0 0 1-9 0Z" />
    </svg>
  );
}

function MutedMicIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12.5 7.5a.75.75 0 0 0-1.5 0 4.5 4.5 0 0 1-1.1 2.94l1.08 1.08A5.97 5.97 0 0 0 12.5 7.5ZM8 1a2.5 2.5 0 0 0-2.5 2.5v1.38l4.98 4.98A2.5 2.5 0 0 0 10.5 7.5v-4A2.5 2.5 0 0 0 8 1ZM2.03 1.97a.75.75 0 0 0-1.06 1.06l13 13a.75.75 0 1 0 1.06-1.06l-2.01-2.01A5.98 5.98 0 0 0 14 7.5a.75.75 0 0 0-1.5 0 4.48 4.48 0 0 1-.58 2.2l-1.1-1.1V7.5a2.5 2.5 0 0 0-.27-1.12l-1.8-1.8V3.5a2.5 2.5 0 0 0-.25-1.08L2.03 1.97ZM3.5 7.5a4.48 4.48 0 0 0 .58 2.2l1.1-1.1A2.5 2.5 0 0 1 5.5 7.5V5.92L4.03 4.45A5.97 5.97 0 0 0 3.5 7.5Zm3.75 5.95V14.75a.75.75 0 0 0 1.5 0v-1.3c.73-.07 1.42-.28 2.05-.6l-1.13-1.13a4.5 4.5 0 0 1-.92.23Z" />
    </svg>
  );
}

/** The server-synced clock in the composite's corner, for reading glass-to-glass latency. */
function CompositeClock() {
  const offset = useServerClockOffset(true);
  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-50">
      <EdgeClock offsetMs={offset} />
    </div>
  );
}
