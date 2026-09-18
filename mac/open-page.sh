#!/bin/sh
# Start the server if it is not already up, then open the page in the default
# browser. Called by the Mac app's `on run`.
#
# Exit codes: 0 opened, 2 no node, 3 server would not come up.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
PORT=${PORT:-5199}
LOG="$HOME/Library/Logs/gif-it-to-me.log"

. "$HERE/find-tools.sh"

awake() {
  /usr/bin/curl -s -o /dev/null --max-time 1 "http://localhost:$PORT/" 2>/dev/null
}

if awake; then
  /usr/bin/open "http://localhost:$PORT/"
  echo "already running on $PORT"
  exit 0
fi

if [ -z "$NODE_BIN" ]; then
  echo "Node is not installed, or not where this could find it." >&2
  exit 2
fi

mkdir -p "$(dirname "$LOG")"
{
  echo ""
  echo "--- $(date '+%Y-%m-%d %H:%M:%S') starting with $NODE_BIN ---"
} >> "$LOG"

# nohup and a redirect off the shell's stdout, or `do shell script` in the app
# would sit and wait for the server to finish, which it never does.
cd "$ROOT" || exit 3
nohup "$NODE_BIN" serve.mjs --port "$PORT" --idle-exit 120 >> "$LOG" 2>&1 < /dev/null &

# Give it a moment. A cold node start is well under a second, but say so if not.
tries=0
while [ "$tries" -lt 40 ]; do
  if awake; then
    /usr/bin/open "http://localhost:$PORT/"
    echo "started on $PORT"
    exit 0
  fi
  /bin/sleep 0.25
  tries=$((tries + 1))
done

{
  echo "The server did not answer on port $PORT. Last lines of the log:"
  /usr/bin/tail -n 6 "$LOG"
} >&2
exit 3
