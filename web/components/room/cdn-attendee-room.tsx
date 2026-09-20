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
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { API_BASE, api } from "@/lib/api";
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
import { FullscreenIcon, VolumeIcon, VolumeMuteIcon } from "../icons";
import { ControlBar } from "./control-bar";
import { ChatNotifications } from "./chat-notifications";
import { RoomUIProvider, type RoomUI } from "./context";
import { PollPopup } from "./poll-popup";
import { CtaPopup } from "./cta-popup";
import { CaptionOverlay } from "./caption-overlay";
import { StageInviteDialog } from "./stage-invite-dialog";
import { SidePanel } from "./side-panel";
import { ToolDragProvider } from "./tool-drag";
import { ToolWindows } from "./tool-windows";
import { ActiveSpeakerProvider } from "./active-speaker";
import { RecorderProvider, RecordingBanner } from "./recording";
import { FileShareBar } from "./file-share-bar";
import { MeetingLimitBanner } from "./meeting-limit-banner";
import { RoomHeader } from "./webinar-room";

function resolveBroadcastUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = API_BASE.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

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
          if (reason !== "granted") {
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
      cdnStage: true,
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

  // Always set when the server puts this webinar in CDN mode: with the S3
  // playlist gone there is no second URL to guess at, so join turns CDN mode
  // off entirely rather than send an attendee here with nothing to play.
  const streamUrl = resolveBroadcastUrl(join.cdnStreamUrl || "");

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
                      <BroadcastPlayer
                        streamUrl={streamUrl}
                        lowLatency={Boolean(join.cdnLowLatency)}
                        coverUrl={initialImageUrl}
                      />
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
                  <CtaPopup />
                  <CaptionOverlay />
                  <StageInviteDialog onAccepted={() => onPromotedRef.current()} />
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

function isWhepUrl(url: string) {
  return /\/whep(\?|$)/i.test(url);
}

function BroadcastPlayer({
  streamUrl,
  lowLatency,
  coverUrl,
}: {
  streamUrl: string;
  lowLatency?: boolean;
  coverUrl?: string;
}) {
  if (isWhepUrl(streamUrl)) {
    return <WhepPlayer streamUrl={streamUrl} coverUrl={coverUrl} />;
  }
  return (
    <HlsPlayer
      streamUrl={streamUrl}
      lowLatency={lowLatency}
      coverUrl={coverUrl}
    />
  );
}

async function waitIceGathering(pc: RTCPeerConnection, ms = 2500) {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const t = window.setTimeout(resolve, ms);
    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        window.clearTimeout(t);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

function WhepPlayer({
  streamUrl,
  coverUrl,
}: {
  streamUrl: string;
  coverUrl?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(true);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let sessionUrl: string | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let tearingDown = false;

    const tryPlay = () => {
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "true");
      video.muted = true;
      setIsMuted(true);
      video.play().catch(() => {});
    };

    const teardown = () => {
      tearingDown = true;
      if (sessionUrl) {
        void fetch(sessionUrl, { method: "DELETE" }).catch(() => {});
        sessionUrl = null;
      }
      if (pc) {
        pc.close();
        pc = null;
      }
      video.srcObject = null;
    };

    const connect = async () => {
      teardown();
      if (cancelled) return;
      tearingDown = false;

      pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      pc.ontrack = (ev) => {
        if (cancelled || !video) return;
        video.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
        setLoading(false);
        setError(null);
        tryPlay();
      };
      pc.onconnectionstatechange = () => {
        if (tearingDown || cancelled || !pc) return;
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          setError("Waiting for the broadcast to start...");
          setLoading(true);
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => {
            void connect();
          }, 1500);
        }
      };

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitIceGathering(pc);
        const sdp = pc.localDescription?.sdp;
        if (!sdp) throw new Error("no local sdp");

        const res = await fetch(streamUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/sdp",
            Accept: "application/sdp",
          },
          body: sdp,
        });

        if (cancelled) return;

        if (!res.ok) {
          /* 404 is the normal state before the host goes live: Egress has to
           * boot Chromium and connect RTMP before the origin has a stream.
           *
           * Anything else is the origin refusing us, and saying "waiting for
           * the broadcast" to that is how a misconfigured origin cost a whole
           * session — it rejected every viewer with 401 while the mix was
           * publishing, and the room sat on a spinner that read as "the host
           * has not started yet". Still retry, but do not claim to know why. */
          const waiting =
            res.status === 404 || res.status === 406 || res.status === 425;
          if (!waiting) {
            console.error(`whep ${res.status} from ${streamUrl}`);
          }
          setError(
            waiting
              ? "Waiting for the broadcast to start..."
              : "Reconnecting to the broadcast...",
          );
          setLoading(true);
          teardown();
          retryTimer = setTimeout(() => {
            void connect();
          }, waiting ? 1500 : 4000);
          return;
        }

        const loc = res.headers.get("Location");
        if (loc) {
          sessionUrl = new URL(loc, streamUrl).toString();
        }
        const answer = await res.text();
        await pc.setRemoteDescription({ type: "answer", sdp: answer });
      } catch {
        if (cancelled) return;
        setError("Waiting for the broadcast to start...");
        setLoading(true);
        teardown();
        retryTimer = setTimeout(() => {
          void connect();
        }, 1500);
      }
    };

    void connect();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      teardown();
    };
  }, [streamUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const resume = () => {
      if (document.visibilityState === "visible" && video.paused) {
        video.play().catch(() => {
          video.muted = true;
          setIsMuted(true);
          video.play().catch(() => {});
        });
      }
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", resume);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", resume);
    };
  }, [streamUrl]);

  return (
    <StagePlayerChrome
      videoRef={videoRef}
      loading={loading}
      error={error}
      isMuted={isMuted}
      coverUrl={coverUrl}
      onMutedChange={setIsMuted}
      onReady={() => {
        setLoading(false);
        setError(null);
      }}
      unmute={() => {
        if (videoRef.current) {
          videoRef.current.muted = false;
          setIsMuted(false);
          void videoRef.current.play();
        }
      }}
      toggleMute={() => {
        const video = videoRef.current;
        if (!video) return;
        video.muted = !video.muted;
        setIsMuted(video.muted);
        if (!video.muted) void video.play();
      }}
      toggleFullscreen={() => {
        const el = videoRef.current?.parentElement;
        if (!el) return;
        if (document.fullscreenElement) {
          void document.exitFullscreen();
        } else {
          void el.requestFullscreen?.();
        }
      }}
    />
  );
}

