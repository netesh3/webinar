/* The /download page's manifest parsing and show / hide rules.
 *
 * Run: node --experimental-strip-types --no-warnings lib/downloads.test.mts
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- the fixtures are edited into malformed shapes */

import assert from "node:assert/strict";
import {
  APK_NOTE,
  MAC_ARM_LABEL,
  MAC_INTEL_LABEL,
  WINDOWS_NOTE,
  anyReady,
  arrangeOffers,
  detectPlatform,
  formatSize,
  inOwnApp,
  macArchFromHint,
  orderMacLinks,
  parseManifest,
  platformOffers,
  type Manifest,
} from "./downloads.ts";

const SHA = "a".repeat(64);
const f = (name: string, size = 94_371_840) => ({
  url: `https://downloads.webinarliv.com/desktop/0.1.0/${name}`,
  size,
  sha256: SHA,
});

/** Everything published and signed. */
function full(): any {
  return {
    schema: 1,
    updatedAt: "2026-10-29T10:00:00Z",
    desktop: {
      version: "0.1.0",
      releasedAt: "2026-10-29T09:00:00Z",
      signed: { mac: true, windows: true },
      files: {
        "mac-arm64": f("WebinarLiv-arm64.dmg"),
        "mac-x64": f("WebinarLiv-x64.dmg"),
        "win-x64": f("WebinarLiv-Setup.exe"),
      },
    },
    android: {
      version: "1.0.0",
      versionCode: 7,
      releasedAt: "2026-10-29T09:00:00Z",
      signed: true,
      apk: f("webinarliv.apk", 8_000_000),
    },
    stores: {
      appStore: "https://apps.apple.com/app/id123",
      playStore: "https://play.google.com/store/apps/details?id=com.webinarliv.app",
      testflight: "https://testflight.apple.com/join/abc",
    },
  };
}

const parsed = (raw: unknown): Manifest => {
  const m = parseManifest(raw);
  assert.ok(m, "expected a valid manifest");
  return m;
};
const ids = (m: Manifest | null) => platformOffers(m).map((o) => o.id);

// ------------------------------------------------------------------ parsing

{
  const m = parsed(full());
  assert.equal(m.desktop?.version, "0.1.0");
  assert.equal(m.desktop?.files["mac-arm64"]?.size, 94_371_840);
  assert.equal(m.android?.versionCode, 7);
  assert.equal(m.stores.testflight, "https://testflight.apple.com/join/abc");
}

// The empty manifest the pipeline writes before any release.
{
  const m = parsed({
    schema: 1,
    updatedAt: "2026-10-29T10:00:00Z",
    desktop: null,
    android: null,
    stores: { appStore: null, playStore: null, testflight: null },
  });
  assert.deepEqual(platformOffers(m).map((o) => [o.id, o.status]), [["ios", "soon"]]);
  assert.equal(anyReady(platformOffers(m)), false);
}

// Malformed in any part: treated as missing.
{
  const broken: [string, (m: any) => void][] = [
    ["schema 2", (m) => (m.schema = 2)],
    ["no updatedAt", (m) => delete m.updatedAt],
    ["bad date", (m) => (m.updatedAt = "yesterday")],
    ["signed missing", (m) => delete m.desktop.signed],
    ["signed a string", (m) => (m.desktop.signed.mac = "true")],
    ["http file", (m) => (m.desktop.files["win-x64"].url = "http://downloads.webinarliv.com/x.exe")],
    ["not a url", (m) => (m.desktop.files["mac-x64"].url = "WebinarLiv.dmg")],
    ["short sha", (m) => (m.desktop.files["mac-arm64"].sha256 = "abc")],
    ["size 0", (m) => (m.desktop.files["win-x64"].size = 0)],
    ["size float", (m) => (m.android.apk.size = 1.5)],
    ["no apk", (m) => delete m.android.apk],
    ["versionCode string", (m) => (m.android.versionCode = "7")],
    ["stores missing", (m) => delete m.stores],
    ["javascript: store", (m) => (m.stores.appStore = "javascript:alert(1)")],
    ["desktop an array", (m) => (m.desktop = [])],
  ];
  for (const [name, edit] of broken) {
    const raw = full();
    edit(raw);
    assert.equal(parseManifest(raw), null, name);
  }
  for (const raw of [null, undefined, "", "{}", 1, [], {}]) assert.equal(parseManifest(raw), null, String(raw));
  assert.deepEqual(platformOffers(null), []);
}

