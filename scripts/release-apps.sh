#!/usr/bin/env bash
#
# Pull origin/main, bump native versions, build signed Mac / iOS / Android on this
# Mac, publish Mac + Android APK to downloads.webinarliv.com, upload the IPA to
# TestFlight. Windows is GitHub Actions (pass --windows once the desktop version
# is on origin/main). Does not submit App Review or Play review.
#
#   ./release-apps.sh
#   ./release-apps.sh --only mac --only android
#   ./release-apps.sh --skip-pull --skip-bump --desktop-version 0.1.5
#   ./release-apps.sh --dry-run
#
# Signing material: ~/.webinarliv-signing (see docs/app-signing-setup.md).
# Wrangler: profile "webinarliv" on the company Cloudflare account.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

if [[ -t 1 ]]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else
  B=""; G=""; Y=""; R=""; D=""; N=""
fi

step() { printf '%s▸ %s%s\n' "$B" "$1" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
note() { printf '    %s%s%s\n' "$D" "$1" "$N"; }
die()  { printf '  %s✗%s %s\n' "$R" "$N" "$1" >&2; exit 1; }

usage() {
  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
  cat <<'EOF'

Options:
  --yes                         skip the 5s confirmation
  --dry-run                     print the plan and exit
  --skip-pull                   do not git fetch/pull
  --skip-bump                   keep apps/desktop/package.json; still pick unused store build numbers
  --skip-build                  publish artifacts already on disk
  --skip-publish                build only
  --windows                     after a successful Mac publish, run Desktop build with publish_windows
  --only mac|android|ios|windows   repeatable; default is mac, android, ios
  --desktop-version X.Y.Z
  --android-version X.Y.Z
  --android-code N
  --ios-version X.Y.Z
  --ios-build N
  -h, --help
EOF
}

# --------------------------------------------------------------------------- flags

YES=0
DRY=0
SKIP_PULL=0
SKIP_BUMP=0
SKIP_BUILD=0
SKIP_PUBLISH=0
DO_WINDOWS=0
ONLY=()
DESKTOP_VERSION_FLAG=""
ANDROID_VERSION_FLAG=""
ANDROID_CODE_FLAG=""
IOS_VERSION_FLAG=""
IOS_BUILD_FLAG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) YES=1 ;;
    --dry-run) DRY=1 ;;
    --skip-pull) SKIP_PULL=1 ;;
    --skip-bump) SKIP_BUMP=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --skip-publish) SKIP_PUBLISH=1 ;;
    --windows) DO_WINDOWS=1 ;;
    --only)
      [[ $# -ge 2 ]] || die "--only needs mac, android, ios, or windows"
      ONLY+=("$2"); shift
      ;;
    --desktop-version) DESKTOP_VERSION_FLAG="${2:-}"; shift ;;
    --android-version) ANDROID_VERSION_FLAG="${2:-}"; shift ;;
    --android-code) ANDROID_CODE_FLAG="${2:-}"; shift ;;
    --ios-version) IOS_VERSION_FLAG="${2:-}"; shift ;;
    --ios-build) IOS_BUILD_FLAG="${2:-}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

