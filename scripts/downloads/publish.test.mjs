// node --test scripts/downloads
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CACHE_FEED,
  CACHE_IMMUTABLE,
  CACHE_LATEST,
  compareVersions,
  contentTypeFor,
  emptyManifest,
  mergeDesktopSection,
  mergeManifest,
  normalizeManifest,
  updaterFeedFiles,
  updaterFeedVersion,
} from "./lib.mjs";
import { promoteAndroid, promoteDesktop, publishAndroid, publishDesktop } from "./publish.mjs";
import { DirStore, DryRunStore } from "./store.mjs";

const BASE = "https://downloads.webinarliv.com";
const NOW = "2026-10-29T10:00:00.000Z";
const LATER = "2026-11-05T10:00:00.000Z";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const quiet = () => {};

const desktopValue = { version: "0.1.0", releasedAt: NOW, signed: { mac: false, windows: false }, files: {} };
const androidValue = { version: "0.1.0", versionCode: 7, releasedAt: NOW, signed: true, apk: { url: "x", size: 1, sha256: "a" } };

test("merge: missing manifest starts from nulls", () => {
  const m = mergeManifest(null, { section: "desktop", value: desktopValue, now: NOW });
  assert.deepEqual(m, { ...emptyManifest(), updatedAt: NOW, desktop: desktopValue });
  assert.deepEqual(Object.keys(m), ["schema", "updatedAt", "desktop", "android", "stores"]);
});

test("merge: updates only its own section", () => {
  const current = mergeManifest(null, { section: "android", value: androidValue, now: NOW });
  const m = mergeManifest(current, { section: "desktop", value: desktopValue, now: LATER });
  assert.deepEqual(m.android, androidValue);
  assert.deepEqual(m.desktop, desktopValue);
  assert.equal(m.updatedAt, LATER);
  const again = mergeManifest(m, { section: "android", value: { ...androidValue, version: "0.2.0" }, now: LATER });
  assert.deepEqual(again.desktop, desktopValue);
  assert.equal(again.android.version, "0.2.0");
});

test("merge: store links are set when given and never cleared", () => {
  const current = { ...emptyManifest(), stores: { appStore: "https://apps.apple.com/app/id1", playStore: null, testflight: "https://testflight.apple.com/join/x" } };
  const m = mergeManifest(current, {
    section: "android",
    value: androidValue,
    stores: { appStore: "", playStore: "https://play.google.com/store/apps/details?id=com.webinarliv.app", testflight: undefined },
    now: NOW,
  });
  assert.deepEqual(m.stores, {
    appStore: "https://apps.apple.com/app/id1",
    playStore: "https://play.google.com/store/apps/details?id=com.webinarliv.app",
    testflight: "https://testflight.apple.com/join/x",
  });
});

test("merge: garbage in the bucket is treated as empty", () => {
  for (const bad of [null, "nope", [], 42, { desktop: "x", stores: "y" }]) {
    const n = normalizeManifest(bad);
    assert.equal(n.desktop, null);
    assert.deepEqual(n.stores, emptyManifest().stores);
  }
  assert.throws(() => mergeManifest(null, { section: "ios", value: {}, now: NOW }));
});

test("content types", () => {
  assert.equal(contentTypeFor("a.dmg"), "application/x-apple-diskimage");
  assert.equal(contentTypeFor("a.exe"), "application/vnd.microsoft.portable-executable");
  assert.equal(contentTypeFor("a.apk"), "application/vnd.android.package-archive");
  assert.equal(contentTypeFor("latest.json"), "application/json");
});

const macYml = (v) => `version: ${v}
files:
  - url: WebinarLiv-${v}-mac-arm64.zip
    sha512: aaa
    size: 3
  - url: WebinarLiv-${v}-mac-x64.zip
    sha512: bbb
    size: 3
  - url: WebinarLiv-${v}-mac-arm64.dmg
    sha512: ccc
    size: 3
  - url: WebinarLiv-${v}-mac-x64.dmg
    sha512: ddd
    size: 3
path: WebinarLiv-${v}-mac-arm64.zip
sha512: aaa
releaseDate: '2026-10-29T10:00:00.000Z'
`;
const winYml = (v) => `version: ${v}
files:
  - url: WebinarLiv-${v}-win-x64.exe
    sha512: eee
    size: 3
path: WebinarLiv-${v}-win-x64.exe
sha512: eee
releaseDate: '2026-10-29T10:00:00.000Z'
`;

