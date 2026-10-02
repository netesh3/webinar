"use client";

import {
  useConnectionState,
  useLocalParticipant,
  useRemoteParticipants,
  useRoomContext,
  useTracks,
} from "@livekit/components-react";
import { ConnectionState, Track } from "livekit-client";
import { Fragment, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { enableCamera } from "@/lib/backgrounds";
import type { Reaction } from "@/lib/realtime";
import { LAYOUT_LABEL } from "@/lib/layout";
import {
  participantsButtonCount,
  raisedHandsBadgeCount,
  raisedHandsButtonCount,
  raisedHandsPlacement,
} from "@/lib/raised-hands";
import {
  barSlots,
  centerBarTools,
  describeChange,
  gridItems,
  isCustomised,
  isHomeTool,
  isPanelTool,
  morePanelTools,
  tuckedTools,
  usableTools,
  wouldBump,
  type ToolbarChange,
  type ToolbarSnapshot,
  type ToolId,
} from "@/lib/tools";
import { closesMoreOnToolActivate } from "@/lib/bar-popover";
import {
  MEDIA_TOGGLE_SMALL,
  useCompact,
  useMediaToggleSize,
} from "@/lib/compact";
import { isTypingTarget, mediaHotkey } from "@/lib/media-hotkeys";
import { usePictureInPicture } from "@/lib/pip";
import { canShareFile } from "@/lib/file-share";
import { Spinner } from "../controls";
import {
  CameraIcon,
  CameraOffIcon,
  HandIcon,
  LeaveIcon,
  MIC_CAPSULE_PATH,
  MicIcon,
  MicOffIcon,
  MinusIcon,
  PipIcon,
  PlusIcon,
  ScreenShareIcon,
  ScreenShareOffIcon,
} from "../icons";
import { useToast } from "../providers";
import { useMicMeter } from "@/lib/mic-level";
import { useRoomUI } from "./context";
import { InviteMenu } from "./invite-panel";
import { LayoutMenu } from "./layout-menu";
import { MoreButton, MoreGrid } from "./more-grid";
import { ReactionPicker } from "./reactions";
import { RecordButton } from "./recording";
import { useYouTubeStream } from "./stream-to-youtube";
import { CaptionsSession, useCaptionsMoreAction } from "./caption-overlay";
import { SCREEN_SHARE_PUBLISH } from "@/lib/media";
import { describeMediaError, isScreenShareCancel } from "@/lib/media-errors";
import { badgeText } from "@/lib/mentions";
import { MediaToggle } from "./media-toggle";
import { displayMediaOptions, SharePicker } from "./share-picker";
import {
  HostAssignDialog,
  HostLeaveMenu,
} from "./host-leave-dialog";
import { EndWebinarDialog, SendSurveyButton } from "./host-survey";
import { LeaveConfirm } from "./leave-confirm";
import { PipStage } from "./pip-stage";
import { useRaisedHandsPanel } from "./raised-hands-panel";
import { useToolDrag, type DropHandler } from "./tool-drag";
import { tool } from "./tools";

/* The control bar.
 *
 * Three Zoom zones:
 *
 *   fixed left    microphone and camera. Never customisable — they are the
 *                 controls somebody reaches for mid-sentence. An attendee has
 *                 neither; their token forbids publishing.
 *
 *   centre        one strip, centred: Share, Record, Chat / Q&A / Polls /
 *                 Participants / Hand / React / Settings, then pinned extras,
 *                 then More. More is the overflow for this strip, not a sibling
 *                 of Leave.
 *
 *   fixed right   Leave. Isolated so its position never moves under the cursor.
 *
 * Mic / video and Leave are out of flow so the centre strip stays actually
 * centred rather than sliding toward whichever side is emptier.
 */

const subscribeNothing = () => () => {};
const readCanShare = () =>
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices?.getDisplayMedia === "function";
const readCanShareOnServer = () => false;

/* How many customisable slots the bar has, by width.
 *
 * Counted rather than left to flex-wrap. The old bar wrapped to two rows on a
 * narrow laptop and took a third of the video with it, and "just let it wrap" is
 * what produced that. Anything past the capacity is still reachable in the grid,
 * which is the point of having a grid.
 */
const CAPACITY: readonly [query: string, slots: number][] = [
  ["(min-width: 1280px)", 6],
  ["(min-width: 1024px)", 5],
  ["(min-width: 768px)", 4],
  ["(min-width: 640px)", 3],
];
// 0, not a small positive number: a phone this narrow (<640px, i.e. every
// real phone) has no room to spare even for CENTER_BAR_COMPACT's own two
// fixed items (Chat, Raise hand) once mic+camera are both showing — see the
// bar's own dynamic left-padding comment. A pinned or "recently used" tool
// surfacing an extra slot here would silently reopen the exact overflow this
// whole layout pass exists to close. Pinning still works below 640px — it's
// just not auto-surfaced onto a bar that doesn't have room for it; the pin
// takes effect the moment the viewport actually does (≥640px, this file's
// own next CAPACITY tier).
const NARROW_SLOTS = 0;

function useSlotCapacity(): number {
  // Starts at the narrow figure: the server render cannot know the width, and
  // rendering six slots and then dropping to two is a visible jump on load.
  const [slots, setSlots] = useState(NARROW_SLOTS);

  useEffect(() => {
    const queries = CAPACITY.map(([q, n]) => [window.matchMedia(q), n] as const);
    const sync = () => {
      const hit = queries.find(([mq]) => mq.matches);
      setSlots(hit ? hit[1] : NARROW_SLOTS);
    };
    sync();
    for (const [mq] of queries) mq.addEventListener("change", sync);
    return () => {
      for (const [mq] of queries) mq.removeEventListener("change", sync);
    };
  }, []);

  return slots;
}

export function ControlBar() {
  const {
    permissions,
    isHost,
    controls,
    realtime,
    roster,
    tools,
    availableTools,
    unread,
    mentions,
    fileShare,
    stage,
    me,
    leave,
    previewChrome,
    prefs,
    updatePrefs,
  } = useRoomUI();
  const raisedHands = useRaisedHandsPanel();

  const room = useRoomContext();

  const { localParticipant, isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled } =
    useLocalParticipant();
  const connecting = useConnectionState() === ConnectionState.Connecting;
  // Everyone this browser has been told about, plus yourself. Correct for the host's
  // own connection too, but incomplete: the SFU deliberately withholds hidden
  // attendees from every client, which is why the host's number comes from the API.
  const visible = useRemoteParticipants().length + 1;
  const { notify } = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  /** The reaction tray, anchored to whichever slot holds Reactions. Null when
   *  closed; the tool id is not needed, but a boolean would not survive Reactions
   *  being dragged off the bar mid-gesture. */
  const [reactionsOpen, setReactionsOpen] = useState(false);
  /** The Invite popover, anchored to whichever slot holds Invite. */
  const [inviteOpen, setInviteOpen] = useState(false);
  /** "Share a video file" — its own dialog now that Share itself jumps straight
   *  to the browser's picker. See onShareClick. */
  const [shareFileOpen, setShareFileOpen] = useState(false);
  /** Preview-only share toggle — no LiveKit publish in `/preview/room`. */
  const [previewSharing, setPreviewSharing] = useState(false);
  /** The Layout popover, anchored to whichever slot holds it. */
  const [layoutOpen, setLayoutOpen] = useState(false);
  /** Host-only Leave menu (Zoom-style), then assign dialog or end confirm. */
  const [leaveMenuOpen, setLeaveMenuOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);
  /** Everybody else's Leave confirmation, in the same place the host's menu appears. */
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);

  /* The floating window, owned here rather than at the room level.
   *
   * Because this is where the microphone and camera handlers already are, with every guard on
   * them — the host-muted refusal, the self-unmute block, the busy latch. The popped-out window
   * offers those same two controls, and rebuilding them next to it would be a second copy of
   * rules that must never disagree with the bar's: an attendee the host muted has to be refused
   * in both places, by the same code.
   *
   * Allowed in previewChrome, unlike Share. There is no LiveKit behind it there so the window
   * opens with no video in it — which is exactly the empty state worth being able to look at,
   * and reviewing room chrome is what that mode is for.
   *
   * shareActive is any screen share in the room, not only our own: the popped-out stage shows
   * whoever is sharing, and a dismiss has to stick for a viewer of Amlesh's share the same way
   * it sticks for Amlesh. */
  const screenShares = useTracks([Track.Source.ScreenShare], { onlySubscribed: true });
  const pip = usePictureInPicture({
    enabled: !connecting,
    shareActive: screenShares.length > 0,
  });
  const captionsAction = useCaptionsMoreAction();
  const youtube = useYouTubeStream();

  const drag = useToolDrag();
  const capacity = useSlotCapacity();
  // Screen share support, read here (not further down) because Share a video
  // file's availability depends on it.
  const canShare = useSyncExternalStore(subscribeNothing, readCanShare, readCanShareOnServer);
  /* What this browser can actually use right now. Share a video file needs the
   * share permission, a browser that can capture a video element and a real
   * room; Captions needs the host's switch. See usableTools. */
  const usable = usableTools(availableTools, {
    sharefile: !previewChrome && canShare && permissions.canShareScreen && canShareFile(),
    captions: captionsAction !== undefined,
  });
  const slots = barSlots(tools.layout, capacity, usable);
  const grid = gridItems(tools.layout, slots, usable);
  /* YouTube and Settings: on the bar in their own place unless tucked into
   * More (lib/tools.ts HOME_BAR_TOOLS). */
  const tucked = tuckedTools(tools.layout);
  const youtubeHome = usable.includes("youtube") && !tucked.includes("youtube");
  const compact = useCompact();
  const toggleSize = useMediaToggleSize();

  // The centred strip's own left padding is what keeps it clear of mic+camera
  // below — they're out of flow so they don't push it, meaning this has to
  // reserve their actual width itself. Computed from the same conditions
  // those buttons render on (not duplicated as a second source of truth that
  // could drift, and reading the SAME live tier toggleSize does — not a flat
  // guess sized for one phone width) rather than a flat guess sized for the
  // worst case: a plain attendee with neither needs none of this reserved at
  // all, and even a single MediaToggle is half of what two together need.
  // Reserving for two unconditionally was what left no room for the centre
  // strip's own content the one time both actually show — a full "Bring on
  // stage" grant — since that's also exactly when Share and RecordButton
  // newly appear there too. Desktop doesn't need this: MediaToggle is fixed
  // wider there (min-w-14) but `sm:` has enough room to spare either way.
  const micToggleShown =
    (permissions.canPublish || permissions.mutedByHost) &&
    (permissions.canSpeak || permissions.mutedByHost);
  const cameraToggleShown =
    (permissions.canPublish || permissions.mutedByHost) &&
    permissions.canShareCamera;
  const leftClusterCount = (micToggleShown ? 1 : 0) + (cameraToggleShown ? 1 : 0);
  // left-2 offset (8px) + N toggles (main + border + chevron each, at
  // today's live tier) + gaps between them.
  const toggleWidth = toggleSize.mainPx + 1 + toggleSize.chevPx;
  const leftReservePx =
    leftClusterCount === 0
      ? 0
      : 8 + leftClusterCount * toggleWidth + (leftClusterCount - 1) * 4;
  // The one case dynamic padding alone doesn't resolve: both toggles showing
  // is also the only time Share can't fit next to Chat + Raise hand + More
  // on a phone. Same condition, reused rather than re-derived, so this can
  // never disagree with how much room was actually reserved above it.
  const shareOnBar = !compact || !cameraToggleShown;

  /* Attendee, not host or a scheduled panelist. `promoted` is exactly this:
   * "lifted out of the audience" — a scheduled panelist has canPublish
   * without it, and the host is excluded outright. Everything below that
   * treats a person differently from a panelist keys off this, not off
   * canPublish alone. */
  const isAttendee = !isHost && (!permissions.canPublish || permissions.promoted);
  // Reactions stays on an attendee's compact bar at every tier the toggles
  // measure out to fit at — which is every tier except the narrowest phones
  // still sold (see MEDIA_TOGGLE_SMALL's own comment), and only once BOTH
  // toggles are actually showing there. A not-yet-promoted attendee on the
  // smallest phone still gets all four — there's nothing on the left eating
  // the width yet.
  const attendeeHasRoomForReactions = !(
    toggleSize.mainPx === MEDIA_TOGGLE_SMALL.mainPx && leftClusterCount > 0
  );
  const centerTools = centerBarTools(
    availableTools,
    compact,
    isAttendee && attendeeHasRoomForReactions,
    tucked,
  );
  const panelItems = morePanelTools(
    availableTools,
    compact,
    isAttendee && attendeeHasRoomForReactions,
    tucked,
  );
  // Once the host brings an attendee on stage, mic+camera claim the left —
  // and Chat / Raise hand / More move to hug the right edge instead of
  // staying centred, so the strip reads as two clear halves (yours, on the
  // left; everyone else's tools, on the right) rather than mic and camera
  // crowding into a centred cluster's space. Host and panelist keep the
  // centred strip they've always had — isAttendee is false for both, by
  // construction above.
  const shiftToolsRight = compact && isAttendee && leftClusterCount > 0;

  const raisedCount = raisedHandsButtonCount(
    {
      isHost,
      role: me.role,
      promoted: permissions.promoted,
      canPublish: permissions.canPublish,
    },
    realtime.hands.length,
  );
  const raisedWhere = raisedHandsPlacement(compact, raisedCount);
  const raisedBadge = raisedHandsBadgeCount(raisedCount);

  /* The bar reports itself as a drop zone through state and an effect.
   *
   * `ref={drag.setBar}` reads better and is not allowed: a member of an object in
   * a `ref` position marks the whole object as a ref, and every read of
   * `drag.drag` below then counts as touching a ref during render. */
  const [barEl, setBarEl] = useState<HTMLDivElement | null>(null);
  const setBar = drag.setBar;
  useEffect(() => {
    setBar(barEl);
  }, [setBar, barEl]);

  /* Customising the toolbar.
   *
   * `editing` is the non-drag way in ("Customize toolbar" in More): + on each
   * movable tool in More, − on each toolbar button. It lives here rather than
   * in MoreGrid because both halves of it render here.
   *
   * Every edit — drop, +, −, Reset — goes through `edit`, which snapshots the
   * layout first so the notice can offer an exact undo, and marks where the
   * tool landed for the settle animation. */
  const [editing, setEditing] = useState(false);
  const [landed, setLanded] = useState<ToolId | null>(null);
  const [notice, setNotice] = useState<{
    key: number;
    text: string;
    snap: ToolbarSnapshot;
  } | null>(null);

  // Not wrapped in useCallback: the React Compiler memoises it, and a manual
  // wrapper on `tools` is one it cannot preserve.
  const edit = (run: () => ToolbarChange | null) => {
    const snap = tools.snapshot();
    const change = run();
    if (!change) return;
    if (change.kind !== "reset") setLanded(change.tool);
    const text = describeChange(change, (id) => tool(id).label);
    if (text) setNotice({ key: Date.now(), text, snap });
  };

  useEffect(() => {
    if (!landed) return;
    const t = setTimeout(() => setLanded(null), 700);
    return () => clearTimeout(t);
  }, [landed]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // Drops go through the same capacity-aware path as the + button, rather
  // than the provider's plain pin — which could pin a tool past the end of a
  // full bar, out of sight. Through a ref so the handler is registered once
  // rather than re-registered on every render.
  const dropRef = useRef<DropHandler>({ pin: () => {}, unpin: () => {} });
  useEffect(() => {
    dropRef.current = {
      pin: (id, index) => edit(() => tools.place(id, capacity, index)),
      unpin: (id) => edit(() => tools.remove(id)),
    };
  });
  const setDropHandler = drag.setDropHandler;
  useEffect(() => {
    setDropHandler({
      pin: (id, index) => dropRef.current.pin(id, index),
      unpin: (id) => dropRef.current.unpin(id),
    });
    return () => setDropHandler(null);
  }, [setDropHandler]);

  /* The headcount under the Participants button.
   *
   * The host's comes from the server, because it is the only count that includes the
   * hidden audience. Everyone else gets what their own connection knows — which is
   * the whole room when the audience is public, and the stage alone when it is not.
   *
   * In that last case the number is withheld rather than shown. "3" next to a people
   * icon in a room of five hundred is not a smaller truth, it is a wrong one, and the
   * privacy control exists precisely so nobody can count the audience. */
  const headcount = isHost
    ? roster.live
      ? roster.live.onStage + roster.live.attendees
      : undefined
    : controls.hideAttendees
      ? undefined
      : visible;

  /** Wraps a device toggle so a refused permission becomes a readable message
   *  rather than an unhandled rejection in the console. */
  const toggle = useCallback(
    async (key: string, _label: string, run: () => Promise<unknown>) => {
      setPending(key);
      try {
        await run();
      } catch (err) {
        if (key === "share" && isScreenShareCancel(err)) {
          return;
        }
        const kind =
          key === "mic"
            ? "microphone"
            : key === "camera"
              ? "camera"
              : key === "share"
                ? "screen"
                : "devices";
        notify(describeMediaError(err, kind), "error");
      } finally {
        setPending(null);
      }
    },
    [notify],
  );

  // The host can revoke self-unmute for the room. Any individual grant overrides
  // that: mute-all latches allowUnmute off, and without this the host would lift
  // somebody out of the audience and hand them a dead button.
  //
  // `promoted` rather than `audioOnly`, which was the bug. "Allow to speak" was
  // exempted and "Bring on stage" was not — so after a mute-all, a full stage
  // seat came with a working camera and a microphone the person could not turn on.
  // A promotion is the host choosing one person AFTER setting the room policy, and
  // it is the narrower grant that used to work.
  //
  // Being muted BY the host overrides everything. That one is enforced at the SFU
  // — the microphone is out of their grant — so the button is only reflecting a
  // decision that has already been made, not enforcing it.
  const mayUnmute =
    !permissions.mutedByHost && (isHost || permissions.promoted || controls.allowUnmute);
  const micBlocked = !isMicrophoneEnabled && !mayUnmute;

  /* The live level on the mic button, so saying "hello" is visibly going somewhere.
   *
   * Measured off the published track rather than taken from LiveKit's audioLevel or the
   * active-speaker events: those arrive about twice a second and are smoothed for deciding who
   * holds the floor, which makes them useless as a meter — two words would move them once.
   *
   * The ref writes a CSS custom property straight to the DOM every frame and re-renders
   * nothing. See lib/mic-level.ts for why that matters in a tab that is decoding video. */
  const micTrack = localParticipant
    ?.getTrackPublication(Track.Source.Microphone)
    ?.audioTrack?.mediaStreamTrack;
  const meterRef = useMicMeter<SVGRectElement>(micTrack, isMicrophoneEnabled);

  // Someone who may not unmute should hear why once, rather than clicking a dead
  // button and concluding the app is broken. A toast rather than a hover title,
  // because the phones this actually happens on have no hover.
  const onMicClick = useCallback(() => {
    if (permissions.mutedByHost) {
      notify("The host muted you. They'll let you know when you can speak again.", "info");
      return;
    }
    if (micBlocked) {
      notify("The host has turned off self-unmute. Ask them to unmute you.", "info");
      return;
    }
    void toggle("mic", "Microphone", () =>
      localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled),
    );
  }, [
    permissions.mutedByHost,
    micBlocked,
    notify,
    toggle,
    localParticipant,
    isMicrophoneEnabled,
  ]);

  // On with the background already applied, so the audience's first frame is not the room.
  const onCameraClick = useCallback(() => {
    void toggle("camera", "Camera", () =>
      isCameraEnabled
        ? localParticipant.setCameraEnabled(false)
        : enableCamera(
            localParticipant,
            prefs.background,
            prefs.lowLight,
            prefs.backgroundEngine,
          ),
    );
  }, [
    toggle,
    localParticipant,
    isCameraEnabled,
    prefs.background,
    prefs.lowLight,
    prefs.backgroundEngine,
  ]);

  const switchCapture = useCallback(
    async (kind: "audioinput" | "videoinput", deviceId: string) => {
      try {
        await room.switchActiveDevice(kind, deviceId);
        updatePrefs(
          kind === "audioinput" ? { audioInput: deviceId } : { videoInput: deviceId },
        );
      } catch (err) {
        notify(
          describeMediaError(err, kind === "audioinput" ? "microphone" : "camera"),
          "error",
        );
      }
    },
    [room, updatePrefs, notify],
  );

  /* M / V / hold-Space. Typed into a field they are not — see isTypingTarget.
   *
   * Space is push-to-talk only while already muted: holding it to talk, releasing
   * to go quiet again. Unmuting an already-live mic with Space would make the
   * release mute them mid-sentence, which is the opposite of what they asked for. */
  const pttHeld = useRef(false);
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const action = mediaHotkey(e, "down");
      if (!action) return;
      if (action === "mute") {
        e.preventDefault();
        onMicClick();
        return;
      }
      if (action === "camera" && permissions.canShareCamera) {
        e.preventDefault();
        onCameraClick();
        return;
      }
      if (action !== "ptt-down") return;
      if (
        pttHeld.current ||
        isMicrophoneEnabled ||
        permissions.mutedByHost ||
        !mayUnmute
      ) {
        return;
      }
      e.preventDefault();
      pttHeld.current = true;
      void localParticipant.setMicrophoneEnabled(true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (mediaHotkey(e, "up") !== "ptt-up" || !pttHeld.current) return;
      pttHeld.current = false;
      void localParticipant.setMicrophoneEnabled(false);
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [
    onMicClick,
    onCameraClick,
    permissions.canShareCamera,
    permissions.mutedByHost,
    isMicrophoneEnabled,
    mayUnmute,
    localParticipant,
  ]);

  // Screen share is not something any mobile browser supports, so the button is
  // hidden rather than offered and then failing. `canShare` (read above through
  // useSyncExternalStore) cannot be answered during a server render and never
  // changes afterwards — false on the server, the real answer on the client.

  /* One button for both kinds of share.
   *
   * `isScreenShareEnabled` is true either way — a shared file is published on the
   * ScreenShare source, which is exactly what makes it indistinguishable to the
   * audience — so the button reads the same state for both and stopping has to know
   * which it is. Calling setScreenShareEnabled(false) on a file share would
   * unpublish the track and leave the video element, the AudioContext and the object
   * URL behind, so the file keeps decoding in a tab nobody is watching. */
  const sharing = previewChrome
    ? previewSharing
    : isScreenShareEnabled || fileShare.active;

  const stopSharing = useCallback(async () => {
    if (previewChrome) {
      setPreviewSharing(false);
      notify("Stopped sharing (preview)", "info");
      return;
    }
    if (fileShare.active) {
      await fileShare.stop();
      return;
    }
    setPending("share");
    try {
      await localParticipant.setScreenShareEnabled(false);
    } catch {
      // Stopping share should not throw error toasts
    } finally {
      setPending(null);
    }
  }, [previewChrome, fileShare, localParticipant, notify]);

  /** Hands off to the browser's own picker, with a hint at which pane to open on. */
  const startScreenShare = useCallback(
    (surface: "browser" | "window" | "monitor") => {
      if (previewChrome) {
        setPreviewSharing(true);
        setShareFileOpen(false);
        notify("Share screen (preview — not publishing)", "info");
        return;
      }
      void toggle("share", "Screen share", () =>
        // Third argument: publish options for the share's audio, so a shared video is not
        // encoded with the settings tuned for a voice. See SCREEN_SHARE_PUBLISH.
        localParticipant.setScreenShareEnabled(
          true,
          displayMediaOptions(surface),
          SCREEN_SHARE_PUBLISH,
        ),
      );
    },
    [previewChrome, toggle, localParticipant, notify],
  );

  /** Per-tool badge. Only the tools with a stream of things that arrive while
   *  you are not looking. The raised-hand queue is not one of them any more —
   *  it has its own button — and the headcount is not one either: this feeds
   *  gridBadge's "something needs your attention" total on More, and a room of
   *  twenty people with nothing unread must not read as twenty unread things. */
  const badgeFor = (id: ToolId): number | undefined => unread[id] || undefined;

  /** What the button itself shows. Participants is always the headcount, even
   *  while hands are up. Everything else is badgeFor's attention count. */
  const countFor = (id: ToolId): number | undefined =>
    id === "participants" ? participantsButtonCount(headcount, realtime.hands.length) : badgeFor(id);

  const labelFor = (id: ToolId): string => {
    const t = tool(id);
    if (id === "participants" && headcount !== undefined) return `Participants · ${headcount}`;
    if (id === "hand") return realtime.myHandRaised ? "Lower hand" : "Raise hand";
    // Says which layout is in use, so the footer answers the question without
    // being opened.
    if (id === "layout") return `Layout · ${LAYOUT_LABEL[stage.mode]}`;
    if (id === "captions") return captionsAction?.active ? "Captions on" : "Captions off";
    if (id === "sharefile") return fileShare.active ? "Sharing a video file" : "Share a video file";
    if (id === "youtube") return youtube.configured ? "YouTube stream is on" : "Stream to YouTube";
    return t.label;
  };

  const activeFor = (id: ToolId): boolean => {
    if (id === "hand") return realtime.myHandRaised;
    if (id === "reactions") return reactionsOpen;
    if (id === "invite") return inviteOpen;
    if (id === "layout") return layoutOpen;
    if (id === "captions") return captionsAction?.active ?? false;
    if (id === "sharefile") return fileShare.active;
    if (id === "youtube") return youtube.configured;
    if (tools.panelTab === id) return true;
    const win = tools.layout.windows[id];
    return !!win && !win.minimized;
  };

  const editingNow = editing && moreOpen;
  const closeMore = useCallback(() => {
    setMoreOpen(false);
    setEditing(false);
  }, []);

  const activate = (id: ToolId) => {
    // A panel tool takes the one drawer. Yield the queue without putting the
    // tab it covered back on top of the tool just chosen.
    if (isPanelTool(id) && raisedHands.open) raisedHands.dismiss();
    // The same click that runs this tool takes More out of the way; the press
    // itself could not, since it might have been a drag aimed at the panel.
    if (closesMoreOnToolActivate({ moreOpen, editing: editingNow, dragging: drag.drag !== null })) {
      closeMore();
    }
    // Pointer presses already close these via their outside-press handlers;
    // this covers Enter / Space, which fires no pointerdown.
    if (id !== "reactions") setReactionsOpen(false);
    if (id !== "invite") setInviteOpen(false);
    if (id !== "layout") setLayoutOpen(false);
    if (id === "reactions") {
      setReactionsOpen((v) => !v);
      return;
    }
    if (id === "invite") {
      setInviteOpen((v) => !v);
      return;
    }
    if (id === "hand") {
      // A rejection here (e.g. the host has raise-hand turned off) used to be
      // a genuinely silent failure: an unhandled promise rejection nobody
      // saw, with the optimistic local toggle already applied so even the
      // person who clicked couldn't tell it hadn't actually reached anyone.
      void realtime.toggleHand().catch((err) => {
        notify(
          err instanceof Error ? err.message : "Couldn't raise your hand.",
          "error",
        );
      });
      tools.used("hand");
      return;
    }
    if (id === "layout") {
      setLayoutOpen((v) => !v);
      tools.used("layout");
      return;
    }
    if (id === "captions") {
      captionsAction?.onClick();
      return;
    }
    if (id === "sharefile") {
      setShareFileOpen(true);
      return;
    }
    if (id === "youtube") {
      youtube.open();
      return;
    }
    tools.toggle(id);
  };

  // Everything in the grid that has something waiting, so unpinning Chat does not
  // hide the fact that people are talking in it. Includes panelItems: on a phone
  // those badges would otherwise vanish along with the rail that used to show them.
  const gridBadge =
    grid.reduce((sum, id) => sum + (badgeFor(id) ?? 0), 0) +
    (panelItems?.reduce((sum, id) => sum + (badgeFor(id) ?? 0), 0) ?? 0) +
    (raisedWhere === "overflow" && raisedBadge ? raisedBadge : 0);

  const dropIndex = drag.drag?.over === "bar" ? drag.drag.index : null;

  /* The grid opens itself while a tool is being dragged off the bar.
   *
   * Without this, "drag it back to the grid" required having opened the grid
   * first — so the only way to unpin was to drop on nothing and trust that it
   * meant remove, which is not something a user can be expected to guess. Now
   * both drop targets are on screen for the whole gesture, and releasing anywhere
   * else is an unambiguous cancel.
   *
   * Derived rather than stored, so the grid closes itself again when the drag ends
   * and `moreOpen` — the user's own choice — is what remains. */
  const gridVisible = moreOpen || drag.drag?.from === "bar";

  const onShareClick = useCallback(() => {
    if (!previewChrome && !canShare) {
      notify(
        "This browser can't share a screen. Try opening the room in Chrome or Safari instead of an in-app browser.",
        "info",
      );
      return;
    }
    if (sharing) {
      void stopSharing();
      return;
    }
    if (previewChrome) {
      startScreenShare("monitor");
      return;
    }
    // Straight to the browser's own picker, pre-focused on its Chrome-tab pane —
    // the common case, and the one Chrome, Meet and Zoom all default to. Sharing a
    // recorded file instead is a rarer, deliberate choice with its own flow now;
    // see shareFileAction below and ShareVideoFileButton.
    startScreenShare("browser");
  }, [previewChrome, canShare, sharing, stopSharing, startScreenShare, notify]);

  return (
    <div
      ref={setBarEl}
      // pl-48 (192px) is the class-level fallback for the one render before
      // useCompact's effect fires — useEffect runs after paint, so `compact`
      // is briefly false even on a phone. Sized for the worst case (both
      // toggles) rather than 0, so that one frame is over-reserved rather
      // than under — a flash of extra padding is invisible; a flash of Chat
      // rendering under a mic button that appears a moment later is the
      // exact bug this is fixing. The inline style below only ever refines
      // it down once real data is in, never up past this floor.
      className={`relative flex min-h-14 shrink-0 items-center ${shiftToolsRight ? "justify-end" : "justify-center"} border-t border-white/10 bg-stage-bar pl-48 pr-16 sm:px-56`}
      style={{
        // Clears the iOS home indicator; without it the leave button sits
        // under the system gesture area and is genuinely hard to hit.
        paddingBottom: "max(0px, env(safe-area-inset-bottom))",
        ...(compact ? { paddingLeft: leftReservePx } : undefined),
      }}
    >
      {/* Mic + camera park on the left, out of flow, so they don't shove the
          centre cluster sideways. Gated per source: somebody the host allowed
          to speak gets a microphone and must NOT get a camera they were never
          granted. A silenced speaker still belongs here — their microphone is
          gone, but labelling them "view only" would say they lost their seat
          on the stage, which is the host's other, separate decision. */}
      {permissions.canPublish || permissions.mutedByHost ? (
        <div className="absolute top-0 left-2 flex h-14 items-center gap-1 sm:left-3 sm:gap-2">
          {(permissions.canSpeak || permissions.mutedByHost) && (
            <MediaToggle
              label={
                isMicrophoneEnabled
                  ? "Mute"
                  : permissions.mutedByHost
                    ? "Muted by host"
                    : micBlocked
                      ? "Unmute disabled by host"
                      : "Unmute"
              }
              shortcut="M"
              active={isMicrophoneEnabled}
              danger={!isMicrophoneEnabled}
              dimmed={micBlocked}
              busy={pending === "mic"}
              onClick={onMicClick}
              deviceKind="audioinput"
              currentDeviceId={prefs.audioInput}
              onSelectDevice={(id) => void switchCapture("audioinput", id)}
              meter={isMicrophoneEnabled ? <MicLevelIcon meterRef={meterRef} /> : undefined}
              icon={
                isMicrophoneEnabled ? (
                  <MicIcon className="size-5" />
                ) : (
                  <MicOffIcon className="size-5" />
                )
              }
            />
          )}
          {permissions.canShareCamera && (
            <MediaToggle
              label={isCameraEnabled ? "Stop video" : "Start video"}
              shortcut="V"
              active={isCameraEnabled}
              danger={!isCameraEnabled}
              busy={pending === "camera"}
              onClick={onCameraClick}
              deviceKind="videoinput"
              currentDeviceId={prefs.videoInput}
              onSelectDevice={(id) => void switchCapture("videoinput", id)}
              icon={
                isCameraEnabled ? (
                  <CameraIcon className="size-5" />
                ) : (
                  <CameraOffIcon className="size-5" />
                )
              }
            />
          )}
        </div>
      ) : null}

      {/* Centre strip: Share / Record / standing tools / pins / More.
          No horizontal scroll: CENTER_BAR_COMPACT keeps only Chat and Raise
          hand always visible on a phone, and the bar's own left padding
          (above) now reserves exactly mic+camera's real width instead of a
          worst-case guess — between them, Share + Chat + Raise hand + More
          fits without scrolling in every case except one: a full "Bring on
          stage" grant, where mic AND camera both show, leaving no room for
          Share too. shareOnBar below is that one condition — Share moves
          into More instead of overflowing there, not shown twice. */}
      <div className="flex min-w-0 items-center gap-1 sm:gap-2">
          {/* Preview chrome always offers Share (mocked). A live room still needs
              getDisplayMedia support — most mobile browsers do not expose it, and
              some in-app/WebView browsers (a link opened from another app) do not
              either even when the OS's own browser would.
              The button used to simply disappear when `canShare` was false, which
              read as the permission itself missing — "I was told I could share
              and there's no button" is indistinguishable from a bug from where
              the person holding the phone is standing. It stays, dimmed, and a
              tap explains why via a toast rather than doing nothing — a hover
              title would have said the same thing but there is no hover on the
              phones this actually happens on. */}
          {permissions.canShareScreen && shareOnBar && (
            <BarButton
              label={sharing ? "Stop sharing" : "Share"}
              active={sharing}
              dimmed={!previewChrome && !canShare}
              busy={pending === "share" || fileShare.starting}
              onClick={onShareClick}
              icon={
                sharing ? (
                  <ScreenShareOffIcon className="size-5" />
                ) : (
                  <ScreenShareIcon className="size-5" />
                )
              }
            />
          )}

          {/* Recording sits with the centre tools the way Zoom parks Record —
              a capture control, not a mute/video twin. It renders nothing for
              anyone the server has not told they may record. */}
          <RecordButton />
          {/* YouTube's home, beside Record. It moves into More like any other
              tool; its dialog is rendered once below either way. */}
          {youtubeHome && (
            <HomeToolSlot
              id="youtube"
              label={labelFor("youtube")}
              active={activeFor("youtube")}
              live={youtube.configured}
              movable={capacity > 0}
              editing={editingNow}
              landed={landed === "youtube"}
              dragging={drag.drag?.tool === "youtube"}
              onActivate={() => activate("youtube")}
              onRemove={() => edit(() => tools.remove("youtube"))}
            />
          )}
          {/* Captions recognition stays mounted for publishers; the host
              toggle lives in More (captionsAction), not on the standing bar. */}
          <CaptionsSession />

        {centerTools.map((id) => {
          const Icon = tool(id).icon;
          const slot = isHomeTool(id) ? (
            <HomeToolSlot
              id={id}
              label={labelFor(id)}
              active={activeFor(id)}
              movable={capacity > 0}
              editing={editingNow}
              landed={landed === id}
              dragging={drag.drag?.tool === id}
              onActivate={() => activate(id)}
              onRemove={() => edit(() => tools.remove(id))}
            />
          ) : (
            <div className="relative" data-tool-slot={id}>
              <BarButton
                label={tool(id).label}
                active={activeFor(id)}
                badge={countFor(id)}
                mentions={id === "chat" ? mentions : 0}
                onClick={() => activate(id)}
                icon={<Icon className="size-5" />}
              />
              {id === "reactions" && reactionsOpen && (
                <ReactionTray
                  onPick={(emoji) => {
                    void realtime.react(emoji);
                    tools.used("reactions");
                    setReactionsOpen(false);
                  }}
                  onClose={() => setReactionsOpen(false)}
                />
              )}
            </div>
          );
          return (
            <Fragment key={id}>
              {slot}
              {raisedWhere === "bar" && id === "participants" && raisedCount != null && (
                <RaisedHandsBarButton
                  count={raisedBadge}
                  active={raisedHands.open}
                  onClick={() => raisedHands.toggle()}
                />
              )}
            </Fragment>
          );
        })}
        {raisedWhere === "bar" &&
          raisedCount != null &&
          !centerTools.includes("participants") && (
            <RaisedHandsBarButton
              count={raisedBadge}
              active={raisedHands.open}
              onClick={() => raisedHands.toggle()}
            />
          )}

        {/* Customisable extras (Invite, Host tools, Captions, …) sit in the
            same strip they overflow from, not across the bar next to Leave.
            While a tool is in flight from More this strip is the drop zone,
            and says so in words — a dashed outline alone meant nothing to a
            host who had never dragged a toolbar button before. */}
        {(() => {
          const fromGrid = drag.drag?.from === "grid";
          // A home tool returns to its own place wherever it is dropped, so
          // there is no insertion point to draw and nothing to bump.
          const homeDrag = drag.drag ? isHomeTool(drag.drag.tool) : false;
          const bump = fromGrid ? wouldBump(tools.layout, capacity, usable, drag.drag?.tool) : null;
          const zoneLabel = homeDrag
            ? fromGrid
              ? "Drop to put it back on the toolbar"
              : null
            : dropIndex !== null
              ? fromGrid
                ? bump
                  ? `Drop to add · ${tool(bump).label} goes to More`
                  : "Drop to add to toolbar"
                : "Drop to move it here"
              : fromGrid
                ? "Drop here to add"
                : null;
          const markerAt = homeDrag ? null : dropIndex;
          return (
            <div
              className={`relative flex items-center gap-1 rounded-xl px-0.5 transition-colors sm:gap-2 ${
                drag.drag
                  ? dropIndex !== null
                    ? "bg-brand/15 outline-2 outline-brand outline-offset-2"
                    : "outline-1 outline-dashed outline-white/40 outline-offset-2"
                  : editingNow && slots.length > 0
                    ? "outline-1 outline-dashed outline-white/30 outline-offset-2"
                    : ""
              }`}
            >
              {zoneLabel && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute -top-9 left-1/2 z-[60] -translate-x-1/2 rounded-md bg-brand px-2 py-1 text-[11px] font-semibold whitespace-nowrap text-stage shadow-lg"
                >
                  {zoneLabel}
                </span>
              )}
              {slots.map((slot, i) => (
                <div key={slot.tool} className="flex items-center">
                  {markerAt === i && <DropMarker />}
                  <div
                    data-tool-slot={slot.tool}
                    data-tool-pin={slot.tool}
                    className={`relative ${
                      landed === slot.tool
                        ? "motion-safe:animate-[tool-land_420ms_cubic-bezier(0.2,0.9,0.3,1.2)]"
                        : ""
                    }`}
                  >
                    <ToolSlotButton
                      id={slot.tool}
                      label={labelFor(slot.tool)}
                      active={activeFor(slot.tool)}
                      badge={countFor(slot.tool)}
                      mentions={slot.tool === "chat" ? mentions : 0}
                      pinned={slot.pinned}
                      dragging={drag.drag?.tool === slot.tool}
                      onActivate={() => activate(slot.tool)}
                    />
                    {editingNow && (
                      <button
                        type="button"
                        aria-label={`Move ${tool(slot.tool).label} to More`}
                        title={`Move ${tool(slot.tool).label} to More`}
                        onClick={() => edit(() => tools.remove(slot.tool))}
                        className="absolute -top-1.5 -right-1.5 z-10 grid size-5 place-items-center rounded-full bg-white text-stage shadow-md outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-brand"
                      >
                        <MinusIcon className="size-3" />
                      </button>
                    )}
                    {slot.tool === "layout" && layoutOpen && (
                      <LayoutMenu onClose={() => setLayoutOpen(false)} />
                    )}
                    {slot.tool === "reactions" && reactionsOpen && (
                      <ReactionTray
                        onPick={(emoji) => {
                          void realtime.react(emoji);
                          tools.used("reactions");
                          setReactionsOpen(false);
                        }}
                        onClose={() => setReactionsOpen(false)}
                      />
                    )}
                    {slot.tool === "invite" && inviteOpen && (
                      <InviteMenu
                        onUsed={() => tools.used("invite")}
                        onClose={() => setInviteOpen(false)}
                      />
                    )}
                  </div>
                </div>
              ))}
              {/* An empty toolbar still needs somewhere to aim at. */}
              {fromGrid && !homeDrag && slots.length === 0 && (
                <span
                  aria-hidden
                  className={`grid h-10 w-14 place-items-center rounded-lg border-2 border-dashed motion-safe:animate-[tool-slot-breathe_1.6s_ease-in-out_infinite] ${
                    dropIndex !== null ? "border-brand bg-brand/20 text-brand" : "border-white/40 text-white/60"
                  }`}
                >
                  <PlusIcon className="size-4" />
                </span>
              )}
              {markerAt !== null && slots.length > 0 && markerAt >= slots.length && <DropMarker />}
            </div>
          );
        })()}

        <div className="relative">
          <MoreButton
            open={gridVisible}
            count={gridVisible ? 0 : gridBadge}
            mentions={
              !gridVisible &&
              (grid.includes("chat") || (panelItems?.includes("chat") ?? false))
                ? mentions
                : 0
            }
            onToggle={() => {
              if (moreOpen) closeMore();
              else {
                setMoreOpen(true);
                setReactionsOpen(false);
                setInviteOpen(false);
                setLayoutOpen(false);
              }
            }}
          />
          {gridVisible && (
            <MoreGrid
              items={grid}
              panelItems={panelItems}
              raisedHandsAction={
                raisedWhere === "overflow" && raisedCount != null
                  ? {
                      count: raisedBadge,
                      active: raisedHands.open,
                      onClick: () => raisedHands.toggle(),
                    }
                  : undefined
              }
              shareAction={
                permissions.canShareScreen && !shareOnBar
                  ? {
                      label: sharing ? "Stop sharing" : "Share",
                      icon: sharing ? (
                        <ScreenShareOffIcon className="size-5" />
                      ) : (
                        <ScreenShareIcon className="size-5" />
                      ),
                      active: sharing,
                      dimmed: !previewChrome && !canShare,
                      busy: pending === "share" || fileShare.starting,
                      onClick: onShareClick,
                    }
                  : undefined
              }
              // Share a video file and Captions are ordinary tools now (they can
              // move to the toolbar like the rest); their state and click still
              // live here, because this is where the share picker and the host's
              // captions switch are. Share a video file is only offered where
              // the browser can capture a video element — see `usable` above.
              toolActions={{
                sharefile: {
                  active: fileShare.active,
                  busy: fileShare.starting,
                  title: fileShare.active ? "Sharing a video file" : "Share a video file",
                  onClick: () => setShareFileOpen(true),
                },
                ...(captionsAction
                  ? {
                      captions: {
                        active: captionsAction.active,
                        busy: captionsAction.busy,
                        title: captionsAction.title,
                        onClick: captionsAction.onClick,
                      },
                    }
                  : {}),
                youtube: {
                  active: youtube.configured,
                  busy: false,
                  title: youtube.configured
                    ? "YouTube stream is on — click to change"
                    : "Stream to YouTube",
                  onClick: youtube.open,
                },
              }}
              // A tucked home tool can go back even on a screen with no pin
              // slots — it returns to its own place, not a slot. So a phone
              // that tucked Settings can always put it back.
              canCustomize={capacity > 0 || tucked.length > 0}
              movableIds={
                capacity > 0 ? undefined : grid.filter((id) => isHomeTool(id))
              }
              bumpTarget={wouldBump(tools.layout, capacity, usable)}
              editing={editingNow}
              onEditingChange={setEditing}
              onAdd={(id) => edit(() => tools.place(id, capacity))}
              onReset={
                isCustomised(tools.layout)
                  ? () =>
                      edit(() => {
                        tools.reset();
                        return { kind: "reset" };
                      })
                  : undefined
              }
              landed={landed}
              // While the grid is only open because a drag is in flight, dismissing
              // it is not something the user can ask for — the drag owns it.
              onClose={closeMore}
            />
          )}
        </div>
      </div>

      {/* The undo notice, over the bar's left end: the More panel owns the
          right, and a notice on top of the panel it is describing covers the
          very tool it is talking about. */}
      {notice && (
        <ToolbarNotice
          key={notice.key}
          text={notice.text}
          onUndo={() => {
            tools.restore(notice.snap);
            setNotice(null);
          }}
          onDismiss={() => setNotice(null)}
        />
      )}

      {/* Leave stays on the far right, alone, the way Zoom parks End/Leave.
          Out of flow so it does not pull the centred strip toward the left. */}
      <div className="absolute top-0 right-2 flex h-14 items-center gap-1.5 sm:right-3">
        {/* Pop out, beside Leave rather than in the tool strip.
            It is a window-level control like Leave is — it puts the webinar somewhere else
            rather than changing anything inside it — and the tool strip is a draggable layout
            somebody arranges, which this does not belong in.

            Desktop only, and hidden when unsupported rather than disabled: no mobile browser
            implements either kind of PiP, and a dead button that never explains itself is
            worse than one that was never offered. */}
        {pip.supported && (
          <button
            type="button"
            onClick={() => (pip.active ? pip.close({ dismiss: true }) : pip.open())}
            disabled={connecting}
            aria-label={pip.active ? "Close the floating window" : "Pop out into a floating window"}
            aria-pressed={pip.active}
            title={pip.active ? "Close the floating window" : "Pop out"}
            className={`hidden size-10 shrink-0 place-items-center rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:cursor-not-allowed disabled:opacity-50 sm:grid ${
              pip.active
                ? "bg-white/20 text-white"
                : "text-white/70 hover:bg-white/10 hover:text-white"
            }`}
          >
            <PipIcon className="size-4.5" />
          </button>
        )}
        {isHost && <SendSurveyButton disabled={connecting} />}
        <div className="relative">
          <button
            type="button"
            /* One attribute for both popovers, because both need the same guard: the click
               that opens them must not also register as a click outside them. */
            data-host-leave-trigger={isHost ? "" : undefined}
            data-leave-trigger=""
            onClick={() => {
              if (isHost) setLeaveMenuOpen((v) => !v);
              // Not leave(). A mis-click on the one button parked where a window's close
              // control lives used to drop somebody out of a live session with no step in
              // between — see LeaveConfirm for why that step is a popover and not a modal.
              else setLeaveConfirmOpen((v) => !v);
            }}
            disabled={connecting}
            aria-label={isHost ? "Leave or end the webinar" : "Leave the webinar"}
            aria-haspopup={isHost ? "menu" : "dialog"}
            aria-expanded={isHost ? leaveMenuOpen : leaveConfirmOpen}
            title={connecting ? "Connecting…" : undefined}
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-live px-3 text-[13px] font-semibold text-white transition-colors hover:bg-live/90 outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-live sm:px-4"
          >
            <LeaveIcon className="size-4 sm:hidden" />
            <span className="hidden sm:inline">Leave</span>
          </button>
          {isHost ? (
            <HostLeaveMenu
              open={leaveMenuOpen}
              onClose={() => setLeaveMenuOpen(false)}
              onAssign={() => setAssignOpen(true)}
              onEnd={() => setEndConfirmOpen(true)}
            />
          ) : (
            <LeaveConfirm
              open={leaveConfirmOpen}
              /* A panelist is on the stage, and what they take with them when they go is
                 different from what an attendee does — so the copy is too. isAttendee is
                 already the app's own test for the difference. */
              role={isAttendee ? "attendee" : "panelist"}
              onClose={() => setLeaveConfirmOpen(false)}
              onLeave={leave}
            />
          )}
        </div>
      </div>

      {isHost && (
        <>
          <HostAssignDialog
            open={assignOpen}
            onClose={() => setAssignOpen(false)}
            onLeave={leave}
          />
          <EndWebinarDialog
            open={endConfirmOpen}
            onClose={() => setEndConfirmOpen(false)}
          />
        </>
      )}

      {/* Into the floating window's own document, which is a different document — so this is
          a portal by necessity rather than for stacking. React keeps the tree and its context,
          which is what lets the buttons in there call the same handlers as the bar's. */}
      {pip.container &&
        createPortal(
          <PipStage
            micEnabled={isMicrophoneEnabled}
            cameraEnabled={isCameraEnabled}
            onMic={onMicClick}
            onCamera={onCameraClick}
            canSpeak={permissions.canSpeak && !permissions.mutedByHost}
            canShareCamera={permissions.canShareCamera}
            onBackToTab={() => {
              // Raising the tab is what somebody pressing this wants; the window closing is a
              // consequence of arriving, and the visibility listener in usePictureInPicture
              // would do it a moment later anyway. Done here so it is not two steps.
              window.focus();
              pip.close();
            }}
          />,
          pip.container,
        )}

      {/* Rendered here rather than at the room level so it is mounted only for
          somebody who may actually share. It is a Modal, so it portals out of the
          bar's stacking context on its own. */}
      {!previewChrome && canShare && permissions.canShareScreen && (
        <SharePicker
          open={shareFileOpen}
          onClose={() => setShareFileOpen(false)}
          onScreenShare={startScreenShare}
        />
      )}

      {/* Mounted here whether YouTube's button is on the bar or in More, so
          opening it from either place — and More closing behind it — works. */}
      {youtube.dialog}
    </div>
  );
}

