# App signing setup (desktop and mobile)

Follow this on **your own Mac**, not the work Mac. It creates every signing key and secret for
the desktop app (`apps/desktop`, Electron) and the mobile apps (`apps/mobile`, Capacitor), then
stores them as GitHub Actions secrets in `netesh3/webinar`.

Rules for the whole runbook:

- Every secret goes from a file or the clipboard straight into `gh secret set`. Never `echo` or
  `cat` a secret to the terminal, and never paste one into a chat or an issue.
- Everything you create goes in `~/.webinarliv-signing` (mode 700, files 600). Back up each item
  to the password manager as you go. Section 8 covers what to keep and what to delete.
- Every `gh` command names the repo with `-R github.com/netesh3/webinar`.

Known values (not secret): Apple Team ID `GF5C6XT5S4` (Individual membership "Ganesh S P"),
iOS App ID `com.webinarliv.app` (Push Notifications and Associated Domains are on), Mac app ID
`com.webinarliv.desktop` (Developer ID, outside the App Store). The R2 download secrets are
already set.

---

## 0. Prerequisites

```sh
xcode-select --install                 # Xcode command line tools (skip if already installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"   # if brew is missing
brew install gh jq
brew install --cask temurin            # a JDK, for keytool
gh auth login                          # GitHub.com, HTTPS, log in as the account with admin on netesh3/webinar
gh secret list -R github.com/netesh3/webinar | head -3            # proves access

mkdir -p ~/.webinarliv-signing && chmod 700 ~/.webinarliv-signing
cd ~/.webinarliv-signing
umask 077                              # new files in this shell are 600
```

In the password manager, create one entry (for example "Webinar Liv app signing") with file
attachments enabled. Each section says what to add to it.

