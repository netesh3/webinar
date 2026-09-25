"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { shouldRememberPipDismiss } from "./pip-dismiss";

export { shouldRememberPipDismiss } from "./pip-dismiss";

/* Popping the webinar out into a window that floats over everything else.
 *
 * Document Picture-in-Picture, not the video element kind. The element kind can only show one
 * <video> and nothing else — no captions, no name, no microphone button — and this room's
 * stage is a composed thing. Document PiP hands back a real window with a real document, so
 * what goes in it is ordinary DOM that React can render.
 *
 * WHAT CANNOT BE DONE, measured rather than assumed. Chrome refuses requestWindow() without a
 * user gesture:
 *
 *   NotAllowedError: Document PiP requires user activation
 *
 * So "pop out automatically when the tab goes to the background" is not available to a normal
 * page, and that is deliberate on the browser's part: any site could otherwise throw a window
 * over whatever you were doing. The one route to it is the MediaSession action below, which
 * Chrome fires only for an INSTALLED app — registering it costs two lines and does nothing at
 * all until somebody installs webinarliv, which is exactly the right shape for a capability
 * the browser gates on trust.
 *
 * Coming back needs no gesture, so that half is unconditional: returning to the tab closes the
 * window for everybody, installed or not.
 *
 * CLOSING WHILE A SHARE IS LIVE, and why it has to stick.
 *
 * Screen share is exactly when people leave the tab — they are looking at the deck they are
 * presenting, or at another window while someone else shares. Chrome then fires
 * enterpictureinpicture again on the next switch-away (and sometimes again while the share
 * keeps the media session alive). Without a memory of the X click, the window they just closed
 * reappears for the rest of the share. So a dismiss during an active share is remembered until
 * the share ends or they press Pop out again. Returning to the tab is NOT a dismiss: that close
 * is the automatic half of the feature, and the next time they leave they may still want it.
 */

/* Declared here because TypeScript's DOM library does not carry it yet.
 *
 * Narrow on purpose — requestWindow and the window it resolves to are all this file uses, and
 * a fuller guess at the shape would be a fiction that compiles. Optional on Window so the
 * support check is a real check rather than a cast. */
declare global {
  interface DocumentPictureInPicture {
    requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
    readonly window: Window | null;
  }
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture;
  }
}

/** Chromium 116+. Firefox and Safari have no Document PiP at all. */
export function documentPipSupported(): boolean {
  return typeof window !== "undefined" && "documentPictureInPicture" in window;
}

/** The older, video-only kind — Safari has this, and it is the fallback. */
export function elementPipSupported(): boolean {
  return (
    typeof document !== "undefined" &&
    "pictureInPictureEnabled" in document &&
    document.pictureInPictureEnabled
  );
}

/* The window's size, and why it is not square.
 *
 * 16:9 because that is what a camera and a shared screen both are, and a window whose aspect
 * does not match letterboxes whichever is inside it. Chrome clamps to its own minimum and
 * remembers whatever the user resizes it to afterwards, so this is a first guess rather than a
 * constraint — small enough to sit beside a document without covering it.
 */
const PIP_WIDTH = 400;
const PIP_HEIGHT = 225;

/* Stylesheets do not cross into a new document, so they are copied in.
 *
 * Two branches because a stylesheet reachable from script and one that is not need different
 * treatment: same-origin rules can be read and inlined, and a cross-origin sheet throws on
 * .cssRules and has to be re-linked by href instead. Next.js serves the first in development
 * and the second in a build, so both paths are live rather than defensive.
 */
function copyStyles(into: Window): void {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
      const style = into.document.createElement("style");
      style.textContent = css;
      into.document.head.appendChild(style);
    } catch {
      if (!sheet.href) continue;
      const link = into.document.createElement("link");
      link.rel = "stylesheet";
      link.media = String(sheet.media ?? "");
      link.href = sheet.href;
      into.document.head.appendChild(link);
    }
  }
}

