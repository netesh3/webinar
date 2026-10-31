/* The Fullscreen API on an element, standard or webkit-prefixed — the half of
 * lib/fullscreen.ts with no React in it (31 Oct 2026).
 *
 * The room's own fullscreen buttons (the Views menu's, for the stage; a shared screen's,
 * for its tile) called `el.requestFullscreen()` straight. On an iPhone that method does
 * not exist on anything but a <video>, so the call threw "requestFullscreen is not a
 * function" — synchronously, past the `.catch` meant for it — and Faro had it from a
 * viewer in Chrome on iOS (WebKit underneath). iPadOS and older Safari have only the
 * webkit-prefixed method. Everything goes through here instead, and a browser with
 * neither gets `false` rather than an exception.
 *
 * The document is a parameter, defaulting to the real one, so lib/fullscreen-api.test.mts
 * can hand it a fake. No imports, for the same reason. */

type WebkitElement = Element & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

export type FullscreenDocument = {
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
  exitFullscreen?: () => Promise<void> | void;
  webkitExitFullscreen?: () => Promise<void> | void;
  documentElement?: Element;
};

function realDocument(): FullscreenDocument | null {
  return typeof document === "undefined" ? null : (document as unknown as FullscreenDocument);
}

/** The element the browser has fullscreen, through either API. Null on the server. */
export function fullscreenElement(doc: FullscreenDocument | null = realDocument()): Element | null {
  if (!doc) return null;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** Whether this browser can make an element (our container, with our chrome) fullscreen.
 *  False on an iPhone, whose only fullscreen is the native video player, and on the server. */
export function canElementFullscreen(doc: FullscreenDocument | null = realDocument()): boolean {
  if (!doc) return false;
  const el = doc.documentElement as WebkitElement | undefined;
  const api =
    typeof el?.requestFullscreen === "function" ||
    typeof el?.webkitRequestFullscreen === "function";
  return api && Boolean(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
}

/** Asks for `el` fullscreen: the standard API, then the webkit-prefixed one. True when one
 *  of them took it; false when neither exists or both refused. Never throws. */
export async function requestElementFullscreen(el: Element | null): Promise<boolean> {
  if (!el) return false;
  if (typeof el.requestFullscreen === "function") {
    try {
      await el.requestFullscreen();
      return true;
    } catch {
      // A permissions policy, or not in a gesture. The prefixed call is sometimes allowed still.
    }
  }
  const webkit = el as WebkitElement;
  if (typeof webkit.webkitRequestFullscreen === "function") {
    try {
      await webkit.webkitRequestFullscreen();
      return true;
    } catch {
      // Neither would: the caller says so, or falls back.
    }
  }
  return false;
}

/** Leaves whatever element the document has fullscreen, through whichever API put it
 *  there. Never throws: the browser will have its own reason, and Escape still works. */
export async function exitElementFullscreen(
  doc: FullscreenDocument | null = realDocument(),
): Promise<void> {
  if (!doc) return;
  try {
    if (doc.fullscreenElement && typeof doc.exitFullscreen === "function") await doc.exitFullscreen();
    else if (doc.webkitFullscreenElement && typeof doc.webkitExitFullscreen === "function")
      await doc.webkitExitFullscreen();
  } catch {
    // Nothing to report.
  }
}

/** Fullscreen on if `el` is not the fullscreen element, off if anything is. The result
 *  says whether the browser did what was asked. */
export async function toggleElementFullscreen(
  el: Element | null,
  doc: FullscreenDocument | null = realDocument(),
): Promise<boolean> {
  if (fullscreenElement(doc)) {
    await exitElementFullscreen(doc);
    return true;
  }
  return requestElementFullscreen(el);
}
