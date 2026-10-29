# Webinar Liv for Android and iOS

A [Capacitor 8](https://capacitorjs.com) app around the live site. The WebView loads
`https://webinarliv.com` (`server.url` in `capacitor.config.ts`), so each web deploy reaches the
apps immediately, without a store release. The native layer adds what a browser tab can't do:
push, App Links and Universal Links, the native share sheet, keep-awake, background audio, a
native splash screen and status bar, and a bundled error page.

| | |
|---|---|
| App ID / bundle ID | `com.webinarliv.app` |
| Name | Webinar Liv |
| Capacitor | 8.6 (iOS uses Swift Package Manager, no CocoaPods) |
| Android | minSdk 24, target/compile 36 |
| iOS | 15.0+ |

## Layout

```
apps/mobile/
  capacitor.config.ts     app ID, server.url, allowed hosts, plugin config
  www/index.html          the bundled error page (server.errorPath), works with no network
  assets/                 icon and splash sources (scripts/make-icon-source.mjs)
  android/                native Android project (committed)
    app/src/main/java/com/webinarliv/app/AppInfoPlugin.java  tells the page whether push is built in
  ios/App/                native iOS project (committed)
    App/AppDelegate.swift   audio session (background audio), APNs token hand-off
    App/App.entitlements    Associated Domains (Universal Links, webcredentials), aps-environment
web/                      (the site) pieces that only run inside the app
  lib/native-bridge.ts      deep links, push registration, share shim, keep-awake
  components/native-boot.tsx  mounts it from app/layout.tsx
  public/.well-known/       assetlinks.json, apple-app-site-association
.github/workflows/mobile-build.yml   CI builds
```

## Build and run

```sh
cd apps/mobile
npm install
npx cap sync              # copies www/ and config into both native projects
```

**iOS** (Xcode 16 or later):

```sh
npx cap open ios          # then pick a simulator or device and Run
# or headless, for the simulator:
cd ios/App && xcodebuild -project App.xcodeproj -scheme App -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO
```

To run on a device, set your team under Signing & Capabilities for the App target. Xcode adds
the Push Notifications and Associated Domains capabilities to the App ID from the entitlements.

**Android** (Android Studio, or JDK 21 + Android SDK 36):

```sh
npx cap open android      # or:
cd android && ./gradlew assembleDebug    # app/build/outputs/apk/debug/app-debug.apk
```

You don't need a local Android toolchain: CI builds the APK (see below).

**Icons and splash** come from `assets/`. They are redrawn at 1024/2732 px from the same shapes
as the PWA icons (`web/scripts/pwa-icons.mjs`), because the repo has no high-res logo:
`web/public/brand/mark.png` is only 128 px. To regenerate them, or to swap in designer artwork:

```sh
npm run assets            # make-icon-source.mjs, then @capacitor/assets for ios + android
```

**Debugging:** debug builds can be inspected from `chrome://inspect` (Android) and Safari's
Develop menu (iOS). The bridge logs lines prefixed with `[webinarliv-app]`.

## What the native layer does

| Feature | How |
|---|---|
| Site only, other links outside | `server.allowNavigation` is `webinarliv.com` and `*.webinarliv.com` (e.g. `recordings.webinarliv.com`). Capacitor opens every other top-level navigation in the system browser. |
| Error / offline page | `www/index.html`, shown through `server.errorPath` when the site doesn't load. It reloads when the connection comes back. |
| Camera and mic (LiveKit WebRTC) | **Android:** CAMERA, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS, INTERNET (plus BLUETOOTH_CONNECT for headsets) in the manifest. Capacitor's `BridgeWebChromeClient.onPermissionRequest` already asks for the matching runtime permission and then grants the WebView request, so the app adds no custom WebChromeClient. **iOS:** NSCameraUsageDescription and NSMicrophoneUsageDescription. Capacitor's WKUIDelegate grants `requestMediaCapturePermissionFor`, so the user sees only the OS prompt. Capacitor already sets `allowsInlineMediaPlayback = true` and `mediaTypesRequiringUserActionForPlayback = []`. |
| Background audio | iOS: `UIBackgroundModes` includes `audio`, and AppDelegate sets the `.playback` audio-session category, so a webinar keeps playing with the screen locked or the app in the background. Android: the WebView keeps playing while the activity is in the background, but there is no foreground service, so the OS can stop it under memory pressure (see Limits). |
| Keep screen awake | `@capacitor-community/keep-awake`, switched on for `/webinars/*/room`, `/host/*/room` and recording pages, and off everywhere else (`keepsScreenAwake` in `web/lib/native-bridge.ts`). The plugin works the same on both platforms, so the app doesn't rely on the Screen Wake Lock API, which WKWebView gained only in recent iOS versions. |
| App Links / Universal Links | Join and webinar URLs (`/webinars/*`, `/w/*`, `/host/*`, `/recordings*`, `/my-webinars*`, `/verify-email*`, `/reset-password*`) on `webinarliv.com` and `www` open the app. The intent filter has `autoVerify`. Entitlements: `applinks:webinarliv.com`, `applinks:www.webinarliv.com`. |
| Custom scheme | `webinarliv://webinars/<id>` opens `https://webinarliv.com/webinars/<id>` in the app. |
| Routing an opened link | The App plugin's `appUrlOpen` event (warm start) and `getLaunchUrl()` (cold start) feed `routeForOpenedUrl`, which accepts only our hosts and the custom scheme. The WebView then navigates there. |
| Native share sheet | The Android WebView has no `navigator.share`. Inside the app, the bridge backs it with `@capacitor/share`, so the site's existing Share buttons (invite panel, attendee link) open the system sheet. WKWebView's own `navigator.share` already opens the iOS sheet. |
| Push | `@capacitor/push-notifications` (FCM on Android, APNs on iOS). It asks for permission once, registers, and logs the token. A tapped notification with `data.url` opens that page. See "Push notifications". |
| Password AutoFill | `webcredentials:webinarliv.com`, so iOS offers saved webinarliv.com passwords at login. |
| Splash, status bar, icons | `@capacitor/splash-screen` and `@capacitor/status-bar`, with icons and splash screens generated by `@capacitor/assets`. |
| In-app marker | The user agent ends in `WebinarLivApp/1.0`, and `<html data-native-app="ios|android">`. `web/lib/device.ts` `isNativeAppUA` uses it so the registration form doesn't show "open this page in Chrome" inside our own app, and sends Gmail registrants the email link instead of Google OAuth (see Limits). |

### WebRTC in WKWebView

`getUserMedia` and `RTCPeerConnection` work in WKWebView since iOS 14.3, so LiveKit runs in
the app the same way it does in Safari: camera, mic, receiving video, simulcast. The limits:

- **No screen share from an iPhone or iPad.** `getDisplayMedia` isn't available in WKWebView.
  Sharing the device screen would need a ReplayKit Broadcast Upload Extension that publishes
  to LiveKit natively. That's out of scope. Attendees can still see a share from a desktop host.
- When the app goes to the background, WebKit pauses the camera and mutes the mic. Received
  audio keeps playing (background audio), but a speaker who locks the phone stops sending.
- Background blur, noise suppression and captions depend on WASM and WebGL performance and
  are slower on older phones.

## Push notifications

What exists: **Web Push** with VAPID (`api/internal/api/push.go`, `api/internal/push`). Browsers
subscribe with a PushSubscription and the tick sends queued `push_messages`. The API has **no
endpoint for native device tokens** (FCM registration token or APNs device token), so the app
registers, gets a token, logs it, and stops there.

Follow-up (backend, not in this change):
1. Add a `POST /api/push/native` endpoint that stores `{platform, token}` against the account or
   join key, plus a delete endpoint for sign-out.
2. Send to native tokens from `flushPush`: FCM HTTP v1 for Android, APNs (token-based, `.p8`)
   for iOS. Put `{"url": "/webinars/<id>"}` in the data payload, which the app already opens
   on tap.
3. In `web/lib/native-bridge.ts`, replace the `console.info` of the token with a call to that
   endpoint.

Setup the owner has to do:
- **Firebase (Android):** create a Firebase project, add an Android app with package
  `com.webinarliv.app`, and download `google-services.json`. Put it at
  `apps/mobile/android/app/google-services.json`. It's **gitignored and must not be
  committed**. For CI, store it base64-encoded as the secret `GOOGLE_SERVICES_JSON_BASE64`.
  Without it, the Gradle build skips the google-services plugin and the app keeps push off.
  `AppInfoPlugin` reports `pushConfigured: false`, and the bridge never calls `register()`,
  which would otherwise crash.
- **APNs (iOS):** in the Apple Developer account, create an APNs Auth Key (`.p8`). Note its Key
  ID and your Team ID. That key belongs to the backend sender (step 2), not to the app. The
  App ID needs the Push Notifications capability.

## Deep-link setup (placeholders)

Both files are served by Workers Assets straight from `web/public/.well-known/`, before the
Worker runs, so there are no www or http redirects on them. `web/public/_headers` gives both
`Content-Type: application/json` (the Apple file has no extension). Wrangler uploads
`.well-known` like any other asset directory. After deploying, check them:

```sh
curl -sI https://webinarliv.com/.well-known/apple-app-site-association   # 200, application/json
curl -sI https://webinarliv.com/.well-known/assetlinks.json              # 200, application/json
```

| Placeholder | File | Replace with |
|---|---|---|
| `<ANDROID_SHA256_CERT_FINGERPRINT>` | `web/public/.well-known/assetlinks.json` | The SHA-256 of the **app signing key** from Play Console, under Test and release, then App integrity, then App signing. Use the format `AB:CD:...`. If you also sideload builds signed with the upload key, add that key's SHA-256 too (`keytool -list -v -keystore upload.jks`). |
| `<APPLE_TEAM_ID>` (2 places) | `web/public/.well-known/apple-app-site-association` | Your 10-character Team ID (Developer account, then Membership). |

Then check: Android with `adb shell pm get-app-links com.webinarliv.app` (the domain should
show `verified`), iOS by long-pressing a `https://webinarliv.com/webinars/...` link in Notes.

## CI: `.github/workflows/mobile-build.yml`

Runs on manual dispatch, on pushes to `main` that touch `apps/mobile/**`, and on PRs that touch
those paths. It builds and uploads artifacts only. Nothing is published to a store.

| Job | Always | Only with secrets |
|---|---|---|
| android (ubuntu, JDK 21) | `assembleDebug` produces artifact **`webinarliv-android-debug`** (APK) | `bundleRelease` produces **`webinarliv-android-release`** (signed AAB) |
| ios (macos) | unsigned simulator build produces **`webinarliv-ios-simulator`** (zipped `App.app`) | archive and export produce **`webinarliv-ios-ipa`** |

Secrets (names only; set them under repo Settings, then Secrets and variables, then Actions):

| Secret | Used for |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | base64 of the Play **upload** keystore (`.jks`) |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias |
| `ANDROID_KEY_PASSWORD` | key password |
| `GOOGLE_SERVICES_JSON_BASE64` | optional: Firebase config, which enables Android push |
| `APPLE_TEAM_ID` | Team ID, needed for any signed iOS build |
| `IOS_DIST_CERT_P12_BASE64` | manual signing: Apple Distribution certificate (`.p12`) |
| `IOS_DIST_CERT_PASSWORD` | its export password |
| `IOS_PROVISIONING_PROFILE_BASE64` | App Store provisioning profile for `com.webinarliv.app` (with Push and Associated Domains) |
| `APP_STORE_CONNECT_API_KEY_ID` | instead of the three above, automatic signing |
| `APP_STORE_CONNECT_API_ISSUER_ID` | " |
| `APP_STORE_CONNECT_API_KEY_P8_BASE64` | " (base64 of `AuthKey_XXXX.p8`, App Manager role) |

Make the upload keystore once with `keytool -genkeypair -v -keystore upload.jks -keyalg RSA
-keysize 2048 -validity 10000 -alias upload`. Keep it safe and outside the repo. Enrol in
Play App Signing, so Google holds the app signing key, and put *that* key's SHA-256 in
`assetlinks.json`. CI sets the Android `versionCode` and the iOS build number to the run number.

**Direct APK download.** With the signing secrets, CI also builds a signed `app-release.apk`
(`assembleRelease`, artifact `webinarliv-android-apk`). Pushing a `mobile-v<version>` tag
builds with `versionName <version>` and publishes that APK to
`https://downloads.webinarliv.com/android/` and `latest.json` (see
[docs/downloads.md](../../docs/downloads.md)). Unsigned and debug APKs are never published.
The APK is signed with the upload key, not Play's app signing key, so add the upload key's
SHA-256 to `assetlinks.json` too for App Links to verify on sideloaded installs.

## What the owner must provide

1. **Apple:** Team ID. Register the App ID `com.webinarliv.app` with the Push Notifications and
   Associated Domains capabilities. Create an App Store Connect app record. Provide an Apple
   Distribution certificate and App Store provisioning profile, or an App Store Connect API key.
   Create an APNs Auth Key (`.p8`) for the push backend.
2. **Google:** a Play Console app for `com.webinarliv.app`, an upload keystore (plus its
   passwords and alias) enrolled in Play App Signing, the **app signing key's SHA-256** for
   `assetlinks.json`, and a Firebase project with an Android app, which gives
   `google-services.json`.
3. Replace the two placeholders in `web/public/.well-known/` and deploy the web app.
4. Store listings: name, subtitle, description, keywords, category (Business or Productivity),
   support URL, marketing URL, privacy policy URL (`https://webinarliv.com/privacy`),
   screenshots (6.9" and 6.5" iPhone, 13" iPad if iPad stays enabled, Android phone and 7"/10"
   tablet), a feature graphic (1024x500, Play), and an age rating questionnaire.

## Store submission checklist

**App Store guideline 4.2 (minimum functionality).** A plain website in a WebView gets rejected.
Say what the app adds in the review notes: push notifications (once the backend sends them),
Universal Links that open join links straight into the app, the native share sheet, background
audio with the screen locked, keep-awake during sessions, camera and mic for live sessions,
Password AutoFill, and an offline screen. More that would strengthen the case:
- **Native push actually sending** (the backend follow-up above). This is the biggest one:
  "your webinar is starting" notifications.
- Calendar: add a registered webinar to the device calendar with a native event.
- Picture-in-picture for the HLS player (works in WKWebView for `<video>`; check the site
  doesn't disable it).
- Sign in with Apple, which guideline 4.8 requires if Google sign-in is offered in the iOS app
  (see Limits).
- A native "Upcoming" home screen widget, or Live Activities for a running webinar.

**Guideline 3.1.1 (in-app purchase). Read this before you submit.** The site sells host plans
(Razorpay checkout, "See plans & buy" on the home page). On iOS, digital subscriptions bought
inside the app must use Apple IAP. To avoid that, the iOS app should hide pricing, plan
purchase and upgrade prompts when `isNativeApp()` (or the `WebinarLivApp` UA) is true.
Accounts are created and paid for on the web, and the app is for joining and hosting. That
isn't done in this change. Google Play's payments policy is similar for digital goods.

**Privacy (App Store "App Privacy" labels / Play "Data safety").** Declare at least: contact
info (name, email, phone at registration), user content (chat, Q&A, poll answers, audio and
video in sessions, recordings), identifiers (account ID; push token once it's sent), usage and
diagnostics (Google Analytics / Tag Manager, Grafana Faro errors and Web Vitals), and coarse
location (the API derives country and city from the IP for audience reports). Note what's
linked to the user and whether anything is used for tracking (GA). Both stores require
in-app account deletion if accounts can be created in the app. Check that the site's account
page offers it.

**Review notes.** Provide a demo account (email and password, not Google) that has an upcoming
or live webinar, plus steps: "Open the app, sign in, open My webinars, join." Mention the camera
and mic prompts and that screen share isn't available on iPhone. Don't create the account in
this repo. Make it in production and paste the credentials only into App Store Connect and
Play Console.

**Other items:** `ITSAppUsesNonExemptEncryption = false` is already set (HTTPS only). Fill in
the export compliance answers to match. Play needs the Android 13+ notification permission
declared (done) and a target API level that's current (36).

## Limits

- **Google sign-in.** Google refuses OAuth inside WebViews (`disallowed_useragent`), and
  `accounts.google.com` isn't an allowed host, so "Continue with Google" leaves for the system
  browser and the session ends up there, not in the app. Email and password, and email links,
  work. A Gmail address on the registration form gets the verification link inside the app.
  Follow-up: a native Google Sign-In (or ASWebAuthenticationSession) that hands a one-time code
  back through `webinarliv://`. If Google stays on iOS, add Sign in with Apple (guideline 4.8).
- **Zoom / Google Drive integrations** also use OAuth and have the same problem. Use them from a
  desktop browser.
- **No screen share from phones** (see WebRTC in WKWebView).
- **Android background:** without a foreground service (a media notification), Android can stop
  the WebView's audio after a while in the background, and the mic stops when the screen is off.
  A small foreground-service plugin would fix this.
- **Web Push inside the app** isn't available (neither WebView supports the Push API). The
  site's "Get a notification" and Settings, then Notifications, will report it unsupported until
  native push is wired to the backend.
- **Service worker on iOS:** WKWebView runs service workers only for App-Bound Domains, which
  aren't enabled. The site works without its service worker, and the app's own error page
  replaces its offline page.
- `allowNavigation` is documented by Capacitor as "not intended for production" for arbitrary
  hosts. Here it only lists our own domains, which is the intended use.
