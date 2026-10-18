"use client";

/* The room for an Edge-delivery viewer (docs/edge-delivery.md).
 *
 * Same room as CdnAttendeeRoom — header, control bar, side panel, chat, Q&A, polls, raised
 * hands, surveys — with two differences, both the point of edge delivery:
 *
 *   - the picture is the stage mix as LL-HLS (EdgePlayer), from the origin or a CDN in front
 *     of it, not WHEP from the video server;
 *   - nothing connects to LiveKit. The Room below never connects; useEdgeEvents feeds it the
 *     session's events from the SSE stream, so every shared hook works on it unchanged.
 *
 * Going on stage is a new join (WebinarRoom.handlePromoted), which returns a LiveKit token and
 * mounts the WebRTC room in place of this one; going back is the same in reverse. */

import { RoomContext } from "@livekit/components-react";
import { Room } from "livekit-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { JoinResponse } from "@/lib/api-types";
import { useEdgeEvents, useServerClockOffset } from "@/lib/edge-events";
import { useMediaPreferences } from "@/lib/media";
import { useMediaPermissions, useLiveRole } from "@/lib/permissions";
import { useRealtime, useSessionControls, type Relay, type Sender } from "@/lib/realtime";
import { countSince } from "@/lib/room-history";
import { useRoomHistory } from "@/lib/room-history-sync";
import { useAudiencePolls } from "@/lib/polls";
import { useHostRoster } from "./participants";
import { useNetworkHealth } from "@/lib/network";
import { useAvailableTools } from "./tools";
import { isToolVisible, useToolLayout, type ToolId } from "@/lib/tools";
import { stageFrame, useCompact } from "@/lib/compact";
import { useFileShare } from "@/lib/file-share";
import { useStageLayout } from "@/lib/layout";
import { useMentionBadge } from "@/lib/use-mentions";
import { ControlBar } from "./control-bar";
import { ChatNotifications } from "./chat-notifications";
import { RoomUIProvider, type RoomUI } from "./context";
import { PollPopup } from "./poll-popup";
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
import { MeetingLimitBanner } from "./meeting-limit-banner";
import { RoomHeader } from "./webinar-room";
import { EdgePlayer } from "./edge-player";