want() {
  local p="$1"
  if [[ ${#ONLY[@]} -eq 0 ]]; then
    [[ "$p" == "windows" ]] && return 1
    return 0
  fi
  local x
  for x in "${ONLY[@]}"; do
    [[ "$x" == "$p" ]] && return 0
  done
  return 1
}

# --------------------------------------------------------------------------- constants (not secret)

SIGNING="${WEBINARLIV_SIGNING:-$HOME/.webinarliv-signing}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-GF5C6XT5S4}"
ASC_KEY_ID="${ASC_KEY_ID:-5NML5Y5293}"
ASC_ISSUER="${ASC_ISSUER:-8ccaa106-0a87-464d-b869-a1df8baa669e}"
IOS_BUNDLE="com.webinarliv.app"
IOS_PROFILE_NAME="${IOS_PROFILE_NAME:-Webinar Liv App Store}"
WRANGLER_PROFILE="${WRANGLER_PROFILE:-webinarliv}"
CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-cb9814264e4657f60ee8961f546c6a0e}"
DOWNLOADS_BASE_URL="${DOWNLOADS_BASE_URL:-https://downloads.webinarliv.com}"
R2_DOWNLOADS_BUCKET="${R2_DOWNLOADS_BUCKET:-webinarliv-downloads}"
ANDROID_KEY_ALIAS="${ANDROID_KEY_ALIAS:-upload}"
ASC_P8="$SIGNING/AuthKey_${ASC_KEY_ID}.p8"
DEVID_P12="$SIGNING/devid.p12"
DEVID_PASS="$SIGNING/devid-p12.pass"
UPLOAD_JKS="$SIGNING/upload.jks"
UPLOAD_PASS="$SIGNING/upload.pass"

export WRANGLER_PROFILE CLOUDFLARE_ACCOUNT_ID R2_DOWNLOADS_BUCKET DOWNLOADS_BASE_URL
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# --------------------------------------------------------------------------- helpers

semver_ok() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; }

bump_patch() {
  python3 -c 'import sys; a,b,c=sys.argv[1].split(".",2); c=c.split("-",1)[0]; print(f"{a}.{b}.{int(c)+1}")' "$1"
}

max_version() {
  printf '%s\n' "$@" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+' | sort -V | tail -n 1
}

need_file() { [[ -f "$1" ]] || die "missing $1"; }

curl_json() {
  curl -fsS -A 'Mozilla/5.0' "$@"
}

# App Store Connect JWT (ES256). Token is written to stdout; callers must not log it.
asc_token() {
  ASC_P8="$ASC_P8" ASC_KEY_ID="$ASC_KEY_ID" ASC_ISSUER="$ASC_ISSUER" node -e '
const { createPrivateKey, sign } = require("crypto");
const fs = require("fs");
const key = createPrivateKey(fs.readFileSync(process.env.ASC_P8));
const now = Math.floor(Date.now() / 1000);
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const h = b64({ alg: "ES256", kid: process.env.ASC_KEY_ID, typ: "JWT" });
const p = b64({ iss: process.env.ASC_ISSUER, iat: now, exp: now + 600, aud: "appstoreconnect-v1" });
const s = sign("sha256", Buffer.from(h + "." + p), { key, dsaEncoding: "ieee-p1363" });
process.stdout.write(h + "." + p + "." + s.toString("base64url"));
'
}

asc_get() {
  local path="$1" token="$2"
  curl -fsSg "https://api.appstoreconnect.apple.com${path}" \
    -H "Authorization: Bearer ${token}" -H "Accept: application/json"
}

set_desktop_version() {
  local ver="$1"
  node -e '
const fs = require("fs");
const p = process.argv[1];
const v = process.argv[2];
const j = JSON.parse(fs.readFileSync(p, "utf8"));
j.version = v;
fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$ROOT/apps/desktop/package.json" "$ver"
  (cd "$ROOT/apps/desktop" && npm install --package-lock-only --ignore-scripts --no-fund --no-audit >/dev/null)
}

# --------------------------------------------------------------------------- preflight

[[ "$(uname -s)" == "Darwin" ]] || die "this script is for the owner Mac"

toplevel="$(git rev-parse --show-toplevel)"
[[ "$toplevel" == "$ROOT" ]] || die "run from the webinar checkout, not a nested dir"
case "$ROOT" in
  *webinar-ui*) die "this is the UI worktree; run from /Users/ganeshsp/Projects/webinar on main" ;;
esac

branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" ]] || die "on '$branch'; checkout main in this worktree"

if want mac || want ios; then
  need_file "$ASC_P8"
  need_file "$DEVID_P12"
  need_file "$DEVID_PASS"
