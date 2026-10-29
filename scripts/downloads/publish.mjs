#!/usr/bin/env node
// Publish installers to the downloads bucket (https://downloads.webinarliv.com) and merge
// latest.json. The layout and manifest are the contract in docs/downloads.md.
//
//   node scripts/downloads/publish.mjs desktop --version 0.1.0 --dir dist \
//        --signed-mac false --signed-windows false
//   node scripts/downloads/publish.mjs android --version 0.1.0 --version-code 42 \
//        --apk app-release.apk --signed true
//   node scripts/downloads/publish.mjs promote-desktop --version 0.1.0   # rollback / re-publish
//   node scripts/downloads/publish.mjs promote-android --version 0.1.0
//
// Options for every command:
//   --dry-run                 print the plan and the merged latest.json, write nothing
//   --fake-bucket <dir>       use a local directory as the bucket (tests)
//   --current-manifest <file> with --dry-run: use this as the bucket's latest.json
//   --write-manifest <file>   also write the merged latest.json to a local file
//   --base-url <url>          default https://downloads.webinarliv.com (DOWNLOADS_BASE_URL)
//   --bucket <name>           default webinarliv-downloads (R2_DOWNLOADS_BUCKET)
//
// Environment for the real bucket: R2_DOWNLOADS_ACCOUNT_ID, AWS_ACCESS_KEY_ID and
// AWS_SECRET_ACCESS_KEY (an R2 API token scoped to the bucket). Store links come from
// IOS_APP_STORE_URL, ANDROID_PLAY_STORE_URL, IOS_TESTFLIGHT_URL when set.
//
// Versioned objects are immutable: an existing one with the same sha256 is skipped, one with
// a different sha256 stops the run before anything is written (bump the version instead).

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  CACHE_FEED,
  CACHE_IMMUTABLE,
  CACHE_LATEST,
  DEFAULT_BASE_URL,
  DEFAULT_BUCKET,
  DESKTOP_FEED_FILES,
  DESKTOP_TARGETS,
  MANIFEST_KEY,
  androidLatestKey,
  androidVersionedKey,
  assertVersion,
  contentTypeFor,
  desktopFeedKey,
  desktopFeedVersionedKey,
  desktopFileName,
  desktopLatestKey,
  desktopPayloadKey,
  desktopVersionedKey,
  fileInfo,
  mergeManifest,
  parseManifest,
  publicUrl,
  storesFromEnv,
  updaterFeedFiles,
  updaterFeedVersion,
} from "./lib.mjs";
import { AwsStore, DirStore, DryRunStore, WranglerR2Store } from "./store.mjs";

const bool = (v) => v === true || v === "true" || v === "1";

/**
 * Upload versioned (immutable) objects. Checks every key first so a conflict stops the run
 * before anything is written. Returns the existing metadata of skipped objects by key.
 */
async function putImmutable(store, items, log) {
  const existing = new Map();
  for (const it of items) {
    const head = await store.head(it.key);
    if (!head) continue;
    if (head.metadata?.sha256 !== it.sha256) {
      throw new Error(
        `${it.key} is already in the bucket with different content (sha256 ${head.metadata?.sha256 ?? "unknown"}, ` +
          `this build ${it.sha256}). Versioned files are immutable: bump the version, or delete the object and purge the CDN cache.`,
      );
    }
    existing.set(it.key, head.metadata);
  }
  for (const it of items) {
    if (existing.has(it.key)) {
      log(`skip  ${it.key} (already uploaded, same sha256)`);
      continue;
    }
    log(`put   ${it.key}`);
    await store.putFile(it.key, it.path, {
      contentType: contentTypeFor(it.key),
      cacheControl: CACHE_IMMUTABLE,
      metadata: { ...it.metadata, sha256: it.sha256 },
    });
  }
  return existing;
}

async function writeManifest(store, { section, value, env, now, log }) {
  const current = parseManifest(await store.getText(MANIFEST_KEY));
  const merged = mergeManifest(current, { section, value, stores: storesFromEnv(env), now });
  log(`put   ${MANIFEST_KEY} (${section} section)`);
  await store.putText(MANIFEST_KEY, `${JSON.stringify(merged, null, 2)}\n`, {
    contentType: contentTypeFor(MANIFEST_KEY),
    cacheControl: CACHE_LATEST,
  });
  return merged;
}

