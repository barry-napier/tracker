#!/bin/zsh
# Verify a published GitHub release against local dist/ — the last step of
# every release. electron-builder's retry uploads have twice published
# corrupt/stale assets (v0.2.6, v0.2.7), so nothing is trusted until the
# published bytes hash-match the local build and Gatekeeper accepts the app
# with a quarantine attribute attached.
set -euo pipefail

TAG="${1:?usage: verify-release.sh vX.Y.Z}"
REPO="barry-napier/tracker"
DIST="$(cd "$(dirname "$0")/../dist" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "❌ $1" >&2; exit 1 }

# One release, not draft, no duplicates hiding on the tag.
count=$(gh api "repos/$REPO/releases" --jq "[.[] | select(.tag_name == \"$TAG\")] | length")
[[ "$count" == "1" ]] || fail "expected exactly 1 release for $TAG, found $count (duplicate/draft race?)"
draft=$(gh release view "$TAG" --repo "$REPO" --json isDraft -q .isDraft)
[[ "$draft" == "false" ]] || fail "$TAG is still a draft"

# Every local artifact must exist remotely with identical bytes.
for f in "$DIST"/*"${TAG#v}"*(.N) "$DIST/latest-mac.yml"; do
  name="$(basename "$f")"
  gh release download "$TAG" --repo "$REPO" -p "$name" -D "$WORK" || fail "$name missing from release"
  local_hash=$(shasum -a 256 "$f" | cut -d' ' -f1)
  remote_hash=$(shasum -a 256 "$WORK/$name" | cut -d' ' -f1)
  [[ "$local_hash" == "$remote_hash" ]] || fail "$name: published bytes differ from dist/"
  echo "✓ $name"
done

# Gatekeeper must accept each DMG's app with quarantine attached. The mount
# point comes from hdiutil's own plist output — guessing via /Volumes
# globbing picks up stale mounts from previous runs.
for dmg in "$WORK"/*.dmg(.N); do
  xattr -w com.apple.quarantine "0081;00000000;verify;" "$dmg"
  vol=$(hdiutil attach -nobrowse -plist "$dmg" \
    | plutil -extract 'system-entities' json -o - - \
    | /usr/bin/python3 -c 'import json,sys; print(next(e["mount-point"] for e in json.load(sys.stdin) if "mount-point" in e))')
  [[ -d "$vol" ]] || fail "$(basename "$dmg"): could not resolve mount point"
  spctl -a "$vol/Tracker.app" || { hdiutil detach "$vol" -quiet; fail "$(basename "$dmg"): Gatekeeper rejected" }
  xcrun stapler validate -q "$vol/Tracker.app" || { hdiutil detach "$vol" -quiet; fail "$(basename "$dmg"): no stapled ticket" }
  echo "✓ $(basename "$dmg") notarized + stapled"
  hdiutil detach "$vol" -quiet
done

echo "✅ $TAG verified: assets match dist/, Gatekeeper accepts"
