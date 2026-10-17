"use client";

import { VideoTrack } from "@livekit/components-react";
import { Track, type LocalParticipant, type Participant, type TrackPublication } from "livekit-client";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { documentPipSupported } from "@/lib/pip";
import {
  formatElapsed,
  requestPresenter,
  useElapsed,
  useOwnShare,
  useSnapshot,
  wantsPresenterView,
  type OwnShare,
} from "@/lib/own-share";
import { EyeIcon, EyeOffIcon, PopOutIcon, ScreenShareIcon, StopIcon } from "../icons";

/* What a presenter sees of their own window or screen share.
 *
 * Two places: the stage of the webinar tab (OwnShareView, in place of the plain "You're
 * sharing your screen" card) and the floating window that stays on top while they present
 * (PresenterPip). Both follow one rule about live pictures:
 *
 *   A WINDOW is shown live. It is somebody else's window, so showing it here loops nothing,
 *   and it is the only way to be sure the audience sees the slide you think they see.
 *
 *   The ENTIRE SCREEN is never shown live, in either place. This tab and the floating window
 *   are both ON the screen being shared; a live picture of it shows itself inside itself,
 *   forever, and the audience receives that too. A single snapshot from when it started
 *   says which screen it is without the loop.
 *
 *   A TAB is left as it was: Chrome already takes you to it and draws its own controls.
 */

const HIDE_KEY = "webinar.sharePreviewHidden";
const subscribeNothing = () => () => {};
const notOnServer = () => false;

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
}

/** The stage's own-share tile. `fallback` is the existing notice, for a tab or a share the
 *  browser will not describe. */
