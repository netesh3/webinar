"use client";

import { VideoTrack } from "@livekit/components-react";
import { Track, type LocalParticipant, type Participant, type TrackPublication } from "livekit-client";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { documentPipSupported } from "@/lib/pip";
import {
  formatElapsed,
  requestPresenter,
  screenLivePreviewConfirmed,
  setScreenLivePreview,
  useElapsed,
  useOwnShare,
  useScreenLivePreview,
  useSnapshot,
  wantsPresenterView,
  type OwnShare,
} from "@/lib/own-share";
import { EyeIcon, EyeOffIcon, PopOutIcon, ScreenShareIcon } from "../icons";
import { ShareOnlySwitch } from "./share-only";

/* What a presenter sees of their own window or screen share.
 *
 * Two places: the stage of the webinar tab (OwnShareView, in place of the plain "You're
 * sharing your screen" card) and the floating window that stays on top while they present
 * (PresenterPip). Both follow one rule about live pictures:
 *
 *   A WINDOW is shown live. It is somebody else's window, so showing it here loops nothing,
 *   and it is the only way to be sure the audience sees the slide you think they see.
 *
 *   The ENTIRE SCREEN is shown as a snapshot by default, in both places. This tab and the
 *   floating window are usually ON the screen being shared; a live picture of it shows
 *   itself inside itself, forever, and the audience receives that too. A single snapshot
 *   from when it started says which screen it is without the loop. A presenter with two
 *   screens — webinar on one, sharing the other — can turn on Live preview (asked once,
 *   remembered); then both places go live, since neither is on the shared screen.
 *
 *   Both places always show the same kind of picture, and say which it is: "Live view"
 *   with a green dot, or "Snapshot · not updating" with a pause mark. The LIVE badge in the
 *   bars means "you are sharing" and never describes the preview.
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
  const screenLive = useScreenLivePreview();
  // The "is this window on another screen?" question, shown once before going live.
  const [asking, setAsking] = useState(false);
  const toggleScreenLive = () => {
    if (screenLive) setScreenLivePreview(false);
    else if (screenLivePreviewConfirmed()) setScreenLivePreview(true);
    else setAsking(true);
  };
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

  const showLive = !!publication?.track && (isWindow ? !hidden : screenLive);

  /* Header, picture, buttons — stacked, not layered. The picture gets every pixel between
   * the two rows and nothing is drawn over it: a header or button row on top of a shared
   * window covers its title bar and dock, which is exactly what a presenter checks. Only
   * the frozen warning overlays, because it must be seen. */
  return (
    <div className="relative flex size-full flex-col bg-black">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <LiveBadge small />
        <span className="truncate text-[12.5px] font-medium text-white/90">
          {isWindow ? (
            "This is what everyone sees · a window"
          ) : showLive ? (
            <>
              <span className="font-semibold text-white">This is what everyone sees</span>
              <span className="text-white/65"> · your entire screen</span>
            </>
          ) : (
            <>
              <span className="font-semibold text-white">Everyone can see your entire screen</span>
              <span className="text-white/65">, including this page</span>
            </>
          )}
        </span>
        <Elapsed share={share} />
      </div>

      <div className="relative min-h-0 flex-1 px-3">
        {showLive ? (
          <div className="relative size-full">
            <VideoTrack
              trackRef={{ participant, source: Track.Source.ScreenShare, publication: publication! }}
              className="size-full object-contain"
            />
            <PreviewTag kind="live" />
          </div>
        ) : !isWindow && snapshot ? (
          /* The entire screen, as large as the stage allows. Still a snapshot, never live:
           * this tab is on the screen being shared, so a live picture would mirror itself
           * for everyone. Labelled so it is not mistaken for the live picture; not dimmed,
           * because a dimmed screenshot reads as a blurry one. */
          <div className="relative size-full">
            {/* eslint-disable-next-line @next/next/no-img-element -- a data URL, nothing for next/image to optimise */}
            <img
              src={snapshot}
              alt="Your screen when sharing started"
              className="absolute inset-0 size-full object-contain"
            />
            <PreviewTag kind="snapshot" />
            <span className="pointer-events-none absolute bottom-3 left-1/2 max-w-[92%] -translate-x-1/2 truncate rounded-full bg-black/75 px-3 py-1 text-[12px] text-white/90">
              Taken when you started · not live, so this page doesn&apos;t mirror itself
            </span>
          </div>
        ) : (
          <div className="grid size-full place-items-center p-6 text-center">
            <div className="max-w-xl">
              {isWindow ? (
                <>
                  <p className="text-[18px] font-semibold text-white/90">Preview hidden</p>
                  <p className="mt-1.5 text-[13px] text-white/60">
                    Everyone still sees your window. Turn the preview back on to check what they see.
                  </p>
                </>
              ) : (
                <p className="text-[13px] text-white/65">Go to what you want to present.</p>
              )}
            </div>
          </div>
        )}

        {share.frozen && <FrozenWarning isWindow={isWindow} />}
      </div>

      <div className="flex shrink-0 flex-wrap justify-center gap-2 px-3 py-2.5">
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
        {!isWindow && (
          <button
            type="button"
            role="switch"
            aria-checked={screenLive}
            onClick={toggleScreenLive}
            title="Only when this window is on a different screen from the one you share"
            className={`inline-flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/50 ${
              screenLive
                ? "bg-ok/20 text-white ring-1 ring-ok/50 hover:bg-ok/25"
                : "bg-white/12 text-white/90 hover:bg-white/20"
            }`}
          >
            <span
              aria-hidden
              className={`relative h-[14px] w-[26px] shrink-0 rounded-full transition-colors ${
                screenLive ? "bg-ok" : "bg-white/30"
              }`}
            >
              <span
                className={`absolute top-[2px] size-[10px] rounded-full bg-white transition-[left] ${
                  screenLive ? "left-[14px]" : "left-[2px]"
                }`}
              />
            </span>
            Live preview
          </button>
        )}
        {canFloat && (
          <StageButton onClick={() => requestPresenter("float")} icon={<PopOutIcon className="size-4" />}>
            Floating controls
          </StageButton>
        )}
        {/* No Stop button here: the Share button in the control bar stops the share.
            requestPresenter("stop") and the bar's handler for it are still in place. */}
      </div>
      {/* Host and co-hosts: what the audience sees around this share. */}
      <div className="flex shrink-0 justify-center px-3 pb-2.5">
        <ShareOnlySwitch small />
      </div>

      {asking && (
        <LivePreviewQuestion
          onYes={() => {
            setScreenLivePreview(true, true);
            setAsking(false);
          }}
          onNo={() => setAsking(false)}
        />
      )}
    </div>
  );
}

