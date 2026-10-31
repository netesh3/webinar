# Webinar Liv for Android and iOS

A [Capacitor 8](https://capacitorjs.com) app around the live site. The WebView loads
`https://webinarliv.com/login` (`server.url` in `capacitor.config.ts`), so each web deploy reaches
the apps immediately, without a store release. The app opens on the sign-in page, not the
marketing home: signed in, the site's gate (`web/lib/access.ts`) sends `/login` straight on to
the host dashboard (`/host`) or an attendee's `/my-webinars`. The native layer adds what a browser tab can't do:
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
    app/src/main/java/com/webinarliv/app/CallQos*.java       live-room FGS, Wi-Fi/CPU locks
  ios/App/                native iOS project (committed)
    App/AppDelegate.swift   audio session (background audio), APNs token hand-off
    App/Info.plist          UIBackgroundModes: audio, remote-notification, voip (CallKit)
    App/CallQosPlugin.swift live-room videoChat audio session
    App/App.entitlements    Associated Domains (Universal Links, webcredentials), aps-environment
web/                      (the site) pieces that only run inside the app
  lib/native-bridge.ts      deep links, push registration, share shim, keep-awake
  lib/app-auth.ts           Google sign-in through the system browser (see Sign-in)
  app/auth/app-return/      the system browser's hand-back page; app/auth/complete/ redeems it
  lib/app-connect.ts        Connect Zoom / YouTube and the Drive picker the same way (see Connecting integrations)
  app/connect/              app-return/ (system browser), complete/ (WebView), drive/ (the Picker, system browser)
  components/native-boot.tsx  mounts it from app/layout.tsx (NativeSessionSync: push token per account)
  components/ios-app.tsx    the iOS app's no-purchase rule (see guideline 3.1.1)
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
| Site only, other links outside | `server.allowNavigation` is `webinarliv.com` and `*.webinarliv.com` (e.g. `recordings.webinarliv.com`). Capacitor opens every other top-level navigation in the system browser. Same-origin rooms (`openRoomTab`, Instant webinar, Go live, Join / Rejoin `target=_blank`) stay in the WebView; Zoom / WhatsApp still leave. |
| Error / offline page | `www/index.html`, shown through `server.errorPath` when the site doesn't load. It reloads when the connection comes back. |
| Camera and mic (LiveKit WebRTC) | **Android:** CAMERA, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS, INTERNET (plus BLUETOOTH_CONNECT for headsets) in the manifest. Capacitor's `BridgeWebChromeClient.onPermissionRequest` already asks for the matching runtime permission and then grants the WebView request, so the app adds no custom WebChromeClient. **iOS:** NSCameraUsageDescription and NSMicrophoneUsageDescription. Capacitor's WKUIDelegate grants `requestMediaCapturePermissionFor`, so the user sees only the OS prompt. Capacitor already sets `allowsInlineMediaPlayback = true` and `mediaTypesRequiringUserActionForPlayback = []`. |
| Background audio | iOS: `UIBackgroundModes` includes `audio`, and AppDelegate sets the `.playback` audio-session category at launch. While a live room is open, `CallQosPlugin` switches to `.playAndRecord` / `.videoChat` so routing matches a video call. Android: `CallQosService` is a `mediaPlayback` foreground service (persistent "In a live webinar" notification) so the OS does not treat the WebView as a background tab. |
| Keep screen awake | `@capacitor-community/keep-awake`, switched on for `/webinars/*/room`, `/host/*/room` and recording pages, and off everywhere else (`keepsScreenAwake` in `web/lib/native-bridge.ts`). The same path also calls `CallQos.setActive` (Wi-Fi low-latency lock, CPU wake lock, high-bandwidth `requestNetwork` on Android; videoChat session on iOS). |
| Call QoS | Native `CallQos` plugin. Android also raises the WebView renderer to `RENDERER_PRIORITY_IMPORTANT` for the room. Capture stays 720p on phones (thermal); publish bitrate and subscribe density are the site's LiveKit defaults (`web/lib/network.ts`). |
| App Links / Universal Links | Join and webinar URLs (`/webinars/*`, `/w/*`, `/host/*`, `/recordings*`, `/my-webinars*`, `/verify-email*`, `/reset-password*`) on `webinarliv.com` and `www` open the app. The intent filter has `autoVerify`. Entitlements: `applinks:webinarliv.com`, `applinks:www.webinarliv.com`. |
| Custom scheme | `webinarliv://webinars/<id>` opens `https://webinarliv.com/webinars/<id>` in the app. |
| Routing an opened link | The App plugin's `appUrlOpen` event (warm start) and `getLaunchUrl()` (cold start) feed `routeForOpenedUrl`, which accepts only our hosts and the custom scheme. The WebView then navigates there. |
| Native share sheet | The Android WebView has no `navigator.share`. Inside the app, the bridge backs it with `@capacitor/share`, so the site's existing Share buttons (invite panel, attendee link) open the system sheet. WKWebView's own `navigator.share` already opens the iOS sheet. |
| Push | `@capacitor-firebase/messaging`: an FCM token on both platforms (FCM reaches iOS through APNs). It asks for permission once, sends the token to `POST /api/push/native` for the signed-in account, and drops it on sign-out. A tapped notification opens its `data.url`. See "Push notifications". |
| Google sign-in | In the system browser through `@capacitor/browser` (SFSafariViewController on iOS, Custom Tabs on Android), handed back through `webinarliv://auth/complete`. See "Sign-in". |
| Connect Zoom / YouTube, Drive picker | The same browser, with a one-time ticket, handed back through `webinarliv://connect/complete` (or `webinarliv://connect/picked` for Drive, which only closes the sheet). See "Connecting integrations". |
| Password AutoFill | `webcredentials:webinarliv.com`, so iOS offers saved webinarliv.com passwords at login. |
| Splash, status bar, icons | `@capacitor/splash-screen` and `@capacitor/status-bar`, with icons and splash screens generated by `@capacitor/assets`. |
| In-app marker | The user agent ends in `WebinarLivApp/1.0`, and `<html data-native-app="ios|android">`. `web/lib/device.ts` `isNativeAppUA` uses it so the registration form doesn't show "open this page in Chrome" inside our own app, and sends Gmail registrants the email link instead of Google OAuth. `isIOSAppUA` and `<html data-ios-app>` (set before paint) mark the iOS app, which sells nothing (see guideline 3.1.1). The desktop app sends `WebinarLivDesktop/` instead, so it isn't caught by either. |

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

## Sign-in

Email and password, and the email links (verify, reset), run in the WebView and are unchanged.

**Continue with Google goes through the system browser** (29 Oct 2026). Google refuses OAuth
inside WebViews (`disallowed_useragent`), and before this the session ended up in Safari or
Chrome instead of the app. The round trip (`web/lib/app-auth.ts`, `api/internal/api/auth_app.go`):

1. The sign-in page makes a random verifier, keeps it in the WebView's localStorage, and opens
   `/api/auth/google/start?app=ios|android&challenge=<SHA-256 of the verifier>&next=…` with
   `@capacitor/browser`: SFSafariViewController on iOS, a Custom Tab on Android. Google allows
   both. A build without the Browser plugin loads the start URL in the WebView instead;
   Capacitor then hands the Google page to the system browser, and the rest is the same.
2. Google, then `/api/auth/google/callback`, in that browser. The API sets **no** session
   there. It stores a one-time code (SHA-256 only, two minutes, one try) and sends the browser
   to `/auth/app-return#code=…`, which opens `webinarliv://auth/complete?code=…`.
3. The App plugin's `appUrlOpen` fires, the bridge closes the Safari sheet (`Browser.close()`,
   iOS) and loads `/auth/complete?code=…` in the WebView.