// Unknown file keys are ignored; the checksum is lowercased.
{
  const raw = full();
  raw.desktop.files["linux-x64"] = { url: "nope" };
  raw.desktop.files["win-x64"].sha256 = "A".repeat(64);
  const m = parsed(raw);
  assert.equal(m.desktop?.files["win-x64"]?.sha256, SHA);
  assert.ok(!("linux-x64" in (m.desktop?.files ?? {})));
}

// ------------------------------------------------------------------ show / hide

// Everything: all four, iOS from the App Store (not TestFlight), no warnings.
{
  const offers = platformOffers(parsed(full()));
  assert.deepEqual(offers.map((o) => o.id), ["mac", "windows", "android", "ios"]);
  const mac = offers[0];
  assert.deepEqual(mac.links.map((l) => l.label), [MAC_ARM_LABEL, MAC_INTEL_LABEL]);
  assert.deepEqual(offers[1].notes, []);
  assert.deepEqual(offers[2].links.map((l) => l.id), ["playStore", "apk"]);
  assert.deepEqual(offers[2].notes, [APK_NOTE]);
  assert.deepEqual(offers[3].links.map((l) => l.id), ["appStore"]);
  assert.ok(anyReady(offers));
}

// Unsigned Mac build: Mac hidden. Unsigned Windows: shown with the SmartScreen note.
{
  const raw = full();
  raw.desktop.signed = { mac: false, windows: false };
  const offers = platformOffers(parsed(raw));
  assert.ok(!offers.some((o) => o.id === "mac"));
  assert.deepEqual(offers.find((o) => o.id === "windows")?.notes, [WINDOWS_NOTE]);
}

// Signed Mac with only one architecture published.
{
  const raw = full();
  delete raw.desktop.files["mac-x64"];
  const mac = platformOffers(parsed(raw)).find((o) => o.id === "mac");
  assert.deepEqual(mac?.links.map((l) => l.id), ["mac-arm64"]);
}

// Signed Mac but no Mac file: hidden. No win-x64: Windows hidden.
{
  const raw = full();
  raw.desktop.files = { "win-x64": f("x.exe") };
  assert.deepEqual(ids(parsed(raw)), ["windows", "android", "ios"]);
  raw.desktop.files = {};
  assert.deepEqual(ids(parsed(raw)), ["android", "ios"]);
}

// Platforms on their own versions: macOS 0.1.3 signed, Windows 0.1.4 unsigned. Each card
// shows its own file's version and size; the section version is only the highest.
{
  const raw = full();
  raw.desktop.version = "0.1.4";
  raw.desktop.signed = { mac: true, windows: false };
  raw.desktop.files["mac-arm64"] = { ...f("a.dmg", 121_967_568), version: "0.1.3", releasedAt: "2026-10-30T04:19:04Z" };
  raw.desktop.files["mac-x64"] = { ...f("b.dmg", 127_891_165), version: "0.1.3", releasedAt: "2026-10-30T04:19:04Z" };
  raw.desktop.files["win-x64"] = { ...f("c.exe", 90_000_000), version: "0.1.4", releasedAt: "2026-10-31T10:00:00Z" };
  const m = parsed(raw);
  assert.equal(m.desktop?.files["win-x64"]?.version, "0.1.4");
  assert.equal(m.desktop?.files["mac-x64"]?.releasedAt, "2026-10-30T04:19:04Z");
  const offers = platformOffers(m);
  const win = offers.find((o) => o.id === "windows");
  assert.deepEqual(win?.links.map((l) => l.kind === "file" && [l.label, l.version, l.size]), [["Download for Windows", "0.1.4", 90_000_000]]);
  assert.deepEqual(win?.notes, [WINDOWS_NOTE]);
  const mac = offers.find((o) => o.id === "mac");
  assert.deepEqual(mac?.links.map((l) => l.kind === "file" && l.version), ["0.1.3", "0.1.3"]);

  // The legacy shape (no per-file version) takes the section's version.
  const legacy = full();
  legacy.desktop.version = "0.1.3";
  const lw = platformOffers(parsed(legacy)).find((o) => o.id === "windows")?.links[0];
  assert.equal(lw?.kind === "file" && lw.version, "0.1.3");
  assert.equal(parsed(legacy).desktop?.files["mac-arm64"]?.releasedAt, legacy.desktop.releasedAt);

  // Windows only (no mac files yet) still shows the Windows button.
  const winOnly = full();
  winOnly.desktop.files = { "win-x64": { ...f("c.exe"), version: "0.1.4", releasedAt: "2026-10-31T10:00:00Z" } };
  assert.deepEqual(ids(parsed(winOnly)), ["windows", "android", "ios"]);

  // A malformed per-file version or date is a malformed manifest.
  const badVersion = full();
  badVersion.desktop.files["win-x64"].version = 4;
  assert.equal(parseManifest(badVersion), null);
  const badDate = full();
  badDate.desktop.files["win-x64"].releasedAt = "soon";
  assert.equal(parseManifest(badDate), null);
}

