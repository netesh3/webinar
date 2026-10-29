# Webinar Liv desktop (macOS and Windows)

An Electron shell around the live site, https://webinarliv.com. There is no
bundled copy of the web app: the window loads the site, so every web deploy
reaches the desktop app at once. This package is separate from `web/`.

```
apps/desktop/
  src/main.ts            app lifecycle, windows, single instance, deep links
  src/config.ts          start URL, which URLs are "the site", deep-link parsing
  src/security.ts        permissions, navigation rules, popups
  src/screen-picker.ts   getDisplayMedia handler + picker window
  src/preload.ts         window.webinarlivDesktop bridge, call detection, badge
  src/picker-preload.ts  bridge for the picker window
  src/power.ts           keep the display awake during a call
  src/updater.ts         electron-updater (GitHub Releases)
  src/menu.ts            native menus
  src/window-state.ts    remembered window size and position
  static/                picker and offline pages (local files, strict CSP)
  build/                 icons, macOS entitlements
  scripts/make-icons.sh  regenerates build/icon.{png,icns,ico}
  electron-builder.config.cjs
```

## Run and build

Node 22.

```sh
cd apps/desktop
npm ci
npm start                       # tsc, then electron . against webinarliv.com
WEBINARLIV_URL=https://staging.example.com npm start   # or --webinarliv-url=<url>
npm run typecheck

npm run pack:mac                # release/mac-arm64/Webinar Liv.app (no installer)
npm run dist:mac                # dmg + zip, arm64 and x64
npm run dist:win                # NSIS installer, x64 (run on Windows)
```

Artifacts land in `release/`:

| Platform | Files |
| --- | --- |
| macOS | `WebinarLiv-<version>-mac-arm64.dmg`, `WebinarLiv-<version>-mac-x64.dmg`, the same as `.zip`, `latest-mac.yml` |
| Windows | `WebinarLiv-<version>-win-x64.exe`, `latest.yml` |

The `.blockmap` files are for differential updates. The `.zip` and `latest*.yml`
files have to be in the release for auto-update to work.

CI: `.github/workflows/desktop-build.yml` builds both platforms on pull
requests and pushes to main that touch `apps/desktop/**`, and on manual runs,
and uploads the files as the `desktop-mac` and `desktop-windows` artifacts.

### Releasing

1. Bump `version` in `package.json` (and run `npm install` so the lock file follows).
2. Merge, then tag the merge commit `desktop-v<version>` and push the tag.
3. CI builds and creates a **draft** release with all the files. Check it and
   publish it. Installed apps pick it up on their next check.

electron-updater asks GitHub for the repo's *latest* release, so only publish
desktop releases as "latest" in this repo. A different kind of release marked
latest would break update checks until the next desktop release.

## Signing and notarization (to add later)

Nothing is signed today: the mac app is ad-hoc signed, the Windows installer is
unsigned. Add these repository secrets and the next build picks them up; with
none of them set the build stays unsigned.

macOS (Developer ID Application certificate, exported as .p12 then base64):

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

With `CSC_LINK` the app is signed with the hardened runtime and the
entitlements in `build/`; with the three `APPLE_*` as well it is notarized.

Windows (Azure Trusted Signing; the config hook is in `electron-builder.config.cjs`):

- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (service principal)
- `AZURE_TRUSTED_SIGNING_ENDPOINT` (e.g. `https://eus.codesigning.azure.net`)
- `AZURE_TRUSTED_SIGNING_ACCOUNT`
- `AZURE_TRUSTED_SIGNING_PROFILE`
- `AZURE_TRUSTED_SIGNING_PUBLISHER` (optional, the certificate's publisher name)

Until then, people see Gatekeeper's "cannot be opened" (right-click the app,
Open; or `xattr -cr "/Applications/Webinar Liv.app"`) and Windows SmartScreen's
"Windows protected your PC" (More info, Run anyway).

## How it works

### Navigation

- The site is `webinarliv.com`, every subdomain (so `recordings.webinarliv.com`),
  and the host of `WEBINARLIV_URL`. It stays in the app.
