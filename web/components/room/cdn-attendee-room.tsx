"use client";

import {
  RoomContext,
  useSequentialRoomConnectDisconnect,
} from "@livekit/components-react";
import {
  DisconnectReason,
  Room,
  RoomEvent,
} from "livekit-client";
import Hls from "hls.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { JoinResponse } from "@/lib/api-types";
import { useMediaPreferences } from "@/lib/media";
import {
  useMediaPermissions,
  useLiveRole,
  useLiveCoHost,
  type MediaPermissions,
} from "@/lib/permissions";
import {
  decodeBacklog,
  useRealtime,
  useSessionControls,
  type Relay,
  type Sender,
} from "@/lib/realtime";
import { useAudiencePolls } from "@/lib/polls";
import { useHostRoster } from "./participants";
import { useNetworkHealth } from "@/lib/network";
import { useAvailableTools } from "./tools";
import { isToolVisible, useToolLayout, type ToolId } from "@/lib/tools";
import { COMPACT_STAGE_HEIGHT, useCompact } from "@/lib/compact";
import { useFileShare } from "@/lib/file-share";
import { useStageLayout } from "@/lib/layout";
import { useToast } from "../providers";
import { Spinner } from "../controls";
import { ControlBar } from "./control-bar";
import { ChatNotifications } from "./chat-notifications";
import { RoomUIProvider, type RoomUI } from "./context";
import { PollPopup } from "./poll-popup";
import { SidePanel } from "./side-panel";
import { ToolDragProvider } from "./tool-drag";
import { ToolWindows } from "./tool-windows";
import { ActiveSpeakerProvider } from "./active-speaker";
import { RecorderProvider, RecordingBanner } from "./recording";
import { FileShareBar } from "./file-share-bar";
import { MeetingLimitBanner } from "./meeting-limit-banner";
import { RoomHeader } from "./webinar-room";