/** Where a dropped tool will land. A line rather than a gap that opens up: the
 *  gap shifts every other button sideways mid-drag, and the target the user was
 *  aiming at moves out from under the pointer. */
function DropMarker() {
  return (
    <span
      aria-hidden
      className="mx-0.5 h-9 w-0.5 shrink-0 rounded-full bg-brand shadow-[0_0_8px_var(--color-brand)]"
    />
  );
}

/** "Captions is on your toolbar now. Undo" — above the More button, for six
 *  seconds. Not the app-wide toast: that has no action slot, and an undo that
 *  lives somewhere else from the thing it undoes is one nobody finds. A polite
 *  live region, so a screen reader hears what the + or − did. */
function ToolbarNotice({
  text,
  onUndo,
  onDismiss,
}: {
  text: string;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      data-toolbar-notice
      role="status"
      aria-live="polite"
      className="room-dark absolute bottom-full left-2 z-[60] mb-3 flex w-max max-w-[min(360px,calc(100vw-1rem))] items-center gap-3 rounded-xl border border-line-2 bg-surface-2 py-2 pr-2 pl-3 text-[12px] text-ink shadow-2xl motion-safe:animate-[poll-card-in_200ms_ease-out] sm:left-3"
    >
      <span className="min-w-0">{text}</span>
      <button
        type="button"
        onClick={onUndo}
        className="shrink-0 rounded-md px-2 py-1 font-semibold text-brand outline-none hover:bg-brand/10 focus-visible:ring-2 focus-visible:ring-brand/50"
      >
        Undo
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/50"
      >
        ×
      </button>
    </div>
  );
}

