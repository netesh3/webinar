/* The /download page's decisions: what the release manifest says, which apps are ready to
 * offer, and which one to put first for the visitor's device.
 *
 * The manifest is https://downloads.webinarliv.com/latest.json, written by the release
 * pipeline (schema 1; desktop files may carry their own version, docs/downloads.md). Anything that does not match the schema exactly is treated as no
 * manifest at all: a half-read manifest could put a wrong link or checksum on the page.
 *
 * Kept free of React, Next and "@/" imports so lib/downloads.test.mts runs it with plain
 * Node. The fetch is lib/downloads-server.ts; the page is app/download/page.tsx.
 *
 * What is offered (the owner's rule: hide what is not ready):
 *   Mac      only a signed build. Unsigned ones fail with "damaged" / "can't be opened".
 *   Windows  any win-x64 build; unsigned ones carry the SmartScreen note.
 *   Android  the Play Store when listed; the APK only when it is signed.
 *   iOS      the App Store, else TestFlight, else "Coming soon". Never a file.
 */

import { isAndroid, isIOS, isNativeAppUA } from "./device.ts";

export const MANIFEST_URL = "https://downloads.webinarliv.com/latest.json";

export type DesktopFileKey = "mac-arm64" | "mac-x64" | "win-x64";

export type ManifestFile = { url: string; size: number; sha256: string };

/** A desktop installer. macOS and Windows are released separately, so each file has its own
 *  version and release time; manifests written before that carry them only on the section,
 *  and the parser copies them down. */
export type DesktopFile = ManifestFile & { version: string; releasedAt: string };

export type Manifest = {
  schema: 1;
  updatedAt: string;
  desktop: {
    version: string;
    releasedAt: string;
    signed: { mac: boolean; windows: boolean };
    /** The highest version among the files (older readers show only this). */
    files: Partial<Record<DesktopFileKey, DesktopFile>>;
  } | null;
  android: {
    version: string;
    versionCode: number;
    releasedAt: string;
    signed: boolean;
    apk: ManifestFile;
  } | null;
  stores: { appStore: string | null; playStore: string | null; testflight: string | null };
};

// ------------------------------------------------------------------ parsing

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isDate = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

