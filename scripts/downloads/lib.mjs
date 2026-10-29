// Pure helpers for the downloads bucket (downloads.webinarliv.com): object keys, headers,
// the latest.json merge and electron-updater feed parsing. No I/O except hashing a file.
// The contract these implement is docs/downloads.md.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export const DEFAULT_BASE_URL = "https://downloads.webinarliv.com";
export const DEFAULT_BUCKET = "webinarliv-downloads";
export const MANIFEST_KEY = "latest.json";

/** latest.json and the latest/ copies: they change on every release. */
export const CACHE_LATEST = "public, max-age=300";
/** Versioned files never change once uploaded (the publisher refuses to overwrite them). */
export const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
/** desktop/latest*.yml, the auto-update feed: always revalidated at the edge. */
export const CACHE_FEED = "no-cache";

const CONTENT_TYPES = {
  dmg: "application/x-apple-diskimage",
  exe: "application/vnd.microsoft.portable-executable",
  apk: "application/vnd.android.package-archive",
  json: "application/json",
  zip: "application/zip",
  yml: "text/yaml",
  blockmap: "application/octet-stream",
};

export function contentTypeFor(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function assertVersion(version) {
  if (!VERSION_RE.test(String(version ?? ""))) {
    throw new Error(`invalid version "${version}" (expected e.g. 0.1.0 or 0.2.0-beta.1)`);
  }
  return version;
}

/** Desktop installers in the manifest, keyed by the contract's file ids. */
export const DESKTOP_TARGETS = [
  { id: "mac-arm64", ext: "dmg", platform: "mac" },
  { id: "mac-x64", ext: "dmg", platform: "mac" },
  { id: "win-x64", ext: "exe", platform: "windows" },
];

/** electron-builder's artifact name (artifactName in apps/desktop/electron-builder.config.cjs). */
export const desktopFileName = (version, t) => `WebinarLiv-${version}-${t.id}.${t.ext}`;
export const desktopVersionedKey = (version, t) => `desktop/${version}/${desktopFileName(version, t)}`;
export const desktopLatestKey = (t) => `desktop/latest/WebinarLiv-${t.id}.${t.ext}`;
/** electron-updater feed files. The feed URL is <base>/desktop/. */
export const DESKTOP_FEED_FILES = ["latest-mac.yml", "latest.yml"];
export const desktopFeedKey = (name) => `desktop/${name}`;
export const desktopFeedVersionedKey = (version, name) => `desktop/${version}/${name}`;
/** Update payloads (zip, exe, blockmap) sit flat in desktop/, next to the feed files. */
export const desktopPayloadKey = (name) => `desktop/${name}`;

export const androidFileName = (version) => `WebinarLiv-${version}.apk`;
export const androidVersionedKey = (version) => `android/${version}/${androidFileName(version)}`;
export const androidLatestKey = () => "android/latest/WebinarLiv.apk";

export const publicUrl = (baseUrl, key) => `${String(baseUrl).replace(/\/+$/, "")}/${key}`;

export function emptyManifest() {
  return {
    schema: 1,
    updatedAt: null,
    desktop: null,
    android: null,
    stores: { appStore: null, playStore: null, testflight: null },
  };
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A manifest read from the bucket, or anything else, as a well-formed manifest. */
export function normalizeManifest(current) {
  const base = emptyManifest();
  if (!isObject(current)) return base;
  const stores = { ...base.stores };
  if (isObject(current.stores)) {
    for (const k of Object.keys(stores)) {
      const v = current.stores[k];
      stores[k] = typeof v === "string" && v.trim() !== "" ? v : null;
    }
  }
  return {
    schema: 1,
    updatedAt: typeof current.updatedAt === "string" ? current.updatedAt : null,
    desktop: isObject(current.desktop) ? current.desktop : null,
    android: isObject(current.android) ? current.android : null,
    stores,
  };
}

/** Store links from the repo variables. Empty or unset values are ignored, never cleared. */
export function storesFromEnv(env = process.env) {
  return {
    appStore: env.IOS_APP_STORE_URL,
    playStore: env.ANDROID_PLAY_STORE_URL,
    testflight: env.IOS_TESTFLIGHT_URL,
  };
}

/**
 * Replace one section ("desktop" or "android") of the manifest and leave the other as it
 * is. `stores` values that are non-empty strings overwrite; anything else keeps what is there.
 */
export function mergeManifest(current, { section, value, stores = {}, now }) {
  if (section !== "desktop" && section !== "android") throw new Error(`unknown section "${section}"`);
  if (!isObject(value)) throw new Error(`section "${section}" needs an object`);
  const out = normalizeManifest(current);
  out[section] = value;
  for (const k of Object.keys(out.stores)) {
    const v = stores[k];
    if (typeof v === "string" && v.trim() !== "") out.stores[k] = v.trim();
  }
  out.updatedAt = now ?? new Date().toISOString();
  return out;
}

/** Parse latest.json text from the bucket. Missing (null) or unreadable means start over. */
export function parseManifest(text) {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * File names an electron-updater latest*.yml points at (`url:` entries and the legacy
 * `path:`). The generic provider resolves them against the feed URL, so they must be bare
 * file names in the same directory.
 */
export function updaterFeedFiles(yml) {
  const names = new Set();
  for (const line of String(yml).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:-\s+)?(?:url|path):\s*(.+?)\s*$/);
    if (!m) continue;
    const name = m[1].replace(/^(['"])(.*)\1$/, "$2");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new Error(`updater feed refers to "${name}"; expected a bare file name next to the feed`);
    }
    names.add(name);
  }
  return [...names];
}

/** The `version:` of an electron-updater latest*.yml. */
export function updaterFeedVersion(yml) {
  const m = String(yml).match(/^version:\s*['"]?([^'"\s]+)['"]?\s*$/m);
  return m ? m[1] : null;
}

export async function fileInfo(path) {
  const { size } = await stat(path);
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    createReadStream(path).on("data", (c) => hash.update(c)).on("error", reject).on("end", resolve);
  });
  return { size, sha256: hash.digest("hex") };
}