function desktopSection({ version, releasedAt, signed, files, baseUrl }) {
  const out = { version, releasedAt, signed, files: {} };
  for (const t of DESKTOP_TARGETS) {
    const f = files[t.id];
    if (!f) continue;
    out.files[t.id] = { url: publicUrl(baseUrl, desktopLatestKey(t)), size: f.size, sha256: f.sha256 };
  }
  return out;
}

export async function publishDesktop({ store, dir, version, signedMac, signedWindows, baseUrl, env, now, log }) {
  assertVersion(version);
  now ??= new Date().toISOString();
  const signed = { mac: Boolean(signedMac), windows: Boolean(signedWindows) };

  const installers = [];
  for (const t of DESKTOP_TARGETS) {
    const path = join(dir, desktopFileName(version, t));
    if (!existsSync(path)) continue;
    installers.push({ t, path, ...(await fileInfo(path)) });
  }
  if (!installers.some((i) => i.t.platform === "mac")) {
    throw new Error(`missing macOS installer in ${dir}`);
  }

  const feeds = [];
  const payloadNames = new Set();
  for (const name of DESKTOP_FEED_FILES) {
    const path = join(dir, name);
    if (!existsSync(path)) {
      // Windows feed is absent when this Mac ships macOS-only (no Azure Trusted Signing).
      if (name === "latest.yml") continue;
      throw new Error(`missing updater feed ${path}`);
    }
    const text = await readFile(path, "utf8");
    const feedVersion = updaterFeedVersion(text);
    if (feedVersion !== version) throw new Error(`${name} is for version ${feedVersion}, expected ${version}`);
    for (const n of updaterFeedFiles(text)) payloadNames.add(n);
    feeds.push({ name, path, text, ...(await fileInfo(path)) });
  }
  const payloads = [];
  for (const name of payloadNames) {
    const path = join(dir, name);
    if (!existsSync(path)) throw new Error(`updater feed refers to ${name}, which is not in ${dir}`);
    payloads.push({ name, path, ...(await fileInfo(path)) });
    const blockmap = `${path}.blockmap`;
    if (existsSync(blockmap)) payloads.push({ name: `${name}.blockmap`, path: blockmap, ...(await fileInfo(blockmap)) });
  }

  const immutable = [
    ...installers.map((i) => ({
      key: desktopVersionedKey(version, i.t),
      path: i.path,
      sha256: i.sha256,
      metadata: { version, "released-at": now, signed: String(signed[i.t.platform]) },
    })),
    ...payloads.map((p) => ({ key: desktopPayloadKey(p.name), path: p.path, sha256: p.sha256, metadata: { version } })),
    ...feeds.map((f) => ({ key: desktopFeedVersionedKey(version, f.name), path: f.path, sha256: f.sha256, metadata: { version } })),
  ];
  const existing = await putImmutable(store, immutable, log);

  // A re-run of the same build keeps the original release time and signed flags.
  const prior = (t) => existing.get(desktopVersionedKey(version, t));
  const releasedAt = prior(DESKTOP_TARGETS[0])?.["released-at"] ?? now;
  for (const t of DESKTOP_TARGETS) {
    const was = prior(t)?.signed;
    if (was === "true" || was === "false") signed[t.platform] = was === "true";
  }

  for (const i of installers) {
    const key = desktopLatestKey(i.t);
    log(`copy  ${desktopVersionedKey(version, i.t)} -> ${key}`);
    await store.copy(desktopVersionedKey(version, i.t), key, {
      contentType: contentTypeFor(key),
      cacheControl: CACHE_LATEST,
      metadata: prior(i.t) ?? { version, "released-at": releasedAt, signed: String(signed[i.t.platform]), sha256: i.sha256 },
    });
  }
  for (const f of feeds) {
    log(`put   ${desktopFeedKey(f.name)}`);
    await store.putText(desktopFeedKey(f.name), f.text, { contentType: contentTypeFor(f.name), cacheControl: CACHE_FEED });
  }

  const files = Object.fromEntries(installers.map((i) => [i.t.id, { size: i.size, sha256: i.sha256 }]));
  const value = desktopSection({ version, releasedAt, signed, files, baseUrl });
  return writeManifest(store, { section: "desktop", value, env, now, log });
}