/** A tool on the bar. Click to use, drag to move or remove. */
function ToolSlotButton({
  id,
  label,
  active,
  badge,
  mentions = 0,
  pinned,
  dragging,
  onActivate,
}: {
  id: ToolId;
  label: string;
  active: boolean;
  badge?: number;
  /** Unseen @mentions, which turn the badge into "@". Chat only. */
  mentions?: number;
  /** False for a tool surfaced into a vacant slot from recent use. Marked, because
   *  a button that appeared on its own needs to be explicable — and because
   *  dragging it is what makes it stay. */
  pinned: boolean;
  dragging: boolean;
  onActivate: () => void;
}) {
  const t = tool(id);
  const Icon = t.icon;
  const drag = useToolDrag();

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={pinned ? label : `${label} — recently used. Drag it to keep it here.`}
      {...drag.bind(id, "bar", onActivate)}
      className={`relative shrink-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-white/50 ${
        dragging ? "opacity-40" : ""
      }`}
    >
      <BarButtonShell label={t.label} active={active}>
        <Icon className="size-5" />
      </BarButtonShell>
      <ToolBadge count={badge} mentions={mentions} />
      {!pinned && (
        <span
          aria-hidden
          title="Recently used"
          className="absolute bottom-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-white/40"
        />
      )}
    </button>
  );
}

