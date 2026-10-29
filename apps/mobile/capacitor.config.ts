import type { CapacitorConfig } from "@capacitor/cli";

/* Webinar Liv for Android and iOS.
 *
 * The app is the live site (server.url), not a bundled copy of it: a webinar
 * platform's pages are server-rendered and change with every deploy, and the
 * session cookie has to be first-party on webinarliv.com for the Worker's /api
 * proxy (web/worker.ts). The native layer is what the shell adds around it:
 * push, App Links / Universal Links, the native share sheet, keep-awake during
 * a session, background audio, splash and status bar, and Google sign-in through
 * the system browser (@capacitor/browser; web/lib/app-auth.ts). See README.md.
 *
 * www/ is only the bundled error page (server.errorPath), shown when the site
 * cannot be reached. Capacitor still requires webDir to exist.
 */
const config: CapacitorConfig = {
  appId: "com.webinarliv.app",
  appName: "Webinar Liv",
  webDir: "www",
  /* The web app reads this to know it is inside the app (web/lib/native-bridge.ts
   * prefers window.Capacitor.isNativePlatform(); this is the server-side marker). */
  appendUserAgent: "WebinarLivApp/1.0",
  backgroundColor: "#0b5cff",
  server: {
    /* The app opens on the sign-in page, not the marketing home (29 Oct 2026). Signed in,
     * the site's own gate (web/lib/access.ts) sends /login straight on to the host's
     * dashboard (/host) or an attendee's /my-webinars, so nobody signed in ever sees it. */
    url: "https://webinarliv.com/login",
    /* Only webinarliv.com and its subdomains load inside the app. Capacitor opens
     * every other top-level navigation in the system browser (Android: an
     * ACTION_VIEW intent; iOS: UIApplication.open). */
    allowNavigation: ["webinarliv.com", "*.webinarliv.com"],
    errorPath: "index.html",
    cleartext: false,
    androidScheme: "https",
  },
  android: {
    allowMixedContent: false,
    // webContentsDebuggingEnabled is left at its default: on for debug builds
    // (chrome://inspect), off for release.
  },
  ios: {
    contentInset: "never",
    /* A long-press on a join link should not pop a Safari preview of it. */
    allowsLinkPreview: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: "#0b5cff",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
      splashFullScreen: false,
      splashImmersive: false,
    },
    StatusBar: {
      style: "DEFAULT",
      overlaysWebView: false,
    },
    /* Native push through Firebase Cloud Messaging on both platforms (29 Oct 2026): the app
     * sends its FCM token to POST /api/push/native and the API sends through FCM HTTP v1,
     * which reaches iOS through the APNs key uploaded into Firebase. Needs
     * google-services.json (Android) and GoogleService-Info.plist (iOS); without them push
     * stays off. See README.md, "Push notifications". */
    FirebaseMessaging: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
  /* The Firebase plugin's Swift package is named like Firebase's own, which collides in SPM
   * unless it is symlinked (the plugin's README, "Swift Package Manager"). */
  experimental: {
    ios: {
      spm: {
        packageOptions: {
          "@capacitor-firebase/messaging": { symlink: true },
        },
      },
    },
  },
};

export default config;
