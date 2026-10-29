# Downloads: downloads.webinarliv.com

Installable packages (the desktop app for macOS and Windows, the Android APK) live in a
Cloudflare R2 bucket, `webinarliv-downloads`, served at **https://downloads.webinarliv.com**.
CI uploads them on release tags; the website's `/download` page reads `latest.json`.

This file is the contract between the publisher (`scripts/downloads/publish.mjs`, run by
`.github/workflows/desktop-build.yml` and `.github/workflows/mobile-build.yml`) and everything
that reads the bucket (the web page, the desktop auto-updater, people).

## Layout

```
latest.json                                       manifest, see below
desktop/<version>/WebinarLiv-<version>-mac-arm64.dmg
desktop/<version>/WebinarLiv-<version>-mac-x64.dmg
desktop/<version>/WebinarLiv-<version>-win-x64.exe
desktop/<version>/latest-mac.yml                  the update feed as built for <version>
desktop/<version>/latest.yml
desktop/latest/WebinarLiv-mac-arm64.dmg           copies of the current version
desktop/latest/WebinarLiv-mac-x64.dmg
desktop/latest/WebinarLiv-win-x64.exe
desktop/latest-mac.yml                            electron-updater feed (macOS)
desktop/latest.yml                                electron-updater feed (Windows)
desktop/WebinarLiv-<version>-mac-arm64.zip        update payloads named in the feed,
desktop/WebinarLiv-<version>-mac-x64.zip          with their .blockmap files
desktop/WebinarLiv-<version>-win-x64.exe
desktop/WebinarLiv-<version>-*.blockmap
android/<version>/WebinarLiv-<version>.apk
android/latest/WebinarLiv.apk
```

`<version>` is `major.minor.patch` (optionally `-prerelease`): the desktop version is
`apps/desktop/package.json`'s, the Android one comes from the `mobile-v<version>` tag.

### Headers

| Objects | Cache-Control |
| --- | --- |
| `latest.json`, `desktop/latest/*`, `android/latest/*` | `public, max-age=300` |
| `desktop/<version>/*`, `android/<version>/*`, `desktop/WebinarLiv-<version>-*` | `public, max-age=31536000, immutable` |
| `desktop/latest-mac.yml`, `desktop/latest.yml` | `no-cache` |

| Extension | Content-Type |
| --- | --- |
| `.dmg` | `application/x-apple-diskimage` |
| `.exe` | `application/vnd.microsoft.portable-executable` |
| `.apk` | `application/vnd.android.package-archive` |
| `.json` | `application/json` |
| `.zip` | `application/zip` |
| `.yml` | `text/yaml` |
| `.blockmap` | `application/octet-stream` |

Versioned objects are immutable. The publisher stores each one's sha256 as object metadata
(`x-amz-meta-sha256`, plus `version`, `released-at`, `signed`, and `version-code` for the
APK). Re-running a publish with the same files skips them; a different file under an
existing versioned key stops the run before anything is written. To ship a changed build,
bump the version.

## latest.json

```json
{
  "schema": 1,
  "updatedAt": "2026-10-29T10:00:00.000Z",
  "desktop": {
    "version": "0.1.0",
    "releasedAt": "2026-10-29T10:00:00.000Z",
    "signed": { "mac": false, "windows": false },
    "files": {
      "mac-arm64": { "url": "https://downloads.webinarliv.com/desktop/latest/WebinarLiv-mac-arm64.dmg", "size": 123456789, "sha256": "<64 hex>" },
      "mac-x64":   { "url": "https://downloads.webinarliv.com/desktop/latest/WebinarLiv-mac-x64.dmg",   "size": 123456789, "sha256": "<64 hex>" },
      "win-x64":   { "url": "https://downloads.webinarliv.com/desktop/latest/WebinarLiv-win-x64.exe",   "size": 123456789, "sha256": "<64 hex>" }
    }
  },
  "android": {
    "version": "0.1.0",
    "versionCode": 42,
    "releasedAt": "2026-10-29T10:00:00.000Z",
    "signed": true,
    "apk": { "url": "https://downloads.webinarliv.com/android/latest/WebinarLiv.apk", "size": 12345678, "sha256": "<64 hex>" }
  },
  "stores": { "appStore": null, "playStore": null, "testflight": null }
}
```