fi
if want android; then
  need_file "$UPLOAD_JKS"
  need_file "$UPLOAD_PASS"
  need_file "$SIGNING/google-services.json"
fi
if want ios; then
  need_file "$SIGNING/GoogleService-Info.plist"
fi

# --------------------------------------------------------------------------- git pull

if [[ "$SKIP_PULL" -eq 0 ]]; then
  step "pull origin/main"
  git fetch origin
  dirty="$(git status --porcelain --untracked-files=normal | grep -Ev \
    -e '^ M apps/desktop/package\.json$' \
    -e '^ M apps/desktop/package-lock\.json$' \
    -e '^\?\? apps/mobile/ios/dist/' \
    -e '^\?\? apps/mobile/android/dist/' \
    -e '^\?\? apps/mobile/store-assets/' \
    -e '^\?\? e2e/load/env$' \
    -e '^\?\? env$' \
    || true)"
  if [[ -n "$dirty" ]]; then
    printf '%s\n' "$dirty" >&2
    die "working tree has other local changes; commit them or pass --skip-pull"
  fi
  git pull --ff-only origin main
  ok "$(git log -1 --oneline)"
else
  warn "skipping git pull"
fi

# --------------------------------------------------------------------------- live versions

step "read live versions"
LIVE_JSON="$(curl_json "$DOWNLOADS_BASE_URL/latest.json")"
LIVE_MAC="$(printf '%s' "$LIVE_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); f=(d.get("desktop") or {}).get("files") or {}; print((f.get("mac-arm64") or {}).get("version") or (d.get("desktop") or {}).get("version") or "0.0.0")')"
LIVE_ANDROID="$(printf '%s' "$LIVE_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); a=d.get("android") or {}; print(a.get("version") or "0.0.0")')"
LIVE_ANDROID_CODE="$(printf '%s' "$LIVE_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); a=d.get("android") or {}; print(int(a.get("versionCode") or 0))')"
LOCAL_DESKTOP="$(node -p "require('$ROOT/apps/desktop/package.json').version")"
ok "downloads mac $LIVE_MAC  android $LIVE_ANDROID ($LIVE_ANDROID_CODE)  package.json $LOCAL_DESKTOP"

LIVE_IOS="0.0.0"
LIVE_IOS_BUILD=0
if want ios && [[ -f "$ASC_P8" ]]; then
  TOKEN="$(asc_token)"
  APPS_JSON="$(asc_get "/v1/apps?filter[bundleId]=${IOS_BUNDLE}" "$TOKEN")"
  APP_ID="$(printf '%s' "$APPS_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["data"][0]["id"] if d.get("data") else "")')"
  [[ -n "$APP_ID" ]] || die "no App Store Connect app for $IOS_BUNDLE"
  BUILDS_JSON="$(asc_get "/v1/builds?filter[app]=${APP_ID}&sort=-uploadedDate&limit=8&include=preReleaseVersion" "$TOKEN")"
  read -r LIVE_IOS LIVE_IOS_BUILD <<<"$(printf '%s' "$BUILDS_JSON" | python3 -c '
import json,sys
d=json.load(sys.stdin)
pre={p["id"]: p["attributes"]["version"] for p in d.get("included") or [] if p["type"]=="preReleaseVersions"}
best_v, best_b = "0.0.0", 0
for b in d.get("data") or []:
    rel=(b.get("relationships") or {}).get("preReleaseVersion", {}).get("data") or {}
    v=pre.get(rel.get("id") or "", "0.0.0")
    n=int(b["attributes"].get("version") or 0)
    if n>best_b:
        best_b, best_v = n, v
print(best_v, best_b)
')"
  unset TOKEN
  ok "TestFlight $LIVE_IOS build $LIVE_IOS_BUILD"
fi

# --------------------------------------------------------------------------- pick next versions