/* Asked the first time Live preview is turned on for the entire screen, and not again
 * once answered yes. A picture of two screens because "a different screen from the one
 * you're sharing" is a sentence people misread; the picture is not. */
function LivePreviewQuestion({ onYes, onNo }: { onYes: () => void; onNo: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="live-preview-q"
      className="absolute bottom-28 left-1/2 z-10 w-[min(380px,92%)] -translate-x-1/2 rounded-xl border border-white/15 bg-[#1b1b1e] p-4 text-white shadow-2xl"
    >
      <p id="live-preview-q" className="text-[14px] font-semibold">
        Is this window on another screen?
      </p>
      <p className="mt-1.5 text-[12.5px] leading-snug text-white/70">
        A live preview only works when this webinar window is on a different screen from the
        one you&apos;re sharing. On the same screen it shows itself inside itself, and everyone
        sees that.
      </p>
      <div aria-hidden className="mt-3 flex items-center justify-center gap-3">
        <ScreenPicture label="Shared" sub="what you present" shared />
        <ScreenPicture label="This window" sub="live preview" />
      </div>
      <div className="mt-3.5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onNo}
          className="h-8 rounded-lg bg-white/10 px-3 text-[12.5px] font-medium text-white/90 outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/50"
        >
          Keep snapshot
        </button>
        <button
          type="button"
          onClick={onYes}
          className="h-8 rounded-lg bg-brand px-3 text-[12.5px] font-medium text-white outline-none hover:bg-brand-hover focus-visible:ring-2 focus-visible:ring-white/50"
        >
          It&apos;s on another screen
        </button>
      </div>
    </div>
  );
}

