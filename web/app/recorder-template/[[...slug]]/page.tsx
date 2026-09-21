"use client";

import { Component, Suspense, useEffect, useState, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
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
import { Track, RoomEvent, type Participant } from "livekit-client";

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
        <ZoomRecordingStage />
      </StageBoundary>
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

function ZoomRecordingStage() {
  const room = useRoomContext();
  const [activeSpeakerId, setActiveSpeakerId] = useState<string>("");
  const startedRef = useRef(false);

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

  const cameraRefs = useMemo(() => {
    const cams = trackRefs.filter((ref) => ref.source === Track.Source.Camera);
    // Sort cameras: active speaker on top, then by identity
    return [...cams].sort((a, b) => {
      const aActive = a.participant.identity === activeSpeakerId || a.participant.isSpeaking;
      const bActive = b.participant.identity === activeSpeakerId || b.participant.isSpeaking;
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return 1;
      return a.participant.identity.localeCompare(b.participant.identity);
    });
  }, [trackRefs, activeSpeakerId]);

  /* Sharing puts the screen in the main area with everyone down the side;
   * otherwise the loudest person takes the main area and the rest sit along the
   * top. Both cases are the same two boxes in a different direction, and that
   * is deliberate.
   *
   * These used to be two separate trees returned from two branches. Swapping
   * between them unmounted and remounted every VideoTrack, so each time a share
   * started or stopped, every tile detached its track and attached a new
   * element — seconds of black frames, on the one machine with no CPU to spare,
   * while RoomAudioRenderer carried on. That is the moment hosts reported the
   * recording breaking and the audio drifting out of step. One tree keyed by
   * identity means a share toggle relocates at most a single tile. */
  const primarySpeaker = screenShareRef ? undefined : cameraRefs[0];
  const stripRefs = screenShareRef ? cameraRefs : cameraRefs.slice(1);

  if (!screenShareRef && !primarySpeaker) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black text-zinc-600 font-mono text-sm">
        Waiting for webinar presenter to start video...
      </div>
    );
  }

  return (
    <div className={`flex h-full w-full bg-black ${screenShareRef ? "flex-row" : "flex-col"}`}>
      {/* Main area: the shared screen, or the active speaker. */}
      <div
        className={
          screenShareRef
            ? "relative flex-1 h-full min-w-0 flex items-center justify-center bg-black p-1 order-1"
            : "flex-1 min-h-0 relative flex items-center justify-center p-3 bg-black order-2"
        }
      >
        {screenShareRef ? (
          <VideoTrack trackRef={screenShareRef} className="size-full object-contain" />
        ) : primarySpeaker ? (
          <SpeakerTile
            trackRef={primarySpeaker}
            isSpeaking={
              primarySpeaker.participant.identity === activeSpeakerId ||
              primarySpeaker.participant.isSpeaking
            }
            className="size-full max-w-7xl max-h-full"
          />
        ) : null}
      </div>

      {/* Filmstrip: down the right while sharing, along the top otherwise. */}
      {(screenShareRef || stripRefs.length > 0) && (
        <div
          className={
            screenShareRef
              ? "w-[22%] min-w-[240px] max-w-[340px] h-full bg-zinc-950/90 border-l border-zinc-800/80 p-2 flex flex-col gap-2.5 overflow-hidden order-2"
              : "h-28 shrink-0 flex items-center justify-center gap-2 px-3 py-1.5 bg-zinc-950/80 border-b border-zinc-800/60 order-1"
          }
        >
          {stripRefs.length > 0 ? (
            stripRefs.slice(0, screenShareRef ? undefined : 5).map((ref) => {
              const isSpeaking =
                ref.participant.identity === activeSpeakerId || ref.participant.isSpeaking;
              return (
                <div
                  key={ref.participant.identity}
                  className={screenShareRef ? "w-full" : "h-full aspect-video"}
                >
                  <SpeakerTile
                    trackRef={ref}
                    isSpeaking={isSpeaking}
                    compact={!screenShareRef}
                  />
                </div>
              );
            })
          ) : (
            <div className="flex flex-1 items-center justify-center text-xs text-zinc-600">
              No camera published
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SpeakerTile({
  trackRef,
  isSpeaking,
  aspect = "aspect-video",
  className = "",
  compact = false,
}: {
  trackRef: TrackReferenceOrPlaceholder;
  isSpeaking: boolean;
  aspect?: string;
  className?: string;
  compact?: boolean;
}) {
  const { participant, publication } = trackRef;
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
        <VideoTrack trackRef={trackRef} className="size-full object-cover" />
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
