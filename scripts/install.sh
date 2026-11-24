#!/usr/bin/env bash
# Install this repo's dist/ into LearnHarness's plugin folder.
#
# Replaces only <plugins>/system-design-lab/dist/. Never touches the sibling
# data/ folder (or anything else in the plugin folder).
#
# Override the plugins folder with LEARNHARNESS_PLUGINS_DIR (used for testing).
set -euo pipefail

PLUGIN_ID="system-design-lab"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/dist"
PLUGINS_DIR="${LEARNHARNESS_PLUGINS_DIR:-$HOME/Library/Application Support/LearnHarness/data/plugins}"
TARGET="$PLUGINS_DIR/$PLUGIN_ID"
DEST="$TARGET/dist"

die() { echo "install: $*" >&2; exit 1; }

[ -f "$SRC/manifest.json" ] || die "missing $SRC/manifest.json"
grep -q "\"id\": *\"$PLUGIN_ID\"" "$SRC/manifest.json" \
  || die "manifest id is not \"$PLUGIN_ID\""
[ -d "$PLUGINS_DIR" ] || die "plugins folder not found: $PLUGINS_DIR (is LearnHarness installed?)"

[ -L "$TARGET" ] && die "refusing: $TARGET is a symlink"
[ -L "$DEST" ] && die "refusing: $DEST is a symlink"
[ -e "$DEST" ] && [ ! -d "$DEST" ] && die "refusing: $DEST exists and is not a directory"

mkdir -p "$TARGET"

# Copy into a temp folder next to dist, then swap, so a failed copy never
# leaves a half-written dist behind.
TMP="$(mktemp -d "$TARGET/.dist.tmp.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
cp -R "$SRC/." "$TMP/"
chmod 755 "$TMP"

rm -rf "$DEST"
mv "$TMP" "$DEST"
trap - EXIT

echo "Installed $PLUGIN_ID $(grep -o '"version": *"[^"]*"' "$SRC/manifest.json" | grep -o '[0-9][^"]*') -> $DEST"
echo "Restart LearnHarness to load the new code."
