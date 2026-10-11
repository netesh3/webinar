"use client";

/* Real browser windows for room panels — the "drag Chat to my other monitor"
 * feature.
 *
 * An in-page floating window can never leave the tab. A separate OS window
 * can, so this opens a same-origin `about:blank` popup and the room renders
 * the panel INTO it with a React portal. Nothing is duplicated: the popup has
 * no script of its own, no second LiveKit connection and no second realtime
 * socket. It is just another place the one React tree draws to, so a message
 * typed there is sent by exactly the same code as one typed in the dock.
 *
 * Constraints that shape the API:
 *
 *   gesture   `window.open` must run inside a user gesture (a click, or the
 *             pointerup that ends a drag) or the popup blocker eats it. So the
 *             window is opened here, synchronously, by the caller's handler —
 *             never later from an effect.
 *   styles    the popup starts with no CSS. Every stylesheet in the room's
 *             <head> is copied across, and later additions (dev HMR, lazily
 *             loaded chunks) are mirrored, along with <html>'s class and
 *             data-theme so fonts and the theme match.
 *   closing   the user can close it with the OS close button at any time; the
 *             caller hears about it through `onClosed`, exactly once.
 */

export type PopoutRect = { x: number; y: number; w: number; h: number };

export type PopoutHandle = {
  win: Window;
  /** Where the portal renders. */
  root: HTMLElement;
  /** Closes the window without reporting it through `onClosed`. */
  close: () => void;
};

const DEFAULT_W = 400;
const DEFAULT_H = 640;

/** Screen coordinates for the popup.
 *
 *  `rect` is in the room's client coordinates (a floating window's rect, or
 *  where a drag was released). Without one, the popup goes against the right
 *  edge of the browser window — the side nearest a second monitor for most
 *  desks, and where the docked panel was. Browsers clamp this to the current
 *  screen unless the site has the Window Management permission, so the user
 *  finishes the move to the other monitor by dragging the OS title bar. */
function placement(rect?: PopoutRect): { left: number; top: number; w: number; h: number } {
  const w = Math.round(rect?.w ?? DEFAULT_W);
  const h = Math.round(rect?.h ?? DEFAULT_H);
  const chromeTop = Math.max(0, window.outerHeight - window.innerHeight);
  if (rect) {
    return {
      left: Math.round(window.screenX + rect.x),
      top: Math.round(window.screenY + chromeTop + rect.y),
      w,
      h,
    };
  }
  return {
    left: Math.round(window.screenX + window.outerWidth - w - 24),
    top: Math.round(window.screenY + chromeTop + 16),
    w,
    h,
  };
}

function copyStyle(node: Node, doc: Document): Node | null {
  if (node instanceof HTMLLinkElement && node.rel === "stylesheet") {
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    // The resolved URL, not the attribute: `/_next/...` is relative and the
    // popup's base URL is not something to depend on.
    link.href = node.href;
    if (node.media) link.media = node.media;
    if (node.crossOrigin) link.crossOrigin = node.crossOrigin;
    return link;
  }
  if (node instanceof HTMLStyleElement) {
    const style = doc.createElement("style");
    style.textContent = node.textContent;
    if (node.media) style.media = node.media;
    return style;
  }
  return null;
}

function syncHtmlAttributes(doc: Document) {
  const from = document.documentElement;
  const to = doc.documentElement;
  for (const attr of Array.from(from.attributes)) {
    if (attr.name === "style") continue;
    to.setAttribute(attr.name, attr.value);
  }
}

/**
 * Opens (or re-uses) the popup for `name` and prepares it for a portal.
 *
 * Returns null when the browser blocked it — the caller should fall back to an
 * in-page window rather than leave the user with nothing.
 */
export function openPopout(options: {
  /** Stable per panel, so a second open re-uses the same OS window. */
  name: string;
  title: string;
  rect?: PopoutRect;
  /** The user closed the window (or it was lost). Not called by `close()`. */
  onClosed: () => void;
}): PopoutHandle | null {
  if (typeof window === "undefined") return null;
  const { left, top, w, h } = placement(options.rect);
  const features = `popup=yes,width=${w},height=${h},left=${left},top=${top}`;

  let win: Window | null = null;
  try {
    win = window.open("", `webinarliv-${options.name}`, features);
  } catch {
    win = null;
  }
  if (!win) return null;

  const doc = win.document;
  // A window of this name may survive from a previous visit with an old,
  // dead portal in it. Start clean either way.
  doc.head.replaceChildren();
  doc.body.replaceChildren();
  doc.title = `${options.title} — Webinar Liv`;
  syncHtmlAttributes(doc);

  const meta = doc.createElement("meta");
  meta.name = "viewport";
  meta.content = "width=device-width, initial-scale=1";
  doc.head.appendChild(meta);
  for (const node of Array.from(document.head.querySelectorAll('link[rel="stylesheet"], style'))) {
    const copy = copyStyle(node, doc);
    if (copy) doc.head.appendChild(copy);
  }

  doc.documentElement.style.height = "100%";
  doc.body.style.margin = "0";
  doc.body.style.height = "100%";
  doc.body.className = "font-sans antialiased";

  const root = doc.createElement("div");
  root.className = "room-dark flex h-full min-h-0 flex-col bg-surface text-ink";
  doc.body.appendChild(root);

  // Mirror what arrives later: dev HMR style tags, lazily loaded CSS chunks,
  // and theme changes made in the main window.
  const headObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        const copy = copyStyle(node, doc);
        if (copy) doc.head.appendChild(copy);
      }
    }
  });
  headObserver.observe(document.head, { childList: true });
  const htmlObserver = new MutationObserver(() => syncHtmlAttributes(doc));
  htmlObserver.observe(document.documentElement, { attributes: true });

  let done = false;
  const finish = (report: boolean) => {
    if (done) return;
    done = true;
    headObserver.disconnect();
    htmlObserver.disconnect();
    clearInterval(poll);
    win?.removeEventListener("pagehide", onHide);
    if (report) options.onClosed();
  };
  const onHide = () => finish(true);
  win.addEventListener("pagehide", onHide);
  // Backstop: some browsers skip pagehide on a popup closed while the opener
  // is in the background.
  const poll = setInterval(() => {
    if (win?.closed) finish(true);
  }, 1000);

  win.focus();

  return {
    win,
    root,
    close: () => {
      finish(false);
      try {
        win?.close();
      } catch {
        // Already gone.
      }
    },
  };
}