function ScreenPicture({ label, sub, shared }: { label: string; sub: string; shared?: boolean }) {
  return (
    <div
      className={`grid h-[52px] w-[88px] place-items-center rounded-md border-2 text-center ${
        shared ? "border-ok" : "border-white/35"
      }`}
    >
      <div>
        <p className="text-[11px] font-medium text-white/90">{label}</p>
        <p className="text-[10px] text-white/50">{sub}</p>
      </div>
    </div>
  );
}

/* Which kind of picture this is, in the corner of the picture itself. The same two labels
 * in the stage and the floating window, so the difference is learned once. */
function PreviewTag({ kind, compact }: { kind: "live" | "snapshot"; compact?: boolean }) {
  return (
    <span
      className={`pointer-events-none absolute inline-flex items-center gap-1.5 rounded-md bg-black/75 font-semibold ${
        compact ? "left-1.5 top-1.5 px-1.5 py-0.5 text-[10.5px]" : "left-2.5 top-2.5 px-2 py-1 text-[11.5px]"
      } ${kind === "live" ? "text-[#bbf7d0]" : "text-white/85"}`}
    >
      {kind === "live" ? (
        <span aria-hidden className="size-1.5 rounded-full bg-ok" />
      ) : (
        <svg aria-hidden viewBox="0 0 10 10" className="size-2.5 fill-current">
          <rect x="1.5" y="1" width="2.4" height="8" rx="0.6" />
          <rect x="6.1" y="1" width="2.4" height="8" rx="0.6" />
        </svg>
      )}
      {kind === "live" ? "Live view" : "Snapshot · not updating"}
    </span>
  );
}

/** The floating window's content while presenting a window or the entire screen. */
export function PresenterPip({
  share,
  participant,
  publication,
  onBack,
}: {
  share: OwnShare;
  participant: Participant;
  publication: TrackPublication | undefined;
  /** Kept for the caller; the window shows no Stop button (see the stage's note). */
  onStop: () => void;
  onBack: () => void;
}) {
  const isWindow = share.surface === "window";
  const snapshot = useSnapshot(share.track, share.surface === "monitor");
  const screenLive = useScreenLivePreview();
  /* Same picture as the stage: a window live; the entire screen as the snapshot, or live
   * when the presenter turned Live preview on (this window is then on another screen). */
  const showLive = !!publication?.track && (isWindow || screenLive);
  return (
    <div className="flex h-dvh w-full flex-col bg-black text-white">
      {showLive ? (
        <div className="relative min-h-0 flex-1">
          <VideoTrack
            trackRef={{ participant, source: Track.Source.ScreenShare, publication: publication! }}
            className="h-full w-full object-contain"
          />
          <PreviewTag kind="live" compact />
          {share.frozen && <FrozenWarning isWindow={isWindow} compact />}
        </div>
      ) : !isWindow && snapshot ? (
        /* The entire screen as a still picture. This window floats ON the screen being
           shared, so the audience sees it: a still thumbnail, never a mirror. */
        <div className="relative min-h-0 flex-1">
          {/* eslint-disable-next-line @next/next/no-img-element -- a data URL, nothing for next/image to optimise */}
          <img
            src={snapshot}
            alt="Your screen when sharing started"
            className="absolute inset-0 size-full object-contain"
          />
          <PreviewTag kind="snapshot" compact />
          <p className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/70 to-transparent px-2.5 pb-1.5 pt-5 text-[11.5px] leading-snug text-white/90">
            Everyone sees your whole screen, including this little window.
          </p>
          {share.frozen && <FrozenWarning isWindow={false} compact />}
        </div>
      ) : (
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
        compact ? "top-1.5 px-2 py-1 text-[11px]" : "top-3 px-3 py-2 text-[13px]"
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
