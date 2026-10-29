import type { CapacitorConfig } from "@capacitor/cli";

/* Webinar Liv for Android and iOS.
 *
 * The app is the live site (server.url), not a bundled copy of it: a webinar
 * platform's pages are server-rendered and change with every deploy, and the
 * session cookie has to be first-party on webinarliv.com for the Worker's /api
 * proxy (web/worker.ts). The native layer is what the shell adds around it:
 * push, App Links / Universal Links, the native share sheet, keep-awake during
 * a session, background audio, splash and status bar. See README.md.
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
    url: "https://webinarliv.com",
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
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