- Integration and payment flows stay in the app, because they must come back
  to the site with its cookies: `accounts.google.com` and
  `accounts.youtube.com` (Connect YouTube, the Drive picker), `zoom.us`
  (Connect Zoom), `razorpay.com` (checkout). Continue with Google is the
  exception: it runs in the system browser (see Sign-in).
- Every other link, and any `target=_blank` to another site, opens in the
  system browser (`http`, `https`, `mailto`, `tel` only).
- `window.open` of a site URL opens another app window (live rooms open in
  their own window, as they open in a new tab on the web). `about:blank`
  popups (the pop-out chat/panels, and the "open a blank tab, then point it at
  the room" pattern) are allowed. A popup that is not on the site (a payment
  3-D Secure page, for example) may move between https pages freely.
- A failed page load shows a local "Can't reach Webinar Liv" page with Try again.

### Sign-in

Email and password, and the email links, are normal pages in the window and
are unchanged.

**Continue with Google runs in the system browser** (29 Oct 2026). Google
refuses OAuth in embedded browsers, and the app used to get round that by
stripping `Electron/x` from its user agent so it looked like plain Chrome. It
no longer pretends. The round trip (`web/lib/app-auth.ts`,
`api/internal/api/auth_app.go`):

1. The sign-in page sees `window.webinarlivDesktop.openSignIn` and makes a
   random verifier, kept in the window's localStorage. It calls
   `openSignIn("/api/auth/google/start?app=desktop&challenge=<SHA-256 of the verifier>&next=…")`.
2. The main process opens that URL with `shell.openExternal`, and only that
   URL: a site page, path `/api/auth/google/start`, `app=desktop`
   (`isSignInStartUrl` in `src/config.ts`).
3. Google, then `/api/auth/google/callback`, in Chrome or Safari. The API sets
   **no** session there. It stores a one-time code (SHA-256 only, two
   minutes, one try) and sends the browser to `/auth/app-return#code=…`,
   which opens `webinarliv://auth/complete?code=…`. The browser asks before
   opening the app. The tab can be closed afterwards.
4. The app gets the link (`open-url` on macOS, `second-instance` on Windows),
   loads `https://webinarliv.com/auth/complete?code=…` in its window and takes
   focus. Only the code or an error word is carried over from the link.
5. That page POSTs the code and the verifier to `/api/auth/app/exchange`,
   which sets the normal session cookie in the app and returns where the
   sign-in was going.

Why it is safe: the session token is never in a URL. The code is, but it is
useless without the verifier, which never leaves the app's window. A code
that leaks from the browser history, or that another app registered for
`webinarliv://` catches, can't be redeemed. The first redemption attempt
spends a code, right verifier or wrong, and exchange is rate-limited
(10 a minute per IP).

The user agent is Electron's own plus `WebinarLivDesktop/<version>`. Pages can
also check `window.webinarlivDesktop`. The marker is deliberately not
`WebinarLivApp/`: that is the phone app's, and the iOS app hides purchases.
The desktop app keeps them.

Deploy the web app and the API before shipping a desktop build with this:
an older site doesn't know `openSignIn` and would run Google in the window,
where Google now refuses it.

Google One Tap uses an iframe, but the product no longer shows it. FedCM
isn't available in Electron, and the site already falls back when it is
missing.

### Security

- `contextIsolation`, `sandbox`, no `nodeIntegration`, no `<webview>`.
- Permissions are granted only to the site origin, and only: camera and
  microphone (`media`), screen share (`display-capture`), notifications,
  clipboard read and write, plus `fullscreen` (the video player) and
  `screen-wake-lock` (the live rooms keep the screen on). Everything else
  (geolocation, MIDI, USB, HID, serial, ...) is refused, and third-party
  iframes get nothing. On macOS the OS camera/microphone prompt comes first.
- The preload exposes `window.webinarlivDesktop` on site pages only:
  `isDesktop`, `platform`, `version`, `setCallActive(on)`, `setBadgeCount(n)`,
  `openSignIn(url)` (the main process opens only the site's Google sign-in
  start URL in the system browser).

### Screen sharing

