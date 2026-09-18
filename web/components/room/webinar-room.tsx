"use client";

import {
  RoomAudioRenderer,
  RoomContext,
  StartAudio,
  useConnectionState,
  useSequentialRoomConnectDisconnect,
} from "@livekit/components-react";
import {
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  type LocalAudioTrack,
  type LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { JoinResponse } from "@/lib/api-types";
import { roomOptions, useMediaPreferences } from "@/lib/media";
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
import { describeQuality, prioritiseAudio, useNetworkHealth } from "@/lib/network";
import { formatElapsed } from "@/lib/format";
import { Alert, Spinner } from "../controls";
import { EyeOffIcon, LockIcon, SignalIcon, SlidersIcon } from "../icons";
import { useAppConfig, useToast } from "../providers";
import { Badge } from "../ui";
import { ControlBar } from "./control-bar";
import { planRecovery, RECOVERY_BACKOFF_MS } from "@/lib/recovery";
import { ActiveSpeakerProvider } from "./active-speaker";
import { ChatNotifications } from "./chat-notifications";
import { RoomUIProvider, useRoomUI, type RoomUI } from "./context";
import { PreJoin } from "./prejoin";
import { RecordingIndicator } from "./recording";
import { useAudiencePolls } from "@/lib/polls";
import { useHostRoster } from "./participants";
import { VirtualBackground } from "./background-picker";
import { PollPopup } from "./poll-popup";
import { FileShareBar } from "./file-share-bar";
import { MeetingInfo } from "./meeting-info";
import { ViewsMenu } from "./views-menu";
import { ShareStopBar } from "./share-stop-bar";
import { NetworkMetrics } from "./network-readout";
import { Stage } from "./stage";
import { SidePanel } from "./side-panel";
import { ToolDragProvider } from "./tool-drag";
import { ToolWindows } from "./tool-windows";
import { useAvailableTools } from "./tools";
import { isToolVisible, useToolLayout, type ToolId } from "@/lib/tools";
import { COMPACT_STAGE_HEIGHT, useCompact } from "@/lib/compact";
import { useFileShare } from "@/lib/file-share";
import { useStageLayout } from "@/lib/layout";
import { useTelemetry } from "@/lib/telemetry";

/* The webinar room.
 *
 * There is no media code here and none anywhere else in this repo: the browser
 * provides RTCPeerConnection, livekit-client drives it, and the LiveKit SFU
 * terminates it. Our contribution is the token — and the token is what decides
 * whether this participant can publish, and whether the rest of the room is ever
 * told they are here.
 *
 * The Room object is created here rather than by <LiveKitRoom> because three
 * things need it directly: the realtime hook publishes on its data channel, the
 * settings dialog switches devices on it, and the metadata subscription reads the
 * host's controls off it.
 */

export function WebinarRoom({
  join,
  slug,
  topic: initialTopic,
  imageUrl: initialImageUrl,
  joinKey,
  onLeave,
}: {
  join: JoinResponse;
  slug: string;
  topic: string;
  /** The webinar's own cover image (see stage.tsx's WaitingForStage). Only
   *  ever passed by the attendee path — a host or panelist always has
   *  something to present and never reaches the screen that shows it. */
  imageUrl?: string;
  /** An attendee's credential for the realtime relay. Absent for the host and the
   *  panelists, who publish on the data channel directly, and for an attendee who
   *  joined on their session alone. */
  joinKey?: string;
  onLeave: () => void;
}) {
  const { ready: prefsReady } = useMediaPreferences();

  // Every path below assumes WebRTC. That's true of every evergreen browser —
  // Chrome, Firefox, Safari, Edge, and every Chromium-based browser — but not
  // of a browser old or unusual enough to lack it, which would otherwise fail
  // deep inside livekit-client with a confusing error instead of a plain one.
  // Checked after the hook, not before it, so hook order never depends on it.
  if (typeof window !== "undefined" && !("RTCPeerConnection" in window)) {
    return <UnsupportedBrowser />;
  }

  // Wait for the stored preferences before creating the Room: it opens devices
  // from them, and joining with the defaults first would grab the wrong camera and
  // then visibly swap.
  if (!prefsReady) {
    return (
      <main className="grid min-h-dvh place-items-center">
        <Spinner className="size-6 text-ink-3" />
      </main>
    );
  }

  // A separate component so the Room is constructed once, with real preferences,
  // and lives across the pre-join screen — which is what allows the connection to
  // be warmed up while the presenter is still checking their camera.
  return (
    <RoomSession
      join={join}
      slug={slug}
      initialTopic={initialTopic}
      initialImageUrl={initialImageUrl}
      joinKey={joinKey}
      onLeave={onLeave}
    />
  );
}

function UnsupportedBrowser() {
  return (
    <main className="grid min-h-dvh place-items-center px-5">
      <div className="max-w-sm text-center">
        <h1 className="mb-2 text-[18px] font-semibold">
          This browser can&apos;t join video calls
        </h1>
        <p className="text-[14px] text-ink-2">
          Your browser doesn&apos;t support the technology webinars run on.
          Please open this link in a recent version of Chrome, Safari,
          Firefox, or Edge.
        </p>
      </div>
    </main>
  );
}

/** Connect options, stated rather than inherited.
 *
 *  peerConnectionTimeout is how long the client waits for ICE and DTLS before giving
 *  up and retrying. I set this to 8 seconds while the media path was broken, so the
 *  retry — which is what switches the ICE preference to TCP — would come sooner than
 *  the SDK's 15-second default. That was right for a path that could never work and
 *  wrong the moment it could: measured against a working SFU, DTLS sometimes lands
 *  between 8 and 15 seconds while ICE works through the candidate list, and 8 seconds
 *  cut off connections that were about to succeed.
 *
 *  15 seconds matches the SDK default and is stated here so the value is a decision
 *  rather than an inheritance. A healthy connection completes in about two. */
const CONNECT_OPTIONS = {
  peerConnectionTimeout: 15_000,
  websocketTimeout: 15_000,
} as const;

/* Recovering from a dropped peer connection, instead of surrendering to it.
 *
 * The policy and the reasoning live in lib/recovery.ts, where they can be tested — a real
 * media-path failure cannot be injected from a test harness. This file is the wiring.
 */
/* How long a connection has to hold before its attempts are forgiven.
 *
 * Without this a connection that flaps every twenty seconds would retry for ever, because
 * each success resets the counter. With it, a genuinely unusable network still reaches the
 * terminal screen and tells the person the truth. */
const STABLE_MS = 30_000;

type Entry = {
  micEnabled: boolean;
  cameraEnabled: boolean;
  audioTrack: LocalAudioTrack | null;
  videoTrack: LocalVideoTrack | null;
};

function RoomSession({
  join,
  slug,
  initialTopic,
  initialImageUrl,
  joinKey,
  onLeave,
}: {
  join: JoinResponse;
  slug: string;
  initialTopic: string;
  initialImageUrl?: string;
  joinKey?: string;
  onLeave: () => void;
}) {
  const { prefs, update: updatePrefs } = useMediaPreferences();

  // Created once, before the pre-join screen. Recreating it on a re-render would
  // tear down the connection, so the options are captured at mount and changed
  // later through the Room's own device-switching API instead.
  const [room] = useState(() => new Room(roomOptions(prefs, join.canPublish)));

  // A publisher checks their devices first; an attendee publishes nothing, so a
  // preview screen would be a pointless click between them and the webinar.
  const [checked, setChecked] = useState(!join.canPublish);
  const [entry, setEntry] = useState<Entry>({
    micEnabled: false,
    cameraEnabled: false,
    audioTrack: null,
    videoTrack: null,
  });

  /* Warm the connection up while the presenter is still on the pre-join screen — but only as
   * far as it is safe to.
   *
   * prepareConnection resolves DNS, completes the TLS handshake and validates the token against
   * the SFU. It stops there, and that turns out to be the right place to stop.
   *
   * I tried going further: mounting ConnectedRoom immediately so room.connect() ran during the
   * pre-join screen, on the reasoning that the 1708 ms of ICE and DTLS measured from the click
   * needs nothing from the presenter. The reasoning was sound and the result was much worse.
   * With no track published, the transport sits idle, and on this deployment an idle transport
   * DROPS:
   *
   *     [warning] peerconnection failed disconnected
   *     [warning] triggering ICE restart
   *     [error]   publisher data channel 'DATA_TRACK_LOSSY' closed unexpectedly
   *
   * The ICE restart cost about eighteen seconds, taking time-to-first-frame from 2.8 s to 24 s
   * — measured three times, consistently, by e2e/probe-firstframe.mjs. So connect() stays where
   * it is, after the click, where the connection is used the moment it exists.
   *
   * That the path drops when idle is itself a finding and is not fixed here; see §8d.
   */
  useEffect(() => {
    void room.prepareConnection(join.url, join.token).catch(() => {});
  }, [room, join.url, join.token]);

  /* Noise suppression cannot go through switchActiveDevice — it isn't a device,
   * it's a capture constraint — so it is the one preference above that isn't
   * self-updating. Settings only ever changed `prefs`; the room's own capture
   * defaults, fixed at the `useState` initializer above, kept whatever value
   * was live when it connected. The Settings copy promises "applies the next
   * time your microphone starts," so the room's defaults have to track the
   * preference for that promise to be true the next time the mic is toggled or
   * switched, mid-session, with nobody having to leave and rejoin. */
  useEffect(() => {
    room.options.audioCaptureDefaults = {
      ...room.options.audioCaptureDefaults,
      noiseSuppression: prefs.noiseSuppression,
    };
  }, [room, prefs.noiseSuppression]);

  // A publisher checks their devices before anything is published, so this screen gates the
  // connection as well. See the note above for why that is deliberate rather than incidental.
  if (!checked) {
    return (
      <PreJoin
        topic={initialTopic}
        displayName={join.displayName}
        role={join.role === "host" ? "Host" : "Panelist"}
        prefs={prefs}
        onUpdatePrefs={updatePrefs}
        onJoin={(choices) => {
          setEntry(choices);
          setChecked(true);
        }}
      />
    );
  }

  return (
    <ConnectedRoom
      room={room}
      join={join}
      slug={slug}
      initialTopic={initialTopic}
      initialImageUrl={initialImageUrl}
      joinKey={joinKey}
      onLeave={onLeave}
      prefs={prefs}
      updatePrefs={updatePrefs}
      // The host's mute-on-entry decision wins over a remembered preference: a
      // panelist who always joins unmuted must not walk over it.
      startMic={entry.micEnabled && !(join.controls.muteOnEntry && join.role !== "host")}
      /* A presenter's camera comes on when they enter, whatever the remembered
       * preference said.
       *
       * The stage used to greet them with "You're live — nothing on stage yet.
       * Start your camera or share your screen" and two buttons. That is a nag
       * screen in the first seconds of a session the presenter has just
       * deliberately started, and the fix it suggested is something the app can
       * simply do — so it does. They can turn it off again from the bar, and
       * nothing turns it back on.
       *
       * Note what this overrides: a presenter who joined camera-off last week has
       * that remembered, and now comes in with video. That is the trade the change
       * asks for. The microphone is untouched — coming in audible without meaning
       * to is a different and worse surprise. */
      startCamera={entry.cameraEnabled || join.canPublish}
      entryAudio={entry.audioTrack}
      entryVideo={entry.videoTrack}
    />
  );
}

function ConnectedRoom({
  room,
  join,
  slug,
  initialTopic,
  initialImageUrl,
  joinKey,
  onLeave,
  prefs,
  updatePrefs,
  startMic,
  startCamera,
  entryAudio,
  entryVideo,
}: {
  room: Room;
  join: JoinResponse;
  slug: string;
  initialTopic: string;
  initialImageUrl?: string;
  joinKey?: string;
  onLeave: () => void;
  prefs: ReturnType<typeof useMediaPreferences>["prefs"];
  updatePrefs: ReturnType<typeof useMediaPreferences>["update"];
  startMic: boolean;
  startCamera: boolean;
  /** Tracks the pre-join screen already opened; published rather than reopened. */
  entryAudio: LocalAudioTrack | null;
  entryVideo: LocalVideoTrack | null;
}) {

  const [failure, setFailure] = useState<string | null>(null);
  const [exit, setExit] = useState<ExitReason | null>(null);
  /* Whether room.connect() has resolved. Separate from `ready`, which is about the person:
   * the connection comes up on its own while they are still choosing a camera, and publishing
   * needs both. */
  const [connected, setConnected] = useState(false);
  /* `attempt` is a dependency of the connect effect, so bumping it tears the connection
   * down and builds it again — the retry reuses the whole existing connect path rather than
   * duplicating it. `recovering` is what the banner reads. */
  const [attempt, setAttempt] = useState(0);
  const [recovering, setRecovering] = useState<number | null>(null);
  const attempts = useRef(0);

  // Held in a ref so the connect effect does not re-run — and therefore does not
  // tear down and rebuild the connection — when the parent re-renders and hands
  // down a new callback identity. Assigned in an effect rather than during render
  // because a discarded render's ref write cannot be rolled back.
  const onLeaveRef = useRef(onLeave);
  useEffect(() => {
    onLeaveRef.current = onLeave;
  }, [onLeave]);

  /* The pre-join screen's tracks, in a ref so they are not connect-effect dependencies — a
   * re-render must never tear down a live connection to pick up a new track identity.
   *
   * KEPT UP TO DATE in an effect, which it did not used to need. This component used to mount
   * only after the pre-join screen had finished, so the tracks were already final at mount and
   * a one-shot ref was correct. Now it mounts first, so at mount they are both null, and a
   * ref frozen at that moment is a ref that is permanently wrong.
   *
   * The consequence was not subtle: publishing found no tracks, fell through to
   * setCameraEnabled(true), and asked for a SECOND camera while the pre-join screen still held
   * the first. Measured at 24 seconds to first frame — nine times worse than the delay the
   * early connect was meant to remove. Caught by re-running the probe rather than by reasoning
   * about it, which is the only reason it is not in production.
   */
  const entryTracks = useRef({ audio: entryAudio, video: entryVideo });
  useEffect(() => {
    entryTracks.current = { audio: entryAudio, video: entryVideo };
  }, [entryAudio, entryVideo]);

  const liveRole = useLiveRole(room, join.role);
  // A co-host is a panelist the host made their equal — everywhere in this
  // component tree that reads `isHost` to decide what to show or allow, a
  // co-host should get exactly the same answer the real host does. See
  // useLiveCoHost and lk.Spec.CoHost on the API side for what that grants.
  const isCoHost = useLiveCoHost(room);
  const isHost = liveRole === "host" || isCoHost;
  const me = useMemo<Sender>(
    () => ({
      identity: join.identity,
      name: join.displayName,
      role: liveRole === "host" || liveRole === "panelist" ? liveRole : join.role,
    }),
    [join.identity, join.displayName, join.role, liveRole],
  );

  const { controls, topic, recording, startedAt, endedAt, status } = useSessionControls(
    room,
    join.controls,
  );
  const { notify } = useToast();
  // Attendee identities already announced to the host this room session —
  // see onAttendeeJoined below. A ref, not state: recording who has already
  // been announced must never itself trigger a re-render.
  const seenJoins = useRef(new Set<string>());

  // Temporary, for one performance-test window — see lib/telemetry.ts. `room`
  // is passed as null rather than skipping the call when the flag is off, so
  // this stays a real hook call every render (rules of hooks) while still
  // attaching zero listeners and sampling nothing when telemetry is disabled.
  const { telemetryEnabled } = useAppConfig();
  useTelemetry(telemetryEnabled ? room : null, {
    userId: join.identity,
    roomName: slug,
  });

  // The audience's route out. Their tokens carry canPublishData=false, so the SFU
  // refuses a packet they publish themselves and this is how their chat, questions,
  // hands and reactions reach the room — with the server choosing the recipients,
  // which is what makes the host's chat destination a rule rather than a request.
  //
  // Handed to everyone, including the host: useRealtime prefers the data channel
  // whenever the SFU says this participant may publish on it, so the host and the
  // panelists never actually use this, and a promoted attendee stops using it the
  // moment their grant arrives.
  const relay = useCallback<Relay>(
    (req) => api.say(slug, joinKey ? { ...req, joinKey } : req),
    [slug, joinKey],
  );

  const realtime = useRealtime(
    room,
    me,
    relay,
    useMemo(
      () => ({
        // The host cannot start somebody's microphone from the server, so "please
        // unmute" arrives as a request on the data channel and surfaces here.
        onUnmuteRequested: (from: Sender) =>
          notify(
            `${from.name} would like you to unmute. Use the microphone button when you're ready.`,
            "info",
          ),
        // Host, co-host, AND ordinary panelists are asked to notice — a badge
        // alone means someone watching the video misses the person waiting to
        // speak, which is the whole point of raising a hand. Panelists get a
        // plain heads-up rather than the host's "open Participants to let them
        // in" instruction: ParticipantsPanel gates its action buttons on isHost,
        // not role, so an ordinary panelist has no roster action to take here —
        // telling them to go act on it would be pointing at a button that isn't
        // there.
        onHandRaised: (from: Sender) => {
          if (isHost) {
            notify(
              `${from.name} wants to speak — open Participants to let them in or dismiss it.`,
              "info",
            );
          } else if (liveRole === "panelist") {
            notify(`${from.name} raised their hand.`, "info");
          }
        },
        onHandLowered: (reason: "granted" | "dismissed") => {
          // Being granted the microphone announces itself through the permission
          // change, so saying it twice would be noise.
          if (reason === "dismissed") {
            notify("The host dismissed your request to speak for now.", "info");
          }
        },
        // The server addresses this to the host alone, but the check is kept
        // here anyway — the same defensive habit as onHandRaised — rather than
        // trusting that nothing else could ever deliver this packet.
        //
        // seenJoins (below) is what keeps this to one toast per attendee: the
        // server fires this on every joinAsAttendee call, including a
        // reconnect (dropped wifi, a reloaded tab) for someone already in the
        // room, which is a real join as far as the API is concerned but not
        // news to the host a second time.
        onAttendeeJoined: (from: Sender) => {
          if (!isHost) return;
          if (seenJoins.current.has(from.identity)) return;
          seenJoins.current.add(from.identity);
          notify(`${from.name} joined.`, "info");
        },
      }),
      [notify, isHost, liveRole],
    ),
  );

  // Being handed a microphone mid-session is easy to miss — the button simply
  // appears. Saying so is the difference between an attendee answering the host
  // and the host wondering why nobody replied.
  const announcePermissions = useCallback(
    (next: MediaPermissions, previous: MediaPermissions) => {
      // A host mute first: it also takes the microphone out of the grant, so
      // without this it would be reported as losing the stage.
      if (next.mutedByHost && !previous.mutedByHost) {
        notify("You have been muted by the host.", "info");
        return;
      }
      if (next.canSpeak && !previous.canSpeak) {
        notify(
          previous.mutedByHost
            ? "The host has allowed you to speak again."
            : next.audioOnly
              ? "The host has invited you to speak. Unmute yourself when you're ready."
              /* A host or panelist reaching the stage is just "connected" — they arrived with
               * publish rights and pressed Join, so a sentence about where the buttons are
               * tells them something already on screen. A PROMOTED attendee is a different
               * event: they did not ask for it and their bar has just grown two controls, so
               * that case still says what happened. */
              : join.canPublish
                ? "Connected"
                : "You're on the stage. Your microphone and camera controls are below.",
          "ok",
        );
        return;
      }
      if (!next.canPublish && !next.mutedByHost && previous.canPublish) {
        notify("The host has moved you back to the audience.", "info");
      }
    },
    // join.canPublish decides whether this says "Connected" or explains the stage, and it
    // is fixed for the lifetime of a token — but it is a real dependency, so it is declared.
    [notify, join.canPublish],
  );

  const permissions = useMediaPermissions(room, announcePermissions);

  // ---- connect ----------------------------------------------------------

  // Set only by the Leave button. Without it, the disconnect our own effect
  // cleanup performs arrives as a CLIENT_INITIATED event and is indistinguishable
  // from the user pressing Leave — which navigated people out of the room the
  // instant React re-ran the effect. Requiring explicit intent means the only
  // thing that leaves the room is somebody choosing to.
  const leaving = useRef(false);

  // Sequentialises connect and disconnect. React can run a cleanup's disconnect
  // and the next effect's connect concurrently, and the two overlapping leaves
  // the room in a state where neither has really happened.
  const { connect, disconnect } = useSequentialRoomConnectDisconnect(room);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;

    const onDisconnected = (reason?: DisconnectReason) => {
      if (cancelled) return;
      const exitReason = classifyDisconnect(reason);
      if (!exitReason) {
        if (leaving.current) onLeaveRef.current();
        return;
      }
      /* Only "lost" is worth retrying, and the distinction matters. Being removed by the
       * host, the room being deleted, or the same identity signing in elsewhere are all
       * decisions somebody made — reconnecting would either fail identically or fight the
       * other tab. "lost" is the one that means the network, and the network comes back. */
      const plan = planRecovery(exitReason, attempts.current);
      if (plan.action === "retry") {
        attempts.current = plan.attempt;
        setRecovering(plan.attempt);
        retry = setTimeout(() => setAttempt((n) => n + 1), plan.delayMs);
        return;
      }
      setExit(exitReason);
    };

    room.on(RoomEvent.Disconnected, onDisconnected);

    (async () => {
      try {
        await connect(join.url, join.token, CONNECT_OPTIONS);
        if (cancelled) return;
        setRecovering(null);
        // Forgiven only after it has held. See STABLE_MS.
        settle = setTimeout(() => {
          attempts.current = 0;
        }, STABLE_MS);

        setConnected(true);
      } catch (err) {
        if (cancelled) return;
        /* A connect that never landed is the same fault as one that dropped, and used to be
         * treated as final. It is retried on the same schedule: the common reason for the
         * first attempt failing is that the network was not ready yet, which is exactly what
         * a second attempt a second later fixes. */
        const plan = planRecovery("lost", attempts.current);
        if (plan.action === "retry") {
          attempts.current = plan.attempt;
          setRecovering(plan.attempt);
          retry = setTimeout(() => setAttempt((n) => n + 1), plan.delayMs);
          return;
        }
        setFailure(
          err instanceof Error
            ? err.message
            : "Could not connect to the media server.",
        );
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(retry);
      clearTimeout(settle);
      room.off(RoomEvent.Disconnected, onDisconnected);
      void disconnect();
    };
    /* `startMic` and `startCamera` are deliberately NOT dependencies any more.
     *
     * They are decided on the pre-join screen, which now happens while this effect's
     * connection is already up — so listing them would tear down a working transport at the
     * exact moment the presenter clicked Join, and hand back the 1708 ms this change exists
     * to save. Publishing reads them in its own effect below. */
  }, [attempt, room, connect, disconnect, join.url, join.token]);

  /* Publishing, once the connection is up AND the presenter has finished checking devices.
   *
   * Split out of the connect effect because the two no longer happen together: the connection
   * is made as soon as the room page loads, and this waits for a click that may be seconds
   * later. Guarded by a ref rather than by state so a re-render cannot publish twice — a
   * second publishTrack for the same track throws, and the toast for it would be the first
   * thing a presenter saw.
   */
  const published = useRef(false);
  useEffect(() => {
    if (!connected || !join.canPublish || published.current) return;
    published.current = true;

    void (async () => {
      // Publish what the pre-join screen already opened. These devices are running:
      // publishing is a track added to an existing peer connection, not a device
      // negotiation, so the first frame reaches the audience a camera-open sooner.
      //
      // Parallel is safe precisely because these are existing tracks — the reason the old
      // code was sequential was two concurrent getUserMedia calls prompting twice, and
      // there is no getUserMedia left on this path.
      const publishing: Promise<unknown>[] = [];
      const { audio, video } = entryTracks.current;
      if (startMic && audio) publishing.push(room.localParticipant.publishTrack(audio));
      if (startCamera && video) publishing.push(room.localParticipant.publishTrack(video));
      try {
        if (publishing.length) await Promise.all(publishing);

        // An attendee promoted mid-session, or anyone whose pre-join handed over nothing,
        // still needs the devices opened the ordinary way. Sequential, for the
        // permission-prompt reason above.
        if (startMic && !audio) await room.localParticipant.setMicrophoneEnabled(true);
        if (startCamera && !video) await room.localParticipant.setCameraEnabled(true);
      } catch {
        /* A publish that fails is not a connection that failed, and must not be reported as
         * one: the room still works, chat still works, and the honest recovery is the
         * presenter pressing the camera button. Allowed to be retried, unlike the guard
         * above, because there is nothing published to collide with. */
        published.current = false;
      }
    })();
  }, [connected, join.canPublish, room, startMic, startCamera]);

  // A handle on the live Room, in development only.
  //
  // Two things need it and neither can reach into React: the end-to-end suite,
  // which asserts on what this client was actually told about the room, and a
  // person debugging a session from the console. Gated on NODE_ENV so it is not
  // part of the shipped bundle — the checks that matter in production are the ones
  // asked of the SFU directly.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as { __lkRoom?: Room };
    w.__lkRoom = room;
    return () => {
      delete w.__lkRoom;
    };
  }, [room]);

  // ---- tools: the bar, the More grid and the floating windows -------------

  // What this person may use. Passed into the layout so it can drop a tool that
  // has gone away and surface one that has appeared — a host turning polls on
  // mid-session has to reach a bar that was laid out before they did.
  const availableTools = useAvailableTools({ isHost, controls });
  const tools = useToolLayout(availableTools);
  // Whether a docked panel (Chat, Participants, …) should be sharing the
  // screen with the video right now, rather than overlaying it — only true
  // on a phone-shaped viewport with a panel actually open. A floating/popped-
  // out window doesn't count: that already has its own space via
  // ToolWindows, so the stage stays full-bleed underneath it.
  const compact = useCompact();
  const panelOpen = compact && Boolean(tools.panelTab);

  /* Playing a recorded video into the session as the presenter's screen share.
   *
   * Room-level, like the recorder and the virtual background, and for the same
   * reason: it owns a video element, an AudioContext and two published tracks, and
   * their lifetime is the session's rather than any dialog's. Closing the picker
   * must not stop the share.
   *
   * Gated on the permission to share a screen, because that is exactly what this
   * publishes. A host who is demoted mid-share has it taken down for them — see
   * the `enabled` effect in lib/file-share.ts. */
  const fileShare = useFileShare(room);

  /* How this viewer wants the stage laid out — and, as a consequence, which video
   * tracks this browser subscribes to. Room-level because the control that changes
   * it is in the footer and the thing it changes is the stage. Client-side only:
   * see lib/layout.ts. */
  const stage = useStageLayout();

  /* The stage element, captured into state and handed on in an effect.
   *
   * `ref={tools.setStage}` would have been one line and is not allowed: passing a
   * member of an object into a `ref` position marks the whole object as a ref, so
   * every later read of `tools.layout` in this component becomes a ref access
   * during render. A plain state setter as the ref keeps the two separate. */
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const setStage = tools.setStage;
  useEffect(() => {
    setStage(stageEl);
  }, [setStage, stageEl]);

  // ---- unread badges ----------------------------------------------------

  /* A watermark of how much had arrived the last time each tool was looked at, so
   * a badge only ever means "this came in while you weren't looking".
   *
   * Chat and Q&A are "visible" when their docked tab is open, or when they have
   * been popped out into an un-minimised floating window.
   */
  const chatCount = realtime.chat.length;
  const questionCount = realtime.questions.length;

  const chatVisible = isToolVisible(tools.layout, tools.panelTab, "chat");
  const qaVisible = isToolVisible(tools.layout, tools.panelTab, "qa");

  const [seen, setSeen] = useState({ chat: 0, qa: 0 });

  /* While a panel tab is in front of you, everything arriving in it counts as read.
   *
   * Adjusted during render rather than in an effect. This is the case React's own
   * guidance covers — state derived from a change since the last render — and it
   * is the right shape here for a visible reason: an effect commits a render with
   * the old watermark first, so opening Chat on a busy room painted the badge one
   * more time before clearing it. React re-runs this component immediately and
   * discards the intermediate result, so nothing is shown with a stale count.
   *
   * One call rather than two `if`s: two would both read the same stale `seen`, and
   * the second would undo the first.
   */
  const wantSeen = {
    chat: chatVisible ? chatCount : seen.chat,
    qa: qaVisible ? questionCount : seen.qa,
  };
  if (wantSeen.chat !== seen.chat || wantSeen.qa !== seen.qa) setSeen(wantSeen);

  const unread = useMemo<Record<ToolId, number>>(
    () => ({
      chat: chatVisible ? 0 : Math.max(0, chatCount - seen.chat),
      qa: qaVisible ? 0 : Math.max(0, questionCount - seen.qa),
      // No watermark for the rest. A poll is not a stream of messages, and the
      // thing worth a badge is that one is OPEN right now — which the bar reads
      // from the poll list. Participants carries the raised-hand queue instead,
      // computed in the control bar where the host acts on it.
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
    leaving.current = true;
    void disconnect();
  }, [disconnect]);

  // The server's view of the room, for the host only. It is the one list that
  // includes hidden attendees, so it is both the only honest headcount and the only
  // list a host can moderate from. Polled here rather than in the participants panel
  // so the control bar's badge is right whether or not the panel is open.
  const roster = useHostRoster(slug, isHost);

  // The audience's polls, for everyone who is not the host. Read here rather than in
  // the panel because a launched poll has to reach somebody who is not looking at the
  // panel — the pop-up is the point — and because the pop-up and the panel should agree
  // rather than each fetching.
  const polls = useAudiencePolls(slug, joinKey, realtime.pollsRevision, !isHost);

  /* The connection, sampled from getStats, and the publish ladder held where it belongs.
   *
   * Runs for everyone. A subscriber has no ladder to move, but their inbound loss and
   * jitter are what decide whether the session is working for them — and the indicator
   * that says so is the difference between "this app is broken" and "my wifi is bad".
   */
  const network = useNetworkHealth(room, join.canPublish);

  // The microphone's turn in the browser's send queue. Applied when a track appears
  // rather than once at connect, because a presenter usually unmutes later — and
  // re-applied after a reconnect, which renegotiates the senders away.
  const micTrackSid = permissions.canSpeak
    ? room.localParticipant?.getTrackPublication(Track.Source.Microphone)?.trackSid
    : undefined;
  useEffect(() => {
    if (micTrackSid) void prioritiseAudio(room);
  }, [room, micTrackSid]);

  /* Chat history: on joining, and again after every reconnect.
   *
   * Two triggers, one request. Joining asks from cursor zero and gets the conversation
   * so far, which is what makes arriving twenty minutes late useful rather than
   * disorienting. Reconnecting asks from the highest sequence already held and gets only
   * the gap — the SFU's data channel does not replay what it delivered while the socket
   * was down, so without this a dropped connection silently loses everything said during
   * it.
   *
   * Merged by message id, so the overlap between the backlog and the live stream — which
   * is expected, because a cursor cannot be advanced and a socket drained in the same
   * instant — appears once.
   */
  useEffect(() => {
    let cancelled = false;

    const sync = () => {
      api
        .chatBacklog(slug, realtime.chatCursor, joinKey)
        .then((backlog) => {
          if (!cancelled) realtime.mergeBacklog(decodeBacklog(backlog.messages));
        })
        // Silent: the conversation on screen is more useful than an error where it used
        // to be, and the next reconnect tries again.
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
    // chatCursor is deliberately NOT a dependency: it changes on every message, and
    // re-subscribing per message would re-fetch the backlog per message. It is read
    // through the closure at the moment a sync actually runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, slug, joinKey, realtime.mergeBacklog]);

  const ui = useMemo<RoomUI>(
    () => ({
      slug,
      join,
      joinKey,
      controls,
      topic: topic ?? initialTopic,
      // Never arrives over room metadata — a cover image is fixed at schedule
      // time, unlike the topic, which a host can rename mid-session — so
      // there is nothing to prefer this over.
      coverImageUrl: initialImageUrl ?? null,
      // Prefer live metadata so a stamp that arrives after connect is used; fall
      // back to the join response so the clock is right before metadata lands.
      startedAt: startedAt ?? join.startedAt ?? null,
      endedAt: endedAt ?? join.endedAt ?? null,
      status,
      recording,
      isHost,
      permissions,
      me,
      /* The pre-join camera, so the stage has something to show while connecting.
       *
       * The prop, not entryTracks.current. The ref exists to keep these out of the connect
       * effect's dependencies — a new identity there would tear down a live connection —
       * and reading it here would be a ref read during render. The prop is set once by the
       * parent before this component mounts, so it is stable anyway. */
      entryVideo,
      recovering,
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
      entryVideo,
      recovering,
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
      recording,
      isHost,
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
    return <SessionOver reason={exit} onLeave={onLeave} />;
  }

  if (failure) {
    return <ConnectionFailed message={failure} onLeave={onLeave} />;
  }

  return (
    <RoomContext.Provider value={room}>
      <RoomUIProvider value={ui}>
        {/* The one subscription to voice activity in the app, publishing a single debounced
            identity for the green border. Wraps the tree rather than sitting inside the stage
            because `children` passes through untouched — so when the highlight moves, React
            re-renders the tiles that read it and nothing else. See active-speaker.tsx. */}
        <ActiveSpeakerProvider>
        {/* The drag layer wraps everything, because the two ends of the gesture are
            in different subtrees: the More grid is inside the control bar and the
            bar's slots are its siblings, and a drop that starts in one has to be
            resolved against the other. */}
        <ToolDragProvider onPin={tools.pin} onUnpin={tools.unpin}>
          {/* dvh, not vh: on mobile Safari a vh-tall column puts the control bar
              underneath the browser's own toolbar.

              data-room is read by globals.css to lift the toast stack above the
              control bar, so a notification never sits on the Leave button. */}
          <div data-room className="flex h-dvh flex-col overflow-hidden bg-stage">
            {/* Zoom chrome: video fills the column; header and Chat overlay it;
                only the bottom bar takes layout space. A reserved header + a
                shrinking side rail was the thing that made this feel unlike a
                webinar client.

                On a phone with a panel open, this inverts for the video only:
                full-bleed-and-covered reads as "the video vanished" on a
                screen too small to make the overlay read as an overlay, so
                the video instead keeps a fixed strip at the top and the
                panel is sized to the remaining space below it (SidePanel),
                rather than either one overlaying the other. */}
            <div className="relative min-h-0 min-w-0 flex-1">
              <div
                ref={setStageEl}
                data-stage
                className="absolute inset-x-0 top-0 flex flex-col"
                style={panelOpen ? { height: COMPACT_STAGE_HEIGHT } : { bottom: 0 }}
              >
                <Stage />
                {/* Playback controls for a shared video file. Host-only by
                    construction — it lives in the presenter's own shell, and what the
                    audience receives is captured from a hidden element elsewhere, so
                    none of this can reach a subscriber. */}
                <FileShareBar />
                <ShareStopBar />
                <ConnectionBanner />
                {/* Chat that arrived while the panel was shut, said once rather than
                    left as a number. Given the same `chatVisible` the badge uses, so
                    the two cannot disagree about whether you are looking at it. */}
                <ChatNotifications chatVisible={chatVisible} />
              </div>

              {/* A poll the host just launched, brought to the attendee rather than left
                  behind a button. Renders nothing for the stage and nothing when there is
                  no open poll they have yet to answer. */}
              <PollPopup />

              {/* Applies the stored virtual background to whatever camera track is
                  published, and re-applies it when the track is replaced. Renders nothing;
                  it is here rather than in the settings window because the background has
                  to survive the window being closed. */}
              <VirtualBackground />

              <RoomHeader />
              <SidePanel />
            </div>

            <ControlBar />
          </div>

          {/* Outside the stage element on purpose. They are position-fixed and
              clamped to the stage's rect, so nesting them inside it would put them
              in its overflow-hidden subtree and clip a window being dragged. */}
          <ToolWindows />
        </ToolDragProvider>

        {/* Renders every subscribed audio track. Without this you get video and
            silence, which is a genuinely confusing bug to chase. */}
        <RoomAudioRenderer />
        {/* AutoStartAudio (below) clears the browser's autoplay block silently
            on the first ordinary interaction, for the common case. But which
            gesture that ends up being — and how long it takes for a track to
            exist to unlock in the first place — varies per device and
            network, which is exactly what made audio "sometimes there,
            sometimes not" once the button below was removed on its own.
            StartAudio is LiveKit's own component for this: it renders nothing
            at all once canPlaybackAudio is true, and a real, tappable pill
            whenever it is not — so nobody is ever left with silence and no
            way to fix it themselves. */}
        <StartAudio
          label="Tap to enable sound"
          className="fixed top-16 left-1/2 z-50 -translate-x-1/2 rounded-full bg-brand px-4 py-2 text-[13px] font-medium text-white shadow-lg"
        />
        <AutoStartAudio room={room} />
        </ActiveSpeakerProvider>
      </RoomUIProvider>
    </RoomContext.Provider>
  );
}

/* Unblocks audio the moment there is any interaction at all, without asking for one —
 * the quiet half of unblocking audio. StartAudio, rendered alongside this in
 * ConnectedRoom, is the visible half and the one with a hard guarantee.
 *
 * Browsers withhold autoplay-with-sound until a page has had a genuine user gesture —
 * that is a platform policy this app cannot switch off, and working around it with a
 * trick (a synthetic click, a silent audio priming hack) is exactly the kind of thing
 * browsers have since closed off.
 *
 * This used to be the ONLY mechanism, with no visible fallback — the original "Click to
 * enable sound" pill was removed on the theory that `register-form.tsx`'s JoinGate
 * opening the room in the same tab (itself a gesture) plus this listener would catch
 * nearly everyone silently. It does not catch everyone reliably: which of chat, mute, a
 * layout change ends up being the first qualifying interaction — and whether a track
 * even exists to unlock by the time it fires — varies by device, network and browser,
 * which is what turned into attendees hearing audio on some joins and not others with no
 * pattern a person could see. StartAudio is what makes the outcome no longer a coin
 * flip: it renders nothing while canPlaybackAudio is true, and a real, tappable pill
 * the moment it is not, so this silent path only ever saves someone a tap — it is never
 * the only way out. Reacting to chat, pressing mute, choosing a layout — any of the
 * things somebody does within a few seconds of landing on a live room — still clears it
 * before StartAudio's pill would even have had reason to appear.
 */
function AutoStartAudio({ room }: { room: Room }) {
  useEffect(() => {
    // Deliberately NOT gated on room.canPlaybackAudio here. That flag starts
    // out true in livekit-client's own Room constructor — it means "nothing
    // has failed YET", not "playback is confirmed working" — and the real
    // subscribed audio track this depends on doesn't exist until well after
    // this effect has already run once on mount. Bailing out here on that
    // optimistic default skipped attaching the listeners below in the
    // ordinary case, so the retry mechanism was never armed before the
    // actual autoplay failure happened a moment later — it fired into a
    // room with nothing listening. That was the mobile-listener-never-hears-
    // the-host bug: the previous version of this fix looked identical below
    // but never ran, because of this one early return.
    //
    // Keeps retrying on every interaction until playback is actually
    // confirmed unlocked, instead of giving up after one attempt.
    const start = () => {
      if (room.canPlaybackAudio) {
        stop();
        return;
      }
      void room.startAudio().catch(() => {});
    };
    const stop = () => {
      window.removeEventListener("pointerdown", start);
      window.removeEventListener("keydown", start);
      room.off(RoomEvent.AudioPlaybackStatusChanged, onStatusChange);
    };
    const onStatusChange = () => {
      if (room.canPlaybackAudio) stop();
    };

    window.addEventListener("pointerdown", start);
    window.addEventListener("keydown", start);
    room.on(RoomEvent.AudioPlaybackStatusChanged, onStatusChange);
    return stop;
  }, [room]);

  return null;
}

// ------------------------------------------------------------------- header

function RoomHeader() {
  const { controls, isHost, permissions, tools } = useRoomUI();
  const panelOpen = Boolean(tools.panelTab);

  // From the live permissions, not from the role in the join response. An attendee
  // the host brought on stage is no longer "view only", and a badge still saying
  // so while they hold a microphone is the same stale-join-response bug the
  // control bar had.
  const standing = isHost
    ? { label: "Host", tone: "ok" as const }
    : permissions.mutedByHost
      ? { label: "Muted by host", tone: "warn" as const }
      : permissions.audioOnly
        ? { label: "Allowed to speak", tone: "ok" as const }
        : permissions.canPublish
          ? { label: "Panelist", tone: "ok" as const }
          : { label: "Attendee", tone: "neutral" as const };

  return (
    <header
      className={`pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start gap-2 bg-black px-3 pt-2 pb-2 text-white ${
        panelOpen ? "md:pr-[24rem]" : ""
      }`}
    >
      <div className="pointer-events-auto min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <MeetingInfo />
          <LiveClock />
          {/* Everyone sees this, including the audience — consent is not something
              to leave to the browser that pressed the button. */}
          <RecordingIndicator />
          <NetworkIndicator />
        </div>
        {/* Only exceptional room state — not the room ID on every frame. */}
        {(controls.hideAttendees || controls.locked) && (
          <div className="flex items-center gap-2 text-[11px] text-white/45">
            {controls.hideAttendees && (
              <span
                className="inline-flex items-center gap-1"
                title="Attendees cannot see each other"
              >
                <EyeOffIcon className="size-3" />
                Audience private
              </span>
            )}
            {controls.locked && (
              <span className="inline-flex items-center gap-1 text-warn">
                <LockIcon className="size-3" />
                Locked
              </span>
            )}
          </div>
        )}
      </div>

      <div className="pointer-events-auto flex shrink-0 items-center gap-1">
        <ViewsMenu />

        <span className="hidden sm:block">
          <Badge tone={standing.tone}>{standing.label}</Badge>
        </span>

        {/* Host controls stay in the header — that is where hosts look. Settings
            live under More so the chrome is one primary action for hosts, not two. */}
        {isHost && (
          <button
            type="button"
            onClick={() => tools.open("host")}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-white/10 px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-white/20 outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          >
            <SlidersIcon className="size-3.5" />
            <span className="hidden sm:inline">Controls</span>
          </button>
        )}
      </div>
    </header>
  );
}

/* The connection, in the header.
 *
 * Shown only when it is worth saying something. A permanent green tick is furniture
 * nobody reads; a line that appears when the picture has been reduced is the difference
 * between "this app is broken" and "my wifi is bad", and it is the answer to the support
 * question that would otherwise arrive an hour later.
 *
 * The compact tag stays; hover / keyboard focus opens the same numbers as Settings →
 * Connection (ping, loss, upload speed, congestion). A native title attribute was not
 * enough — it is slow, not keyboard-reachable, and could not show a readable grid.
 */
function NetworkIndicator() {
  const { network, permissions } = useRoomUI();
  const { label, tone } = describeQuality(network);
  const tipId = useId();
  if (tone === "ok" || network.quality === ConnectionQuality.Unknown) return null;

  return (
    <span className="group relative inline-flex">
      <span
        tabIndex={0}
        aria-describedby={tipId}
        className={`inline-flex cursor-default items-center gap-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-white/35 ${
          tone === "bad" ? "text-live" : "text-warn"
        }`}
      >
        <SignalIcon className="size-3" />
        {label}
      </span>
      <span
        id={tipId}
        role="tooltip"
        className="room-dark pointer-events-none absolute top-full left-0 z-50 mt-1.5 w-[15.5rem] origin-top-left scale-95 rounded-lg border border-line bg-surface px-3 py-2.5 opacity-0 shadow-xl transition duration-100 group-hover:scale-100 group-hover:opacity-100 group-focus-within:scale-100 group-focus-within:opacity-100"
      >
        <NetworkMetrics
          network={network}
          canPublish={permissions.canPublish}
          compact
        />
        {permissions.canPublish && network.degraded && (
          <p className="mt-2 text-[11px] leading-relaxed text-warn">
            Reduced automatically to protect audio. Recovers on its own — no need to
            reconnect.
          </p>
        )}
      </span>
    </span>
  );
}

/** How long the webinar has been live, from the host's start time.
 *
 *  Counts from webinar.startedAt (server stamp when status became live), not
 *  from this browser's connect / mount time — a late joiner must match the room. */
function LiveClock() {
  const state = useConnectionState();
  const { startedAt, endedAt, status } = useRoomUI();
  const [now, setNow] = useState(() => Date.now());

  const ended = status === "ended" || Boolean(endedAt);
  // Freeze on endedAt when we have it; otherwise hold the last tick so the
  // display does not keep advancing after the session is over.
  const clockNow = ended && endedAt ? new Date(endedAt).getTime() : now;

  useEffect(() => {
    if (state !== ConnectionState.Connected || ended) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state, ended]);

  if (state !== ConnectionState.Connected) return null;
  // Not started yet — show a zero clock rather than inventing a local start.
  if (!startedAt) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-onair/15 px-2 py-0.5 text-[10.5px] font-semibold text-onair-soft">
        <span className="size-1.5 rounded-full bg-onair" aria-hidden />
        <span className="tabular-nums">0:00</span>
      </span>
    );
  }

  return (
    // Green, not red. This says "the session is running", and the only red thing in
    // the room should be the recording indicator — red means "you are being
    // recorded" everywhere else, so spending it on a healthy clock both dilutes that
    // signal and makes a working webinar look like it has a problem.
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-onair/15 px-2 py-0.5 text-[10.5px] font-semibold text-onair-soft">
      <span
        className={`size-1.5 rounded-full bg-onair ${ended ? "" : "animate-pulse"}`}
        aria-hidden
      />
      <span className="tabular-nums">{formatElapsed(startedAt, clockNow)}</span>
    </span>
  );
}

/** Reconnection state, shown over the stage.
 *
 *  A silent reconnect is worse than a visible one: people start clicking things
 *  and end up rejoining, which drops them from the SFU and makes it slower. */
function ConnectionBanner() {
  const state = useConnectionState();
  const { recovering } = useRoomUI();
  if (state === ConnectionState.Connected && recovering === null) return null;

  /* Our own retry outranks the SDK's state.
   *
   * Between attempts the room really is Disconnected, and saying so would be true and
   * useless — it reads as final while something is actively being done about it. The attempt
   * number is included because a silent wait of up to eight seconds looks like nothing
   * happening at all. */
  const message =
    recovering !== null
      ? `Reconnecting… (${recovering} of ${RECOVERY_BACKOFF_MS.length})`
      : state === ConnectionState.Reconnecting
        ? "Reconnecting…"
        : state === ConnectionState.Connecting
          ? "Connecting…"
          : state === ConnectionState.Disconnected
            ? "Disconnected"
            : null;
  if (!message) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center">
      <span className="inline-flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-[12px] font-medium text-white backdrop-blur">
        <SignalIcon className="size-3.5 animate-pulse" />
        {message}
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ end states

/** Why this participant is no longer in the room. Only for things that happened
 *  TO them — leaving on their own is not an exit state, it is navigation. */
type ExitReason = "ended" | "removed" | "duplicate" | "lost";

/** Maps LiveKit's disconnect reason onto something worth telling a person.
 *
 *  Returns null when they disconnected themselves, which needs no explanation. */
function classifyDisconnect(reason?: DisconnectReason): ExitReason | null {
  switch (reason) {
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.ROOM_CLOSED:
    case DisconnectReason.SERVER_SHUTDOWN:
      return "ended";
    case DisconnectReason.PARTICIPANT_REMOVED:
      return "removed";
    // The same join key opened in a second tab. Saying so beats the two tabs
    // silently fighting over one identity.
    case DisconnectReason.DUPLICATE_IDENTITY:
      return "duplicate";
    case DisconnectReason.SIGNAL_CLOSE:
    case DisconnectReason.STATE_MISMATCH:
      return "lost";
    case DisconnectReason.CLIENT_INITIATED:
    case undefined:
      return null;
    default:
      return "lost";
  }
}

const EXIT_COPY: Record<ExitReason, { title: string; body: string }> = {
  ended: {
    title: "The webinar has ended",
    body: "Thanks for coming — the host closed the session for everyone.",
  },
  removed: {
    title: "You were removed from the webinar",
    body: "The host removed you from this session. Contact them if you think that was a mistake.",
  },
  duplicate: {
    title: "You joined from somewhere else",
    body: "This webinar was opened in another tab or on another device with the same link, so this session was closed.",
  },
  lost: {
    title: "You were disconnected",
    body: "The connection to the media server dropped and could not be recovered. Rejoining usually fixes it.",
  },
};

function SessionOver({ reason, onLeave }: { reason: ExitReason; onLeave: () => void }) {
  const copy = EXIT_COPY[reason];
  return (
    <main className="grid min-h-dvh place-items-center bg-stage p-6 text-center">
      <div className="max-w-sm">
        <h1 className="text-[18px] font-semibold text-white">{copy.title}</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-white/60">{copy.body}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {reason === "lost" && (
            <button
              onClick={() => location.reload()}
              className="rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-white hover:bg-brand-hover"
            >
              Rejoin
            </button>
          )}
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

function ConnectionFailed({
  message,
  onLeave,
}: {
  message: string;
  onLeave: () => void;
}) {
  return (
    <main className="grid min-h-dvh place-items-center bg-page p-6">
      <div className="w-full max-w-md">
        <h1 className="text-[18px] font-semibold text-ink">Couldn&apos;t connect</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">{message}</p>
        <div className="mt-4">
          <Alert tone="warn" title="The usual causes">
            A firewall blocking UDP, or a media server reachable over{" "}
            <code>ws://</code> from a page served over <code>https://</code> — which
            browsers block as mixed content.
          </Alert>
        </div>
        <div className="mt-5 flex gap-2">
          <button
            onClick={() => location.reload()}
            className="h-10 rounded-lg bg-brand px-4 text-[13.5px] font-medium text-white hover:bg-brand-hover"
          >
            Try again
          </button>
          <button
            onClick={onLeave}
            className="h-10 rounded-lg border border-line-2 px-4 text-[13.5px] font-medium text-ink hover:bg-surface-2"
          >
            Go back
          </button>
        </div>
      </div>
    </main>
  );
}
