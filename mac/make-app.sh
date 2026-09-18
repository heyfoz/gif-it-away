#!/bin/sh
# Build "GIF it to me.app" so the tool can be used without a terminal.
#
#   sh mac/make-app.sh [install-dir]
#
# Default install-dir is /Applications when it is writable, otherwise
# ~/Applications. Everything used here ships with macOS: osacompile makes a real
# app bundle with a droplet handler, iconutil makes the icon, plutil edits the
# plist. No Xcode, no signing, no dependencies.
#
# Re-run it after moving the project folder: the app stores an absolute path.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
APP_NAME="GIF it to me"

if [ $# -ge 1 ]; then
  DEST_DIR=$1
elif [ -w /Applications ]; then
  DEST_DIR=/Applications
else
  DEST_DIR="$HOME/Applications"
fi
mkdir -p "$DEST_DIR"
APP="$DEST_DIR/$APP_NAME.app"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# 1. Bake the project location into the script. The app has to know where it
#    lives, and a bundle in /Applications cannot work it out from its own path.
sed "s|__PROJECT_ROOT__|$ROOT|" "$HERE/app.applescript" > "$WORK/app.applescript"

# 2. osacompile builds the bundle. A script with an `on open` handler becomes a
#    droplet, which is what makes the Finder accept a video dropped on the icon.
rm -rf "$APP"
osacompile -o "$APP" "$WORK/app.applescript"

# 3. Icon. A script with an `on open` handler compiles to a *droplet*, whose
#    CFBundleIconFile is "droplet", not the "applet" an ordinary script gets, so
#    the name is read back rather than assumed. Writing applet.icns into a
#    droplet leaves the stock icon in place and looks like nothing happened.
ICON_NAME=$(plutil -extract CFBundleIconFile raw "$APP/Contents/Info.plist" 2>/dev/null || echo applet)
"${NODE:-node}" "$HERE/make-icon.mjs" "$WORK/icon.iconset" > /dev/null
iconutil -c icns "$WORK/icon.iconset" -o "$APP/Contents/Resources/${ICON_NAME%.icns}.icns"

# 4. Plist. osacompile writes a generic applet plist, so this adds a real name,
#    a bundle id, and the video types the Finder should let you drop.
PLIST="$APP/Contents/Info.plist"
set_plist() {
  plutil -replace "$1" -"$2" "$3" "$PLIST" 2>/dev/null || plutil -insert "$1" -"$2" "$3" "$PLIST"
}
set_plist CFBundleName string "$APP_NAME"
set_plist CFBundleDisplayName string "$APP_NAME"
set_plist CFBundleIdentifier string "io.gestique.gif-it-to-me"
set_plist CFBundleShortVersionString string "1.0.0"
set_plist CFBundleVersion string "1"
# Retina, or the page and any screenshot of it come out soft.
set_plist NSHighResolutionCapable bool YES

# Inserting a dict into an array by index is not something plutil can do on
# every macOS (it throws an NSRangeException), so the whole value goes in as one
# lump of XML instead.
DOC_TYPES='<array><dict>
  <key>CFBundleTypeName</key><string>Video</string>
  <key>CFBundleTypeRole</key><string>Viewer</string>
  <key>LSHandlerRank</key><string>Alternate</string>
  <key>LSItemContentTypes</key><array>
    <string>public.movie</string>
    <string>public.video</string>
    <string>public.mpeg-4</string>
    <string>com.apple.quicktime-movie</string>
    <string>org.webmproject.webm</string>
    <string>public.avi</string>
  </array>
</dict></array>'
plutil -replace CFBundleDocumentTypes -xml "$DOC_TYPES" "$PLIST"

# 5. osacompile signs the bundle as it writes it, and everything above this
#    line changed it since. Re-sign ad-hoc so the signature is not left broken.
codesign --force --sign - "$APP" > /dev/null 2>&1 || true

# 6. The Finder caches icons hard. Touching the bundle makes it look again.
touch "$APP"

plutil -lint "$PLIST" > /dev/null
codesign --verify "$APP" 2>/dev/null && echo "signature: ok (ad-hoc)" || echo "signature: unsigned, which is fine for a local build"
echo "built: $APP"
echo "project: $ROOT"
echo
echo "Double-click it to open the page, or drop a video on it to convert one."