/** YouTube or Settings in its home on the bar (lib/tools.ts HOME_BAR_TOOLS).
 *
 *  Draggable into More and, in Customize, carries the same − as a pin. Not a
 *  `data-tool-pin`: the drag layer counts those to place the insertion marker,
 *  and a home tool is not in that run of slots. `live` is YouTube's red
 *  "On YT" look, kept from the button it replaces. On a screen with no pin
 *  slots it is a plain button, because a tool tucked there could only come
 *  back on a wider screen. */
function HomeToolSlot({
  id,
  label,
  active,
  live = false,
  movable,
  editing,
  landed,
  dragging,
  onActivate,
  onRemove,
}: {
  id: ToolId;
  label: string;
  active: boolean;
  live?: boolean;
  movable: boolean;
  editing: boolean;
  landed: boolean;
  dragging: boolean;
  onActivate: () => void;
  onRemove: () => void;
}) {
  const t = tool(id);
  const Icon = t.icon;
  const drag = useToolDrag();
  const caption = id === "youtube" && live ? "On YT" : t.label;
  const title = live ? `${label} — click to change` : label;

  return (
    <div
      data-tool-slot={id}
      data-tool-home={id}
      className={`relative ${
        landed ? "motion-safe:animate-[tool-land_420ms_cubic-bezier(0.2,0.9,0.3,1.2)]" : ""
      }`}
    >
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        title={movable && !editing ? `${title}. Drag into More to tuck it away.` : title}
        {...(movable ? drag.bind(id, "bar", onActivate) : { onClick: onActivate })}
        className={`relative shrink-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-white/50 ${
          dragging ? "opacity-40" : ""
        }`}
      >
        <BarButtonShell label={caption} active={active} live={live}>
          <Icon className="size-5" />
        </BarButtonShell>
      </button>
      {editing && movable && (
        <button
          type="button"
          aria-label={`Move ${t.label} to More`}
          title={`Move ${t.label} to More`}
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 z-10 grid size-5 place-items-center rounded-full bg-white text-stage shadow-md outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-brand"
        >
          <MinusIcon className="size-3" />
        </button>
      )}
    </div>
  );
}

