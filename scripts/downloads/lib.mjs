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

export const DESKTOP_PLATFORMS = ["mac", "windows"];
export const desktopTargetsFor = (platform) => DESKTOP_TARGETS.filter((t) => t.platform === platform);
/** Each platform has its own electron-updater feed, so macOS and Windows update independently. */
export const DESKTOP_FEED_FOR = { mac: "latest-mac.yml", windows: "latest.yml" };

export function assertDesktopPlatform(platform) {
  if (!DESKTOP_PLATFORMS.includes(platform)) {
    throw new Error(`invalid platform "${platform}" (expected ${DESKTOP_PLATFORMS.join(" or ")})`);
  }
  return platform;
}

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

/** Semver order: -1, 0 or 1. A prerelease sorts before its release. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const s = String(v);
    const dash = s.indexOf("-");
    const core = dash < 0 ? s : s.slice(0, dash);
    return { nums: core.split(".").map((n) => Number(n) || 0), pre: dash < 0 ? null : s.slice(dash + 1).split(".") };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Math.sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * The desktop section after publishing some platforms. macOS and Windows are released on
 * their own (macOS from the owner's Mac, Windows from CI), so each file entry carries its
 * own `version` and `releasedAt`:
 *
 * - each platform in `platforms` gets exactly `files` (its targets only) and `signed[platform]`;
 *   every other platform's files and signed flag are kept as they are;
 * - entries written before per-file versions take the section's `version` / `releasedAt`;
 * - the section's `version` is the highest version among the files, and `releasedAt` the
 *   latest release time among the files on that version (for readers that only look there).
 */
export function mergeDesktopSection(current, { platforms, files = {}, signed = {} }) {
  for (const p of platforms) assertDesktopPlatform(p);
  const cur = isObject(current) ? current : null;
  const curFiles = isObject(cur?.files) ? cur.files : {};
  const outFiles = {};
  for (const t of DESKTOP_TARGETS) {
    if (platforms.includes(t.platform)) {
      if (files[t.id]) outFiles[t.id] = files[t.id];
      continue;
    }
    const f = curFiles[t.id];
    if (!isObject(f)) continue;
    const version = typeof f.version === "string" ? f.version : cur.version;
    const releasedAt = typeof f.releasedAt === "string" ? f.releasedAt : cur.releasedAt;
    outFiles[t.id] = {
      ...f,
      ...(typeof version === "string" ? { version } : {}),
      ...(typeof releasedAt === "string" ? { releasedAt } : {}),
    };
  }
  const outSigned = { mac: cur?.signed?.mac === true, windows: cur?.signed?.windows === true };
  for (const p of platforms) outSigned[p] = Boolean(signed[p]);

  let version = null;
  for (const f of Object.values(outFiles)) {
    if (typeof f.version === "string" && (version === null || compareVersions(f.version, version) > 0)) version = f.version;
  }
  let releasedAt = null;
  for (const f of Object.values(outFiles)) {
    if (f.version === version && typeof f.releasedAt === "string" && (releasedAt === null || f.releasedAt > releasedAt)) {
      releasedAt = f.releasedAt;
    }
  }
  return {
    version: version ?? cur?.version ?? null,
    releasedAt: releasedAt ?? cur?.releasedAt ?? null,
    signed: outSigned,
    files: outFiles,
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