function HlsPlayer({
  streamUrl,
  lowLatency,
  coverUrl,
}: {
  streamUrl: string;
  lowLatency?: boolean;
  coverUrl?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const activeUrl = streamUrl;
  const ll = Boolean(lowLatency);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: Hls | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const tryPlay = () => {
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "true");
      video.muted = true;
      setIsMuted(true);
      video.play().catch(() => {});
    };

    const isPlaylist = /\.m3u8(\?|$)/i.test(activeUrl);
    if (!isPlaylist) {
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.muted = true;
      setIsMuted(true);
      video.src = activeUrl;
      const onLoaded = () => {
        setLoading(false);
        tryPlay();
      };
      video.addEventListener("loadedmetadata", onLoaded);
      video.addEventListener("error", () => {
        setError("Could not play this recording.");
        setLoading(false);
      });
      return () => {
        video.removeEventListener("loadedmetadata", onLoaded);
        video.removeAttribute("src");
        video.load();
      };
    }

    if (Hls.isSupported()) {
      hls = new Hls({
        /* Do not set liveSyncDurationCount in low-latency mode.
         *
         * hls.js only honours the playlist's PART-HOLD-BACK (0.585s here) if
         * the caller left liveSyncDurationCount and liveSyncDuration unset —
         * providing either makes it fall back to liveSyncDurationCount *
         * targetduration instead. With 2-second segments that pinned the
         * target latency at ~4s and quietly threw away the entire benefit of
         * 200ms parts. Omitting these is what makes LL-HLS actually low
         * latency; the counts below apply only to the non-LL path.
         *
         * liveDurationInfinity keeps the media duration at Infinity so the
         * element behaves like a live stream rather than a growing file. */
        ...(ll
          ? { liveDurationInfinity: true }
          : { liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 8 }),
        // Let the player nudge up to 1.5x to close a gap instead of waiting
        // for it to drain on its own.
        maxLiveSyncPlaybackRate: ll ? 1.5 : 1,
        enableWorker: true,
        // MediaMTX serves LL-HLS with 200ms parts and CAN-BLOCK-RELOAD.
        lowLatencyMode: ll,
        manifestLoadingMaxRetry: 120,
        manifestLoadingRetryDelay: 1000,
        manifestLoadingMaxRetryTimeout: 300000,
        levelLoadingMaxRetry: 60,
        levelLoadingRetryDelay: 1000,
        fragLoadingMaxRetry: 60,
        fragLoadingRetryDelay: 1000,
      });

      hls.loadSource(activeUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setLoading(false);
        setError(null);
        tryPlay();
      });

      hls.on(Hls.Events.LEVEL_LOADED, () => {
        setLoading(false);
        setError(null);
      });

      hls.on(Hls.Events.FRAG_LOADED, () => {
        setLoading(false);
        setError(null);
      });

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        setLoading(false);
        setError(null);
        if (video.paused) {
          tryPlay();
        }
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          switch (data.type) {
            /* Retry rather than surface a failure. The live origin 404s for
             * the first seconds of every broadcast — Egress has to boot
             * Chromium and connect RTMP before MediaMTX has a playlist — and
             * that is indistinguishable from "the host has not started yet".
             * There is no second feed to switch to, so waiting is the only
             * correct behaviour. */
            case Hls.ErrorTypes.NETWORK_ERROR:
              setError("Waiting for the broadcast to start...");
              clearTimeout(retryTimer);
              retryTimer = setTimeout(() => {
                if (hls) {
                  hls.startLoad();
                }
              }, 1500);
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls?.recoverMediaError();
              break;
            default:
              clearTimeout(retryTimer);
              retryTimer = setTimeout(() => {
                if (hls) {
                  hls.startLoad();
                }
              }, 1500);
              break;
          }
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = activeUrl;
      const onLoadedMetadata = () => {
        setLoading(false);
        setError(null);
        tryPlay();
      };
      const onNativeError = () => {
        setError("Waiting for the broadcast to start...");
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          if (video && video.paused) {
            video.src = activeUrl;
            video.load();
          }
        }, 1500);
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
  }, [activeUrl, ll]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const resume = () => {
      if (document.visibilityState === "visible" && video.paused) {
        video.play().catch(() => {
          video.muted = true;
          setIsMuted(true);
          video.play().catch(() => {});
        });
      }
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", resume);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", resume);
    };
  }, [activeUrl]);

  const unmute = () => {
    if (videoRef.current) {
      videoRef.current.muted = false;
      setIsMuted(false);
      void videoRef.current.play();
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
    if (!video.muted) void video.play();
  };

  const toggleFullscreen = () => {
    const el = videoRef.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen?.();
    }
  };

  return (
    <StagePlayerChrome
      videoRef={videoRef}
      loading={loading}
      error={error}
      isMuted={isMuted}
      coverUrl={coverUrl}
      onMutedChange={setIsMuted}
      onReady={() => {
        setLoading(false);
        setError(null);
      }}
      unmute={unmute}
      toggleMute={toggleMute}
      toggleFullscreen={toggleFullscreen}
    />
  );
}