4. That page POSTs the code and the verifier to `/api/auth/app/exchange`. The API sets the
   normal session cookie in the WebView and returns where the sign-in was going.

The session token is never in a URL. The code is, but without the verifier, which never leaves
the WebView, it can't be redeemed. That covers a code caught from the browser's history or by
another app that registered `webinarliv://`. The first attempt spends a code, right verifier or
wrong. Exchange is rate-limited (10 a minute per IP), and codes expire after two minutes.

The registration form still sends a Gmail registrant inside the app to the email link rather
than to Google. That's unchanged and could move to the hand-off later.

**Apple guideline 4.8 (Sign in with Apple).** Google sign-in stays in the iOS app, so App Review
may ask for Sign in with Apple as an equivalent option. The owner has chosen to keep Google
without it for now. If review raises it, adding Sign in with Apple is the fix.

## Connecting integrations

**Connect Zoom, Connect YouTube and the Drive picker go through the system browser too**
(29 Oct 2026). Their OAuth leaves the WebView, and their callbacks used to look for the session
cookie, which is in the WebView, not in Safari or Chrome. The round trip
(`web/lib/app-connect.ts`, `api/internal/api/app_connect.go`):

1. The page, signed in, POSTs `/api/host/integrations/{zoom|youtube|drive}/app-ticket` and gets
   a start URL with a one-time ticket (32 random bytes, SHA-256 only, two minutes, one use,
   bound to the account and the provider). It opens it with `@capacitor/browser`.