/** The emoji row, above whichever slot holds Reactions. */
function ReactionTray({
  onPick,
  onClose,
}: {
  onPick: (emoji: Reaction) => void;
  onClose: () => void;
}) {
  const wrap = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    /* An outside press, like every other bar popover — not a full-screen
     * catcher, which swallowed the press meant for More or Chat and made the
     * host click twice. The Reactions button itself toggles the tray. */
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (wrap.current?.contains(target)) return;
      if (target?.closest?.("[data-tool-slot='reactions']")) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [onClose]);

  return (
    <div
      ref={wrap}
      className="absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 rounded-xl border border-line bg-surface p-1 shadow-xl"
    >
      <ReactionPicker onPick={onPick} />
    </div>
  );
}

// ------------------------------------------------------------------- buttons

/** The count in a bar button's corner — or "@" while a mention is waiting, with a
 *  ring so it reads as a different thing from a number, not just a different number. */
function ToolBadge({ count, mentions = 0 }: { count?: number; mentions?: number }) {
  const text = badgeText(count, mentions);
  if (!text) return null;
  return (
    <span
      className={`absolute top-0.5 right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white ${
        mentions > 0 ? "ring-2 ring-white/80" : ""
      }`}
    >
      {mentions > 0 && <span className="sr-only">You were mentioned: </span>}
      {text}
    </span>
  );
}