function isHttpsUrl(v: unknown): v is string {
  if (!isStr(v)) return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

class Invalid extends Error {}

function need<T>(ok: boolean, v: T): T {
  if (!ok) throw new Invalid();
  return v;
}

function file(v: unknown): ManifestFile {
  need(isObj(v), v);
  const o = v as Obj;
  need(isHttpsUrl(o.url), o.url);
  need(Number.isSafeInteger(o.size) && (o.size as number) > 0, o.size);
  need(typeof o.sha256 === "string" && /^[0-9a-f]{64}$/i.test(o.sha256), o.sha256);
  return { url: o.url as string, size: o.size as number, sha256: (o.sha256 as string).toLowerCase() };
}

/** A desktop file; `version` / `releasedAt` are optional on it and default to the section's. */
function desktopFile(v: unknown, version: string, releasedAt: string): DesktopFile {
  const base = file(v);
  const o = v as Obj;
  if (o.version !== undefined) need(isStr(o.version), o.version);
  if (o.releasedAt !== undefined) need(isDate(o.releasedAt), o.releasedAt);
  return {
    ...base,
    version: (o.version as string | undefined) ?? version,
    releasedAt: (o.releasedAt as string | undefined) ?? releasedAt,
  };
}

function storeUrl(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return need(isHttpsUrl(v), v as string);
}

const FILE_KEYS: readonly DesktopFileKey[] = ["mac-arm64", "mac-x64", "win-x64"];

/** The manifest, or null when it is not a valid schema 1 manifest. Unknown file keys
 *  (a future linux build, say) are ignored; a known one that is malformed is not. */
export function parseManifest(raw: unknown): Manifest | null {
  try {
    need(isObj(raw), raw);
    const m = raw as Obj;
    need(m.schema === 1, m.schema);
    need(isDate(m.updatedAt), m.updatedAt);

    let desktop: Manifest["desktop"] = null;
    if (m.desktop !== null && m.desktop !== undefined) {
      need(isObj(m.desktop), m.desktop);
      const d = m.desktop as Obj;
      need(isStr(d.version) && isDate(d.releasedAt) && isObj(d.signed) && isObj(d.files), d);
      const signed = d.signed as Obj;
      need(isBool(signed.mac) && isBool(signed.windows), signed);
      const files: Partial<Record<DesktopFileKey, DesktopFile>> = {};
      for (const key of FILE_KEYS) {
        const f = (d.files as Obj)[key];
        if (f !== undefined && f !== null) files[key] = desktopFile(f, d.version as string, d.releasedAt as string);
      }
      desktop = {
        version: d.version as string,
        releasedAt: d.releasedAt as string,
        signed: { mac: signed.mac as boolean, windows: signed.windows as boolean },
        files,
      };
    }

    let android: Manifest["android"] = null;
    if (m.android !== null && m.android !== undefined) {
      need(isObj(m.android), m.android);
      const a = m.android as Obj;
      need(isStr(a.version) && Number.isSafeInteger(a.versionCode) && isDate(a.releasedAt) && isBool(a.signed), a);
      android = {
        version: a.version as string,
        versionCode: a.versionCode as number,
        releasedAt: a.releasedAt as string,
        signed: a.signed as boolean,
        apk: file(a.apk),
      };
    }

    need(isObj(m.stores), m.stores);
    const s = m.stores as Obj;
    const stores = {
      appStore: storeUrl(s.appStore),
      playStore: storeUrl(s.playStore),
      testflight: storeUrl(s.testflight),
    };

    return { schema: 1, updatedAt: m.updatedAt as string, desktop, android, stores };
  } catch (e) {
    if (e instanceof Invalid) return null;
    throw e;
  }
}

// ------------------------------------------------------------------ offers

export type PlatformId = "mac" | "windows" | "android" | "ios";

export type DownloadLink =
  | {
      kind: "file";
      /** Which build, for the Mac pair: "mac-arm64" | "mac-x64" | "win-x64" | "apk". */
      id: DesktopFileKey | "apk";
      label: string;
      url: string;
      size: number;
      sha256: string;
      version: string;
    }
  | { kind: "store"; id: "appStore" | "playStore" | "testflight"; label: string; url: string };

export type PlatformOffer = {
  id: PlatformId;
  name: string;
  /** "ready" has at least one link; "soon" is shown with no link (iOS only). */
  status: "ready" | "soon";
  links: DownloadLink[];
  notes: string[];
};

export const MAC_ARM_LABEL = "Apple Silicon (M1–M5)";
export const MAC_INTEL_LABEL = "Intel";
export const WINDOWS_NOTE =
  "Windows may show “Windows protected your PC”: click More info → Run anyway.";
export const APK_NOTE =
  "Android will ask you to allow installs from your browser the first time. Allow it, then open the file.";
export const IOS_SOON = "Coming soon to the App Store";

function desktopLink(id: DesktopFileKey, label: string, f: DesktopFile): DownloadLink {
  return { kind: "file", id, label, url: f.url, size: f.size, sha256: f.sha256, version: f.version };
}

/** Every platform worth showing, in display order. Platforms that are not ready are left
 *  out, except iOS, which says it is coming soon. */
export function platformOffers(m: Manifest | null): PlatformOffer[] {
  if (!m) return [];
  const out: PlatformOffer[] = [];
  const d = m.desktop;

  if (d?.signed.mac) {
    const links: DownloadLink[] = [];
    const arm = d.files["mac-arm64"];
    const intel = d.files["mac-x64"];
    if (arm) links.push(desktopLink("mac-arm64", MAC_ARM_LABEL, arm));
    if (intel) links.push(desktopLink("mac-x64", MAC_INTEL_LABEL, intel));
    if (links.length) out.push({ id: "mac", name: "macOS", status: "ready", links, notes: [] });
  }

  // Shown whenever there is a Windows build, on its own version (it ships apart from macOS).
  const win = d?.files["win-x64"];
  if (d && win) {
    out.push({
      id: "windows",
      name: "Windows",
      status: "ready",
      links: [desktopLink("win-x64", "Download for Windows", win)],
      notes: d.signed.windows ? [] : [WINDOWS_NOTE],
    });
  }

  {
    const links: DownloadLink[] = [];
    const notes: string[] = [];
    if (m.stores.playStore) links.push({ kind: "store", id: "playStore", label: "Get it on Google Play", url: m.stores.playStore });
    const a = m.android;
    if (a?.signed) {
      links.push({ kind: "file", id: "apk", label: "Download the APK", version: a.version, ...a.apk });
      notes.push(APK_NOTE);
    }
    if (links.length) out.push({ id: "android", name: "Android", status: "ready", links, notes });
  }

  if (m.stores.appStore) {
    out.push({
      id: "ios",
      name: "iPhone and iPad",
      status: "ready",
      links: [{ kind: "store", id: "appStore", label: "Download on the App Store", url: m.stores.appStore }],
      notes: [],
    });
  } else if (m.stores.testflight) {
    out.push({
      id: "ios",
      name: "iPhone and iPad",
      status: "ready",
      links: [{ kind: "store", id: "testflight", label: "Join the TestFlight beta", url: m.stores.testflight }],
      notes: ["TestFlight is Apple's beta app. Install it first, then open this link."],
    });
  } else {
    out.push({ id: "ios", name: "iPhone and iPad", status: "soon", links: [], notes: [] });
  }

  return out;
}

/** Whether there is anything at all to download. "iOS coming soon" alone is not. */
export function anyReady(offers: readonly PlatformOffer[]): boolean {
  return offers.some((o) => o.status === "ready");
}

// ------------------------------------------------------------------ the visitor's device

export type VisitorPlatform = PlatformId | "other";

/** The visitor's platform from the user agent. iPadOS Safari says "Macintosh"; the
 *  server cannot tell, so the page passes maxTouchPoints from the client to refine it. */
export function detectPlatform(ua: string, maxTouchPoints = 0): VisitorPlatform {
  if (!ua) return "other";
  if (isIOS(ua, maxTouchPoints)) return "ios";
  if (isAndroid(ua)) return "android";
  if (/CrOS/i.test(ua)) return "other";
  if (/Windows NT|Win64|Win32/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  return "other";
}

/** Apple Silicon or Intel from navigator.userAgentData's "architecture" hint, which
 *  only Chromium browsers give. Safari and Firefox: null, so both Mac builds are shown. */
export function macArchFromHint(architecture: unknown): "mac-arm64" | "mac-x64" | null {
  if (architecture === "arm") return "mac-arm64";
  if (architecture === "x86") return "mac-x64";
  return null;
}

/** The visitor's own platform first (when it is on offer), then the rest. */
export function arrangeOffers(
  offers: readonly PlatformOffer[],
  platform: VisitorPlatform,
): { primary: PlatformOffer | null; others: PlatformOffer[] } {
  const primary = offers.find((o) => o.id === platform) ?? null;
  return { primary, others: offers.filter((o) => o !== primary) };
}

/** The Mac links with the visitor's architecture first; both when it is unknown. */
export function orderMacLinks(links: readonly DownloadLink[], arch: "mac-arm64" | "mac-x64" | null): DownloadLink[] {
  if (!arch) return [...links];
  return [...links].sort((a, b) => Number(b.id === arch) - Number(a.id === arch));
}

/** 94_371_840 → "90 MB". One decimal below 10 MB. */
export function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return "0.1 MB";
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** Inside our own app (the Capacitor phone app's user agent, or the desktop app's
 *  window.webinarlivDesktop bridge): links that send people to download it are hidden. */
export function inOwnApp(ua: string, hasDesktopBridge: boolean): boolean {
  return hasDesktopBridge || isNativeAppUA(ua);
}