2. `/api/integrations/{provider}/app-start` spends the ticket, signs the usual OAuth state with
   the account, the app and the attempt, and goes to Zoom or Google.
3. The callback connects nothing in that browser. It needs the state cookie the start route set
   there, parks the provider's authorization code (sealed, two minutes, once) and sends the
   browser to `/connect/app-return#code=…`, which opens `webinarliv://connect/complete?code=…`.
4. `appUrlOpen` fires, the bridge closes the Safari sheet (iOS) and loads
   `/connect/complete?code=…` in the WebView. That page POSTs the code to
   `/api/host/integrations/app/complete`. Only if the WebView's session is the ticket's account
   does the API exchange the code and store the tokens, as the web callback does. The page then
   goes back to Settings, Integrations (or wherever the connect started) showing Connected.

**Drive picker.** In a room, "Pick from Drive" mints a drive ticket and opens it the same way.
The start route sets a short, HttpOnly pick cookie and shows `/connect/drive`, where Google's
sign-in and Picker run with the browser's own Google session. The file and Google's short read
token go to the API, and the page opens `webinarliv://connect/picked`: the bridge only closes
the sheet, it doesn't navigate (`handOffReturn` in `web/lib/native-bridge.ts`). The room stays
live, polls for the pick with its session, collects it once and copies the file in. Sharing a
video file needs `captureStream`, which WKWebView lacks, so in practice this is Android's.

No session and no OAuth token is ever in a URL. A ticket is single use, expires in two minutes
and is rate-limited (20 a minute per IP, 30 an hour per account). A forwarded ticket link can't
connect somebody else's Zoom to the sender's account: the completion code lands in the clicker's
own app, whose session is not the ticket's account, and is spent there.

## Push notifications

**Design.** One sender for both platforms: Firebase Cloud Messaging HTTP v1
(`api/internal/push/fcm.go`). The app uses `@capacitor-firebase/messaging`, which gives an FCM
registration token on iOS as well as Android. FCM delivers to iOS through APNs, with the APNs
key uploaded into the Firebase project, so the API holds one credential and never talks to
APNs itself.

- **Tokens.** `POST /api/push/native {platform, token, appVersion}` (signed in) stores the
  install against the account in `native_push_tokens` (migration 0174), unique on the token, so
  the same install signing in as somebody else moves to them. The bridge sends it when it gets a
  token, when Firebase rotates it, after any sign-in (`NativeSessionSync` in
  `components/native-boot.tsx` watches the session), and once a day. `DELETE /api/push/native`
  runs just before sign-out (`signOut` in `components/providers.tsx`).
- **Sending.** The same outbox as Web Push. Every fan-out (starting now, 15-minute reminder,
  replay ready, lobby knock, approvals, recap ready, recording expiry, test) writes a
  `push_messages` row per install next to the row per browser, with the same dedupe key, TTL,
  per-account opt-outs (Settings, Notifications) and retries. The tick sends both channels.
  `data.url` is the absolute site URL, and the app opens it on tap.
