"use client";

import { Suspense, useEffect, useState, useMemo, useRef } from "react";
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
  const searchParams = useSearchParams();
  const [params, setParams] = useState<{ url: string; token: string }>({ url: "", token: "" });

  useEffect(() => {
    let url = searchParams.get("url") || "";
    let token = searchParams.get("token") || "";

    if (!url || !token) {
      if (typeof window !== "undefined") {
        const sp = new URLSearchParams(window.location.search);
        url = url || sp.get("url") || "";
        token = token || sp.get("token") || "";
      }
    }

    if (url && token) {
      setParams({ url, token });
    }
  }, [searchParams]);

  const { url, token } = params;

  if (!url || !token) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black text-zinc-600 font-mono text-sm">
        Waiting for LiveKit Egress parameters (?url=...&token=...)
      </div>
    );
  }

  return (
    <LiveKitRoom
      serverUrl={url}
      token={token}
      connect={true}
      audio={true}
      video={true}
      onConnected={() => {
        console.log("START_RECORDING");
      }}
      onDisconnected={() => {
        console.log("END_RECORDING");
      }}
      className="fixed inset-0 h-screen w-screen overflow-hidden bg-black select-none"
    >
      <RoomAudioRenderer />
      <ZoomRecordingStage />
    </LiveKitRoom>
  );
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

    return () => {
      room.off(RoomEvent.Connected, signalStart);
      room.off(RoomEvent.ActiveSpeakersChanged, onSpeakers);
      room.off(RoomEvent.Disconnected, onDisconnected);
      console.log("END_RECORDING");
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

  // If a screen is being shared: ZOOM SIDE-BY-SIDE RECORDING LAYOUT
  if (screenShareRef) {
    return (
      <div className="flex h-full w-full bg-black">
        {/* Left 78%: Full presentation screen share */}
        <div className="relative flex-1 h-full min-w-0 flex items-center justify-center bg-black p-1">
          <VideoTrack
            trackRef={screenShareRef}
            className="size-full object-contain"
          />
        </div>

        {/* Right 22%: Vertical filmstrip of speakers */}
        <div className="w-[22%] min-w-[240px] max-w-[340px] h-full bg-zinc-950/90 border-l border-zinc-800/80 p-2 flex flex-col gap-2.5 overflow-hidden">
          {cameraRefs.length > 0 ? (
            cameraRefs.map((ref) => {
              const isSpeaking =
                ref.participant.identity === activeSpeakerId || ref.participant.isSpeaking;
              return (
                <SpeakerTile
                  key={ref.participant.identity}
                  trackRef={ref}
                  isSpeaking={isSpeaking}
                  aspect="aspect-video"
                />
              );
            })
          ) : (
            <div className="flex flex-1 items-center justify-center text-xs text-zinc-600">
              No camera published
            </div>
          )}
        </div>
      </div>
    );
  }

  // If NO screen is being shared: ZOOM ACTIVE SPEAKER RECORDING LAYOUT
  const primarySpeaker = cameraRefs[0];
  const otherSpeakers = cameraRefs.slice(1);

  if (!primarySpeaker) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black text-zinc-600 font-mono text-sm">
        Waiting for webinar presenter to start video...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full bg-black">
      {/* Top filmstrip if there are other speakers on stage */}
      {otherSpeakers.length > 0 && (
        <div className="h-28 shrink-0 flex items-center justify-center gap-2 px-3 py-1.5 bg-zinc-950/80 border-b border-zinc-800/60">
          {otherSpeakers.slice(0, 5).map((ref) => {
            const isSpeaking =
              ref.participant.identity === activeSpeakerId || ref.participant.isSpeaking;
            return (
              <div key={ref.participant.identity} className="h-full aspect-video">
                <SpeakerTile trackRef={ref} isSpeaking={isSpeaking} compact />
              </div>
            );
          })}
        </div>
      )}

      {/* Main active speaker centered */}
      <div className="flex-1 min-h-0 relative flex items-center justify-center p-3 bg-black">
        <SpeakerTile
          trackRef={primarySpeaker}
          isSpeaking={
            primarySpeaker.participant.identity === activeSpeakerId ||
            primarySpeaker.participant.isSpeaking
          }
          className="size-full max-w-7xl max-h-full"
        />
      </div>
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