export function EdgeAudienceRoom({
  join,
  slug,
  initialTopic,
  initialImageUrl,
  joinKey,
  onLeave,
  onPromoted,
  onRemoved,
  onRefreshJoin,
}: {
  join: JoinResponse;
  slug: string;
  initialTopic: string;
  initialImageUrl?: string;
  joinKey?: string;
  onLeave: () => void;
  onPromoted: () => void;
  onRemoved: () => void;
  /** The event stream refused its token: join again for a fresh one. */
  onRefreshJoin: () => void;
}) {
  const { prefs, update: updatePrefs } = useMediaPreferences();
  // Never connected. The SSE stream raises its events (see lib/edge-events.ts).
  const [room] = useState(() => new Room());
  const [removed, setRemoved] = useState(false);

  const onPromotedRef = useRef(onPromoted);
  useEffect(() => {
    onPromotedRef.current = onPromoted;
  }, [onPromoted]);

  const { controls, topic, recording, startedAt, endedAt, status, maxDurationMin } =
    useSessionControls(room, join.controls, join.maxDurationMin);
  const liveRole = useLiveRole(room, join.role);

  const relay = useCallback<Relay>(
    (req) => api.say(slug, joinKey ? { ...req, joinKey } : req),
    [slug, joinKey],
  );
  const me: Sender = useMemo(
    () => ({ identity: join.identity, name: join.displayName, role: liveRole }),
    [join.identity, join.displayName, liveRole],
  );

  const selfHand = useRef<((event: SelfHandEvent) => void) | null>(null);
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

  const announceSelfHand = useSelfHandToasts({
    slug,
    joinKey,
    handRaised: realtime.myHandRaised,
    invite: realtime.stageInvite,
    recording,
    canRaise: controls.raiseHandEnabled,
    toggleHand: realtime.toggleHand,
    dismissInvite: realtime.dismissStageInvite,
    // Accepting stored the grant on the server; joining again returns the stage token.
    onAccepted: useCallback(() => onPromotedRef.current(), []),
  });
  useEffect(() => {
    selfHand.current = announceSelfHand;
  }, [announceSelfHand]);

  // Never fires for a room that is not connected; kept so the UI reads the same shape.
  const permissions = useMediaPermissions(room, () => undefined);

  const streamState = useEdgeEvents({
    room,
    slug,
    token: join.eventsToken ?? "",
    identity: join.identity,
    onPromoted: useCallback(() => {
      selfHand.current?.({ kind: "stage", arrival: "stage" });
      onPromotedRef.current();
    }, []),
    onRemoved: useCallback(() => {
      setRemoved(true);
      onRemoved();
    }, [onRemoved]),
    onExpired: onRefreshJoin,
  });
  const clockOffset = useServerClockOffset(Boolean(join.debugClock));

  const availableTools = useAvailableTools({ isHost: false, controls });
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

  useRoomHistory(room, slug, joinKey, realtime);

  const chatCount = realtime.chat.length;
  const questionCount = realtime.questions.length;
  const chatVisible = isToolVisible(tools.layout, tools.panelTab, "chat", tools.poppedOut);
  const qaVisible = isToolVisible(tools.layout, tools.panelTab, "qa", tools.poppedOut);
  const [seen, setSeen] = useState({ chat: 0, qa: 0 });
  const [mountedAt] = useState(() => Date.now());
  const wantSeen = {
    chat: chatVisible ? chatCount : seen.chat,
    qa: qaVisible ? questionCount : seen.qa,
  };
  if (wantSeen.chat !== seen.chat || wantSeen.qa !== seen.qa) setSeen(wantSeen);
  const mentions = useMentionBadge(realtime.chat, me.identity, chatVisible);

  const unread = useMemo<Record<ToolId, number>>(
    () => ({
      chat: chatVisible
        ? 0
        : Math.min(Math.max(0, chatCount - seen.chat), countSince(realtime.chat, mountedAt, me.identity)),
      qa: qaVisible
        ? 0
        : Math.min(
            Math.max(0, questionCount - seen.qa),
            countSince(realtime.questions, mountedAt, me.identity),
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
    [chatVisible, qaVisible, chatCount, questionCount, seen, realtime.chat, realtime.questions, mountedAt, me.identity],
  );

  const onLeaveRef = useRef(onLeave);
  useEffect(() => {
    onLeaveRef.current = onLeave;
  }, [onLeave]);
  const leave = useCallback(() => onLeaveRef.current(), []);

  const roster = useHostRoster(slug, false, room);
  const polls = useAudiencePolls(slug, joinKey, realtime.pollsRevision, true, controls.pollsEnabled, room);
  const survey = useAudienceSurvey(slug, joinKey, realtime.surveyRevision, true);
  // No media connection to measure: the player reports its own health (latency readout).
  const network = useNetworkHealth(null, false);

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
      over: false,
      markEnding: () => undefined,
      realtime,
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
      slug, join, joinKey, controls, topic, initialTopic, initialImageUrl, startedAt, endedAt, status,
      maxDurationMin, recording, permissions, me, realtime, roster, polls, network, tools, availableTools,
      unread, mentions, fileShare, stage, prefs, updatePrefs, leave,
    ],
  );

  if (removed) {
    return (
      <main className="grid min-h-dvh place-items-center bg-stage p-6 text-center">
        <div className="max-w-[420px]">
          <h1 className="text-[18px] font-semibold text-white">You were removed from this webinar</h1>
          <p className="mt-2 text-[13.5px] text-white/60">The host removed you from the session.</p>
          <button
            onClick={onLeave}
            className="mt-5 rounded-lg bg-white/15 px-4 py-2 text-[13px] font-medium text-white hover:bg-white/25"
          >
            Back to webinars
          </button>
        </div>
      </main>
    );
  }

  if (status === "ended") {
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

  return (
    <RoomContext.Provider value={room}>
      <RoomUIProvider value={ui}>
        <RecorderProvider>
          <ActiveSpeakerProvider>
            <RaisedHandsProvider value={raisedHands}>
              <ToolDragProvider onPin={tools.pin} onUnpin={tools.unpin}>
                <div data-room data-delivery="edge" className="flex h-dvh flex-col overflow-hidden bg-stage">
                  <div className="relative min-h-0 min-w-0 flex-1">
                    <div
                      ref={setStageEl}
                      data-stage
                      className="absolute inset-x-0 top-12 flex flex-col"
                      style={stageFrame(compact, panelOpen)}
                    >
                      <div className="relative flex flex-1 items-center justify-center bg-black">
                        <EdgePlayer
                          playbackUrl={join.playbackUrl ?? ""}
                          coverUrl={initialImageUrl}
                          identity={join.identity}
                          slug={slug}
                          debugClock={Boolean(join.debugClock)}
                          clockOffsetMs={clockOffset}
                          lowLatency={Boolean(join.lowLatency)}
                        />
                        {streamState === "retrying" && (
                          <div className="pointer-events-none absolute bottom-4 left-4 z-20 rounded-full bg-black/60 px-3 py-1 text-[11.5px] text-white/80">
                            Reconnecting chat…
                          </div>
                        )}
                      </div>
                      <FileShareBar />
                      <MeetingLimitBanner
                        startedAt={startedAt}
                        maxDurationMin={maxDurationMin}
                        endedByLimit={false}
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