Electron has no built-in picker, so `getDisplayMedia` goes through
`session.setDisplayMediaRequestHandler`. The app lists screens and windows
with `desktopCapturer` and shows them, with thumbnails and app icons, in a
small modal window (`static/picker.html`). On Windows, when the page asks for
audio, the picker also offers **Share system audio** (WASAPI loopback). This is
the whole system mix, so other people in the call can hear themselves if the
sharer is not on headphones; it is off by default. macOS has no system-audio
option.

macOS asks for Screen Recording permission the first time; the picker shows
a notice with a button to System Settings while it is missing. After granting
it, the app has to be restarted (macOS rule).

### Deep links

The app registers the `webinarliv://` scheme (in the installers and at run time).

| Link | Opens |
| --- | --- |
| `webinarliv://join/w/abc` | `https://webinarliv.com/w/abc` (path, query and hash kept) |
| `webinarliv://open?url=https://webinarliv.com/pricing` | that URL (site URLs only) |
| `webinarliv://open?path=/browse` | `https://webinarliv.com/browse` |
| `webinarliv://open` | the home page |
| `webinarliv://auth/complete?code=…` | `https://webinarliv.com/auth/complete?code=…`, the end of Continue with Google (see Sign-in) |

A `https://webinarliv.com/...` URL passed as a command-line argument opens too.

The app is single-instance. A link while it runs goes to the running window:
`open-url` on macOS, `second-instance` (with the arguments) on Windows. If the
window is in a call, the link opens in a new window rather than replacing the
call.

On macOS, links work once the app has been opened from /Applications once. On
Windows the NSIS installer registers the scheme.

### Calls and display sleep

While any window is in a call, the app holds
`powerSaveBlocker.start("prevent-display-sleep")`. A call is detected without
any web change: the preload watches for a held screen wake lock (the live
rooms take one, see `web/lib/wake-lock.ts`) or a live camera, microphone or
screen-share track. The page can also force it with
`window.webinarlivDesktop.setCallActive(true | false)`.

### Notifications and badge

Web `Notification`s show as OS notifications, and clicking one brings the
app forward. On Windows they appear under "Webinar Liv" (AppUserModelID
`com.webinarliv.desktop`). `navigator.setAppBadge(n)` /
`webinarlivDesktop.setBadgeCount(n)` set the dock badge on macOS.

### Auto-update

electron-updater with the GitHub Releases provider (`netesh3/webinar`, tags
`desktop-v*`). Off when running unpackaged (`npm start`) or with
`WEBINARLIV_DISABLE_UPDATES=1`. Checks 10 s after start and every 4 hours,
downloads in the background, installs on quit. "Check for Updates…" is in the
app menu (macOS) or Help menu (Windows).

## Icons

`build/icon.png` is `web/public/icons/icon-512.png` (the PWA icon), the largest
source in the repo. `scripts/make-icons.sh` makes the `.icns` (artwork inset
on Apple's grid, up to 512 px) and `.ico` (16 to 256 px) from it. A 1024x1024
master would give a sharper icon on Retina docks: run
`npm run icons -- /path/to/master-1024.png` and commit `build/`.

## Limits

- **Connect YouTube and the Drive picker** still run Google OAuth inside the
  window. With the honest user agent, Google may refuse them there
  (`disallowed_useragent`, or "This browser or app may not be secure"). Their
  callbacks need the app's session, so they can't simply move to the system
  browser. Until they get the same hand-off as sign-in (follow-up), connect
  YouTube from a browser at webinarliv.com. The connection is saved on the
  account, so the app uses it too. Connect Zoom (`zoom.us`) is unaffected.

- Web push from the service worker (`web/public/sw.js`) does not arrive:
  Electron has no push service. Notifications work while the app is open.
- The Windows taskbar has no badge count (macOS dock only).
- Windows arm64 has no native build; the x64 installer runs under emulation.
  Adding `arm64` to `win.target` makes one installer with both (twice the size).
- macOS updates only apply to a signed app, so auto-update starts working on
  macOS with the first signed release. Windows unsigned builds do update.
- Unsigned builds trip Gatekeeper and SmartScreen (see above).
