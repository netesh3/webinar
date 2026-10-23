/* Keeping our own UI out of a screen share.
 *
 * Two halves, both pure so `node --experimental-strip-types` can test them:
 *
 *   1. The hints handed to the browser's share picker (getDisplayMedia's options, through
 *      LiveKit's ScreenShareCaptureOptions): hide this tab from Chrome's tab list, do not
 *      push the current tab to the front, keep the full screen on offer, allow switching
 *      the shared surface mid-share, and offer system audio where the OS has it.
 *
 *   2. What to tell the presenter around the picker: a one-time tip before it opens, and —
 *      when they picked the entire screen anyway — a nudge toward the mini controls, which
 *      are a 360×110 window instead of a whole tab of Webinar Liv on everybody's screen.
 *
 * FEATURE DETECTION. These are DisplayMediaStreamOptions dictionary members, not
 * constraints, so getSupportedConstraints() says nothing about them and an unknown member is
 * silently dropped by WebIDL. They are still only sent to the Chromium versions that know
 * them: Safari has misbehaved on a getDisplayMedia hint it did not recognise before (see
 * displayMediaOptions in share-picker.tsx), so nothing is sent on a hunch.
 *
 * monitorTypeSurfaces is in the result for completeness; LiveKit does not forward it, and
 * Chrome's default for it is "include" anyway, which is the value we want.
 */

export type DisplayMediaHints = {
  selfBrowserSurface?: "exclude";
  preferCurrentTab?: false;
  surfaceSwitching?: "include";
  systemAudio?: "include";
  monitorTypeSurfaces?: "include";
};

/** The Chromium version each hint arrived in. */
const SINCE = {
  preferCurrentTab: 94,
  systemAudio: 105,
  selfBrowserSurface: 107,
  surfaceSwitching: 107,
  monitorTypeSurfaces: 119,
} as const;

export type BrowserEnv = {
  userAgent?: string;
  /** navigator.userAgentData.brands, where it exists. */
  brands?: ReadonlyArray<{ brand: string; version: string }>;
};

/** The Chromium major version (Chrome, Edge, Opera, Brave…), or null for anything else. */
export function chromiumMajor(env: BrowserEnv): number | null {
  const brand = env.brands?.find((b) => b.brand === "Chromium");
  if (brand) {
    const n = parseInt(brand.version, 10);
    return Number.isFinite(n) ? n : null;
  }
  // No client hints (older Chromium, or a page that is not a secure context). Chrome on iOS
  // says CriOS and is WebKit underneath, so it correctly does not match here.
  const m = env.userAgent?.match(/\bChrom(?:e|ium)\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** The picker hints this browser understands; empty for Safari and Firefox. */
export function displayMediaHints(chromium: number | null): DisplayMediaHints {
  if (chromium === null) return {};
  const out: DisplayMediaHints = {};
  // Never true together with selfBrowserSurface "exclude": Chrome rejects that pair.
  if (chromium >= SINCE.preferCurrentTab) out.preferCurrentTab = false;
  if (chromium >= SINCE.selfBrowserSurface) out.selfBrowserSurface = "exclude";
  if (chromium >= SINCE.surfaceSwitching) out.surfaceSwitching = "include";
  if (chromium >= SINCE.systemAudio) out.systemAudio = "include";
  if (chromium >= SINCE.monitorTypeSurfaces) out.monitorTypeSurfaces = "include";
  return out;
}

/** The hints for the browser this runs in. */
export function currentDisplayMediaHints(): DisplayMediaHints {
  if (typeof navigator === "undefined") return {};
  const nav = navigator as Navigator & {
    userAgentData?: { brands?: ReadonlyArray<{ brand: string; version: string }> };
  };
  return displayMediaHints(
    chromiumMajor({ userAgent: nav.userAgent, brands: nav.userAgentData?.brands }),
  );
}

/* The one-time tip, before the picker opens. */

export const SHARE_TIP_KEY = "webinar.shareTipSeen";

/** Whether to show the tip, from what localStorage holds (null when nothing, or no storage). */
export function shouldShowShareTip(stored: string | null): boolean {
  return stored !== "1";
}

/* After the share starts: what to offer, by the surface the browser reports. */

export type ShareStartOffer =
  /** Nothing: a window share already gets the presenter's floating window, and an unknown
   *  surface (Safari, Firefox) has nothing to offer. */
  | { kind: "none" }
  /** A tab: Chrome takes the presenter to it, so try the mini controls straight away. */
  | { kind: "open-mini" }
  /** The entire screen, with Document PiP available: suggest the mini controls. */
  | { kind: "suggest-mini" }
  /** The entire screen, without Document PiP: suggest sharing a window or tab next time. */
  | { kind: "suggest-window" };

export function shareStartOffer(
  surface: string | null | undefined,
  opts: { miniSupported: boolean; miniOpen: boolean },
): ShareStartOffer {
  if (surface === "monitor") {
    if (!opts.miniSupported) return { kind: "suggest-window" };
    return opts.miniOpen ? { kind: "none" } : { kind: "suggest-mini" };
  }
  if (surface === "browser" && opts.miniSupported && !opts.miniOpen) return { kind: "open-mini" };
  return { kind: "none" };
}