test("updater feed parsing", () => {
  assert.equal(updaterFeedVersion(macYml("0.1.0")), "0.1.0");
  assert.deepEqual(updaterFeedFiles(winYml("0.1.0")), ["WebinarLiv-0.1.0-win-x64.exe"]);
  assert.equal(updaterFeedFiles(macYml("0.1.0")).length, 4);
  assert.throws(() => updaterFeedFiles("files:\n  - url: https://evil.example/x.zip\n"));
  assert.throws(() => updaterFeedFiles("path: ../x.zip\n"));
});

async function fakeDesktopBuild(version, salt = "") {
  const dir = await mkdtemp(join(tmpdir(), "desktop-build-"));
  const names = [
    `WebinarLiv-${version}-mac-arm64.dmg`,
    `WebinarLiv-${version}-mac-x64.dmg`,
    `WebinarLiv-${version}-win-x64.exe`,
    `WebinarLiv-${version}-mac-arm64.zip`,
    `WebinarLiv-${version}-mac-x64.zip`,
    `WebinarLiv-${version}-mac-arm64.zip.blockmap`,
    `WebinarLiv-${version}-win-x64.exe.blockmap`,
  ];
  for (const n of names) await writeFile(join(dir, n), `${n}${salt}`);
  await writeFile(join(dir, "latest-mac.yml"), macYml(version));
  await writeFile(join(dir, "latest.yml"), winYml(version));
  return dir;
}

test("desktop publish, android publish, re-run, conflict, rollback against a local bucket", async () => {
  const bucket = await mkdtemp(join(tmpdir(), "bucket-"));
  const store = new DirStore(bucket);
  const env = { IOS_TESTFLIGHT_URL: "https://testflight.apple.com/join/abc" };

  const d1 = await fakeDesktopBuild("0.1.0");
  let m = await publishDesktop({ store, dir: d1, version: "0.1.0", signedMac: false, signedWindows: true, baseUrl: BASE, env, now: NOW, log: quiet });
  assert.equal(m.desktop.version, "0.1.0");
  assert.deepEqual(m.desktop.signed, { mac: false, windows: true });
  assert.deepEqual(m.desktop.files["win-x64"], {
    url: `${BASE}/desktop/latest/WebinarLiv-win-x64.exe`,
    size: "WebinarLiv-0.1.0-win-x64.exe".length,
    sha256: sha("WebinarLiv-0.1.0-win-x64.exe"),
    version: "0.1.0",
    releasedAt: NOW,
  });
  assert.equal(m.android, null);
  assert.equal(m.stores.testflight, env.IOS_TESTFLIGHT_URL);

  // Layout and headers.
  const h = (k) => store.headers(k);
  assert.equal((await h("desktop/0.1.0/WebinarLiv-0.1.0-mac-arm64.dmg")).cacheControl, CACHE_IMMUTABLE);
  assert.equal((await h("desktop/0.1.0/WebinarLiv-0.1.0-mac-arm64.dmg")).contentType, "application/x-apple-diskimage");
  assert.equal((await h("desktop/latest/WebinarLiv-mac-x64.dmg")).cacheControl, CACHE_LATEST);
  assert.equal((await h("desktop/latest/WebinarLiv-win-x64.exe")).contentType, "application/vnd.microsoft.portable-executable");
  assert.equal((await h("latest.json")).cacheControl, CACHE_LATEST);
  assert.equal((await h("latest.json")).contentType, "application/json");
  // Updater feed: yml at desktop/, everything it references next to it.
  assert.equal((await h("desktop/latest-mac.yml")).cacheControl, CACHE_FEED);
  for (const k of [
    "desktop/WebinarLiv-0.1.0-mac-arm64.zip",
    "desktop/WebinarLiv-0.1.0-mac-arm64.zip.blockmap",
    "desktop/WebinarLiv-0.1.0-win-x64.exe",
    "desktop/WebinarLiv-0.1.0-win-x64.exe.blockmap",
    "desktop/0.1.0/latest.yml",
  ]) {
    assert.ok(await h(k), k);
  }

  // Android: unsigned is refused, signed goes in and leaves desktop alone.
  const apk = join(d1, "app-release.apk");
  await writeFile(apk, "apk-0.1.0");
  await assert.rejects(publishAndroid({ store, apk, version: "0.1.0", versionCode: 7, signed: false, baseUrl: BASE, env: {}, now: NOW, log: quiet }), /not release-signed/);
  m = await publishAndroid({ store, apk, version: "0.1.0", versionCode: 7, signed: true, baseUrl: BASE, env: { ANDROID_PLAY_STORE_URL: "https://play.google.com/x" }, now: NOW, log: quiet });
  assert.deepEqual(m.android, {
    version: "0.1.0",
    versionCode: 7,
    releasedAt: NOW,
    signed: true,
    apk: { url: `${BASE}/android/latest/WebinarLiv.apk`, size: 9, sha256: sha("apk-0.1.0") },
  });
  assert.equal(m.desktop.version, "0.1.0");
  assert.equal(m.stores.testflight, env.IOS_TESTFLIGHT_URL);
  assert.equal(m.stores.playStore, "https://play.google.com/x");
  assert.equal((await h("android/0.1.0/WebinarLiv-0.1.0.apk")).contentType, "application/vnd.android.package-archive");

  // Re-running the same build is a no-op for versioned files and keeps the release time.
  m = await publishDesktop({ store, dir: d1, version: "0.1.0", signedMac: false, signedWindows: true, baseUrl: BASE, env: {}, now: LATER, log: quiet });
  assert.equal(m.desktop.releasedAt, NOW);
  assert.equal(m.updatedAt, LATER);

  // A different build under the same version is refused before anything is written.
  const before = await readFile(join(bucket, "latest.json"), "utf8");
  const d1b = await fakeDesktopBuild("0.1.0", "-rebuilt");
  await assert.rejects(publishDesktop({ store, dir: d1b, version: "0.1.0", baseUrl: BASE, env: {}, now: LATER, log: quiet }), /immutable/);
  assert.equal(await readFile(join(bucket, "latest.json"), "utf8"), before);

  // 0.2.0, then roll back to 0.1.0.
  const d2 = await fakeDesktopBuild("0.2.0");
  m = await publishDesktop({ store, dir: d2, version: "0.2.0", signedMac: true, signedWindows: true, baseUrl: BASE, env: {}, now: LATER, log: quiet });
  assert.equal(m.desktop.version, "0.2.0");
  assert.match(await store.getText("desktop/latest.yml"), /version: 0\.2\.0/);
  assert.equal(await store.getText("desktop/latest/WebinarLiv-win-x64.exe"), "WebinarLiv-0.2.0-win-x64.exe");

  m = await promoteDesktop({ store, version: "0.1.0", baseUrl: BASE, env: {}, now: LATER, log: quiet });
  assert.equal(m.desktop.version, "0.1.0");
  assert.equal(m.desktop.releasedAt, NOW);
  assert.deepEqual(m.desktop.signed, { mac: false, windows: true });
  assert.equal(m.desktop.files["mac-arm64"].sha256, sha("WebinarLiv-0.1.0-mac-arm64.dmg"));
  assert.equal(await store.getText("desktop/latest/WebinarLiv-win-x64.exe"), "WebinarLiv-0.1.0-win-x64.exe");
  assert.match(await store.getText("desktop/latest.yml"), /version: 0\.1\.0/);
  assert.equal(m.android.versionCode, 7);

  m = await promoteAndroid({ store, version: "0.1.0", baseUrl: BASE, env: {}, now: LATER, log: quiet });
  assert.equal(m.android.versionCode, 7);
  assert.equal(m.android.apk.sha256, sha("apk-0.1.0"));
  await assert.rejects(promoteAndroid({ store, version: "9.9.9", baseUrl: BASE, env: {}, now: LATER, log: quiet }), /not in the bucket/);
});