export async function promoteDesktop({ store, version, baseUrl, env, now, log }) {
  assertVersion(version);
  now ??= new Date().toISOString();
  const files = {};
  const meta = {};
  for (const t of DESKTOP_TARGETS) {
    const key = desktopVersionedKey(version, t);
    const head = await store.head(key);
    if (!head?.metadata?.sha256) {
      if (t.platform === "windows") continue;
      throw new Error(`${key} is not in the bucket (or has no sha256 metadata)`);
    }
    files[t.id] = { size: head.size, sha256: head.metadata.sha256 };
    meta[t.id] = head.metadata;
  }
  const feeds = [];
  for (const name of DESKTOP_FEED_FILES) {
    const text = await store.getText(desktopFeedVersionedKey(version, name));
    if (text == null) {
      if (name === "latest.yml") continue;
      throw new Error(`${desktopFeedVersionedKey(version, name)} is not in the bucket`);
    }
    for (const n of updaterFeedFiles(text)) {
      if (!(await store.head(desktopPayloadKey(n)))) throw new Error(`${desktopPayloadKey(n)} is not in the bucket`);
    }
    feeds.push({ name, text });
  }

  for (const t of DESKTOP_TARGETS) {
    if (!files[t.id]) continue;
    log(`copy  ${desktopVersionedKey(version, t)} -> ${desktopLatestKey(t)}`);
    await store.copy(desktopVersionedKey(version, t), desktopLatestKey(t), {
      contentType: contentTypeFor(desktopLatestKey(t)),
      cacheControl: CACHE_LATEST,
      metadata: meta[t.id],
    });
  }
  for (const f of feeds) {
    log(`put   ${desktopFeedKey(f.name)}`);
    await store.putText(desktopFeedKey(f.name), f.text, { contentType: contentTypeFor(f.name), cacheControl: CACHE_FEED });
  }
  const signed = {
    mac: meta["mac-arm64"]?.signed === "true",
    windows: meta["win-x64"]?.signed === "true",
  };
  const releasedAt = meta["mac-arm64"]?.["released-at"] ?? now;
  const value = desktopSection({ version, releasedAt, signed, files, baseUrl });
  return writeManifest(store, { section: "desktop", value, env, now, log });
}

function androidSection({ version, versionCode, releasedAt, size, sha256, baseUrl }) {
  return {
    version,
    versionCode,
    releasedAt,
    signed: true,
    apk: { url: publicUrl(baseUrl, androidLatestKey()), size, sha256 },
  };
}

export async function publishAndroid({ store, apk, version, versionCode, signed, baseUrl, env, now, log }) {
  assertVersion(version);
  now ??= new Date().toISOString();
  // Debug or unsigned builds are not for customers.
  if (!signed) throw new Error("refusing to publish an APK that is not release-signed");
  const code = Number(versionCode);
  if (!Number.isInteger(code) || code < 1) throw new Error(`invalid versionCode "${versionCode}"`);
  if (!existsSync(apk)) throw new Error(`missing APK ${apk}`);
  const info = await fileInfo(apk);

  const key = androidVersionedKey(version);
  const existing = await putImmutable(
    store,
    [{ key, path: apk, sha256: info.sha256, metadata: { version, "version-code": String(code), "released-at": now, signed: "true" } }],
    log,
  );
  const prior = existing.get(key);
  const releasedAt = prior?.["released-at"] ?? now;
  log(`copy  ${key} -> ${androidLatestKey()}`);
  await store.copy(key, androidLatestKey(), {
    contentType: contentTypeFor(key),
    cacheControl: CACHE_LATEST,
    metadata: prior ?? { version, "version-code": String(code), "released-at": releasedAt, signed: "true", sha256: info.sha256 },
  });
  const value = androidSection({
    version,
    versionCode: Number(prior?.["version-code"] ?? code),
    releasedAt,
    size: info.size,
    sha256: info.sha256,
    baseUrl,
  });
  return writeManifest(store, { section: "android", value, env, now, log });
}