export function OwnShareView({
  participant,
  publication,
  size,
  fallback,
}: {
  participant: Participant;
  publication: TrackPublication | undefined;
  size: "sm" | "md" | "lg";
  fallback: ReactNode;
}) {
  const share = useOwnShare(participant.isLocal ? (participant as LocalParticipant) : undefined);
  /* Off when the shared window is THIS browser window: the preview would show itself. We
   * cannot tell which window was picked, so the presenter can switch it off, and it stays
   * off for next time. */
  const [hidden, setHidden] = useState(readHidden);
  const toggleHidden = () => {
    const next = !hidden;
    setHidden(next);
    try {
      window.localStorage.setItem(HIDE_KEY, next ? "1" : "0");
    } catch {
      // Private mode: the choice lasts for this share only.
    }
  };
  const snapshot = useSnapshot(share.track, share.surface === "monitor");
  // Safari and Firefox have no floating window to offer; no button that does nothing.
  const canFloat = useSyncExternalStore(subscribeNothing, documentPipSupported, notOnServer);

  if (!wantsPresenterView(share.surface)) return <>{fallback}</>;

  const isWindow = share.surface === "window";
  const what = isWindow ? "a window" : "your entire screen";

  // A thumbnail in the filmstrip: no room for anything but the line.
  if (size === "sm") {
    return (
      <div className="grid size-full place-items-center bg-black/40 p-2 text-center">
        <div>
          <LiveBadge small />
          <p className="mt-1 text-[12px] font-semibold text-white/90">Sharing {what}</p>
        </div>
      </div>
    );
  }

  const showLive = isWindow && !hidden && !!publication?.track;

  return (
    <div className="relative size-full bg-black">
      {showLive ? (
        <VideoTrack
          trackRef={{ participant, source: Track.Source.ScreenShare, publication: publication! }}
          className="absolute inset-0 size-full object-contain"
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center p-6 text-center">
          <div className="max-w-xl">
            {isWindow ? (
              <>
                <p className="text-[18px] font-semibold text-white/90">Preview hidden</p>
                <p className="mt-1.5 text-[13px] text-white/60">
                  Everyone still sees your window. Turn the preview back on to check what they see.
                </p>
              </>
            ) : (
              <>
                <p className="text-[20px] font-semibold text-white/95">
                  Everyone can see your entire screen
                </p>
                <p className="mt-1.5 text-[13px] text-white/65">
                  Including this page. Go to what you want to present.
                </p>
                {snapshot && (
                  <figure className="mx-auto mt-4 w-[min(360px,80%)]">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a data URL, nothing for next/image to optimise */}
                    <img
                      src={snapshot}
                      alt="Your screen when sharing started"
                      className="w-full rounded-md border border-white/15"
                    />
                    <figcaption className="mt-1.5 text-[11px] text-white/45">
                      When you started. No live preview here, or everyone would see an endless
                      mirror of this page.
                    </figcaption>
                  </figure>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* What this is, over the picture rather than beside it: the stage is the space. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 bg-black/55 px-3 py-2">
        <LiveBadge small />
        <span className="truncate text-[12.5px] font-medium text-white/90">
          {isWindow ? "This is what everyone sees · a window" : "Sharing your entire screen"}
        </span>
        <Elapsed share={share} />
      </div>

      {share.frozen && <FrozenWarning isWindow={isWindow} />}

      <div className="absolute inset-x-0 bottom-9 flex flex-wrap justify-center gap-2 px-3">
        <StageButton onClick={() => requestPresenter("switch")} icon={<ScreenShareIcon className="size-4" />}>
          {isWindow ? "Share something else" : "Share a window instead"}
        </StageButton>
        {isWindow && (
          <StageButton
            onClick={toggleHidden}
            icon={hidden ? <EyeIcon className="size-4" /> : <EyeOffIcon className="size-4" />}
          >
            {hidden ? "Show preview" : "Hide preview"}
          </StageButton>
        )}
        {canFloat && (
          <StageButton onClick={() => requestPresenter("float")} icon={<PopOutIcon className="size-4" />}>
            Floating controls
          </StageButton>
        )}
        <StageButton danger onClick={() => requestPresenter("stop")} icon={<StopIcon className="size-4" />}>
          Stop sharing
        </StageButton>
      </div>
    </div>
  );
}

/** The floating window's content while presenting a window or the entire screen. */
export function PresenterPip({
  share,
  participant,
  publication,
  onStop,
  onBack,
}: {
  share: OwnShare;
  participant: Participant;
  publication: TrackPublication | undefined;
  onStop: () => void;
  onBack: () => void;
}) {
  const isWindow = share.surface === "window";
  return (
    <div className="flex h-dvh w-full flex-col bg-black text-white">
      {isWindow && publication?.track ? (
        <div className="relative min-h-0 flex-1">
          <VideoTrack
            trackRef={{ participant, source: Track.Source.ScreenShare, publication }}
            className="h-full w-full object-contain"
          />
          {share.frozen && <FrozenWarning isWindow compact />}
        </div>
      ) : (
        /* The entire screen: no picture here at all. This window floats ON the screen being
           shared, so the audience sees it — a live picture in it would be the mirror. */
        <div className="flex min-h-0 flex-1 items-center px-3">
          <p className="text-[12.5px] leading-snug text-white/75">
            {share.frozen
              ? "Your screen stopped sending pictures. Everyone sees the last one."
              : "Everyone can see your entire screen, including this little window."}
          </p>
        </div>
      )}
      <div className="flex shrink-0 items-center gap-2 border-t border-white/10 px-2.5 py-1.5">
        <LiveBadge small />
        <span className="truncate text-[12px] text-white/85">
          {isWindow ? "Sharing a window" : "Sharing entire screen"}
        </span>
        <Elapsed share={share} />
        <div className="flex-1" />
        <button
          type="button"
          onClick={onBack}
          className="h-7 rounded-md px-2 text-[12px] font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          Back to webinar
        </button>
        <button
          type="button"
          onClick={onStop}
          className="h-7 rounded-md bg-live px-2.5 text-[12px] font-semibold text-on-live transition-colors hover:bg-live/90 outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          Stop
        </button>
      </div>
    </div>
  );
}

function LiveBadge({ small }: { small?: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full bg-ok/15 font-semibold tracking-[0.06em] text-ok ${
        small ? "gap-1.5 px-2 py-0.5 text-[10.5px]" : "gap-2 px-2.5 py-1 text-[12px]"
      }`}
    >
      <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-ok" />
      LIVE
    </span>
  );
}

function Elapsed({ share }: { share: OwnShare }) {
  const ms = useElapsed(share.startedAt);
  if (share.startedAt === null) return null;
  return <span className="shrink-0 text-[12px] tabular-nums text-white/55">{formatElapsed(ms)}</span>;
}

/* The browser stopped getting pictures from what is shared — most often a minimized window.
 * The audience is left on the last frame, and the presenter, looking at another app, would
 * otherwise never know. */
function FrozenWarning({ isWindow, compact }: { isWindow: boolean; compact?: boolean }) {
  return (
    <div
      role="status"
      className={`absolute inset-x-0 mx-auto w-fit max-w-[92%] rounded-lg bg-live-soft text-center font-medium text-live ${
        compact ? "top-1.5 px-2 py-1 text-[11px]" : "top-12 px-3 py-2 text-[13px]"
      }`}
    >
      {isWindow
        ? "Your shared window is minimized or hidden. Everyone sees a frozen picture until you bring it back."
        : "Your screen stopped sending pictures. Everyone sees the last one."}
    </div>
  );
}

function StageButton({
  onClick,
  icon,
  danger,
  children,
}: {
  onClick: () => void;
  icon: ReactNode;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/50 ${
        danger
          ? "bg-live text-on-live hover:bg-live/90"
          : "bg-white/12 text-white/90 hover:bg-white/20"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
