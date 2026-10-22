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
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { API_BASE, api } from "@/lib/api";
import type { JoinResponse } from "@/lib/api-types";
import { useMediaPreferences } from "@/lib/media";
import {
  useMediaPermissions,
  useLiveCoHost,
  useLiveRole,
  type MediaPermissions,
} from "@/lib/permissions";
import {
  useRealtime,
  useSessionControls,
  type Realtime,
  type Relay,
  type Sender,
} from "@/lib/realtime";
import { simuliveWaiting, startPositionSec, sharedPositionMs } from "@/lib/simulive-replay";
import { useSimuliveReplay } from "@/lib/use-simulive-replay";
import { countSince } from "@/lib/room-history";
import { useRoomHistory } from "@/lib/room-history-sync";
import { useAudiencePolls } from "@/lib/polls";
import { useHostRoster } from "./participants";
import { useNetworkHealth } from "@/lib/network";
import { useAvailableTools } from "./tools";
import { isToolVisible, useToolLayout, type ToolId } from "@/lib/tools";
import { stageFrame, useCompact } from "@/lib/compact";
import { useFileShare } from "@/lib/file-share";
import { canElementFullscreen, useFullscreen } from "@/lib/fullscreen";
import { playerControls, simuliveCorrection, SIMULIVE_BLOCKED_KEYS } from "@/lib/simulive-clock";
import { isAutoplayRefusal, tryWithSound } from "@/lib/autoplay-sound";
import { takePrimedVideo } from "@/lib/media-unlock";
import { useStageLayout } from "@/lib/layout";
import { useMentionBadge } from "@/lib/use-mentions";
import { useToast } from "../providers";
import { Spinner } from "../controls";
import { FullscreenExitIcon, FullscreenIcon, VolumeIcon, VolumeMuteIcon } from "../icons";
import { ControlBar } from "./control-bar";
import { ChatNotifications } from "./chat-notifications";
import { RoomUIProvider, type RoomUI } from "./context";
import { PollPopup } from "./poll-popup";
import { SimuliveWaiting } from "./simulive-waiting";
import { SurveyPopup } from "./survey-popup";
import { SessionSurvey } from "../survey/session-survey";
import { useAudienceSurvey } from "@/lib/use-audience-survey";
import { CtaPopup } from "./cta-popup";
import { CaptionOverlay } from "./caption-overlay";
import { useSelfHandToasts, type SelfHandEvent } from "./self-hand-toasts";
import { RaisedHandsProvider, useRaisedHandsController } from "./raised-hands-panel";
import { SidePanel } from "./side-panel";
import { ToolDragProvider } from "./tool-drag";
import { ToolWindows } from "./tool-windows";
import { ActiveSpeakerProvider } from "./active-speaker";
import { RecorderProvider, RecordingBanner } from "./recording";
import { FileShareBar } from "./file-share-bar";
import { MeetingLimitBanner, endedByLimit } from "./meeting-limit-banner";
import { RoomHeader } from "./webinar-room";
import { useScreenWakeLock } from "@/lib/wake-lock";
import { CAPTIONS_LABEL, showCaptions } from "@/lib/caption-track";
import { useCaptionTrack } from "@/lib/use-caption-track";
import { CcButton } from "../cc-button";

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
  presenter = false,
}: {
  join: JoinResponse;
  slug: string;
  initialTopic: string;
  initialImageUrl?: string;
  joinKey?: string;
  onLeave: () => void;
  onPromoted: () => void;
  /** The host team dropping into a simulive (JoinResponse.simulive): they watch the
   *  recording like the audience, and chat, answer and moderate as the host. Their grant
   *  publishes no audio or video (lk.Spec.NoMedia), so nothing of theirs reaches anyone. */
  presenter?: boolean;
}) {
  const { prefs, update: updatePrefs } = useMediaPreferences();
  // A phone left to watch must not auto-lock mid-webinar (lib/wake-lock.ts).
  useScreenWakeLock();

  const [room] = useState(() => new Room());

  const [failure, setFailure] = useState<string | null>(null);
  const [exit, setExit] = useState<string | null>(null);
  const [, setConnected] = useState(false);

  const onLeaveRef = useRef(onLeave);
  useEffect(() => {
    onLeaveRef.current = onLeave;
  }, [onLeave]);

  const onPromotedRef = useRef(onPromoted);
  useEffect(() => {
    onPromotedRef.current = onPromoted;
  }, [onPromoted]);

  // Session controls & metadata
  const {
    controls,
    topic,
    recording,
    recordingStartedAt,
    startedAt,
    endedAt,
    status,
    maxDurationMin,
  } = useSessionControls(room, join.controls, join.maxDurationMin);

  // Live roles & permissions
  const liveRole = useLiveRole(room, join.role);
  // The host, or a co-host, dropping into a simulive (see `presenter`). Never an attendee.
  const isCoHost = useLiveCoHost(room);
  const isHost = presenter && (liveRole === "host" || isCoHost);

  // Real-time chat relay
  const relay = useCallback<Relay>(
    (req) => api.say(slug, joinKey ? { ...req, joinKey } : req),
    [slug, joinKey],
  );

  const me: Sender = useMemo(
    () => ({
      identity: join.identity,
      name: join.displayName,
      /* The live role, never the join response's. useLiveRole already starts
       * from join.role and only moves on live metadata, so it is the fresher of
       * the two. Falling back to join.role when the live role said "attendee"
       * kept a demoted attendee a "panelist": someone who joined while on stage
       * (join.role "panelist") and was then moved back to the audience still
       * got the host-only Raised hands queue next to Raise hand, and their
       * chat messages kept a Panelist badge. */
      role: liveRole,
    }),
    [join.identity, join.displayName, liveRole],
  );

  // Filled in below, once `realtime` exists: the hand and stage toasts' bridge.
  const selfHand = useRef<((event: SelfHandEvent) => void) | null>(null);

  // Realtime hook for chat, Q&A, polls, reactions, hand-raising
  const realtime = useRealtime(
    room,
    me,
    relay,
    useMemo(
      () => ({
        onHandLowered: (reason: "granted" | "dismissed") => {
          selfHand.current?.({ kind: "lowered", reason });
        },
        onHandsCleared: () => {
          selfHand.current?.({ kind: "lowered", reason: "cleared" });
        },
      }),
      [],
    ),
  );

  // This person's own hand and stage, as the WebRTC room shows them (self-hand-toasts.tsx).
  // On accepting an invite this room is replaced by the stage and nothing after the
  // remount announces it, so the card says "You're on stage" here.
  const announceSelfHand = useSelfHandToasts({
    slug,
    joinKey,
    handRaised: realtime.myHandRaised,
    invite: realtime.stageInvite,
    recording,
    canRaise: controls.raiseHandEnabled,
    toggleHand: realtime.toggleHand,
    dismissInvite: realtime.dismissStageInvite,
    onAccepted: useCallback(() => onPromotedRef.current(), []),
  });
  useEffect(() => {
    selfHand.current = announceSelfHand;
  }, [announceSelfHand]);

  // Watch permissions: upgrade dynamically to stage if promoted
  const announcePermissions = useCallback(
    (next: MediaPermissions) => {
      if (next.canPublish || next.canSpeak) {
        selfHand.current?.({ kind: "stage", arrival: next.canPublish ? "stage" : "speak" });
        onPromotedRef.current();
      }
    },
    [],
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
  const availableTools = useAvailableTools({ isHost, controls, streaming: true });
  const tools = useToolLayout(availableTools);
  const raisedHands = useRaisedHandsController(tools);
  const compact = useCompact();
  const panelOpen = Boolean(tools.panelTab) || raisedHands.open;

  const fileShare = useFileShare(room);
  const stage = useStageLayout();

  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const setStage = tools.setStage;
  useEffect(() => {
    setStage(stageEl);
  }, [setStage, stageEl]);

  // Chat and Q&A history, on joining and after every reconnect. See useRoomHistory.
  useRoomHistory(room, slug, joinKey, realtime);

  /* A simulive's one shared clock: the server's start, from room metadata, the join, or the
   * waiting screen asking. Until there is one, nothing plays (SimuliveWaiting). */
  const [polledStart, setPolledStart] = useState<string | null>(null);
  const liveStart = startedAt || polledStart || join.startedAt || null;
  const waiting = simuliveWaiting(Boolean(join.simulive), liveStart);

  /* A simulive's engagement replay (lib/simulive-replay.ts): the original session's chat and
   * Q&A, scheduled against this player's own position and folded into the room's
   * conversation alongside what this audience says live; its polls re-read as their moments
   * pass, and its reactions floated. Everything below reads `shown`. */
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const replayed = useSimuliveReplay({
    slug,
    joinKey,
    enabled: Boolean(join.simulive && join.replayEngage),
    video: videoEl,
    startedAt: liveStart,
    chat: realtime.chat,
    questions: realtime.questions,
    showReaction: realtime.showReaction,
  });
  const shown = useMemo<Realtime>(
    () =>
      replayed.chat === realtime.chat && replayed.questions === realtime.questions
        ? realtime
        : { ...realtime, chat: replayed.chat, questions: replayed.questions },
    [realtime, replayed],
  );

  // Unread badge counters. History read back on mount predates this page and is not
  // counted — see the same watermark in webinar-room.tsx.
  const chatCount = shown.chat.length;
  const questionCount = shown.questions.length;
  const chatVisible = isToolVisible(tools.layout, tools.panelTab, "chat", tools.poppedOut);
  const qaVisible = isToolVisible(tools.layout, tools.panelTab, "qa", tools.poppedOut);

  const [seen, setSeen] = useState({ chat: 0, qa: 0 });
  const [mountedAt] = useState(() => Date.now());
  const wantSeen = {
    chat: chatVisible ? chatCount : seen.chat,
    qa: qaVisible ? questionCount : seen.qa,
  };
  if (wantSeen.chat !== seen.chat || wantSeen.qa !== seen.qa) setSeen(wantSeen);

  // By id, not by count — see useMentionBadge.
  const mentions = useMentionBadge(shown.chat, me.identity, chatVisible);

  const unread = useMemo<Record<ToolId, number>>(
    () => ({
      chat: chatVisible
        ? 0
        : Math.min(
            Math.max(0, chatCount - seen.chat),
            countSince(shown.chat, mountedAt, me.identity),
          ),
      qa: qaVisible
        ? 0
        : Math.min(
            Math.max(0, questionCount - seen.qa),
            countSince(shown.questions, mountedAt, me.identity),
          ),
      polls: 0,
      participants: 0,
      invite: 0,
      reactions: 0,
      hand: 0,
      layout: 0,
      settings: 0,
      host: 0,
      captions: 0,
      sharefile: 0,
      youtube: 0,
      linkedin: 0,
      instagram: 0,
      facebook: 0,
      whiteboard: 0,
    }),
    [chatVisible, qaVisible, chatCount, questionCount, seen, shown.chat, shown.questions, mountedAt, me.identity],
  );

  const leave = useCallback(() => {
    void disconnect();
    onLeaveRef.current();
  }, [disconnect]);

  const roster = useHostRoster(slug, isHost, room);
  const polls = useAudiencePolls(
    slug,
    joinKey,
    realtime.pollsRevision + replayed.pollsRevision,
    !isHost,
    controls.pollsEnabled,
    room,
  );
  const survey = useAudienceSurvey(slug, joinKey, realtime.surveyRevision, !isHost);
  const network = useNetworkHealth(room, false);

  const ui = useMemo<RoomUI>(
    () => ({
      slug,
      join,
      joinKey,
      controls,
      topic: topic ?? initialTopic,
      coverImageUrl: initialImageUrl ?? null,
      startedAt: liveStart,
      endedAt: endedAt ?? join.endedAt ?? null,
      status,
      maxDurationMin: maxDurationMin ?? join.maxDurationMin,
      recording,
      recordingStartedAt,
      isHost,
      permissions,
      me,
      entryVideo: null,
      recovering: null,
      over: false,
      markEnding: () => undefined,
      realtime: shown,
      roster,
      polls,
      network,
      tools,
      availableTools,
      unread,
      mentions,
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
      liveStart,
      endedAt,
      status,
      maxDurationMin,
      recording,
      recordingStartedAt,
      isHost,
      permissions,
      me,
      shown,
      roster,
      polls,
      network,
      tools,
      availableTools,
      unread,
      mentions,
      fileShare,
      stage,
      prefs,
      updatePrefs,
      leave,
    ],
  );

  // The server announces the end in room metadata before it closes the room, so the ended
  // screen shows at once instead of the player first saying "Reconnecting to the broadcast…"
  // as the stream goes away.
  if (exit || status === "ended") {
    return (
      <main className="grid min-h-dvh place-items-center bg-stage p-4 text-center sm:p-6">
        <div className="flex w-full max-w-[460px] flex-col items-center">
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
          <SessionSurvey slug={slug} joinKey={joinKey} className="mt-6" />
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
            <RaisedHandsProvider value={raisedHands}>
            <ToolDragProvider onPin={tools.pin} onUnpin={tools.unpin}>
              <div data-room className="flex h-dvh flex-col overflow-hidden bg-stage">
                <div className="relative min-h-0 min-w-0 flex-1">
                  <div
                    ref={setStageEl}
                    data-stage
                    className="absolute inset-x-0 top-12 flex flex-col"
                    style={stageFrame(compact, panelOpen)}
                  >
                    {/* CDN Stream Player */}
                    <div className="relative flex-1 flex items-center justify-center bg-black">
                      {waiting ? (
                        <SimuliveWaiting
                          slug={slug}
                          startsAt={join.startsAt}
                          manual={Boolean(join.simuliveManual)}
                          canStart={isHost && Boolean(join.simuliveManual)}
                          coverUrl={initialImageUrl}
                          onStarted={setPolledStart}
                        />
                      ) : (
                      <BroadcastPlayer
                        streamUrl={streamUrl}
                        lowLatency={Boolean(join.cdnLowLatency)}
                        coverUrl={initialImageUrl}
                        onVideo={setVideoEl}
                        // A simulive's CC: the original session's captions (lib/caption-track.ts).
                        captionsUrl={
                          join.simuliveCaptions ? api.simuliveCaptionsURL(slug, joinKey) : undefined
                        }
                        // A simulive is one shared clock: joining late starts where everybody
                        // else is, not at the top of the recording.
                        sharedStartMs={
                          join.simulive
                            ? () => sharedPositionMs(liveStart, Date.now())
                            : undefined
                        }
                      />
                      )}
                    </div>

                    <FileShareBar />
                    <MeetingLimitBanner
                      startedAt={startedAt}
                      maxDurationMin={maxDurationMin}
                      endedByLimit={endedByLimit({
                      status,
                      startedAt,
                      endedAt: endedAt ?? join.endedAt ?? null,
                      maxDurationMin,
                    })}
                    />
                    <RecordingBanner />
                    <ChatNotifications chatVisible={chatVisible} />
                  </div>

                  <PollPopup />
                  <SurveyPopup
                    slug={slug}
                    joinKey={joinKey}
                    survey={survey.data}
                    onChange={survey.replace}
                    enabled
                  />
                  <CtaPopup />
                  <CaptionOverlay />
                  <RoomHeader />
                  <SidePanel />
                </div>

                <ControlBar />
              </div>

              <ToolWindows />
            </ToolDragProvider>
            </RaisedHandsProvider>
          </ActiveSpeakerProvider>
        </RecorderProvider>
      </RoomUIProvider>
    </RoomContext.Provider>
  );
}

/* The broadcast room's player: HLS or a file, which is what a simulive attendee plays (the
 * recording). It used to choose a WHEP player for the live CDN Broadcast mode; that mode
 * was retired (2026-10-20) and live big audiences are on Edge delivery. */
function BroadcastPlayer({
  streamUrl,
  lowLatency,
  coverUrl,
  onVideo,
  sharedStartMs,
  captionsUrl,
}: {
  streamUrl: string;
  lowLatency?: boolean;
  coverUrl?: string;
  onVideo?: (video: HTMLVideoElement | null) => void;
  sharedStartMs?: () => number | null;
  captionsUrl?: string;
}) {
  return (
    <HlsPlayer
      streamUrl={streamUrl}
      lowLatency={lowLatency}
      coverUrl={coverUrl}
      onVideo={onVideo}
      sharedStartMs={sharedStartMs}
      captionsUrl={captionsUrl}
    />
  );
}

function isPlaylistUrl(url: string): boolean {
  return /\.m3u8(\?|$)/i.test(url);
}

function HlsPlayer({
  streamUrl,
  lowLatency,
  coverUrl,
  onVideo,
  sharedStartMs,
  captionsUrl,
}: {
  streamUrl: string;
  lowLatency?: boolean;
  coverUrl?: string;
  /** A WebVTT file for a <track> on the element, with a CC switch (lib/caption-track.ts). */
  captionsUrl?: string;
  /** Hands the element up: a simulive's replay is scheduled against its position. */
  onVideo?: (video: HTMLVideoElement | null) => void;
  /** A simulive's shared position, read when the media loads: a late joiner starts there. */
  sharedStartMs?: () => number | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    onVideo?.(videoRef.current);
    return () => onVideo?.(null);
  }, [onVideo]);
  // Read at load time through a ref, so a new closure each render does not reload the media.
  const sharedStart = useRef(sharedStartMs);
  useEffect(() => {
    sharedStart.current = sharedStartMs;
  }, [sharedStartMs]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The element starts muted; tryPlay (below) takes the sound when the browser allows it,
  // and the element's volumechange event keeps this in step (onMutedChange).
  const [isMuted, setIsMuted] = useState(true);
  // The viewer muted it themselves: never unmute behind their back.
  const userMuted = useRef(false);
  const activeUrl = streamUrl;
  const ll = Boolean(lowLatency);
  // A simulive: the recording on one shared clock, played like a live broadcast.
  const simulive = Boolean(sharedStartMs);
  // play() refused even muted (autoplay policy): the clock waits for the tap to join.
  const blocked = useRef(false);

  /* Back onto the shared clock (lib/simulive-clock.ts): a seek from the arrow keys, the media
   * keys, the OS media card, a picture-in-picture window or devtools is put back, and a pause
   * by the browser or the OS is resumed. Runs on the element's own events and once a second,
   * for the drifts no event announces (a throttled background tab). */
  const syncToClock = useCallback((force = false) => {
    const video = videoRef.current;
    const shared = sharedStart.current?.() ?? null;
    if (!video || shared == null || video.readyState < HTMLMediaElement.HAVE_METADATA) return;
    if (video.playbackRate !== 1) video.playbackRate = 1;
    const fix = simuliveCorrection({
      positionSec: video.currentTime,
      sharedSec: shared / 1000,
      durationSec: video.duration,
      paused: video.paused,
      ended: video.ended,
      blocked: blocked.current && !force,
    });
    if (fix.seekTo != null) video.currentTime = fix.seekTo;
    if (fix.resume) {
      video.play().then(
        () => {
          blocked.current = false;
        },
        () => {
          // Refused with sound: muted is what autoplay allows; refused muted too, wait for a tap.
          video.muted = true;
          setIsMuted(true);
          video.play().then(
            () => {
              blocked.current = false;
            },
            () => {
              blocked.current = true;
            },
          );
        },
      );
    }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!simulive || !video) return;
    const check = () => syncToClock();
    // While buffering the position lags on its own; the next tick after it catches up.
    const onTick = () => {
      if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA || video.paused) syncToClock();
    };
    video.addEventListener("seeked", check);
    video.addEventListener("pause", check);
    video.addEventListener("ratechange", check);
    video.addEventListener("ended", check);
    const timer = setInterval(onTick, 1000);

    /* The OS media card and media keys: no pause, no skip, no seek. Null hides a button where
     * the browser has no default for it; pause gets a handler that does nothing, since null
     * would hand it back to the browser, which pauses. Whatever still gets through (a PiP
     * window's own controls, say) is put back by the checks above. */
    const session =
      typeof navigator !== "undefined" && "mediaSession" in navigator ? navigator.mediaSession : null;
    const noop = () => {};
    const actions: [MediaSessionAction, MediaSessionActionHandler | null][] = [
      ["pause", noop],
      ["seekbackward", null],
      ["seekforward", null],
      ["seekto", null],
      ["previoustrack", null],
      ["nexttrack", null],
    ];
    for (const [action, handler] of actions) {
      try {
        session?.setActionHandler(action, handler);
      } catch {
        // A browser that does not know the action.
      }
    }
    return () => {
      video.removeEventListener("seeked", check);
      video.removeEventListener("pause", check);
      video.removeEventListener("ratechange", check);
      video.removeEventListener("ended", check);
      clearInterval(timer);
      for (const [action] of actions) {
        try {
          session?.setActionHandler(action, null);
        } catch {
          // As above.
        }
      }
    };
  }, [simulive, syncToClock, activeUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: Hls | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    /* Sound if the browser allows it (lib/autoplay-sound.ts): the Join click, kept by a
     * same-tab navigation, allows it in Chrome, Edge and Firefox, and an element unlocked in
     * that tap (lib/media-unlock.ts) in Safari. Refused (NotAllowedError), it plays muted and
     * the first tap or key anywhere turns the sound on (StagePlayerChrome). */
    let soundAllowed: boolean | null = null;
    const playMuted = () => {
      video.muted = true;
      setIsMuted(true);
      video.play().catch(() => {});
    };
    const tryPlay = () => {
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "true");
      if (userMuted.current || soundAllowed === true) {
        video.play().catch(() => {});
        return;
      }
      if (soundAllowed === false) return playMuted();
      const withSound = tryWithSound({
        activated: navigator.userActivation?.hasBeenActive,
        primed: video.dataset.primed === "1",
      });
      if (!withSound) {
        soundAllowed = false;
        return playMuted();
      }
      soundAllowed = true;
      video.muted = false;
      video
        .play()
        .then(() => setIsMuted(false))
        .catch((err: unknown) => {
          // Only NotAllowedError is the autoplay policy; anything else says nothing about
          // sound, so ask again on the next try.
          if (!isAutoplayRefusal(err)) {
            soundAllowed = null;
            return;
          }
          soundAllowed = false;
          playMuted();
        });
    };

    // A simulive's late joiner starts at the shared position (lib/simulive-replay.ts).
    const seekToShared = () => {
      const at = startPositionSec(sharedStart.current?.() ?? null, video.duration);
      if (at != null && Math.abs(video.currentTime - at) > 2) video.currentTime = at;
    };

    const isPlaylist = isPlaylistUrl(activeUrl);
    if (!isPlaylist) {
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.src = activeUrl;
      const onLoaded = () => {
        setLoading(false);
        seekToShared();
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
        // A simulive's recording (VOD) starts at the shared position; -1 is hls.js's default.
        startPosition: ll ? -1 : (startPositionSec(sharedStart.current?.() ?? null) ?? -1),
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
        if (!ll) seekToShared();
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
      userMuted.current = false;
      videoRef.current.muted = false;
      setIsMuted(false);
      // A simulive's tap to join starts where everybody is, however long the tap took.
      if (simulive) {
        blocked.current = false;
        syncToClock(true);
      }
      void videoRef.current.play().catch(() => {});
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    userMuted.current = video.muted;
    setIsMuted(video.muted);
    if (!video.muted) void video.play();
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
      captionsUrl={captionsUrl}
      simulive={simulive}
    />
  );
}

// A browser does not gain or lose the Fullscreen API while the page is open.
const subscribeNothing = () => () => {};
const serverCanFullscreen = () => true;

export function StagePlayerChrome({
  videoRef,
  loading,
  error,
  isMuted,
  coverUrl,
  onMutedChange,
  onReady,
  unmute,
  toggleMute,
  captionsUrl,
  simulive = false,
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
  captionsUrl?: string;
  /** A simulive: a broadcast on a shared clock. Its fullscreen is only ever our container
   *  (never the iPhone's native player, which has a scrubber), and seek keys do nothing. */
  simulive?: boolean;
}) {
  /* Fullscreen belongs to the chrome, not to each player: the players could differ
   * in how they fill the video element and in nothing else, and the two copies
   * of this that lived in those players had already drifted into being the
   * same eight lines twice. */
  const containerRef = useRef<HTMLDivElement>(null);
  const { notify } = useToast();
  const { isFullscreen, toggle } = useFullscreen(containerRef, videoRef, { nativeVideo: !simulive });
  // A capability, read like lib/pip.ts reads one: the server says yes (most browsers can),
  // the client the truth, so the first client render matches the server HTML.
  const elementFullscreen = useSyncExternalStore(
    subscribeNothing,
    canElementFullscreen,
    serverCanFullscreen,
  );
  const shown = playerControls(simulive ? "simulive" : "live", elementFullscreen);
  // Captions as a native track: they follow the playback position, seeks included.
  const captionTrack = useCaptionTrack(captionsUrl);
  const [ccOn, setCcOn] = useState(true);

  /* The <video>, made here rather than rendered: on Safari the player has to be the element
   * the Join tap unlocked (lib/media-unlock.ts), which React did not create. Laid out before
   * the players' own effects run, so videoRef is set when they read it.
   *
   * No `controls`. This is a live stage, not a file: a scrubber invites seeking on a stream
   * that has nowhere to seek to, and the native menu offers playback speed, download and
   * PiP, none of which mean anything for a broadcast. The attributes are belt-and-braces for
   * the places a browser shows its own UI anyway. Volume and fullscreen live in the overlay
   * instead. PiP stays off: the shared clock would snap its scrubber back, but a window with
   * a play button that does nothing is worse than no window. */
  const slotRef = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onReady, onMutedChange });
  useEffect(() => {
    handlers.current = { onReady, onMutedChange };
  });
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const adopted = takePrimedVideo();
    const video = adopted ?? document.createElement("video");
    if (adopted) video.dataset.primed = "1";
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.muted = true;
    video.autoplay = true;
    video.preload = "auto";
    video.controls = false;
    video.disablePictureInPicture = true;
    video.setAttribute("controlsList", "nodownload noplaybackrate noremoteplayback");
    video.className = "h-full w-full object-contain";
    slot.appendChild(video);
    videoRef.current = video;

    const ready = () => handlers.current.onReady?.();
    const onTime = () => {
      if (video.currentTime > 0) ready();
    };
    const onVolume = () => handlers.current.onMutedChange(video.muted);
    const readyEvents = ["play", "playing", "canplay", "canplaythrough", "loadeddata"];
    for (const e of readyEvents) video.addEventListener(e, ready);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("volumechange", onVolume);
    return () => {
      for (const e of readyEvents) video.removeEventListener(e, ready);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("volumechange", onVolume);
      video.remove();
    };
  }, [videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (coverUrl) video.poster = coverUrl;
    else video.removeAttribute("poster");
  }, [coverUrl, videoRef]);

  useEffect(() => {
    // A cast session is a player of its own, off the shared clock; a live stage keeps it.
    if (videoRef.current) videoRef.current.disableRemotePlayback = simulive;
  }, [simulive, videoRef]);

  // Captions as a native track: they follow the playback position, seeks included.
  const ccOnRef = useRef(ccOn);
  useEffect(() => {
    ccOnRef.current = ccOn;
  });
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !captionTrack) return;
    const track = document.createElement("track");
    track.kind = "captions";
    track.label = CAPTIONS_LABEL;
    track.srclang = "und";
    track.src = captionTrack;
    track.default = ccOnRef.current;
    const onLoad = () => showCaptions(video, ccOnRef.current);
    track.addEventListener("load", onLoad);
    video.appendChild(track);
    return () => {
      track.removeEventListener("load", onLoad);
      track.remove();
    };
  }, [captionTrack, videoRef]);
  useEffect(() => {
    showCaptions(videoRef.current, ccOn);
  }, [ccOn, captionTrack, videoRef]);

  /* Muted because the browser said so (a cold room link, a refresh, a new tab), not by the
   * viewer: their next tap, click or key anywhere on the page is the permission the browser
   * wanted, so it turns the sound on. Inside the event, so it counts as the gesture. */
  const userMuted = useRef(false);
  const unmuteRef = useRef(unmute);
  useEffect(() => {
    unmuteRef.current = unmute;
  });
  const askingForSound = isMuted && !loading;
  useEffect(() => {
    if (!askingForSound) return;
    const onGesture = (e: Event) => {
      if (userMuted.current) return;
      // Our own mute button does its own thing.
      if (e.target instanceof Element && e.target.closest("[data-mute-toggle]")) return;
      unmuteRef.current();
    };
    // pointerup and touchend, not pointerdown: a touch's pointerdown is not an activation.
    const events = ["pointerup", "touchend", "keydown"] as const;
    for (const ev of events) document.addEventListener(ev, onGesture, true);
    return () => {
      for (const ev of events) document.removeEventListener(ev, onGesture, true);
    };
  }, [askingForSound]);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full flex items-center justify-center bg-black"
      onKeyDownCapture={
        simulive
          ? (e) => {
              // Keys a browser maps to seek or pause on a focused video. Our own buttons keep
              // Enter and Space: only keys aimed at the picture itself are swallowed.
              if (e.target instanceof HTMLButtonElement) return;
              if (SIMULIVE_BLOCKED_KEYS.has(e.key)) e.preventDefault();
            }
          : undefined
      }
    >
      {/* The <video> goes in here (the effect above): the element unlocked in the Join
        * tap when there is one, a new one otherwise. */}
      <div ref={slotRef} className="contents" />

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

      {askingForSound && (
        /* One small pill, not an overlay: the picture, captions and chat all stay usable, and
         * any tap or key anywhere turns the sound on (the effect above), this pill included. */
        <button
          type="button"
          onClick={unmute}
          className="absolute bottom-4 left-4 z-20 flex items-center gap-1.5 rounded-full bg-black/65 px-3 py-1.5 text-[12.5px] font-semibold text-white shadow-lg backdrop-blur transition hover:bg-black/80"
        >
          <VolumeIcon className="size-3.5" />
          Tap to turn on sound
        </button>
      )}

      {!loading && (
        <div className="absolute bottom-4 right-4 z-20 flex items-center gap-1 rounded-full bg-black/55 p-1 backdrop-blur">
          {captionTrack && (
            <CcButton on={ccOn} onToggle={() => setCcOn((v) => !v)} className="mx-1.5" />
          )}
          <button
            type="button"
            data-mute-toggle
            onClick={() => {
              userMuted.current = !isMuted;
              toggleMute();
            }}
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
          {shown.fullscreen && (
          <button
            type="button"
            onClick={() => {
              void toggle().then((ok) => {
                // Only reachable where no fullscreen API exists at all — an
                // in-app browser, mostly. Saying so beats a dead button.
                if (!ok) notify("This browser will not let the video go fullscreen.", "info");
              });
            }}
            aria-label={isFullscreen ? "Leave fullscreen" : "Enter fullscreen"}
            title={isFullscreen ? "Leave fullscreen" : "Fullscreen"}
            className="grid size-8 place-items-center rounded-full text-white/90 transition hover:bg-white/15 hover:text-white"
          >
            {isFullscreen ? (
              <FullscreenExitIcon className="size-4" />
            ) : (
              <FullscreenIcon className="size-4" />
            )}
          </button>
          )}
        </div>
      )}
    </div>
  );
}