export async function promoteAndroid({ store, version, baseUrl, env, now, log }) {
  assertVersion(version);
  now ??= new Date().toISOString();
  const key = androidVersionedKey(version);
  const head = await store.head(key);
  if (!head?.metadata?.sha256) throw new Error(`${key} is not in the bucket (or has no sha256 metadata)`);
  if (head.metadata.signed !== "true") throw new Error(`${key} is not marked signed; refusing to promote it`);
  log(`copy  ${key} -> ${androidLatestKey()}`);
  await store.copy(key, androidLatestKey(), {
    contentType: contentTypeFor(key),
    cacheControl: CACHE_LATEST,
    metadata: head.metadata,
  });
  const value = androidSection({
    version,
    versionCode: Number(head.metadata["version-code"]),
    releasedAt: head.metadata["released-at"] ?? now,
    size: head.size,
    sha256: head.metadata.sha256,
    baseUrl,
  });
  return writeManifest(store, { section: "android", value, env, now, log });
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      version: { type: "string" },
      "version-code": { type: "string" },
      dir: { type: "string" },
      apk: { type: "string" },
      signed: { type: "string" },
      "signed-mac": { type: "string" },
      "signed-windows": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "fake-bucket": { type: "string" },
      "current-manifest": { type: "string" },
      "write-manifest": { type: "string" },
      "base-url": { type: "string" },
      bucket: { type: "string" },
    },
  });
  const command = positionals[0];
  const env = process.env;
  // In a dry run the store prints each write with its headers; skip the duplicate line.
  const log = (line) => {
    if (!(values["dry-run"] && /^(put|copy) /.test(line))) console.log(line);
  };
  const baseUrl = values["base-url"] || env.DOWNLOADS_BASE_URL || DEFAULT_BASE_URL;
  const bucket = values.bucket || env.R2_DOWNLOADS_BUCKET || DEFAULT_BUCKET;

  let store;
  if (values["fake-bucket"]) {
    store = new DirStore(values["fake-bucket"]);
  } else if (env.R2_DOWNLOADS_ACCOUNT_ID && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    // R2_DOWNLOADS_ENDPOINT overrides the endpoint (a local S3 for testing).
    const endpoint = env.R2_DOWNLOADS_ENDPOINT || `https://${env.R2_DOWNLOADS_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    store = new AwsStore({ bucket, endpoint });
  } else if (!values["dry-run"]) {
    // This Mac: Wrangler OAuth to R2 when the S3 API keys are not in the env.
    store = new WranglerR2Store({ bucket });
  }
  if (values["dry-run"]) {
    const overrides = {};
    if (values["current-manifest"]) overrides[MANIFEST_KEY] = await readFile(values["current-manifest"], "utf8");
    store = new DryRunStore(store, (line) => console.log(line), overrides);
  }
  const target =
    store instanceof AwsStore || store instanceof WranglerR2Store
      ? `r2://${bucket}`
      : values["fake-bucket"]
        ? `dir:${values["fake-bucket"]}`
        : "nothing";
  log(`${command}${values["dry-run"] ? " (dry run)" : ""} -> ${target}, public base ${baseUrl}`);

  const common = { store, version: values.version, baseUrl, env, log };
  let manifest;
  switch (command) {
    case "desktop":
      if (!values.dir) throw new Error("--dir is required");
      manifest = await publishDesktop({
        ...common,
        dir: values.dir,
        signedMac: bool(values["signed-mac"]),
        signedWindows: bool(values["signed-windows"]),
      });
      break;
    case "android":
      if (!values.apk) throw new Error("--apk is required");
      manifest = await publishAndroid({
        ...common,
        apk: values.apk,
        versionCode: values["version-code"],
        signed: bool(values.signed),
      });
      break;
    case "promote-desktop":
      manifest = await promoteDesktop(common);
      break;
    case "promote-android":
      manifest = await promoteAndroid(common);
      break;
    default:
      throw new Error(`usage: ${basename(process.argv[1])} desktop|android|promote-desktop|promote-android --version X [...]`);
  }
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  if (values["write-manifest"]) await writeFile(values["write-manifest"], json);
  log(`\n${MANIFEST_KEY}${values["dry-run"] ? " (would be)" : ""}:\n${json}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