test("desktop publish allows macOS-only (no Windows installer or latest.yml)", async () => {
  const bucket = await mkdtemp(join(tmpdir(), "bucket-mac-"));
  const store = new DirStore(bucket);
  const dir = await mkdtemp(join(tmpdir(), "desktop-mac-"));
  const version = "0.1.0";
  for (const n of [
    `WebinarLiv-${version}-mac-arm64.dmg`,
    `WebinarLiv-${version}-mac-x64.dmg`,
    `WebinarLiv-${version}-mac-arm64.zip`,
    `WebinarLiv-${version}-mac-x64.zip`,
    `WebinarLiv-${version}-mac-arm64.zip.blockmap`,
  ]) {
    await writeFile(join(dir, n), n);
  }
  await writeFile(join(dir, "latest-mac.yml"), macYml(version));
  const m = await publishDesktop({
    store,
    dir,
    version,
    signedMac: true,
    signedWindows: false,
    baseUrl: BASE,
    env: {},
    now: NOW,
    log: quiet,
  });
  assert.equal(m.desktop.signed.mac, true);
  assert.equal(m.desktop.signed.windows, false);
  assert.ok(m.desktop.files["mac-arm64"]);
  assert.ok(m.desktop.files["mac-x64"]);
  assert.equal(m.desktop.files["win-x64"], undefined);
  assert.equal(await store.getText("desktop/latest.yml"), null);
});