DESKTOP_VERSION="${DESKTOP_VERSION_FLAG:-$LOCAL_DESKTOP}"
ANDROID_VERSION="${ANDROID_VERSION_FLAG:-$LIVE_ANDROID}"
ANDROID_CODE="${ANDROID_CODE_FLAG:-$LIVE_ANDROID_CODE}"
IOS_VERSION="${IOS_VERSION_FLAG:-$LIVE_IOS}"
IOS_BUILD="${IOS_BUILD_FLAG:-$LIVE_IOS_BUILD}"

# --skip-bump keeps apps/desktop/package.json as-is. Android/iOS still take the
# next unused store numbers unless you pass them explicitly (CDN keys are immutable).
if [[ "$SKIP_BUMP" -eq 0 && -z "$DESKTOP_VERSION_FLAG" ]] && want mac; then
  DESKTOP_VERSION="$(bump_patch "$(max_version "$LIVE_MAC" "$LOCAL_DESKTOP")")"
fi
if [[ -z "$ANDROID_VERSION_FLAG" ]] && want android; then
  ANDROID_VERSION="$(bump_patch "$(max_version "$LIVE_ANDROID" "0.0.0")")"
fi
if [[ -z "$ANDROID_CODE_FLAG" ]] && want android; then
  ANDROID_CODE=$((LIVE_ANDROID_CODE + 1))
fi
if [[ -z "$IOS_VERSION_FLAG" ]] && want ios; then
  IOS_VERSION="$(bump_patch "$(max_version "$LIVE_IOS" "0.0.0")")"
fi
if [[ -z "$IOS_BUILD_FLAG" ]] && want ios; then
  IOS_BUILD=$((LIVE_IOS_BUILD + 1))
fi

if want mac && ! semver_ok "$DESKTOP_VERSION"; then die "bad desktop version $DESKTOP_VERSION"; fi
if want android && ! semver_ok "$ANDROID_VERSION"; then die "bad android version $ANDROID_VERSION"; fi
if want ios && ! semver_ok "$IOS_VERSION"; then die "bad ios version $IOS_VERSION"; fi
want windows && DO_WINDOWS=1

PLAN=()
want mac && PLAN+=("Mac     $DESKTOP_VERSION  → $DOWNLOADS_BASE_URL (signed + notarized)")
want android && PLAN+=("Android $ANDROID_VERSION (versionCode $ANDROID_CODE)  → CDN APK; AAB left for Play Console")
want ios && PLAN+=("iOS     $IOS_VERSION build $IOS_BUILD  → TestFlight (not App Review)")
if want windows || [[ "$DO_WINDOWS" -eq 1 ]]; then
  PLAN+=("Windows $DESKTOP_VERSION  → gh workflow desktop-build.yml publish_windows (needs version on origin/main)")
fi

step "plan"
printf '    %s\n' "${PLAN[@]}"
note "desktop package.json is not committed by this script"

if [[ "$DRY" -eq 1 ]]; then
  ok "dry run; nothing built"
  exit 0
fi

if [[ "$YES" -eq 0 ]]; then
  note "starting in 5s  (Ctrl-C to abort, --yes to skip)"
  sleep 5
fi

if want mac && [[ "$SKIP_BUMP" -eq 0 ]] && [[ "$LOCAL_DESKTOP" != "$DESKTOP_VERSION" ]]; then
  step "bump desktop package.json $LOCAL_DESKTOP → $DESKTOP_VERSION"
  set_desktop_version "$DESKTOP_VERSION"
  ok "apps/desktop/package.json $DESKTOP_VERSION (uncommitted)"
fi

# --------------------------------------------------------------------------- build Mac