- `desktop` and `android` are `null` until the first release of each. Readers must handle
  `null`, and a missing `latest.json` (404) the same as all-`null`.
- `url`s point at the `latest/` copies; `size` is bytes; `sha256` is lowercase hex of the file.
- `releasedAt` is when that version was first published (a rollback keeps the original time);
  `updatedAt` is the last write of the file.
- `signed.mac`: built with a Developer ID certificate (`CSC_LINK` secret present).
  `signed.windows`: built with Azure Trusted Signing (all its secrets present). The page can
  show the Gatekeeper / SmartScreen instructions when they are `false`.
- `android.signed` is always `true`: unsigned or debug APKs are never published.
- `stores` holds store links from the repo variables `IOS_APP_STORE_URL` (`appStore`),
  `ANDROID_PLAY_STORE_URL` (`playStore`) and `IOS_TESTFLIGHT_URL` (`testflight`). A set
  variable overwrites the value; an unset one keeps what is there. Nothing clears a link
  (edit `latest.json` in the R2 dashboard to remove one).
- Each publish rewrites only its own section: it downloads `latest.json`, replaces
  `desktop` or `android`, and uploads it. Publish jobs in both workflows share the
  `downloads-publish` concurrency group, so they never write it at the same time.
- New fields may be added; readers should ignore unknown keys. A breaking change bumps
  `schema`.

## Desktop auto-update

The app uses electron-updater's **generic** provider with the feed URL
`https://downloads.webinarliv.com/desktop/` (`publish` in
`apps/desktop/electron-builder.config.cjs`, baked into the app as `app-update.yml`).

- The app fetches `desktop/latest-mac.yml` (macOS) or `desktop/latest.yml` (Windows), with
  a `?noCache=` query, and compares `version` with its own.
- Every `url:` / `path:` in those files is a bare file name, which the generic provider
  resolves against the feed URL, so the payloads (`.zip` on macOS, the `.exe` on Windows)
  are uploaded flat into `desktop/`. The publisher refuses a feed that names anything else.
- Differential updates fetch `<payload>.blockmap` and the previous version's blockmap by
  replacing the version in the file name, which the flat layout also satisfies.
- The feed files are written after every payload and installer is in place.

The GitHub draft release (`desktop-v<version>`) is still created as an archive, but
installed apps no longer read it: there is no automatic fallback to GitHub. If the bucket
ever had to be abandoned, a new build with the `github` provider in `publish` (or
`autoUpdater.setFeedURL` in `apps/desktop/src/updater.ts`) would be needed. Builds made
before this change (none were released) read GitHub Releases.

macOS only applies updates to a signed app, so mac auto-update starts with the first
signed release.

## Releasing

- **Desktop:** bump `apps/desktop/package.json`, merge, tag `desktop-v<version>`, push the
  tag. The `publish` job uploads after both builds succeed.
- **Android:** tag `mobile-v<version>` and push it. CI builds `versionName <version>`,
  `versionCode <run number>`, signs the APK (`assembleRelease`, next to the Play AAB),
  verifies the signature with `apksigner`, and the `publish-android` job uploads it. Without
  the Android signing secrets nothing is published.

Publishing is skipped with a notice when the R2 secrets are missing. The job summary shows
the resulting `latest.json`.

### Rolling back, or re-publishing a version

Every version stays in the bucket, so making an older one current is a copy:

1. Actions, then **Desktop build** (or **mobile-build**), then **Run workflow**, and set
   `promote_tag` to the version to restore, e.g. `desktop-v0.1.0` or `mobile-v0.1.0`.