/** The visual shell, shared so every button on the bar is the same object
 *  whatever renders it. */
function BarButtonShell({
  label,
  active = false,
  danger = false,
  dimmed = false,
  live = false,
  className = "",
  children,
}: {
  label: string;
  active?: boolean;
  danger?: boolean;
  dimmed?: boolean;
  /** YouTube's "stream is on" look — red, like the live badge. */
  live?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const tone = dimmed
    ? "text-white/35"
    : live
      ? "bg-live/20 text-live-soft"
      : danger
      ? // Every other "soft" badge in the room uses bg-X-soft text-X — a pale
        // tint behind a fully saturated icon. This one had it backwards:
        // bg-live/15 text-live-soft put the FAINT maroon (--color-live-soft,
        // #3a1917 in the room's dark theme) on the icon itself, over a
        // near-black bar — the icon all but disappeared, so muted read as
        // "the button turned faintly red" rather than "that mic has a slash
        // through it." bg-live-soft text-live matches the convention and
        // makes the crossed icon the thing that's actually legible.
        "bg-live-soft text-live"
      : active
        ? "bg-white/20 text-white"
        : "text-white/75 hover:bg-white/10 hover:text-white";

  return (
    <span
      className={`inline-flex h-10 min-w-10 flex-col items-center justify-center gap-0.5 rounded-lg px-2 transition-colors sm:min-w-14 ${tone} ${className}`}
    >
      {children}
      {/* The caption disappears below `sm`, where there is only room for glyphs. */}
      <span className="hidden text-[9.5px] leading-none font-medium whitespace-nowrap sm:block">{label}</span>
    </span>
  );
}

function RaisedHandsBarButton({
  count,
  active,
  onClick,
}: {
  /** Null when the queue is empty — the button stays, without a "0" badge. */
  count: number | null;
  active: boolean;
  onClick: () => void;
}) {
  const named = count != null && count > 0 ? `Raised hands, ${count}` : "Raised hands";
  return (
    <BarButton
      label="Raised hands"
      ariaLabel={named}
      active={active}
      badge={count != null && count > 0 ? count : undefined}
      onClick={onClick}
      icon={<HandIcon className="size-5" />}
    />
  );
}

function BarButton({
  label,
  icon,
  onClick,
  active = false,
  danger = false,
  dimmed = false,
  busy = false,
  badge,
  mentions = 0,
  meterRef,
  ariaLabel,
  className = "",
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  dimmed?: boolean;
  busy?: boolean;
  badge?: number;
  /** Unseen @mentions, which turn the badge into "@". Chat only. */
  mentions?: number;
  ariaLabel?: string;
  /** Attach a live audio meter to this button. The element's `--mic-level` is written every
   *  frame by useMicMeter; only the microphone passes this. */
  meterRef?: React.RefObject<SVGRectElement | null>;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? label}
      aria-pressed={active}
      title={ariaLabel ?? label}
      disabled={busy}
      className={`relative shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-white/50 rounded-lg ${className}`}
    >
      <BarButtonShell label={label} active={active} danger={danger} dimmed={dimmed}>
        {busy ? (
          <Spinner className="size-5" />
        ) : active && meterRef ? (
          <MicLevelIcon meterRef={meterRef} />
        ) : (
          icon
        )}
      </BarButtonShell>
      <ToolBadge count={badge} mentions={mentions} />
    </button>
  );
}