build_mac() {
  step "build Mac $DESKTOP_VERSION"
  [[ "$SKIP_BUILD" -eq 0 ]] || { warn "skipping Mac build"; return 0; }
  local dmg_arm="$ROOT/apps/desktop/release/WebinarLiv-${DESKTOP_VERSION}-mac-arm64.dmg"
  local dmg_x64="$ROOT/apps/desktop/release/WebinarLiv-${DESKTOP_VERSION}-mac-x64.dmg"

  # Do not print keystore / p12 passwords.
  export CSC_LINK="file://${DEVID_P12}"
  export CSC_KEY_PASSWORD
  CSC_KEY_PASSWORD="$(tr -d '\n' < "$DEVID_PASS")"
  export APPLE_API_KEY="$ASC_P8"
  export APPLE_API_KEY_ID="$ASC_KEY_ID"
  export APPLE_API_ISSUER="$ASC_ISSUER"
  export APPLE_TEAM_ID

  (cd "$ROOT/apps/desktop"
    [[ -d node_modules ]] || npm ci
    npm run build
    npx electron-builder --config electron-builder.config.cjs --mac --publish never
  )
  unset CSC_KEY_PASSWORD
  [[ -f "$dmg_arm" && -f "$dmg_x64" ]] || die "electron-builder did not write both DMGs"

  local key="$ASC_P8"
  local dmg
  for dmg in "$dmg_arm" "$dmg_x64"; do
    if ! xcrun stapler validate "$dmg" >/dev/null 2>&1; then
      note "notarizing $(basename "$dmg")"
      xcrun notarytool submit "$dmg" --key "$key" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER" --wait --output-format json \
        | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("status")=="Accepted", d'
      xcrun stapler staple "$dmg"
    fi
    xcrun stapler validate "$dmg" >/dev/null
  done
  ok "Mac $DESKTOP_VERSION notarized and stapled"
}

publish_mac() {
  [[ "$SKIP_PUBLISH" -eq 0 ]] || { warn "skipping Mac publish"; return 0; }
  step "publish Mac $DESKTOP_VERSION"
  node "$ROOT/scripts/downloads/publish.mjs" desktop --platform mac --version "$DESKTOP_VERSION" \
    --dir "$ROOT/apps/desktop/release" --signed-mac true
  ok "Mac $DESKTOP_VERSION on $DOWNLOADS_BASE_URL"
}

# --------------------------------------------------------------------------- build Android

build_android() {
  step "build Android $ANDROID_VERSION ($ANDROID_CODE)"
  [[ "$SKIP_BUILD" -eq 0 ]] || { warn "skipping Android build"; return 0; }

  cp "$SIGNING/google-services.json" "$ROOT/apps/mobile/android/app/google-services.json"
  (cd "$ROOT/apps/mobile"
    [[ -d node_modules ]] || npm ci
    npx cap sync android
  )

  if [[ -z "${JAVA_HOME:-}" ]]; then
    JAVA_HOME="$(/usr/libexec/java_home -v 21 2>/dev/null || /usr/libexec/java_home -v 17 2>/dev/null || true)"
    [[ -n "$JAVA_HOME" ]] && export JAVA_HOME
  fi
  if [[ -z "${ANDROID_HOME:-}" ]]; then
    for d in "$HOME/Library/Android/sdk" /opt/homebrew/share/android-commandlinetools; do
      if [[ -d "$d" ]]; then ANDROID_HOME="$d"; export ANDROID_HOME; break; fi
    done
  fi
  [[ -n "${ANDROID_HOME:-}" ]] || die "ANDROID_HOME is not set and ~/Library/Android/sdk is missing"

  export ANDROID_KEYSTORE_PATH="$UPLOAD_JKS"
  export ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_PASSWORD ANDROID_KEY_ALIAS
  ANDROID_KEYSTORE_PASSWORD="$(tr -d '\n' < "$UPLOAD_PASS")"
  ANDROID_KEY_PASSWORD="$ANDROID_KEYSTORE_PASSWORD"

  (cd "$ROOT/apps/mobile/android"
    ./gradlew --no-daemon bundleRelease assembleRelease \
      -PversionCode="$ANDROID_CODE" -PversionName="$ANDROID_VERSION"
  )
  unset ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_PASSWORD

  local apk="$ROOT/apps/mobile/android/app/build/outputs/apk/release/app-release.apk"
  local aab="$ROOT/apps/mobile/android/app/build/outputs/bundle/release/app-release.aab"
  [[ -f "$apk" && -f "$aab" ]] || die "gradle did not write app-release.apk / .aab"

  local apksigner
  apksigner="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)/apksigner"
  "$apksigner" verify --print-certs "$apk" | grep -q "CN=Android Debug" && die "APK is debug-signed"
  "$apksigner" verify "$apk" >/dev/null

  mkdir -p "$ROOT/apps/mobile/android/dist"
  cp "$apk" "$ROOT/apps/mobile/android/dist/WebinarLiv-${ANDROID_VERSION}.apk"
  cp "$aab" "$ROOT/apps/mobile/android/dist/WebinarLiv-${ANDROID_VERSION}.aab"
  ok "Android $ANDROID_VERSION versionCode $ANDROID_CODE"
}