test("dry run writes nothing", async () => {
  const lines = [];
  const store = new DryRunStore(null, (l) => lines.push(l), {
    "latest.json": JSON.stringify({ ...emptyManifest(), android: androidValue, stores: { appStore: "https://apps.apple.com/x" } }),
  });
  const d = await fakeDesktopBuild("0.3.0");
  const m = await publishDesktop({ store, dir: d, version: "0.3.0", baseUrl: BASE, env: {}, now: NOW, log: (l) => lines.push(l) });
  assert.equal(m.desktop.version, "0.3.0");
  assert.deepEqual(m.android, androidValue);
  assert.equal(m.stores.appStore, "https://apps.apple.com/x");
  assert.ok(lines.some((l) => l.startsWith("[dry-run] put   latest.json")));
});

// ------------------------------------------------------------------ platforms on their own versions

async function fakePlatformBuild(platform, version, salt = "") {
  const dir = await mkdtemp(join(tmpdir(), `desktop-${platform}-`));
  const names =
    platform === "mac"
      ? [
          `WebinarLiv-${version}-mac-arm64.dmg`,
          `WebinarLiv-${version}-mac-x64.dmg`,
          `WebinarLiv-${version}-mac-arm64.zip`,
          `WebinarLiv-${version}-mac-x64.zip`,
          `WebinarLiv-${version}-mac-arm64.zip.blockmap`,
        ]
      : [`WebinarLiv-${version}-win-x64.exe`, `WebinarLiv-${version}-win-x64.exe.blockmap`];
  for (const n of names) await writeFile(join(dir, n), `${n}${salt}`);
  if (platform === "mac") await writeFile(join(dir, "latest-mac.yml"), macYml(version));
  else await writeFile(join(dir, "latest.yml"), winYml(version));
  return dir;
}

const publishMac = async (store, version, now) =>
  publishDesktop({
    store,
    dir: await fakePlatformBuild("mac", version),
    version,
    platform: "mac",
    signedMac: true,
    signedWindows: true,
    baseUrl: BASE,
    env: {},
    now,
    log: quiet,
  });
const publishWin = async (store, version, now) =>
  publishDesktop({
    store,
    dir: await fakePlatformBuild("windows", version),
    version,
    platform: "windows",
    signedMac: false,
    signedWindows: false,
    baseUrl: BASE,
    env: {},
    now,
    log: quiet,
  });

