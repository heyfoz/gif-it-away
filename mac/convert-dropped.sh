#!/bin/sh
# Convert one video to a GIF beside it. Called by the Mac app's `on open`, once
# per dropped file, and safe to run from a terminal too.
#
#   convert-dropped.sh <video> [maxWidth] [fps] [colors]
#
# Exit codes: 0 done, 2 something missing, 4 the conversion failed.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)

SRC=${1:-}
WIDTH=${2:-800}
FPS=${3:-15}
COLORS=${4:-256}

[ -n "$SRC" ] || { echo "Which file?" >&2; exit 2; }
[ -f "$SRC" ] || { echo "$(basename "$SRC") is not there any more." >&2; exit 2; }

. "$HERE/find-tools.sh"

[ -n "$NODE_BIN" ] || { echo "Node is not installed, or not where this could find it." >&2; exit 2; }
[ -n "$FFMPEG_BIN" ] || {
  echo "Dropping a file needs ffmpeg, which is not installed. Open the page instead and drop the video there: the browser does its own decoding." >&2
  exit 2
}

DIR=$(dirname "$SRC")
BASE=$(basename "$SRC")
STEM=${BASE%.*}

# Never write over a GIF that is already sitting there.
OUT="$DIR/$STEM.gif"
n=2
while [ -e "$OUT" ]; do
  OUT="$DIR/$STEM $n.gif"
  n=$((n + 1))
done

# cli.mjs finds ffmpeg on PATH, so hand it the one that was just located.
PATH="$(dirname "$FFMPEG_BIN"):$PATH"
export PATH

cd "$ROOT" || exit 4
# cli.mjs reports progress on stderr, so that is where a failure reason is too.
if ! REPORT=$("$NODE_BIN" cli.mjs "$SRC" --width "$WIDTH" --fps "$FPS" --colors "$COLORS" -o "$OUT" -q 2>&1 >/dev/null); then
  echo "${REPORT:-The conversion failed.}" >&2
  exit 4
fi

/usr/bin/open -R "$OUT"

SIZE=$(/usr/bin/stat -f%z "$OUT" 2>/dev/null || echo 0)
printf '%s is ready, %s\n' "$(basename "$OUT")" \
  "$(echo "$SIZE" | /usr/bin/awk '{ if ($1 > 1048576) printf "%.1f MB", $1/1048576; else printf "%d KB", $1/1024 }')"