// Android: unsigned APK never offered; Play Store alone is enough; neither hides Android.
{
  const raw = full();
  raw.android.signed = false;
  const a = platformOffers(parsed(raw)).find((o) => o.id === "android");
  assert.deepEqual(a?.links.map((l) => l.id), ["playStore"]);
  assert.deepEqual(a?.notes, []);
  raw.stores.playStore = null;
  assert.ok(!ids(parsed(raw)).includes("android"));
  raw.android.signed = true;
  assert.deepEqual(platformOffers(parsed(raw)).find((o) => o.id === "android")?.links.map((l) => l.id), ["apk"]);
}

// iOS: App Store, else TestFlight, else coming soon. Never a file.
{
  const raw = full();
  raw.stores.appStore = null;
  let ios = platformOffers(parsed(raw)).find((o) => o.id === "ios");
  assert.deepEqual(ios?.links.map((l) => l.id), ["testflight"]);
  raw.stores.testflight = null;
  ios = platformOffers(parsed(raw)).find((o) => o.id === "ios");
  assert.equal(ios?.status, "soon");
  assert.deepEqual(ios?.links, []);
  for (const o of platformOffers(parsed(full()))) {
    if (o.id === "ios") assert.ok(o.links.every((l) => l.kind === "store"));
  }
}

// Windows + Android APK + App Store (the screenshot's middle state).
{
  const raw = full();
  raw.desktop.signed = { mac: false, windows: false };
  raw.stores.playStore = null;
  raw.stores.testflight = null;
  assert.deepEqual(ids(parsed(raw)), ["windows", "android", "ios"]);
}

// ------------------------------------------------------------------ the visitor's device

{
  const UA = {
    mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
    iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    chromeos: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  };
  assert.equal(detectPlatform(UA.mac), "mac");
  assert.equal(detectPlatform(UA.mac, 5), "ios", "iPadOS Safari reports as a Mac");
  assert.equal(detectPlatform(UA.win), "windows");
  assert.equal(detectPlatform(UA.android), "android");
  assert.equal(detectPlatform(UA.iphone), "ios");
  assert.equal(detectPlatform(UA.linux), "other");
  assert.equal(detectPlatform(UA.chromeos), "other");
  assert.equal(detectPlatform(""), "other");

  assert.equal(macArchFromHint("arm"), "mac-arm64");
  assert.equal(macArchFromHint("x86"), "mac-x64");
  assert.equal(macArchFromHint(""), null);
  assert.equal(macArchFromHint(undefined), null);

  const offers = platformOffers(parsed(full()));
  const onWin = arrangeOffers(offers, "windows");
  assert.equal(onWin.primary?.id, "windows");
  assert.deepEqual(onWin.others.map((o) => o.id), ["mac", "android", "ios"]);
  const onLinux = arrangeOffers(offers, "other");
  assert.equal(onLinux.primary, null);
  assert.equal(onLinux.others.length, 4);
  // A Mac visitor when the Mac build is hidden: no primary, the rest listed.
  const raw = full();
  raw.desktop.signed.mac = false;
  assert.equal(arrangeOffers(platformOffers(parsed(raw)), "mac").primary, null);

  const mac = offers[0].links;
  assert.deepEqual(orderMacLinks(mac, "mac-x64").map((l) => l.id), ["mac-x64", "mac-arm64"]);
  assert.deepEqual(orderMacLinks(mac, "mac-arm64").map((l) => l.id), ["mac-arm64", "mac-x64"]);
  assert.deepEqual(orderMacLinks(mac, null).map((l) => l.id), ["mac-arm64", "mac-x64"]);

  assert.equal(inOwnApp(`${UA.iphone} WebinarLivApp/1.0`, false), true);
  assert.equal(inOwnApp(UA.mac, true), true);
  assert.equal(inOwnApp(UA.mac, false), false);
}

assert.equal(formatSize(94_371_840), "90 MB");
assert.equal(formatSize(8_000_000), "7.6 MB");
assert.equal(formatSize(10), "0.1 MB");

console.log("downloads: ok");