export function CdnAttendeeRoom({
  join,
  slug,
  initialTopic,
  initialImageUrl,
  joinKey,
  onLeave,
  onPromoted,
}: {
  join: JoinResponse;
  slug: string;
  initialTopic: string;
  initialImageUrl?: string;
  joinKey?: string;
  onLeave: () => void;
  onPromoted: () => void;
}) {
  const { prefs, update: updatePrefs } = useMediaPreferences();
  const { notify } = useToast();

  const [room] = useState(() => new Room());

  const [failure, setFailure] = useState<string | null>(null);
  const [exit, setExit] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const onLeaveRef = useRef(onLeave);
  useEffect(() => {
    onLeaveRef.current = onLeave;
  }, [onLeave]);

  const onPromotedRef = useRef(onPromoted);
  useEffect(() => {
    onPromotedRef.current = onPromoted;
  }, [onPromoted]);

  // Session controls & metadata
  const { controls, topic, recording, startedAt, endedAt, status, maxDurationMin } =
    useSessionControls(room, join.controls, join.maxDurationMin);

  // Live roles & permissions
  const liveRole = useLiveRole(room, join.role);
  const liveCoHost = useLiveCoHost(room);

  // Real-time chat relay
  const relay = useCallback<Relay>(
    (req) => api.say(slug, joinKey ? { ...req, joinKey } : req),
    [slug, joinKey],
  );

  const me: Sender = useMemo(
    () => ({
      identity: join.identity,
      name: join.displayName,
      role: liveRole === "host" || liveRole === "panelist" ? liveRole : join.role,
    }),
    [join.identity, join.displayName, join.role, liveRole],
  );

  // Realtime hook for chat, Q&A, polls, reactions, hand-raising
  const realtime = useRealtime(
    room,
    me,
    relay,
    useMemo(
      () => ({
        onHandLowered: (reason: "granted" | "dismissed") => {
          if (reason === "granted") {
            notify("The host invited you to speak! Joining the stage...", "ok");
            onPromotedRef.current();
          } else {
            notify("The host dismissed your request to speak for now.", "info");
          }
        },
      }),
      [notify],
    ),
  );

  // Watch permissions: upgrade dynamically to stage if promoted
  const announcePermissions = useCallback(
    (next: MediaPermissions) => {
      if (next.canPublish || next.canSpeak) {
        notify("You're on the stage!", "ok");
        onPromotedRef.current();
      }
    },
    [notify],
  );

  const permissions = useMediaPermissions(room, announcePermissions);

  const { connect, disconnect } = useSequentialRoomConnectDisconnect(room);

  useEffect(() => {
    let cancelled = false;

    const onDisconnected = (reason?: DisconnectReason) => {
      if (cancelled) return;
      if (reason === DisconnectReason.CLIENT_INITIATED) {
        onLeaveRef.current();
      } else {
        setExit("disconnected");
      }
    };

    room.on(RoomEvent.Disconnected, onDisconnected);

    void connect(join.url, join.token, {
      peerConnectionTimeout: 15_000,
      websocketTimeout: 15_000,
      autoSubscribe: false,
    })
      .then(() => {
        if (!cancelled) setConnected(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFailure(err instanceof Error ? err.message : "Could not connect to data channel.");
        }
      });

    return () => {
      cancelled = true;
      room.off(RoomEvent.Disconnected, onDisconnected);
      void disconnect();
    };
  }, [room, connect, disconnect, join.url, join.token]);

  // Tools & layout
  const availableTools = useAvailableTools({ isHost: false, controls });
  const tools = useToolLayout(availableTools);
  const compact = useCompact();
  const panelOpen = compact && Boolean(tools.panelTab);

  const fileShare = useFileShare(room);
  const stage = useStageLayout();

  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const setStage = tools.setStage;
  useEffect(() => {
    setStage(stageEl);
  }, [setStage, stageEl]);

  // Chat backlog sync
  useEffect(() => {
    let cancelled = false;

    const sync = () => {
      api
        .chatBacklog(slug, realtime.chatCursor, joinKey)
        .then((backlog) => {
          if (!cancelled) realtime.mergeBacklog(decodeBacklog(backlog.messages));
        })
        .catch(() => {});
    };

    sync();
    room.on(RoomEvent.Reconnected, sync);
    room.on(RoomEvent.Connected, sync);
    return () => {
      cancelled = true;
      room.off(RoomEvent.Reconnected, sync);
      room.off(RoomEvent.Connected, sync);
    };
  }, [room, slug, joinKey, realtime.mergeBacklog, realtime.chatCursor]);

  // Unread badge counters
  const chatCount = realtime.chat.length;
  const questionCount = realtime.questions.length;
  const chatVisible = isToolVisible(tools.layout, tools.panelTab, "chat");
  const qaVisible = isToolVisible(tools.layout, tools.panelTab, "qa");

  const [seen, setSeen] = useState({ chat: 0, qa: 0 });
  const wantSeen = {
    chat: chatVisible ? chatCount : seen.chat,
    qa: qaVisible ? questionCount : seen.qa,
  };
  if (wantSeen.chat !== seen.chat || wantSeen.qa !== seen.qa) setSeen(wantSeen);

  const unread = useMemo<Record<ToolId, number>>(
    () => ({
      chat: chatVisible ? 0 : Math.max(0, chatCount - seen.chat),
      qa: qaVisible ? 0 : Math.max(0, questionCount - seen.qa),
      polls: 0,
      participants: 0,
      invite: 0,
      reactions: 0,
      hand: 0,
      layout: 0,
      settings: 0,
      host: 0,
    }),
    [chatVisible, qaVisible, chatCount, questionCount, seen],
  );

  const leave = useCallback(() => {
    void disconnect();
    onLeaveRef.current();
  }, [disconnect]);

  const roster = useHostRoster(slug, false, room);
  const polls = useAudiencePolls(slug, joinKey, realtime.pollsRevision, true);
  const network = useNetworkHealth(room, false);

  const ui = useMemo<RoomUI>(
    () => ({
      slug,
      join,
      joinKey,
      controls,
      topic: topic ?? initialTopic,
      coverImageUrl: initialImageUrl ?? null,
      startedAt: startedAt ?? join.startedAt ?? null,
      endedAt: endedAt ?? join.endedAt ?? null,
      status,
      maxDurationMin: maxDurationMin ?? join.maxDurationMin,
      recording,
      isHost: false,
      permissions,
      me,
      entryVideo: null,
      recovering: null,
      realtime,
      roster,
      polls,
      network,
      tools,
      availableTools,
      unread,
      fileShare,
      stage,
      prefs,
      updatePrefs,
      leave,
    }),
    [
      slug,
      join,
      joinKey,
      controls,
      topic,
      initialTopic,
      initialImageUrl,
      startedAt,
      endedAt,
      status,
      maxDurationMin,
      recording,
      permissions,
      me,
      realtime,
      roster,
      polls,
      network,
      tools,
      availableTools,
      unread,
      fileShare,
      stage,
      prefs,
      updatePrefs,
      leave,
    ],
  );

  if (exit) {
    return (
      <main className="grid min-h-dvh place-items-center bg-stage p-6 text-center">
        <div className="max-w-sm">
          <h1 className="text-[18px] font-semibold text-white">The webinar has ended</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-white/60">
            Thanks for coming — the host closed the session.
          </p>
          <div className="mt-5 flex justify-center">
            <button
              onClick={onLeave}
              className="rounded-lg bg-white/15 px-4 py-2 text-[13px] font-medium text-white hover:bg-white/25"
            >
              Back to webinars
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (failure) {
    return (
      <main className="grid min-h-dvh place-items-center bg-page p-6">
        <div className="w-full max-w-md text-center">
          <h1 className="text-[18px] font-semibold text-ink">Couldn&apos;t connect</h1>
          <p className="mt-2 text-[13.5px] text-ink-2">{failure}</p>
          <div className="mt-5 flex justify-center">
            <button
              onClick={onLeave}
              className="rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-white hover:bg-brand-hover"
            >
              Leave
            </button>
          </div>
        </div>
      </main>
    );
  }

  const streamUrl = join.cdnStreamUrl || `/api/webinars/${slug}/broadcast/index.m3u8`;

  return (
    <RoomContext.Provider value={room}>
      <RoomUIProvider value={ui}>
        <RecorderProvider>
          <ActiveSpeakerProvider>
            <ToolDragProvider onPin={tools.pin} onUnpin={tools.unpin}>
              <div data-room className="flex h-dvh flex-col overflow-hidden bg-stage">
                <div className="relative min-h-0 min-w-0 flex-1">
                  <div
                    ref={setStageEl}
                    data-stage
                    className="absolute inset-x-0 top-0 flex flex-col"
                    style={panelOpen ? { height: COMPACT_STAGE_HEIGHT } : { bottom: 0 }}
                  >
                    {/* CDN Stream Player */}
                    <div className="relative flex-1 flex items-center justify-center bg-black">
                      <HlsPlayer streamUrl={streamUrl} coverUrl={initialImageUrl} />
                    </div>

                    <FileShareBar />
                    <MeetingLimitBanner
                      startedAt={startedAt}
                      maxDurationMin={maxDurationMin}
                      endedByLimit={status === "ended" && Boolean(startedAt) && Boolean(maxDurationMin)}
                    />
                    <RecordingBanner />
                    <ChatNotifications chatVisible={chatVisible} />
                  </div>

                  <PollPopup />
                  <RoomHeader />
                  <SidePanel />
                </div>

                <ControlBar />
              </div>

              <ToolWindows />
            </ToolDragProvider>
          </ActiveSpeakerProvider>
        </RecorderProvider>
      </RoomUIProvider>
    </RoomContext.Provider>
  );
}

function HlsPlayer({
  streamUrl,
  coverUrl,
}: {
  streamUrl: string;
  coverUrl?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: Hls | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const tryPlay = () => {
      video.play().catch(() => {
        // Autoplay policy prevented audio, mute and play with unmute button
        video.muted = true;
        setIsMuted(true);
        video.play().catch(() => {});
      });
    };

    if (Hls.isSupported()) {
      hls = new Hls({
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 6,
        enableWorker: true,
        lowLatencyMode: true,
        manifestLoadingMaxRetry: 30,
        manifestLoadingRetryDelay: 1500,
        manifestLoadingMaxRetryTimeout: 120000,
        levelLoadingMaxRetry: 15,
        levelLoadingRetryDelay: 1500,
      });

      hls.loadSource(streamUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setLoading(false);
        setError(null);
        tryPlay();
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              setError("Connecting to live broadcast stream...");
              retryTimer = setTimeout(() => {
                if (hls) {
                  hls.loadSource(streamUrl);
                  hls.startLoad();
                }
              }, 2000);
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls?.recoverMediaError();
              break;
            default:
              retryTimer = setTimeout(() => {
                if (hls) {
                  hls.loadSource(streamUrl);
                  hls.startLoad();
                }
              }, 2000);
              break;
          }
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = streamUrl;
      const onLoadedMetadata = () => {
        setLoading(false);
        setError(null);
        tryPlay();
      };
      const onNativeError = () => {
        setError("Connecting to live broadcast stream...");
        retryTimer = setTimeout(() => {
          if (video && video.paused) {
            video.src = streamUrl;
            video.load();
          }
        }, 2000);
      };
      video.addEventListener("loadedmetadata", onLoadedMetadata);
      video.addEventListener("error", onNativeError);

      return () => {
        clearTimeout(retryTimer);
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        video.removeEventListener("error", onNativeError);
      };
    } else {
      setError("HLS playback is not supported by your browser.");
    }

    return () => {
      clearTimeout(retryTimer);
      if (hls) {
        hls.destroy();
      }
    };
  }, [streamUrl]);

  const unmute = () => {
    if (videoRef.current) {
      videoRef.current.muted = false;
      setIsMuted(false);
      void videoRef.current.play();
    }
  };

  return (
    <div className="relative h-full w-full flex items-center justify-center bg-black">
      <video
        ref={videoRef}
        playsInline
        controls
        autoPlay
        onPlay={() => setLoading(false)}
        onVolumeChange={(e) => {
          setIsMuted((e.target as HTMLVideoElement).muted);
        }}
        poster={coverUrl}
        className="h-full w-full object-contain"
      />

      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 text-white gap-3 pointer-events-none z-10">
          <Spinner className="size-8 text-brand" />
          <p className="text-[13px] text-ink-3">
            {error || "Connecting to broadcast stream..."}
          </p>
        </div>
      )}

      {isMuted && !loading && (
        <button
          type="button"
          onClick={unmute}
          className="absolute bottom-16 left-6 z-20 flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-[13px] font-semibold text-white shadow-lg transition hover:bg-brand-hover"
        >
          <span className="inline-block size-2 rounded-full bg-white animate-pulse" />
          Click to Unmute Broadcast
        </button>
      )}
    </div>
  );
}