export type PipCloseOptions = {
  /** Remember this close for the rest of the current screen-share session so MediaSession does
   *  not reopen the window. Returning to the tab must NOT pass this — that close is the
   *  automatic half of the feature, not a preference. */
  dismiss?: boolean;
};

export type PipApi = {
  /** Whether either kind of PiP is available, so the button can be hidden rather than fail. */
  supported: boolean;
  /** True for the real Document PiP; false means the fallback gives video only, no controls. */
  composed: boolean;
  /** Where to portal the popped-out UI. Null whenever the window is closed. */
  container: HTMLElement | null;
  active: boolean;
  open: () => void;
  close: (opts?: PipCloseOptions) => void;
};

/* Capability read through useSyncExternalStore, with a server snapshot of false.
 *
 * Not a plain call, and the difference is a hydration error. `"documentPictureInPicture" in
 * window` is false on the server and true in Chrome, so a button rendered straight off it is
 * absent in the server HTML and present a moment later — which React reports as "the server
 * rendered HTML didn't match the client" and then throws the tree away and rebuilds it.
 *
 * Same shape as canPickOutput in control-bar.tsx, and for the same reason: the first client
 * render agrees with the server, and the truth arrives on the render after it. subscribeNothing
 * because a browser does not grow the API while the page is open.
 */
const subscribeNothing = () => () => {};
const notOnServer = () => false;