function StagePlayerChrome({
  videoRef,
  loading,
  error,
  isMuted,
  coverUrl,
  onMutedChange,
  onReady,
  unmute,
  toggleMute,
  toggleFullscreen,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  loading: boolean;
  error: string | null;
  isMuted: boolean;
  coverUrl?: string;
  onMutedChange: (muted: boolean) => void;
  onReady?: () => void;
  unmute: () => void;
  toggleMute: () => void;
  toggleFullscreen: () => void;
}) {
  return (
    <div className="relative h-full w-full flex items-center justify-center bg-black">
      {/* No `controls`. This is a live stage, not a file: a scrubber invites
        * seeking on a stream that has nowhere to seek to, and the native menu
        * offers playback speed, download and PiP, none of which mean anything
        * for a broadcast. The attributes below are belt-and-braces for the
        * places a browser shows its own UI anyway, notably iOS fullscreen.
        * Volume and fullscreen live in the overlay instead. */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        disablePictureInPicture
        controlsList="nodownload noplaybackrate noremoteplayback"
        preload="auto"
        onPlay={() => onReady?.()}
        onPlaying={() => onReady?.()}
        onTimeUpdate={() => {
          if (videoRef.current && videoRef.current.currentTime > 0) {
            onReady?.();
          }
        }}
        onCanPlay={() => onReady?.()}
        onCanPlayThrough={() => onReady?.()}
        onLoadedData={() => onReady?.()}
        poster={coverUrl}
        className="h-full w-full object-contain"
        onVolumeChange={(e) => {
          onMutedChange((e.target as HTMLVideoElement).muted);
        }}
      />

      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 text-white gap-3 pointer-events-none z-10">
          <Spinner className="size-8 text-brand" />
          <p className="text-[13px] text-ink-3">
            {error || "Waiting for the broadcast to start..."}
          </p>
        </div>
      )}

      {!loading && (
        <div className="absolute left-4 top-4 z-20 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white backdrop-blur">
          <span className="inline-block size-1.5 rounded-full bg-red-500 animate-pulse" />
          Live
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

      {!loading && (
        <div className="absolute bottom-4 right-4 z-20 flex items-center gap-1 rounded-full bg-black/55 p-1 backdrop-blur">
          <button
            type="button"
            onClick={toggleMute}
            aria-label={isMuted ? "Unmute broadcast" : "Mute broadcast"}
            title={isMuted ? "Unmute" : "Mute"}
            className="grid size-8 place-items-center rounded-full text-white/90 transition hover:bg-white/15 hover:text-white"
          >
            {isMuted ? (
              <VolumeMuteIcon className="size-4" />
            ) : (
              <VolumeIcon className="size-4" />
            )}
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label="Toggle fullscreen"
            title="Fullscreen"
            className="grid size-8 place-items-center rounded-full text-white/90 transition hover:bg-white/15 hover:text-white"
          >
            <FullscreenIcon className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