- **Outcomes.** FCM's `UNREGISTERED` or `SENDER_ID_MISMATCH` (or a malformed-token 400)
  deletes the token and what was queued for it. 429 and 5xx back the token off, as for a
  browser endpoint. Other 4xx, including `THIRD_PARTY_AUTH_ERROR` (the APNs key in Firebase is
  missing or wrong), drop that message.
- **Credential.** Preferred: `FCM_PROJECT_ID` with no key file. The API asks the Cloud Run
  metadata server for the runtime service account's token with the `firebase.messaging` scope
  and caches it until a minute before it expires. The fallback is a service account JSON key in
  `FCM_SERVICE_ACCOUNT_JSON`, which wins when both are set. The boot log says which one is in
  use (`native push enabled ... credential=metadata_server` or `service_account_json`).
- **Off by default.** With neither set, the API logs once at boot that native push is off.
  Tokens are still stored, and nothing is queued for them. A key that doesn't parse is logged
  and treated as unset, so it can't stop the API from booting.

**Setup the owner has to do:**

1. **Firebase project.** Create one (or reuse one). Add an **Android app** with package
   `com.webinarliv.app` and download `google-services.json`. Add an **iOS app** with bundle ID
   `com.webinarliv.app` and download `GoogleService-Info.plist`. Both are gitignored and must
   not be committed:
   - Local builds: put them at `android/app/google-services.json` and
     `ios/App/App/GoogleService-Info.plist`. The App target's "Copy Firebase config" build
     phase bundles the plist when it's there. Without it the app builds and push stays off.
   - CI (`.github/workflows/mobile-build.yml`): store them base64-encoded as the repo secrets
     `GOOGLE_SERVICES_JSON_BASE64` and `GOOGLE_SERVICE_INFO_PLIST_BASE64`.
2. **APNs key into Firebase, and the same key on the API for VoIP.** In the Apple Developer account, create an APNs Auth Key (`.p8`,
   under Keys, with Apple Push Notifications service). In Firebase, go to Project settings,
   then Cloud Messaging, then Apple app configuration, and upload the `.p8` with its Key ID and
   your Team ID. The App ID needs the Push Notifications capability. Alert push still goes
   through FCM. Incoming-call VoIP is sent by the API straight to APNs, so the same `.p8`
   is also the Cloud Run / GitHub secrets `APNS_KEY_P8`, `APNS_KEY_ID`, and
   `APNS_TEAM_ID=GF5C6XT5S4`. Info.plist `UIBackgroundModes` includes `voip`.
3. **Credential for the API: the Cloud Run identity, no key download.** Firebase lives in the
   API's own GCP project (`selfreminder-rnix`), and the Cloud Run runtime service account
   (`65278594492-compute@developer.gserviceaccount.com`) holds
   `roles/firebasecloudmessaging.admin` there. Set the repo **variable** (not a secret)
   **`FCM_PROJECT_ID=selfreminder-rnix`** and deploy. `.github/workflows/cloudrun-deploy.yml`
   passes it to the API (`deploy/cloudrun-deploy.sh`), and the boot log says
   `native push enabled` with `credential=metadata_server`.
   - Fallback, for a Firebase project outside the API's GCP project: in Firebase, go to Project
     settings, then Service accounts, and click Generate new private key. Store the whole JSON
     file as the repo secret `FCM_SERVICE_ACCOUNT_JSON`, as is or base64-encoded. It wins over
     `FCM_PROJECT_ID` when both are set.
4. Check it: sign in on a phone, then use Settings, then Notifications, then Send test
   notification. That queues one notification to every browser and install of the account.

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
| `GOOGLE_SERVICE_INFO_PLIST_BASE64` | optional: Firebase config, which enables iOS push |
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
   Create an APNs Auth Key (`.p8`) and upload it into Firebase (see Push notifications).
2. **Google:** a Play Console app for `com.webinarliv.app`, an upload keystore (plus its
   passwords and alias) enrolled in Play App Signing, the **app signing key's SHA-256** for
   `assetlinks.json`, and a Firebase project with an Android and an iOS app, which gives
   `google-services.json` and `GoogleService-Info.plist`. The API sends with its Cloud Run
   identity once the `FCM_PROJECT_ID` repo variable is set; no service account key is needed.