publish_android() {
  [[ "$SKIP_PUBLISH" -eq 0 ]] || { warn "skipping Android publish"; return 0; }
  step "publish Android APK $ANDROID_VERSION"
  local apk="$ROOT/apps/mobile/android/dist/WebinarLiv-${ANDROID_VERSION}.apk"
  [[ -f "$apk" ]] || die "missing $apk"
  node "$ROOT/scripts/downloads/publish.mjs" android --version "$ANDROID_VERSION" --version-code "$ANDROID_CODE" \
    --apk "$apk" --signed true
  ok "Android $ANDROID_VERSION on $DOWNLOADS_BASE_URL"
  note "Play Console AAB: $ROOT/apps/mobile/android/dist/WebinarLiv-${ANDROID_VERSION}.aab"
  note "Upload it yourself; this script does not submit Play review."
}

# --------------------------------------------------------------------------- build iOS

build_ios() {
  step "build iOS $IOS_VERSION ($IOS_BUILD)"
  [[ "$SKIP_BUILD" -eq 0 ]] || { warn "skipping iOS build"; return 0; }

  cp "$SIGNING/GoogleService-Info.plist" "$ROOT/apps/mobile/ios/App/App/GoogleService-Info.plist"
  (cd "$ROOT/apps/mobile"
    [[ -d node_modules ]] || npm ci
    npx cap sync ios
  )

  local found=""
  local dir profile
  for dir in \
    "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles" \
    "$HOME/Library/MobileDevice/Provisioning Profiles"
  do
    [[ -d "$dir" ]] || continue
    while IFS= read -r -d '' profile; do
      if security cms -D -i "$profile" 2>/dev/null | grep -q "<string>${IOS_PROFILE_NAME}</string>"; then
        found="$profile"
        break 2
      fi
    done < <(find "$dir" -name '*.mobileprovision' -print0 2>/dev/null)
  done
  [[ -n "$found" ]] || die "provisioning profile '$IOS_PROFILE_NAME' is not installed in Xcode"

  local archive="${TMPDIR%/}/WebinarLiv-${IOS_VERSION}.xcarchive"
  local export_dir="${TMPDIR%/}/WebinarLiv-${IOS_VERSION}-export"
  local export_plist="${TMPDIR%/}/WebinarLiv-${IOS_VERSION}-ExportOptions.plist"
  rm -rf "$archive" "$export_dir"
  mkdir -p "$export_dir"
  cat > "$export_plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>${APPLE_TEAM_ID}</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>${IOS_BUNDLE}</key>
    <string>${IOS_PROFILE_NAME}</string>
  </dict>
  <key>destination</key><string>export</string>
</dict></plist>
EOF

  (cd "$ROOT/apps/mobile/ios/App"
    xcodebuild -project App.xcodeproj -scheme App -configuration Release \
      -destination 'generic/platform=iOS' \
      -archivePath "$archive" \
      MARKETING_VERSION="$IOS_VERSION" CURRENT_PROJECT_VERSION="$IOS_BUILD" \
      DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
      archive
    xcodebuild -exportArchive -archivePath "$archive" \
      -exportOptionsPlist "$export_plist" -exportPath "$export_dir"
  )

  local ipa
  ipa="$(find "$export_dir" -name '*.ipa' | head -n 1)"
  [[ -n "$ipa" ]] || die "xcodebuild export produced no IPA"
  mkdir -p "$ROOT/apps/mobile/ios/dist"
  cp "$ipa" "$ROOT/apps/mobile/ios/dist/WebinarLiv-${IOS_VERSION}.ipa"
  ok "iOS $IOS_VERSION build $IOS_BUILD IPA"
}

