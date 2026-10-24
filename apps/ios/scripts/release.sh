#!/bin/bash
set -euo pipefail
umask 077
sdk_major=$(xcrun --sdk iphoneos --show-sdk-version | cut -d. -f1)
if [ "$sdk_major" -lt 26 ]; then echo 'Apple uploads require the iOS 26 SDK or newer.' >&2; exit 1; fi
for variable in APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_CONTENT APPLE_DEVELOPMENT_TEAM; do
  if [ -z "${!variable:-}" ]; then echo "Missing repository secret: $variable" >&2; exit 1; fi
done
export APPLE_API_KEY_PATH="$RUNNER_TEMP/lakeside-signing.p8"
python3 - <<'PY'
import base64, os
from pathlib import Path
content = os.environ['APPLE_API_KEY_CONTENT'].strip()
key = content.encode() if content.startswith('-----BEGIN PRIVATE KEY-----') else base64.b64decode(''.join(content.split()), validate=True)
Path(os.environ['APPLE_API_KEY_PATH']).write_bytes(key)
PY
trap 'rm -f "$APPLE_API_KEY_PATH"' EXIT
python3 scripts/apple.py
auth=(-allowProvisioningUpdates -authenticationKeyPath "$APPLE_API_KEY_PATH" -authenticationKeyID "$APPLE_API_KEY" -authenticationKeyIssuerID "$APPLE_API_ISSUER")
schemes=(LakesideOps)
for scheme in "${schemes[@]}"; do
  if [ "$scheme" = LakesideOps ]; then
    # Unsigned archive, then an ad hoc signature applied with codesign so the app
    # carries aps-environment into export. Xcode refuses ad hoc signing for the
    # device SDK, and automatic signing would need a development profile (the
    # team has no registered devices). Export re-signs for distribution.
    xcodebuild archive -project LakesideOps.xcodeproj -scheme "$scheme" -configuration Release \
      -destination 'generic/platform=iOS' -archivePath "build/$scheme.xcarchive" \
      CURRENT_PROJECT_VERSION="${GITHUB_RUN_NUMBER:-1}" CODE_SIGNING_ALLOWED=NO
    app="build/$scheme.xcarchive/Products/Applications/$scheme.app"
    python3 scripts/verify-native.py "$app"
    find "$app" -depth \( -name '*.framework' -o -name '*.dylib' -o -name '*.appex' \) -exec codesign --force --sign - {} \;
    codesign --force --sign - --entitlements scripts/ops.entitlements --generate-entitlement-der "$app"
    entitlement=$(codesign -d --entitlements - --xml "build/$scheme.xcarchive/Products/Applications/$scheme.app" 2>/dev/null | plutil -extract aps-environment raw -o - - 2>/dev/null || true)
    if [ "$entitlement" != production ]; then echo "::error::$scheme archive is missing aps-environment" >&2; exit 1; fi
    echo "$scheme aps-environment: $entitlement"
  else
    xcodebuild archive -project LakesideOps.xcodeproj -scheme "$scheme" -configuration Release \
      -destination 'generic/platform=iOS' -archivePath "build/$scheme.xcarchive" \
      CURRENT_PROJECT_VERSION="${GITHUB_RUN_NUMBER:-1}" CODE_SIGNING_ALLOWED=NO
  fi
  app_id=$(python3 -c 'import json,sys; print(next(x["appId"] or "" for x in json.load(open("build/release-status.json")) if x["scheme"] == sys.argv[1]))' "$scheme")
  if [ -z "$app_id" ]; then
    echo "::notice::$scheme compiled for iPhone. Create its app record in App Store Connect, then rerun with release enabled."
    continue
  fi
  for destination in export upload; do
    python3 - "$scheme" "$destination" <<'PY'
import os, plistlib, sys
from pathlib import Path
value = {'method': 'app-store-connect', 'destination': sys.argv[2], 'signingStyle': 'automatic',
    'teamID': os.environ['APPLE_DEVELOPMENT_TEAM'], 'manageAppVersionAndBuildNumber': False,
    'uploadSymbols': True, 'stripSwiftSymbols': True}
Path('build/' + sys.argv[1] + '-' + sys.argv[2] + '.plist').write_bytes(plistlib.dumps(value))
PY
    python3 scripts/private-apple-command.py xcodebuild -exportArchive -archivePath "build/$scheme.xcarchive" \
      -exportOptionsPlist "build/$scheme-$destination.plist" -exportPath "build/$scheme-$destination" "${auth[@]}"
    if [ "$destination" = export ]; then
      # The distribution-signed app must still carry push before it is uploaded.
      ipa=$(find "build/$scheme-export" -name '*.ipa' -print -quit)
      rm -rf build/ipa-check && mkdir -p build/ipa-check && unzip -q "$ipa" -d build/ipa-check
      signed=$(codesign -d --entitlements - --xml build/ipa-check/Payload/*.app 2>/dev/null | plutil -extract aps-environment raw -o - - 2>/dev/null || true)
      if [ "$signed" != production ]; then echo "::error::exported $scheme is missing aps-environment" >&2; exit 1; fi
      echo "$scheme exported aps-environment: $signed"
      rm -rf build/ipa-check "build/$scheme-export"
    fi
  done
  python3 - "$scheme" <<'PY'
import json, sys
from pathlib import Path
p = Path('build/release-status.json'); rows = json.loads(p.read_text())
for row in rows:
    if row['scheme'] == sys.argv[1]: row['status'] = 'uploaded-awaiting-apple-processing'
p.write_text(json.dumps(rows, indent=2) + '\n')
PY
done
cat build/release-status.json >> "$GITHUB_STEP_SUMMARY"