The commands below use `/usr/bin/openssl` (macOS's LibreSSL). It writes `.p12` files that
macOS's `security import` reads. If you use Homebrew's OpenSSL 3 instead, add `-legacy` to every
`openssl pkcs12 -export`, or the CI keychain import fails.

---

## 1. Mac: Developer ID Application certificate (signing and notarization)

Used by `.github/workflows/desktop-build.yml` and `apps/desktop/electron-builder.config.cjs`.

1. Make the private key and the certificate signing request:

   ```sh
   cd ~/.webinarliv-signing
   /usr/bin/openssl genrsa -out devid.key 2048
   /usr/bin/openssl req -new -key devid.key -out devid.csr \
     -subj "/emailAddress=ganesh.sp006@gmail.com/CN=Ganesh S P/C=IN"
   chmod 600 devid.key devid.csr
   ```

   Alternative: Keychain Access, then Keychain Access menu, then Certificate Assistant, then
   Request a Certificate From a Certificate Authority, "Saved to disk". The key then lives in
   your login keychain, and you export the `.p12` from Keychain Access (My Certificates, right
   click, Export) instead of step 4.

2. Upload the CSR: developer.apple.com, then Account, then Certificates, IDs & Profiles, then
   Certificates, then **+**. Choose **Developer ID Application**, Profile Type **G2 Sub-CA**
   (the default), upload `devid.csr`, Continue, Download. Move the downloaded
   `developerID_application.cer` into `~/.webinarliv-signing`. (check: UI may differ)

3. Get Apple's intermediate so the `.p12` has the full chain:

   ```sh
   curl -fsSLo DeveloperIDG2CA.cer https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
   /usr/bin/openssl x509 -inform DER -in developerID_application.cer -out devid.pem
   /usr/bin/openssl x509 -inform DER -in DeveloperIDG2CA.cer -out devid-g2ca.pem
   /usr/bin/openssl x509 -in devid.pem -noout -subject   # should name "Developer ID Application: Ganesh S P (GF5C6XT5S4)"
   ```

4. Make the `.p12` with a random password that is never printed:

   ```sh
   /usr/bin/openssl rand -base64 24 | tr -d '\n' > devid-p12.pass
   pbcopy < devid-p12.pass            # paste into the password manager now
   /usr/bin/openssl pkcs12 -export -inkey devid.key -in devid.pem -certfile devid-g2ca.pem \
     -name "Developer ID Application: Ganesh S P (GF5C6XT5S4)" \
     -out devid.p12 -passout file:devid-p12.pass
   /usr/bin/openssl pkcs12 -in devid.p12 -passin file:devid-p12.pass -noout && echo p12 ok
   ```

   Attach `devid.p12` to the password manager entry.

5. App-specific password for notarization: account.apple.com, then Sign-In and Security, then
   App-Specific Passwords, then **+**, name it `webinarliv-notarize`. Apple shows it once: use
   the copy button so it lands on the clipboard, save it to the password manager, and leave it
   on the clipboard for the next step. (check: UI may differ)

6. Set the secrets:

   ```sh
   base64 -i devid.p12 | gh secret set CSC_LINK -R github.com/netesh3/webinar
   gh secret set CSC_KEY_PASSWORD -R github.com/netesh3/webinar < devid-p12.pass
   pbpaste | gh secret set APPLE_APP_SPECIFIC_PASSWORD -R github.com/netesh3/webinar    # the app-specific password from step 5
   gh secret set APPLE_ID -R github.com/netesh3/webinar            # prompts; type the Apple ID email (hidden input)
   gh secret set APPLE_TEAM_ID -R github.com/netesh3/webinar --body GF5C6XT5S4
   pbcopy < /dev/null                   # clear the clipboard
   ```

   With `CSC_LINK` set the build is signed (hardened runtime); with the three `APPLE_*` too it
   is notarized. `APPLE_TEAM_ID` is shared with the iOS build.

---

## 2. iOS distribution signing

Used by the `ios` job in `.github/workflows/mobile-build.yml`. It needs `APPLE_TEAM_ID` (set in
section 1) plus **one** of the two paths below. If both are set, CI uses manual signing.

### 2a. App Store Connect API key (preferred)

1. appstoreconnect.apple.com, then Users and Access, then Integrations, then App Store Connect
   API, then Team Keys, then **Generate API Key** (or **+**). Name `webinarliv-ci`, Access
   **App Manager** (what `apps/mobile/README.md` says). (check: UI may differ; if Team Keys is
   not offered, request API access on that page first)
2. Note the **Key ID** (in the table) and the **Issuer ID** (above the table).
3. **Download API Key**. Apple lets you download it only once. Move `AuthKey_<KEYID>.p8` into
   `~/.webinarliv-signing` and attach it to the password manager entry.
4. Set the secrets:

   ```sh
   cd ~/.webinarliv-signing
   base64 -i AuthKey_<KEYID>.p8 | gh secret set APP_STORE_CONNECT_API_KEY_P8_BASE64 -R github.com/netesh3/webinar   # replace <KEYID>
   gh secret set APP_STORE_CONNECT_API_KEY_ID -R github.com/netesh3/webinar       # prompts; paste the Key ID
   gh secret set APP_STORE_CONNECT_API_ISSUER_ID -R github.com/netesh3/webinar    # prompts; paste the Issuer ID
   ```

   CI archives with `-allowProvisioningUpdates` and this key, so Xcode creates the distribution
   certificate and profile in the cloud. If the export step fails with a cloud signing or
   permission error, regenerate the key with the **Admin** role. (check: Apple's role
   requirements for cloud-managed distribution certificates)

### 2b. Certificate and provisioning profile (alternative)

1. Key and CSR, as in section 1:

   ```sh
   cd ~/.webinarliv-signing
   /usr/bin/openssl genrsa -out iosdist.key 2048
   /usr/bin/openssl req -new -key iosdist.key -out iosdist.csr \
     -subj "/emailAddress=ganesh.sp006@gmail.com/CN=Ganesh S P/C=IN"
   ```

2. developer.apple.com, then Certificates, then **+**, then **Apple Distribution**, upload
   `iosdist.csr`, download `distribution.cer` into `~/.webinarliv-signing`.
3. Profiles, then **+**, then Distribution **App Store Connect**, App ID `com.webinarliv.app`,
   pick the Apple Distribution certificate, name it `Webinar Liv App Store`, download
   `Webinar_Liv_App_Store.mobileprovision` into `~/.webinarliv-signing`. (check: UI may differ)
4. Build the `.p12` and set the secrets:

   ```sh
   curl -fsSLo AppleWWDRCAG3.cer https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer
   /usr/bin/openssl x509 -inform DER -in distribution.cer -out iosdist.pem
   /usr/bin/openssl x509 -inform DER -in AppleWWDRCAG3.cer -out wwdr-g3.pem
   /usr/bin/openssl rand -base64 24 | tr -d '\n' > iosdist-p12.pass
   pbcopy < iosdist-p12.pass          # into the password manager
   /usr/bin/openssl pkcs12 -export -inkey iosdist.key -in iosdist.pem -certfile wwdr-g3.pem \
     -out iosdist.p12 -passout file:iosdist-p12.pass

   base64 -i iosdist.p12 | gh secret set IOS_DIST_CERT_P12_BASE64 -R github.com/netesh3/webinar
   gh secret set IOS_DIST_CERT_PASSWORD -R github.com/netesh3/webinar < iosdist-p12.pass
   base64 -i Webinar_Liv_App_Store.mobileprovision | gh secret set IOS_PROVISIONING_PROFILE_BASE64 -R github.com/netesh3/webinar
   pbcopy < /dev/null
   ```

   The profile expires after a year, and it has to be regenerated whenever the App ID's
   capabilities change.

---

## 3. APNs key (iOS push)

1. developer.apple.com, then Certificates, IDs & Profiles, then **Keys**, then **+**. Name
   `webinarliv-apns`, tick **Apple Push Notifications service (APNs)**, Configure, environment
   **Sandbox & Production**, Save, Continue, Register. (check: UI may differ)
2. **Download** `AuthKey_<KEYID>.p8`. Apple lets you download it only once. Note the Key ID.
   Attach the file to the password manager entry.
3. Upload it to Firebase (after section 5 creates the project): Firebase console, then Project
   settings (gear), then **Cloud Messaging**, then Apple app configuration for
   `com.webinarliv.app`, then APNs Authentication Key, **Upload**. Give it the `.p8`, the Key ID
   and Team ID `GF5C6XT5S4`.

This key is **not** a GitHub secret. The API sends iOS push through FCM, and FCM uses this key
(PR #778, `api/internal/push/fcm.go`). See "Mismatches found".

---

## 4. Android upload keystore

Used by the `android` job in `.github/workflows/mobile-build.yml` and
`apps/mobile/android/app/build.gradle`.

1. Make the password and the keystore. keytool's default PKCS12 keystore uses one password for
   the store and the key, so both secrets get the same value:

   ```sh
   cd ~/.webinarliv-signing
   /usr/bin/openssl rand -base64 24 | tr -d '\n' > upload.pass
   pbcopy < upload.pass               # into the password manager
   keytool -genkeypair -v -keystore upload.jks -alias upload \
     -keyalg RSA -keysize 4096 -validity 10000 \
     -storepass:file upload.pass -keypass:file upload.pass \
     -dname "CN=Ganesh S P, O=Webinar Liv, L=Bengaluru, C=IN"
   ```

   Attach `upload.jks` to the password manager entry.

2. Set the secrets:

   ```sh
   base64 -i upload.jks | gh secret set ANDROID_KEYSTORE_BASE64 -R github.com/netesh3/webinar
   gh secret set ANDROID_KEYSTORE_PASSWORD -R github.com/netesh3/webinar < upload.pass
   gh secret set ANDROID_KEY_PASSWORD -R github.com/netesh3/webinar < upload.pass
   gh secret set ANDROID_KEY_ALIAS -R github.com/netesh3/webinar --body upload
   pbcopy < /dev/null
   ```

3. Print the upload key's SHA-256 (not secret):

   ```sh
   keytool -list -v -keystore upload.jks -alias upload -storepass:file upload.pass | grep 'SHA256:'
   ```

4. Play Console: create the app `com.webinarliv.app`, upload the first `app-release.aab` (CI
   artifact `webinarliv-android-release`) to a testing track, and accept **Play App Signing**.
   Then Test and release, then App integrity, then **App signing**, and copy the **App signing
   key certificate** SHA-256. (check: UI may differ)

5. Both fingerprints go in `assetlinks.json` (see "Filling the .well-known placeholders"). The
   Play build is signed with Google's app signing key; the APK on downloads.webinarliv.com is
   signed with the upload key.

**BACKUP.** Back up `upload.jks` and its password before anything else. With Play App Signing,
Google can reset a lost upload key (Play Console, App signing, "Request upload key reset"), but
that takes days, and until then you can't ship an update. The direct-download APK is signed with
this key, so a new key also means existing sideloaded installs can't update in place.

---

## 5. Firebase (push)

1. console.firebase.google.com: create a project (for example `webinarliv`), Analytics optional.
2. Add an **Android** app, package `com.webinarliv.app`. You can add the SHA-256 values from
   section 4 under Project settings, then Your apps. Download `google-services.json` into
   `~/.webinarliv-signing`.
3. Add an **iOS** app, bundle ID `com.webinarliv.app`, App Store ID optional. Download
   `GoogleService-Info.plist` into `~/.webinarliv-signing`. Then upload the APNs key
   (section 3, step 3).
4. Set the app config secrets. These files are not very secret, but they stay out of git:

   ```sh
   cd ~/.webinarliv-signing
   base64 -i google-services.json | gh secret set GOOGLE_SERVICES_JSON_BASE64 -R github.com/netesh3/webinar
   base64 -i GoogleService-Info.plist | gh secret set GOOGLE_SERVICE_INFO_PLIST_BASE64 -R github.com/netesh3/webinar   # read by mobile-build.yml after PR #778
   ```

5. Service account for the API's FCM sending: Project settings, then **Service accounts**, then
   Firebase Admin SDK, then **Generate new private key**, Generate key. Move the JSON into
   `~/.webinarliv-signing` as `fcm-sa.json`, then:

   ```sh
   gh secret set FCM_SERVICE_ACCOUNT_JSON -R github.com/netesh3/webinar < fcm-sa.json
   ```

   The API reads this as an env var (raw JSON or base64). `cloudrun-deploy.yml` passes it to
   the API from PR #778 on, so redeploy the API after setting it. Without it, the API stores app
   tokens but sends nothing to them, and logs `native push off` at boot. If the API moves to
   DigitalOcean, that deploy has to pass the same variable.

---

## 6. Windows: Azure Trusted Signing (optional)

Without these, the Windows installer is unsigned and SmartScreen warns. Names come from
`desktop-build.yml` and `electron-builder.config.cjs`. (check: Microsoft renamed parts of this
service and the portal, and individual identity validation is limited to some countries)

1. Azure portal: create a **Trusted Signing account** (resource group `webinarliv-signing`, a
   region such as East US). Its overview shows the **Account URI**, for example
   `https://eus.codesigning.azure.net`.
2. In the account: **Identity validation**, then New, Public, Individual (or Organization). Wait
   for approval.
3. **Certificate profiles**, then Create, **Public Trust**, link the validated identity. Note
   the profile name.
4. Microsoft Entra ID, then App registrations, then New registration (`webinarliv-signing-ci`).
   Note the **Application (client) ID** and **Directory (tenant) ID**. Certificates & secrets,
   then New client secret; copy the **Value** to the clipboard and the password manager.
5. Trusted Signing account, then Access control (IAM), then Add role assignment,
   **Trusted Signing Certificate Profile Signer**, to `webinarliv-signing-ci`.
6. Set the secrets:

   ```sh
   pbpaste | gh secret set AZURE_CLIENT_SECRET -R github.com/netesh3/webinar     # the client secret value from step 4
   pbcopy < /dev/null
   gh secret set AZURE_TENANT_ID -R github.com/netesh3/webinar                   # prompts
   gh secret set AZURE_CLIENT_ID -R github.com/netesh3/webinar                   # prompts
   gh secret set AZURE_TRUSTED_SIGNING_ENDPOINT -R github.com/netesh3/webinar --body https://eus.codesigning.azure.net   # your Account URI
   gh secret set AZURE_TRUSTED_SIGNING_ACCOUNT -R github.com/netesh3/webinar     # prompts; the account name
   gh secret set AZURE_TRUSTED_SIGNING_PROFILE -R github.com/netesh3/webinar     # prompts; the certificate profile name
   gh secret set AZURE_TRUSTED_SIGNING_PUBLISHER -R github.com/netesh3/webinar   # optional; the certificate subject CN, e.g. Ganesh S P
   ```

   Client secrets expire (default 6 months, max 24). Put the expiry date in the password manager.

---

## 7. Verify

```sh
gh secret list -R github.com/netesh3/webinar
```

Expect: `CSC_LINK CSC_KEY_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID`, one iOS
set (`APP_STORE_CONNECT_API_KEY_ID APP_STORE_CONNECT_API_ISSUER_ID
APP_STORE_CONNECT_API_KEY_P8_BASE64`, or `IOS_DIST_CERT_P12_BASE64 IOS_DIST_CERT_PASSWORD
IOS_PROVISIONING_PROFILE_BASE64`), `ANDROID_KEYSTORE_BASE64 ANDROID_KEYSTORE_PASSWORD
ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD`, `GOOGLE_SERVICES_JSON_BASE64
GOOGLE_SERVICE_INFO_PLIST_BASE64 FCM_SERVICE_ACCOUNT_JSON`, the `AZURE_*` set if you did
section 6, and the existing `R2_DOWNLOADS_*`.

Release (after PR #776, the downloads pipeline, is merged). The desktop tag must match
`apps/desktop/package.json` (currently `0.1.0`).

GitHub-hosted `macos-latest` is off until the repo variables `GITHUB_HOSTED_DESKTOP` /
`GITHUB_HOSTED_MOBILE` / `GITHUB_HOSTED_MACOS` are `true`. Until then this Mac builds the
signed macOS app, Android APK/AAB and iOS IPA, and `scripts/downloads/publish.mjs` uploads
through Wrangler OAuth (Windows is skipped with Azure Trusted Signing). Tags still mark the
version:

```sh
cd ~/Personal/webinar && git fetch origin && git checkout main && git pull
git tag desktop-v0.1.0 && git push origin desktop-v0.1.0
git tag mobile-v0.1.0  && git push origin mobile-v0.1.0
gh run list -R github.com/netesh3/webinar --limit 5
gh run watch -R github.com/netesh3/webinar                       # pick the Desktop build / mobile-build runs
```

Check the result:

```sh
curl -fsS https://downloads.webinarliv.com/latest.json | jq '{desktop: .desktop.version, signed: .desktop.signed, android: .android.version, android_signed: .android.signed}'
```

In the run logs, the Desktop build's "Signing environment" step prints `using CSC_LINK` etc.,
and the mac build logs notarization. On a Mac, check the downloaded build:

```sh
spctl -a -vvv -t install ~/Downloads/WebinarLiv-*.dmg    # "accepted, source=Notarized Developer ID"
```

For Android: `apksigner verify --print-certs WebinarLiv.apk` (from the Android SDK build-tools)
should show the upload key's SHA-256. iOS: the `webinarliv-ios-ipa` artifact exists on the
mobile-build run.

### Filling the .well-known placeholders

The Team ID and the SHA-256 fingerprints are not secret, so they go in through a small PR:

- `web/public/.well-known/apple-app-site-association`: replace `<APPLE_TEAM_ID>` (2 places)
  with `GF5C6XT5S4`.
- `web/public/.well-known/assetlinks.json`: replace `<ANDROID_SHA256_CERT_FINGERPRINT>` with
  both fingerprints, as `["<app signing key SHA-256>", "<upload key SHA-256>"]`, format
  `AB:CD:...`.

Print them:

```sh
keytool -list -v -keystore ~/.webinarliv-signing/upload.jks -alias upload \
  -storepass:file ~/.webinarliv-signing/upload.pass | grep 'SHA256:'      # upload key
# app signing key: Play Console, Test and release, App integrity, App signing
```

After the deploy:

```sh
curl -sI https://webinarliv.com/.well-known/apple-app-site-association   # 200, application/json
curl -s  https://webinarliv.com/.well-known/assetlinks.json | jq .
```

---

## 8. Cleanup

Keep in the password manager (these can't be downloaded again):

| Item | Why |
| --- | --- |
| `devid.p12` + its password | Developer ID signing; contains the private key |
| App-specific password | notarization |
| `AuthKey_<KEYID>.p8` (App Store Connect API) + Key ID + Issuer ID | iOS CI signing |
| `iosdist.p12` + password, profile (only if you used 2b) | iOS manual signing |
| `AuthKey_<KEYID>.p8` (APNs) + Key ID | iOS push through Firebase |
| `upload.jks` + its password, alias `upload` | every Android release |
| Azure client secret + its expiry date (if section 6) | Windows signing |

`google-services.json` and `GoogleService-Info.plist` can be downloaded again from Firebase.
Don't keep `fcm-sa.json`: if it's ever needed again, generate a new key and delete the old one
in Google Cloud console, IAM, Service accounts.

Once each kept item opens from the password manager, delete the local copies:

```sh
cd ~ && rm -rf ~/.webinarliv-signing
ls ~/Downloads | grep -iE 'authkey|\.cer$|\.p12$|mobileprovision|google-services|GoogleService|firebase-adminsdk'   # delete any leftovers
pbcopy < /dev/null
```

Then empty the Trash.

---

## Mismatches found

1. **APNs: direct vs through Firebase.** `apps/mobile/README.md` on `main` says the push backend
   sends to APNs itself with the `.p8` (and lists the APNs key under "the push backend"). PR #778
   changes this: the API sends through FCM HTTP v1 for both platforms, and the APNs key is
   uploaded into Firebase only. This runbook follows #778, so there is no APNs GitHub secret.
2. **`GOOGLE_SERVICE_INFO_PLIST_BASE64` and `FCM_SERVICE_ACCOUNT_JSON` exist only in PR #778.**
   On `main`, `mobile-build.yml` doesn't read the plist secret and `cloudrun-deploy.yml` doesn't
   pass the FCM secret. Setting them early is harmless; they take effect once #778 merges.
3. **Windows "signed" flag vs electron-builder.** In PR #776, `latest.json`'s `signed.windows` is
   true only when all six of `AZURE_TRUSTED_SIGNING_ENDPOINT/ACCOUNT/PROFILE` and
   `AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET` are set. `electron-builder.config.cjs` turns signing
   on with just the three `AZURE_TRUSTED_SIGNING_*` values (the other three are the
   credentials). In practice you set all six, so they agree. `AZURE_TRUSTED_SIGNING_PUBLISHER`
   is optional in both places.
4. **App Store Connect key role.** `apps/mobile/README.md` says App Manager. CI uses
   `-allowProvisioningUpdates` (cloud-managed signing), which may need Admin. See section 2a.
