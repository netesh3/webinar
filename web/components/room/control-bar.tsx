"use client";

import {
  useConnectionState,
  useLocalParticipant,
  useRemoteParticipants,
} from "@livekit/components-react";
import { ConnectionState, Track } from "livekit-client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Reaction } from "@/lib/realtime";
import { LAYOUT_LABEL } from "@/lib/layout";
import { barSlots, gridItems, type ToolId } from "@/lib/tools";
import { Spinner } from "../controls";
import {
  CameraIcon,
  CameraOffIcon,
  LeaveIcon,
  MicIcon,
  MicOffIcon,
  ScreenShareIcon,
  ScreenShareOffIcon,
} from "../icons";
import { useToast } from "../providers";
import { useMicMeter } from "@/lib/mic-level";
import { useRoomUI } from "./context";
import { LayoutMenu } from "./layout-menu";
import { MoreButton, MoreGrid } from "./more-grid";
import { ReactionPicker } from "./reactions";
import { RecordButton } from "./recording";
import { SCREEN_SHARE_PUBLISH } from "@/lib/media";
import { displayMediaOptions, SharePicker } from "./share-picker";
import { useToolDrag } from "./tool-drag";
import { tool } from "./tools";

/* The control bar.
 *
 * Three zones, and the split is the whole design:
 *
 *   fixed left    microphone, camera, screen share, record. Never customisable
 *                 and never in the More grid — they are the controls somebody
 *                 reaches for mid-sentence, and a control you have to open a
 *                 drawer to find is a control you mute yourself too late with.
 *                 They are also per-role: an attendee has none of them.
 *
 *   slots         everything else, pinned by the user or surfaced from recent
 *                 use. Draggable in and out. Capacity depends on the width, so
 *                 the bar is one row on a phone and on a 4K monitor.
 *
 *   fixed right   More, and Leave. Leave last because it is the one button whose
 *                 position should never move under the cursor.
 *
 * An attendee sees no publish controls at all. Their token forbids publishing, so
 * a microphone button would open a device prompt and then fail at the SFU.
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
  } = useRoomUI();

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
  const [shareOpen, setShareOpen] = useState(false);
  /** Preview-only share toggle — no LiveKit publish in `/preview/room`. */
  const [previewSharing, setPreviewSharing] = useState(false);
  /** The Layout popover, anchored to whichever slot holds it. */
  const [layoutOpen, setLayoutOpen] = useState(false);

  const drag = useToolDrag();
  const capacity = useSlotCapacity();
  const slots = barSlots(tools.layout, capacity, availableTools);
  const grid = gridItems(tools.layout, slots, availableTools);

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
    async (key: string, label: string, run: () => Promise<unknown>) => {
      setPending(key);
      try {
        await run();
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        notify(
          /permission|denied|NotAllowed/i.test(message)
            ? `${label} is blocked. Allow it in your browser's site settings and try again.`
            : `Couldn't turn ${label.toLowerCase()} on. ${message}`,
          "error",
        );
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
  const meterRef = useMicMeter<HTMLSpanElement>(micTrack, isMicrophoneEnabled);

  // Someone who may not unmute should hear why once, rather than clicking a dead
  // button and concluding the app is broken.
  const onMicClick = () => {
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
  };

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
    if (id === "hand") {
      void realtime.toggleHand();
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
  // hide the fact that people are talking in it.
  const gridBadge = grid.reduce((sum, id) => sum + (badgeFor(id) ?? 0), 0);

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
      className="relative flex min-h-14 shrink-0 items-center gap-1.5 border-t border-white/10 bg-stage-bar px-2 sm:gap-2 sm:px-3"
      // Clears the iOS home indicator; without it the leave button sits under
      // the system gesture area and is genuinely hard to hit.
      style={{ paddingBottom: "max(0px, env(safe-area-inset-bottom))" }}
    >
      {/* ---- fixed left: publish controls ----
          Gated per source, not on "can publish at all": somebody the host allowed
          to speak gets a microphone and must NOT get a camera and a screen share
          they were never granted. */}
      {/* A silenced speaker belongs on this side of the bar. Their microphone is
          gone, but labelling them "view only" would say they lost their seat on
          the stage, which is the host's other, separate decision. */}
      {permissions.canPublish || permissions.mutedByHost ? (
        <>
          {(permissions.canSpeak || permissions.mutedByHost) && (
            <BarButton
              label={
                isMicrophoneEnabled
                  ? "Mute"
                  : permissions.mutedByHost
                    ? "Muted by host"
                    : micBlocked
                      ? "Unmute disabled by host"
                      : "Unmute"
              }
              active={isMicrophoneEnabled}
              danger={!isMicrophoneEnabled}
              dimmed={micBlocked}
              busy={pending === "mic"}
              onClick={onMicClick}
              meterRef={meterRef}
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
            <BarButton
              label={isCameraEnabled ? "Stop video" : "Start video"}
              active={isCameraEnabled}
              danger={!isCameraEnabled}
              busy={pending === "camera"}
              onClick={() =>
                void toggle("camera", "Camera", () =>
                  localParticipant.setCameraEnabled(!isCameraEnabled),
                )
              }
              icon={
                isCameraEnabled ? (
                  <CameraIcon className="size-5" />
                ) : (
                  <CameraOffIcon className="size-5" />
                )
              }
            />
          )}
          {/* Preview chrome always offers Share (mocked). Live rooms still need
              getDisplayMedia support — mobile browsers typically do not. */}
          {(previewChrome || canShare) && permissions.canShareScreen && (
            <BarButton
              label={sharing ? "Stop sharing" : "Share screen"}
              active={sharing}
              busy={pending === "share" || fileShare.starting}
              onClick={() => {
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
        </>
      ) : null}

      {/* Recording sits with the publish controls because that is what it is: a
          capture of what this stage is sending. It renders nothing for anyone the
          server has not told they may record, and nothing in a browser that
          cannot encode video. */}
      <RecordButton />

      <div className="flex-1" />

      {/* ---- the customisable middle ---- */}
      {/* Outlined while a tool is in flight, so both drop targets are visible for
          the whole gesture rather than only the one the pointer happens to be
          over. The two states are distinct on purpose: dashed means "you may drop
          here", solid means "release now and this is what happens". */}
      {/* Outline rather than ring or border: dashed is available on outlines in
          Tailwind v4 and not on rings, and an outline takes no space so the bar
          does not shift by two pixels the moment a drag starts. */}
      <div
        className={`flex items-center gap-1.5 rounded-xl px-1 transition-colors sm:gap-2 ${
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
            </div>
          </div>
        ))}

        {/* The tail marker, for a drop past the last slot. */}
        {dropIndex !== null && dropIndex >= slots.length && <DropMarker />}
      </div>

      {/* Layout is fixed — never capacity-limited or buried under More. Narrow
          bars used to drop it when only two pin slots fit. */}
      {availableTools.includes("layout") && (
        <div data-tool-slot="layout" className="relative">
          <button
            type="button"
            aria-label={`Layout · ${LAYOUT_LABEL[stage.mode]}`}
            aria-pressed={layoutOpen}
            title={`Change layout — ${LAYOUT_LABEL[stage.mode]}`}
            onClick={() => {
              setLayoutOpen((v) => !v);
              tools.used("layout");
            }}
            className="relative shrink-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          >
            <BarButtonShell label="Layout" active={layoutOpen}>
              {(() => {
                const Icon = tool("layout").icon;
                return <Icon className="size-5" />;
              })()}
            </BarButtonShell>
          </button>
          {layoutOpen && <LayoutMenu onClose={() => setLayoutOpen(false)} />}
        </div>
      )}

      {/* ---- fixed right ---- */}
      <div className="relative">
        <MoreButton
          open={gridVisible}
          count={gridVisible ? 0 : gridBadge}
          onToggle={() => setMoreOpen((v) => !v)}
        />
        {gridVisible && (
          <MoreGrid
            items={grid}
            // While the grid is only open because a drag is in flight, dismissing
            // it is not something the user can ask for — the drag owns it.
            onClose={() => setMoreOpen(false)}
          />
        )}
      </div>

      {/* Leave, disabled until there is something to leave.
          Pressing it mid-connect used to tear down a connection that was still being built,
          which either did nothing visible or produced a half-torn session. Disabled only
          while the FIRST connection is being established: during a reconnect it stays live,
          because somebody whose network has gone is exactly who needs a way out and trapping
          them behind a spinner is worse than a slightly untidy disconnect. */}
      <button
        type="button"
        onClick={leave}
        disabled={connecting}
        aria-label="Leave the webinar"
        title={connecting ? "Connecting…" : undefined}
        className="ml-1 inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-live px-3 text-[13px] font-semibold text-white transition-colors hover:bg-live/90 outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-live sm:px-4"
      >
        <LeaveIcon className="size-4 sm:hidden" />
        <span className="hidden sm:inline">Leave</span>
      </button>

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
      ? "bg-live/15 text-live-soft"
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
  meterRef?: React.RefObject<HTMLSpanElement | null>;
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
      {/* The live level, as a strip across the bottom of the button.
          A strip rather than a fill behind the glyph: the shell above it draws a translucent
          background when the button is active, so a fill would be washed out to a tint and I
          could not verify the contrast from here. A strip sits above everything and is
          unmistakably a meter.
          `scaleX` from a left origin rather than a width, because a transform is composited —
          this moves sixty times a second without laying out or repainting the bar around it. */}
      {meterRef && (
        <span
          ref={meterRef}
          aria-hidden
          className="pointer-events-none absolute inset-x-1.5 bottom-0.5 z-10 h-[3px] origin-left rounded-full bg-ok"
          style={{ transform: "scaleX(var(--mic-level, 0))" }}
        />
      )}
      <BarButtonShell label={label} active={active} danger={danger} dimmed={dimmed}>
        {busy ? <Spinner className="size-5" /> : icon}
      </BarButtonShell>
      {badge !== undefined && badge > 0 && (
        <span className="absolute top-0.5 right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}

/** Exported for the pre-join screen, which needs the same mic/camera affordance
 *  before there is a room to toggle. */
export { BarButton };

/** Re-exported so the pre-join preview can label its own tracks consistently. */
export const CAMERA_SOURCE = Track.Source.Camera;