export function usePictureInPicture({
  /** For browsers with no Document PiP: the one video to hand to the browser's own PiP. */
  fallbackVideo,
  /** Off while there is nothing to pop out — before a connection, or after the room ends. */
  enabled = true,
  /** True while any screen share is live in the room. A dismiss sticks only for this session
   *  and clears when it ends, so the next share can auto-open again. */
  shareActive = false,
}: {
  fallbackVideo?: () => HTMLVideoElement | null;
  enabled?: boolean;
  shareActive?: boolean;
} = {}): PipApi {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const composed = useSyncExternalStore(subscribeNothing, documentPipSupported, notOnServer);
  const element = useSyncExternalStore(subscribeNothing, elementPipSupported, notOnServer);
  const supported = composed || element;

  /* The window itself, in a ref rather than state.
   *
   * State would re-render every consumer when it changes, and the only thing anybody needs to
   * re-render for is the container appearing or going away. */
  const win = useRef<Window | null>(null);

  /* Closed on purpose during this share — MediaSession must not reopen until the share ends
   * or open() is called from the Pop out button. A ref, not state: nothing renders from it. */
  const dismissed = useRef(false);
  const shareActiveRef = useRef(shareActive);

  // Keep the ref in sync for pagehide/close (which are not render), and clear a dismiss when
  // the share ends so the next one may auto-open again.
  useEffect(() => {
    shareActiveRef.current = shareActive;
    if (!shareActive) dismissed.current = false;
  }, [shareActive]);

  const close = useCallback((opts?: PipCloseOptions) => {
    if (
      shouldRememberPipDismiss({
        shareActive: shareActiveRef.current,
        tabVisible: document.visibilityState === "visible",
        explicitDismiss: opts?.dismiss === true,
      })
    ) {
      dismissed.current = true;
    }
    if (win.current) {
      // The pagehide listener below is what clears the container, so closing here and closing
      // from the window's own X button take the same path out.
      win.current.close();
      win.current = null;
    }
    if (document.pictureInPictureElement) {
      void document.exitPictureInPicture().catch(() => {});
    }
  }, []);

  const open = useCallback(() => {
    if (!enabled) return;

    // Explicit reopen always wins — the Pop out button is how you take the window back after
    // dismissing it for this share.
    dismissed.current = false;

    if (!documentPipSupported()) {
      /* Safari and Firefox: the browser's own video PiP, on the one element that matters.
       *
       * Video only — no name, no captions, no microphone — because that is all the older API
       * can carry. Worth doing anyway: somebody watching a presentation while they work is
       * served by the picture alone, and the alternative is a button they do not get. */
      const video = fallbackVideo?.();
      if (video) void video.requestPictureInPicture().catch(() => {});
      return;
    }

    // Already open: bring it forward rather than opening a second one, which the API refuses
    // anyway — there is at most one PiP window per tab.
    if (win.current) {
      win.current.focus();
      return;
    }

    void window.documentPictureInPicture!
      .requestWindow({ width: PIP_WIDTH, height: PIP_HEIGHT })
      .then((pip: Window) => {
        win.current = pip;
        copyStyles(pip);
        /* The room's dark tokens, and a black backdrop behind whatever is letterboxed.
         *
         * room-dark is a class rather than a media query, so the popped-out document has to
         * opt in explicitly or every token resolves to the light palette. */
        pip.document.documentElement.classList.add("room-dark");
        pip.document.body.classList.add("room-dark");
        pip.document.body.style.margin = "0";
        pip.document.body.style.background = "#000";
        pip.document.body.style.overflow = "hidden";

        // pagehide, not unload: it is the event Chrome fires for a PiP window closing, whether
        // that was the X button, the tab navigating, or close() above.
        pip.addEventListener("pagehide", () => {
          /* X while the tab is still in the background: they closed it on purpose while
           * working elsewhere. close() is not on this path — the browser tears the window
           * down — so the remember decision has to be made here. */
          if (
            shouldRememberPipDismiss({
              shareActive: shareActiveRef.current,
              tabVisible: document.visibilityState === "visible",
            })
          ) {
            dismissed.current = true;
          }
          win.current = null;
          setContainer(null);
        });
        setContainer(pip.document.body);
      })
      .catch(() => {
        // A refusal is not worth a toast. The common one is a lost user gesture, and the
        // button is still sitting there to be pressed again.
        win.current = null;
        setContainer(null);
      });
  }, [enabled, fallbackVideo]);

  /* Back in the tab, so the floating window has nothing left to do.
   *
   * No gesture is needed to CLOSE one, which is what makes this half of "automatic" possible
   * for everybody rather than only for an installed app. Keyed on visibility rather than on
   * focus: clicking the PiP window itself takes focus away from the tab without the tab
   * becoming hidden, and closing the window somebody just reached for would be absurd.
   *
   * Deliberately close() without dismiss: coming back is not "I never want this during the
   * share", it is the designed return path.
   */
  useEffect(() => {
    if (!container) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") close();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [container, close]);

  /* The one route to popping out WITHOUT a click, and it is the browser's to offer.
   *
   * Chrome fires this MediaSession action when the user switches away from an installed app
   * that has asked for it — the handler runs with activation, so requestWindow() is allowed
   * inside it. Measured on a non-installed page: registering succeeds and the action never
   * fires, which is the graceful half of the deal. Nothing here needs a fallback because
   * nothing here happens at all until somebody installs the app.
   *
   * Honour dismissed: without that check the action re-opens the window for the rest of a
   * screen share every time the user leaves the tab again after closing with X.
   */
  useEffect(() => {
    if (!enabled || !composed || typeof navigator === "undefined") return;
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler(
        "enterpictureinpicture" as MediaSessionAction,
        () => {
          if (dismissed.current) return;
          open();
        },
      );
    } catch {
      // An older Chrome that does not know the action. Nothing to do and nothing to say.
      return;
    }
    return () => {
      try {
        navigator.mediaSession.setActionHandler(
          "enterpictureinpicture" as MediaSessionAction,
          null,
        );
      } catch {
        // Same browser, same silence.
      }
    };
  }, [enabled, composed, open]);

  // Leaving the room with a window still floating would leave a webinar on somebody's screen
  // that they are no longer in.
  useEffect(() => () => close(), [close]);

  return { supported, composed, container, active: container !== null, open, close };
}