2. The `promote` job (`publish.mjs promote-desktop` / `promote-android`) copies
   `desktop/<version>/*` to `desktop/latest/`, restores that version's `latest-mac.yml` and
   `latest.yml` as the feed, and rewrites that section of `latest.json` from the stored
   metadata. Nothing is rebuilt.

`latest/` and `latest.json` are cached for 5 minutes, so the change shows within that time
(purge `downloads.webinarliv.com` in the Cloudflare dashboard to make it immediate).
electron-updater does not downgrade, so apps already on the newer version stay there; the
rollback affects new downloads and apps older than the restored version. To get everyone
off a bad version, release a fixed higher version.

By hand, the same thing with the AWS CLI is `aws s3api copy-object` of each
`desktop/<version>/WebinarLiv-<version>-<target>.<ext>` to
`desktop/latest/WebinarLiv-<target>.<ext>`, the same for the two feed files, and an edited
`latest.json`; the workflow is easier and keeps the headers right.

## Setup (owner, once)

1. **Bucket.** Cloudflare dashboard, then R2, then Create bucket: `webinarliv-downloads`
   (location automatic). Leave public access off on the `r2.dev` URL.
2. **Custom domain.** In the bucket, Settings, then Custom Domains, then Connect Domain:
   `downloads.webinarliv.com` (the `webinarliv.com` zone must be on Cloudflare). Cloudflare
   creates the DNS record and certificate. This is what makes the bucket publicly readable,
   and Cloudflare's cache honours the `Cache-Control` headers above.
3. **API token.** R2, then Manage R2 API Tokens, then Create API token: permission
   **Object Read & Write**, applied to **the `webinarliv-downloads` bucket only**, no expiry
   (or note the date). Copy the Access Key ID and Secret Access Key; the account ID is on
   the R2 overview page.
4. **Secrets** (repo Settings, then Secrets and variables, then Actions, then Secrets):
   - `R2_DOWNLOADS_ACCOUNT_ID`: the Cloudflare account ID
   - `R2_DOWNLOADS_ACCESS_KEY_ID`
   - `R2_DOWNLOADS_SECRET_ACCESS_KEY`
5. **Variables** (optional, the Variables tab):
   - `R2_DOWNLOADS_BUCKET`, only if the bucket is not called `webinarliv-downloads`
   - `IOS_APP_STORE_URL`, `ANDROID_PLAY_STORE_URL`, `IOS_TESTFLIGHT_URL` once those exist
     (they reach `latest.json` on the next publish of either app)
6. **CORS** (only if the web page fetches `latest.json` from the browser rather than the
   server): in the bucket's Settings, add a CORS policy allowing `GET` from
   `https://webinarliv.com`.
7. **Release.** Push a `desktop-v<version>` tag (matching `apps/desktop/package.json`) and,
   with the Android signing secrets in place, a `mobile-v<version>` tag. Check
   `https://downloads.webinarliv.com/latest.json` afterwards.

## Running the publisher locally

```sh
node --test scripts/downloads/publish.test.mjs          # merge logic + a full publish/rollback against a temp dir

# Print the plan and the merged latest.json; writes nothing. Reads the real latest.json
# when the R2 credentials are in the environment, or --current-manifest <file>.
node scripts/downloads/publish.mjs desktop --version 0.1.0 --dir apps/desktop/release \
  --signed-mac false --signed-windows false --dry-run

# A local directory as the bucket (headers in <dir>/.meta/).
node scripts/downloads/publish.mjs android --version 0.1.0 --version-code 1 \
  --apk app-release.apk --signed true --fake-bucket /tmp/fake-bucket
```

Against the real bucket it needs `R2_DOWNLOADS_ACCOUNT_ID`, `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` (the R2 token) and the AWS CLI v2. `R2_DOWNLOADS_ENDPOINT`
overrides the S3 endpoint (a local S3 server for testing).