test("compareVersions", () => {
  assert.equal(compareVersions("0.1.4", "0.1.3"), 1);
  assert.equal(compareVersions("0.1.3", "0.1.10"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
});

test("desktop: mac then Windows on a newer version keeps the mac files", async () => {
  const store = new DirStore(await mkdtemp(join(tmpdir(), "bucket-mw-")));
  let m = await publishMac(store, "0.1.3", NOW);
  const macFiles = m.desktop.files;
  assert.deepEqual(Object.keys(macFiles), ["mac-arm64", "mac-x64"]);
  assert.deepEqual(m.desktop.signed, { mac: true, windows: false });

  m = await publishWin(store, "0.1.4", LATER);
  assert.deepEqual(Object.keys(m.desktop.files), ["mac-arm64", "mac-x64", "win-x64"]);
  assert.deepEqual(m.desktop.files["mac-arm64"], macFiles["mac-arm64"]);
  assert.deepEqual(m.desktop.files["mac-x64"], macFiles["mac-x64"]);
  assert.equal(m.desktop.files["mac-arm64"].version, "0.1.3");
  assert.equal(m.desktop.files["mac-arm64"].releasedAt, NOW);
  assert.equal(m.desktop.files["win-x64"].version, "0.1.4");
  assert.equal(m.desktop.files["win-x64"].releasedAt, LATER);
  assert.deepEqual(m.desktop.signed, { mac: true, windows: false });
  assert.equal(m.desktop.version, "0.1.4");
  assert.equal(m.desktop.releasedAt, LATER);

  // Separate update feeds per platform.
  assert.match(await store.getText("desktop/latest-mac.yml"), /version: 0\.1\.3/);
  assert.match(await store.getText("desktop/latest.yml"), /version: 0\.1\.4/);
  assert.equal(await store.getText("desktop/latest/WebinarLiv-mac-arm64.dmg"), "WebinarLiv-0.1.3-mac-arm64.dmg");
  assert.equal(await store.getText("desktop/latest/WebinarLiv-win-x64.exe"), "WebinarLiv-0.1.4-win-x64.exe");
});

test("desktop: Windows then mac keeps win-x64", async () => {
  const store = new DirStore(await mkdtemp(join(tmpdir(), "bucket-wm-")));
  let m = await publishWin(store, "0.1.4", NOW);
  assert.deepEqual(Object.keys(m.desktop.files), ["win-x64"]);
  assert.deepEqual(m.desktop.signed, { mac: false, windows: false });
  const win = m.desktop.files["win-x64"];

  m = await publishMac(store, "0.1.5", LATER);
  assert.deepEqual(Object.keys(m.desktop.files), ["mac-arm64", "mac-x64", "win-x64"]);
  assert.deepEqual(m.desktop.files["win-x64"], win);
  assert.equal(m.desktop.files["mac-x64"].version, "0.1.5");
  assert.deepEqual(m.desktop.signed, { mac: true, windows: false });
  assert.equal(m.desktop.version, "0.1.5");
  assert.match(await store.getText("desktop/latest.yml"), /version: 0\.1\.4/);
  assert.match(await store.getText("desktop/latest-mac.yml"), /version: 0\.1\.5/);

  // An older mac version still leaves the section on the highest one.
  m = await publishMac(store, "0.1.2", LATER);
  assert.equal(m.desktop.files["mac-arm64"].version, "0.1.2");
  assert.equal(m.desktop.version, "0.1.4");
  assert.equal(m.desktop.releasedAt, NOW);

  // Promoting one platform leaves the other alone.
  m = await promoteDesktop({ store, version: "0.1.5", platform: "mac", baseUrl: BASE, env: {}, now: LATER, log: quiet });
  assert.equal(m.desktop.files["mac-arm64"].version, "0.1.5");
  assert.deepEqual(m.desktop.files["win-x64"], win);
  await assert.rejects(
    promoteDesktop({ store, version: "0.1.5", platform: "windows", baseUrl: BASE, env: {}, now: LATER, log: quiet }),
    /not in the bucket/,
  );
});

test("desktop: --platform publishes only that platform from a dir with both", async () => {
  const store = new DirStore(await mkdtemp(join(tmpdir(), "bucket-only-")));
  await publishMac(store, "0.1.3", NOW);
  const d = await fakeDesktopBuild("0.1.4");
  const m = await publishDesktop({ store, dir: d, version: "0.1.4", platform: "windows", baseUrl: BASE, env: {}, now: LATER, log: quiet });
  assert.equal(m.desktop.files["mac-arm64"].version, "0.1.3");
  assert.equal(m.desktop.files["win-x64"].version, "0.1.4");
  assert.equal(await store.head("desktop/0.1.4/WebinarLiv-0.1.4-mac-arm64.dmg"), null);
  assert.match(await store.getText("desktop/latest-mac.yml"), /version: 0\.1\.3/);
  const macOnly = await fakePlatformBuild("mac", "0.1.4");
  await assert.rejects(
    publishDesktop({ store, dir: macOnly, version: "0.1.4", platform: "windows", baseUrl: BASE, env: {}, now: LATER, log: quiet }),
    /missing windows installer/,
  );
  await assert.rejects(
    publishDesktop({ store, dir: d, version: "0.1.4", platform: "linux", baseUrl: BASE, env: {}, now: LATER, log: quiet }),
    /invalid platform/,
  );
});

test("merge: a legacy desktop section (no per-file versions) keeps its mac files on a Windows publish", () => {
  const legacy = {
    version: "0.1.3",
    releasedAt: NOW,
    signed: { mac: true, windows: false },
    files: {
      "mac-arm64": { url: `${BASE}/desktop/latest/WebinarLiv-mac-arm64.dmg`, size: 10, sha256: "a".repeat(64) },
      "mac-x64": { url: `${BASE}/desktop/latest/WebinarLiv-mac-x64.dmg`, size: 11, sha256: "b".repeat(64) },
    },
  };
  const win = { url: `${BASE}/desktop/latest/WebinarLiv-win-x64.exe`, size: 12, sha256: "c".repeat(64), version: "0.1.4", releasedAt: LATER };
  const d = mergeDesktopSection(legacy, { platforms: ["windows"], files: { "win-x64": win }, signed: { windows: false } });
  assert.deepEqual(d, {
    version: "0.1.4",
    releasedAt: LATER,
    signed: { mac: true, windows: false },
    files: {
      "mac-arm64": { ...legacy.files["mac-arm64"], version: "0.1.3", releasedAt: NOW },
      "mac-x64": { ...legacy.files["mac-x64"], version: "0.1.3", releasedAt: NOW },
      "win-x64": win,
    },
  });
  const fresh = mergeDesktopSection(null, { platforms: ["windows"], files: { "win-x64": win }, signed: { windows: true } });
  assert.deepEqual(fresh.signed, { mac: false, windows: true });
  assert.equal(fresh.version, "0.1.4");
});