3. Replace the two placeholders in `web/public/.well-known/` and deploy the web app.
4. Store listings: name, subtitle, description, keywords, category (Business or Productivity),
   support URL, marketing URL, privacy policy URL (`https://webinarliv.com/privacy`),
   screenshots (6.9" and 6.5" iPhone, 13" iPad if iPad stays enabled, Android phone and 7"/10"
   tablet), a feature graphic (1024x500, Play), and an age rating questionnaire.

## Store submission checklist

**App Store guideline 4.2 (minimum functionality).** A plain website in a WebView gets rejected.
Say what the app adds in the review notes: push notifications (FCM, once the Firebase setup
above is done),
Universal Links that open join links straight into the app, the native share sheet, background
audio with the screen locked, keep-awake during sessions, camera and mic for live sessions,
Password AutoFill, and an offline screen. More that would strengthen the case:
- **Native push sending in production** (the Firebase setup above). This is the biggest one:
  "your webinar is starting" notifications.
- Calendar: add a registered webinar to the device calendar with a native event.
- Picture-in-picture for the HLS player (works in WKWebView for `<video>`; check the site
  doesn't disable it).
- Sign in with Apple, which guideline 4.8 may require because Google sign-in is offered in the
  iOS app (see Sign-in).
- A native "Upcoming" home screen widget, or Live Activities for a running webinar.

**Guideline 3.1.1 (in-app purchase). Done in the site, iOS only** (29 Oct 2026). Digital
subscriptions sold inside an iOS app must use Apple's In-App Purchase, and guideline 3.1.3 and
the anti-steering rules limit pointing people to buy elsewhere. So the iOS app sells nothing and
doesn't say where to buy. Accounts are paid for on the web; the app is for joining and hosting.
Inside the iOS app (`isIOSAppUA` / Capacitor's platform, `<html data-ios-app>` set before paint,
`components/ios-app.tsx`):

- The top nav's Pricing and Features items are hidden, and `/pricing`, `/pricing/proposed` and
  `/features` show only "Plan changes aren't available in the app."
- The pricing section (plan cards, Buy and trial buttons, checkout and trial dialogs) and the
  home page's "See plans & buy" buttons, buy pill and payment lines are hidden, along with the
  FAQ answers about paying.
- The sales chat widget is hidden.
- In the host portal, the host-request card's "Buy a plan" buttons and the billing card's "See
  plans" are replaced by the neutral sentence. The overdue line no longer points to the payment
  email, and the recording-storage "upgrade" links are removed. Cancel stays, because it buys
  nothing.
- Razorpay checkout refuses to open (a backstop behind the hidden UI).

None of it links out or says "buy on our website". **Android and the desktop app keep purchasing
as on the web.** Google Play's payments policy also covers digital goods, so revisit that before
a Play release if checkout should stay there.

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

- **Connecting YouTube from inside a live room** (the room's Stream to YouTube) loads
  `/connect/complete` in the WebView to finish, which leaves the room; the page then goes back
  to it. Connecting from Settings first avoids that.
- **No screen share from phones** (see WebRTC in WKWebView).
- **Android background:** a live room starts `CallQosService` (media-playback FGS). That keeps
  the process in the foreground bucket and holds Wi-Fi / CPU locks, but the mic still stops
  when the screen is off (WebView capture pause), and a forced-stop kills the call. Battery
  and cellular use go up for the session — that is the Zoom-like trade.
- **Web Push inside the app** isn't available (neither WebView supports the Push API); the app
  uses native push instead (see Push notifications). The site's browser opt-ins ("Get a
  notification") still report Web Push unsupported inside the app.
- **Service worker on iOS:** WKWebView runs service workers only for App-Bound Domains, which
  aren't enabled. The site works without its service worker, and the app's own error page
  replaces its offline page.
- `allowNavigation` is documented by Capacitor as "not intended for production" for arbitrary
  hosts. Here it only lists our own domains, which is the intended use.
