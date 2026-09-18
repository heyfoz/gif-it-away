#!/bin/sh
# Finding node and ffmpeg from inside a double-clicked app.
#
# This is the whole reason these scripts exist. A GUI app is launched by
# launchd, not by a shell, so it never reads .zshrc or .zprofile and starts life
# with PATH=/usr/bin:/bin:/usr/sbin:/sbin. Homebrew is not on that path. Neither
# is nvm, which is not even a directory of binaries but a shell function. So
# `node` and `ffmpeg` are both simply missing, and the app has to go looking.
#
# Sourced by the other scripts here. Sets NODE_BIN and FFMPEG_BIN.

# Anything a shell profile would have added, in the order a profile would.
EXTRA_PATHS="/opt/homebrew/bin /usr/local/bin /opt/local/bin $HOME/.local/bin $HOME/.bun/bin $HOME/.volta/bin"

find_tool() {
  tool="$1"

  for dir in $EXTRA_PATHS; do
    if [ -x "$dir/$tool" ]; then
      printf '%s' "$dir/$tool"
      return 0
    fi
  done

  # Whatever is already on PATH, in case this was run from a real shell.
  found=$(command -v "$tool" 2>/dev/null)
  if [ -n "$found" ] && [ -x "$found" ]; then
    printf '%s' "$found"
    return 0
  fi

  # Version managers keep their binaries under a per-version directory. Take the
  # newest, by version order rather than by name order, so v9 does not beat v10.
  for root in "$HOME/.nvm/versions/node" "$HOME/.local/share/fnm/node-versions" \
              "$HOME/.asdf/installs/nodejs" "$HOME/Library/Caches/fnm_multishells"; do
    [ -d "$root" ] || continue
    for candidate in $(ls -d "$root"/*/bin/"$tool" "$root"/*/installation/bin/"$tool" 2>/dev/null | sort -V -r); do
      if [ -x "$candidate" ]; then
        printf '%s' "$candidate"
        return 0
      fi
    done
  done

  return 1
}

NODE_BIN=$(find_tool node) || NODE_BIN=""
FFMPEG_BIN=$(find_tool ffmpeg) || FFMPEG_BIN=""
export NODE_BIN FFMPEG_BIN