publish_ios() {
  [[ "$SKIP_PUBLISH" -eq 0 ]] || { warn "skipping iOS upload"; return 0; }
  step "upload iOS $IOS_VERSION to TestFlight"
  local ipa="$ROOT/apps/mobile/ios/dist/WebinarLiv-${IOS_VERSION}.ipa"
  [[ -f "$ipa" ]] || die "missing $ipa"
  mkdir -p "$HOME/.appstoreconnect/private_keys"
  local dest="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
  if [[ ! -f "$dest" ]]; then
    cp "$ASC_P8" "$dest"
    chmod 600 "$dest"
  fi
  if ! xcrun altool --upload-app --type ios --file "$ipa" \
    --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER" --output-format xml; then
    die "altool upload failed"
  fi
  ok "iOS $IOS_VERSION uploaded (processing on App Store Connect; not submitted for App Review)"
}

publish_windows() {
  [[ "$DO_WINDOWS" -eq 1 ]] || { return 0; }
  [[ "$SKIP_PUBLISH" -eq 0 ]] || { warn "skipping Windows workflow"; return 0; }
  step "Windows $DESKTOP_VERSION"
  local remote_ver
  remote_ver="$(git show "origin/main:apps/desktop/package.json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")"
  if [[ "$remote_ver" != "$DESKTOP_VERSION" ]]; then
    warn "origin/main still has desktop $remote_ver; commit and push $DESKTOP_VERSION before Windows can ship"
    note "then: gh workflow run desktop-build.yml --ref main -f publish_windows=true"
    return 0
  fi
  gh workflow run desktop-build.yml --ref main -f publish_windows=true
  ok "Desktop build workflow started (publish_windows)"
}

# --------------------------------------------------------------------------- run

want mac && { build_mac; publish_mac; }
want android && { build_android; publish_android; }
want ios && { build_ios; publish_ios; }
publish_windows

step "latest.json"
curl_json "$DOWNLOADS_BASE_URL/latest.json" | python3 -c '
import json,sys
d=json.load(sys.stdin)
desk=d.get("desktop") or {}
files=desk.get("files") or {}
print("  desktop", {k: (v or {}).get("version") for k,v in files.items()})
a=d.get("android") or {}
print("  android", a.get("version"), "versionCode", a.get("versionCode"))
'

echo
ok "done"
want mac && note "Mac $DESKTOP_VERSION  $DOWNLOADS_BASE_URL/desktop/latest/WebinarLiv-mac-arm64.dmg"
want android && note "Android $ANDROID_VERSION  $DOWNLOADS_BASE_URL/android/latest/WebinarLiv.apk"
want android && note "Play AAB  $ROOT/apps/mobile/android/dist/WebinarLiv-${ANDROID_VERSION}.aab"
want ios && note "iOS $IOS_VERSION build $IOS_BUILD  TestFlight (processing)"
if want mac && [[ "$(git status --porcelain apps/desktop/package.json apps/desktop/package-lock.json)" ]]; then
  note "commit apps/desktop/package.json if you want Windows $DESKTOP_VERSION from CI"
fi
