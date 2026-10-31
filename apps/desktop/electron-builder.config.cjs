/**
 * electron-builder config for the Webinar Liv desktop app.
 *
 * Everything that depends on a secret is switched on by environment variables
 * and stays off when they are absent, so a plain `npm run dist` on any machine
 * produces an unsigned build:
 *
 *   macOS signing      CSC_LINK + CSC_KEY_PASSWORD (Developer ID Application .p12),
 *                      or CSC_NAME for a certificate already in the keychain.
 *   macOS notarization APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
 *                      (electron-builder reads these itself; only used when signed).
 *   Windows signing    AZURE_TRUSTED_SIGNING_ENDPOINT + AZURE_TRUSTED_SIGNING_ACCOUNT
 *                      + AZURE_TRUSTED_SIGNING_PROFILE (+ AZURE_TENANT_ID,
 *                      AZURE_CLIENT_ID, AZURE_CLIENT_SECRET for the service principal).
 */

const env = (name) => {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : undefined;
};

const macSigned = Boolean(env("CSC_LINK") || env("CSC_NAME"));
const macNotarize =
  macSigned &&
  Boolean(
    (env("APPLE_ID") && env("APPLE_APP_SPECIFIC_PASSWORD") && env("APPLE_TEAM_ID")) ||
      (env("APPLE_API_KEY") && env("APPLE_API_KEY_ID") && env("APPLE_API_ISSUER")),
  );

const azureSign =
  env("AZURE_TRUSTED_SIGNING_ENDPOINT") &&
  env("AZURE_TRUSTED_SIGNING_ACCOUNT") &&
  env("AZURE_TRUSTED_SIGNING_PROFILE")
    ? {
        endpoint: env("AZURE_TRUSTED_SIGNING_ENDPOINT"),
        codeSigningAccountName: env("AZURE_TRUSTED_SIGNING_ACCOUNT"),
        certificateProfileName: env("AZURE_TRUSTED_SIGNING_PROFILE"),
        publisherName: env("AZURE_TRUSTED_SIGNING_PUBLISHER"),
      }
    : undefined;

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "com.webinarliv.desktop",
  productName: "Webinar Liv",
  copyright: "Copyright © Webinar Liv",
  artifactName: "WebinarLiv-${version}-${os}-${arch}.${ext}",
  directories: {
    output: "release",
    buildResources: "build",
  },
  files: ["dist/**/*", "static/**/*", "package.json"],
  asar: true,
  protocols: [{ name: "Webinar Liv", schemes: ["webinarliv"] }],
  // Auto-update feed: electron-updater's generic provider reads
  // https://downloads.webinarliv.com/desktop/latest-mac.yml (macOS) or latest.yml
  // (Windows) and resolves the files listed there against the same directory.
  // CI uploads them (scripts/downloads/publish.mjs, docs/downloads.md); electron-builder
  // itself never publishes (`--publish never`). The first entry is the one baked into the
  // app's app-update.yml.
  publish: [{ provider: "generic", url: "https://downloads.webinarliv.com/desktop/" }],

  mac: {
    category: "public.app-category.business",
    // Finder / Dock / DMG volume icon. --prepackaged must be this .app bundle,
    // not release/mac-arm64 (that nests Webinar Liv.app/Webinar Liv.app;
    // Finder then shows the missing-icon glyph and Gatekeeper rejects the image).
    icon: "build/icon.icns",
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    // Hardened runtime is what notarization needs; an ad-hoc build skips it
    // (with an ad-hoc signature it would refuse Electron's own frameworks).
    hardenedRuntime: macSigned,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    // "-" is an ad-hoc signature: unsigned for distribution, but still runs on
    // Apple silicon, which refuses to launch code with no signature at all.
    identity: macSigned ? undefined : "-",
    notarize: macNotarize,
    extendInfo: {
      NSCameraUsageDescription: "Webinar Liv uses your camera when you turn on video in a webinar or meeting.",
      NSMicrophoneUsageDescription: "Webinar Liv uses your microphone when you speak in a webinar or meeting.",
      NSAudioCaptureUsageDescription: "Webinar Liv captures system audio when you share your screen with sound.",
      NSScreenCaptureUsageDescription: "Webinar Liv records your screen only while you share it in a webinar or meeting.",
    },
  },
  dmg: {
    sign: false,
    icon: "build/icon.icns",
    iconSize: 128,
  },

  win: {
    icon: "build/icon.ico",
    target: [{ target: "nsis", arch: ["x64"] }],
    ...(azureSign ? { azureSignOptions: azureSign } : {}),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Webinar Liv",
  },
};
