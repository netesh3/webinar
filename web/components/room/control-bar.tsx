"use client";

import {
  useConnectionState,
  useLocalParticipant,
  useRemoteParticipants,
  useRoomContext,
} from "@livekit/components-react";
import { ConnectionState, Track } from "livekit-client";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { Reaction } from "@/lib/realtime";
import { LAYOUT_LABEL } from "@/lib/layout";
import { barSlots, centerBarTools, gridItems, morePanelTools, type ToolId } from "@/lib/tools";
import { useCompact } from "@/lib/compact";
import { isTypingTarget, mediaHotkey } from "@/lib/media-hotkeys";
import { Spinner } from "../controls";
import {
  CameraIcon,
  CameraOffIcon,
  LeaveIcon,
  MIC_CAPSULE_PATH,
  MicIcon,
  MicOffIcon,
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
import { SCREEN_SHARE_PUBLISH } from "@/lib/media";
import { describeMediaError } from "@/lib/media-errors";
import { MediaToggle } from "./media-toggle";
import { displayMediaOptions, SharePicker } from "./share-picker";
import {
  HostAssignDialog,
  HostEndConfirm,
  HostLeaveMenu,
} from "./host-leave-dialog";
import { useToolDrag } from "./tool-drag";
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
const NARROW_SLOTS = 2;

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
    fileShare,
    stage,
    leave,
    previewChrome,
    prefs,
    updatePrefs,
  } = useRoomUI();

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
  const [shareOpen, setShareOpen] = useState(false);
  /** Preview-only share toggle — no LiveKit publish in `/preview/room`. */
  const [previewSharing, setPreviewSharing] = useState(false);
  /** The Layout popover, anchored to whichever slot holds it. */
  const [layoutOpen, setLayoutOpen] = useState(false);
  /** Host-only Leave menu (Zoom-style), then assign dialog or end confirm. */
  const [leaveMenuOpen, setLeaveMenuOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);

  const drag = useToolDrag();
  const capacity = useSlotCapacity();
  const slots = barSlots(tools.layout, capacity, availableTools);
  const grid = gridItems(tools.layout, slots, availableTools);
  const compact = useCompact();
  const centerTools = centerBarTools(availableTools, compact);
  const panelItems = morePanelTools(availableTools, compact);

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
        const kind =
          key === "mic" ? "microphone" : key === "camera" ? "camera" : "devices";
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

  const onCameraClick = useCallback(() => {
    void toggle("camera", "Camera", () =>
      localParticipant.setCameraEnabled(!isCameraEnabled),
    );
  }, [toggle, localParticipant, isCameraEnabled]);

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
  // hidden rather than offered and then failing. Read through useSyncExternalStore
  // because it cannot be answered during a server render and never changes
  // afterwards — false on the server, the real answer on the client.
  const canShare = useSyncExternalStore(subscribeNothing, readCanShare, readCanShareOnServer);

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
    await toggle("share", "Screen share", () =>
      localParticipant.setScreenShareEnabled(false),
    );
  }, [previewChrome, fileShare, toggle, localParticipant, notify]);

  /** Hands off to the browser's own picker, with a hint at which pane to open on. */
  const startScreenShare = useCallback(
    (surface: "browser" | "window" | "monitor") => {
      if (previewChrome) {
        setPreviewSharing(true);
        setShareOpen(false);
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

  /** Per-tool badge. Only two tools have a stream of things that arrive while you
   *  are not looking; the raised-hand queue is the third and belongs on
   *  Participants, because that is where the host acts on it. */
  const badgeFor = (id: ToolId): number | undefined => {
    if (id === "participants") {
      return isHost && realtime.hands.length > 0 ? realtime.hands.length : undefined;
    }
    return unread[id] || undefined;
  };

  const labelFor = (id: ToolId): string => {
    const t = tool(id);
    if (id === "participants" && headcount !== undefined) return `Participants · ${headcount}`;
    if (id === "hand") return realtime.myHandRaised ? "Lower hand" : "Raise hand";
    // Says which layout is in use, so the footer answers the question without
    // being opened.
    if (id === "layout") return `Layout · ${LAYOUT_LABEL[stage.mode]}`;
    return t.label;
  };

  const activeFor = (id: ToolId): boolean => {
    if (id === "hand") return realtime.myHandRaised;
    if (id === "reactions") return reactionsOpen;
    if (id === "invite") return inviteOpen;
    if (id === "layout") return layoutOpen;
    if (tools.panelTab === id) return true;
    const win = tools.layout.windows[id];
    return !!win && !win.minimized;
  };

  const activate = (id: ToolId) => {
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
    tools.toggle(id);
  };

  // Everything in the grid that has something waiting, so unpinning Chat does not
  // hide the fact that people are talking in it. Includes panelItems: on a phone
  // those badges would otherwise vanish along with the rail that used to show them.
  const gridBadge =
    grid.reduce((sum, id) => sum + (badgeFor(id) ?? 0), 0) +
    (panelItems?.reduce((sum, id) => sum + (badgeFor(id) ?? 0), 0) ?? 0);

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

  return (
    <div
      ref={setBarEl}
      // The centred strip's own padding is what keeps it clear of the two
      // out-of-flow clusters below (mic+camera on the left, Leave on the
      // right) — they don't push it, so this has to reserve their width
      // itself. On mobile that's asymmetric: two MediaToggles (mic + camera,
      // each ~84px: a ~40px main button plus a ~44px device-picker chevron)
      // plus their left-2 offset is ~180px, while Leave is icon-only and
      // needs under half that. `px-24` (96px each side) was sized for one
      // toggle, not two — a plain attendee granted audio-only ("Allow to
      // speak") barely fit; a full "Bring on stage" grant (mic AND camera)
      // did not, and the centred strip's own leftmost items — Chat, Share —
      // rendered right underneath the now-wider mic/camera cluster instead
      // of being pushed clear of it. Desktop's toggles are wider individually
      // but its existing `sm:px-56` (224px) already has room to spare either
      // way, which is why this only ever showed up on a phone.
      className="relative flex min-h-14 shrink-0 items-center justify-center border-t border-white/10 bg-stage-bar pl-48 pr-16 sm:px-56"
      // Clears the iOS home indicator; without it the leave button sits under
      // the system gesture area and is genuinely hard to hit.
      style={{ paddingBottom: "max(0px, env(safe-area-inset-bottom))" }}
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
              meter={<MicLevelIcon meterRef={meterRef} />}
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
          overflow-x-auto rather than shrinking or clipping: on a phone, Share
          + Chat + Reactions + Raise hand + Polls + More is six buttons in a
          strip that also has to leave room for mic+camera on the left and
          Leave on the right — arithmetically tighter than the available
          width allows even with correct padding. Scrolling means a packed
          bar is reachable with a swipe; the alternative (this row's own
          items silently overlapping or getting clipped) is the exact bug
          this whole layout pass exists to fix, and no fixed reservation is
          safe against a longer locale's labels or a wider dynamic-type
          setting doing the same thing again later. */}
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:thin] sm:gap-2">
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
          {permissions.canShareScreen && (
            <BarButton
              label={sharing ? "Stop sharing" : "Share"}
              active={sharing}
              dimmed={!previewChrome && !canShare}
              busy={pending === "share" || fileShare.starting}
              onClick={() => {
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
                setShareOpen(true);
              }}
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

        {centerTools.map((id) => {
          const Icon = tool(id).icon;
          return (
            <div key={id} className="relative" data-tool-slot={id}>
              <BarButton
                label={tool(id).label}
                active={activeFor(id)}
                badge={badgeFor(id)}
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
        })}

        {/* Customisable extras (Invite, Layout, Host, …) sit in the same strip
            they overflow from, not across the bar next to Leave. */}
        <div
          className={`flex items-center gap-1 rounded-xl px-0.5 transition-colors sm:gap-2 ${
            drag.drag
              ? dropIndex !== null
                ? "bg-brand/15 outline-2 outline-brand outline-offset-2"
                : "outline-1 outline-dashed outline-white/30 outline-offset-2"
              : ""
          }`}
        >
          {slots.map((slot, i) => (
            <div key={slot.tool} className="flex items-center">
              {dropIndex === i && <DropMarker />}
              <div data-tool-slot={slot.tool} className="relative">
                <ToolSlotButton
                  id={slot.tool}
                  label={labelFor(slot.tool)}
                  active={activeFor(slot.tool)}
                  badge={badgeFor(slot.tool)}
                  pinned={slot.pinned}
                  dragging={drag.drag?.tool === slot.tool}
                  onActivate={() => activate(slot.tool)}
                />
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
          {dropIndex !== null && dropIndex >= slots.length && <DropMarker />}
        </div>

        <div className="relative">
          <MoreButton
            open={gridVisible}
            count={gridVisible ? 0 : gridBadge}
            onToggle={() => setMoreOpen((v) => !v)}
          />
          {gridVisible && (
            <MoreGrid
              items={grid}
              panelItems={panelItems}
              // While the grid is only open because a drag is in flight, dismissing
              // it is not something the user can ask for — the drag owns it.
              onClose={() => setMoreOpen(false)}
            />
          )}
        </div>
      </div>

      {/* Leave stays on the far right, alone, the way Zoom parks End/Leave.
          Out of flow so it does not pull the centred strip toward the left. */}
      <div className="absolute top-0 right-2 flex h-14 items-center sm:right-3">
        <div className="relative">
          <button
            type="button"
            data-host-leave-trigger={isHost ? "" : undefined}
            onClick={() => {
              if (isHost) setLeaveMenuOpen((v) => !v);
              else leave();
            }}
            disabled={connecting}
            aria-label={isHost ? "Leave or end the webinar" : "Leave the webinar"}
            aria-haspopup={isHost ? "menu" : undefined}
            aria-expanded={isHost ? leaveMenuOpen : undefined}
            title={connecting ? "Connecting…" : undefined}
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-live px-3 text-[13px] font-semibold text-white transition-colors hover:bg-live/90 outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-live sm:px-4"
          >
            <LeaveIcon className="size-4 sm:hidden" />
            <span className="hidden sm:inline">Leave</span>
          </button>
          {isHost && (
            <HostLeaveMenu
              open={leaveMenuOpen}
              onClose={() => setLeaveMenuOpen(false)}
              onAssign={() => setAssignOpen(true)}
              onEnd={() => setEndConfirmOpen(true)}
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
          <HostEndConfirm
            open={endConfirmOpen}
            onClose={() => setEndConfirmOpen(false)}
          />
        </>
      )}

      {/* Rendered here rather than at the room level so it is mounted only for
          somebody who may actually share. It is a Modal, so it portals out of the
          bar's stacking context on its own. */}
      {!previewChrome && canShare && permissions.canShareScreen && (
        <SharePicker
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          onScreenShare={startScreenShare}
        />
      )}
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

/** A tool on the bar. Click to use, drag to move or remove. */
function ToolSlotButton({
  id,
  label,
  active,
  badge,
  pinned,
  dragging,
  onActivate,
}: {
  id: ToolId;
  label: string;
  active: boolean;
  badge?: number;
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
      {badge !== undefined && badge > 0 && (
        <span className="absolute top-0.5 right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
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

/** The emoji row, above whichever slot holds Reactions. */
function ReactionTray({
  onPick,
  onClose,
}: {
  onPick: (emoji: Reaction) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* A full-screen catcher, which is the only reliable outside-click on touch. */}
      <button className="fixed inset-0 z-40 cursor-default" aria-label="Close reactions" onClick={onClose} />
      <div className="absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 rounded-xl border border-line bg-surface p-1 shadow-xl">
        <ReactionPicker onPick={onPick} />
      </div>
    </>
  );
}

// ------------------------------------------------------------------- buttons

/** The visual shell, shared so every button on the bar is the same object
 *  whatever renders it. */
function BarButtonShell({
  label,
  active = false,
  danger = false,
  dimmed = false,
  className = "",
  children,
}: {
  label: string;
  active?: boolean;
  danger?: boolean;
  dimmed?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const tone = dimmed
    ? "text-white/35"
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
      <span className="hidden text-[9.5px] leading-none font-medium sm:block">{label}</span>
    </span>
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
  meterRef,
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
  /** Attach a live audio meter to this button. The element's `--mic-level` is written every
   *  frame by useMicMeter; only the microphone passes this. */
  meterRef?: React.RefObject<SVGRectElement | null>;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={busy}
      className={`relative shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-white/50 rounded-lg ${className}`}
    >
      <BarButtonShell label={label} active={active} danger={danger} dimmed={dimmed}>
        {busy ? (
          <Spinner className="size-5" />
        ) : meterRef ? (
          <MicLevelIcon meterRef={meterRef} />
        ) : (
          icon
        )}
      </BarButtonShell>
      {badge !== undefined && badge > 0 && (
        <span className="absolute top-0.5 right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
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
      <path d="M6 11a6 6 0 0 0 12 0M12 17v3" />
      <g clipPath={`url(#${clipId})`}>
        <rect
          ref={meterRef}
          /* The capsule's own bounding box, not a padded guess — matched exactly
           * so `scaleY` from this rect's bottom edge lines up with the capsule's
           * true bottom (y=12). A padded rect still LOOKS right at empty and full
           * (both ends are clipped to the same place either way) but makes the
           * fill rise nonlinearly in between, which is the kind of thing a level
           * meter cannot afford to get slightly wrong without looking broken. */
          x="9"
          y="4"
          width="6"
          height="8"
          fill="#4ade80"
          /* Literal green, not currentColor and not --color-ok.
           *
           * The bar is not `.room-dark`, so --color-ok is the light-theme forest
           * green — invisible on this near-black strip. currentColor inherits the
           * button's white, so a working meter looked like the capsule getting
           * slightly thicker, not like "I am being heard". */
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