/**
 * The mic icon with the live level rising inside it, like a tiny liquid gauge —
 * green filling the capsule from the bottom up as the level climbs, not the
 * icon fading to a different color, which read as tinting rather than a meter.
 *
 * The capsule outline draws once, in the button's ordinary color. A second copy
 * of the exact same capsule path is the clip region for a green rect tall enough
 * to cover it at full level; `scaleY` (anchored to the bottom edge via
 * `transformOrigin` + `transformBox: "fill-box"`, so it does not care about the
 * path's actual coordinates) is what rises and falls with speech. Everything
 * below the stand-and-stem strokes, which stay a plain outline throughout —
 * only the capsule fills, the way a real level meter is a needle inside a
 * housing, not the housing itself changing shape.
 *
 * `--mic-level` is written straight to the rect's inline style every frame by
 * useMicMeter (mic-level.ts), same as before this existed; nothing here
 * re-renders while somebody talks, which is the entire reason that hook does
 * not use React state.
 */
function MicLevelIcon({
  meterRef,
}: {
  meterRef: React.RefObject<SVGRectElement | null>;
}) {
  const clipId = useId();
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}>
          <path d={MIC_CAPSULE_PATH} />
        </clipPath>
      </defs>
      <path d={MIC_CAPSULE_PATH} />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <path d="M12 18v3" />
      <path d="M8 21h8" />
      <g clipPath={`url(#${clipId})`}>
        <rect
          ref={meterRef}
          x="9"
          y="2"
          width="6"
          height="12"
          fill="#4ade80"
          style={{
            transform: "scaleY(var(--mic-level, 0))",
            transformOrigin: "50% 100%",
            transformBox: "fill-box",
          }}
        />
      </g>
    </svg>
  );
}

/** Exported for the pre-join screen, which needs the same mic/camera affordance
 *  before there is a room to toggle. */
export { BarButton };

/** Re-exported so the pre-join preview can label its own tracks consistently. */
export const CAMERA_SOURCE = Track.Source.Camera;
