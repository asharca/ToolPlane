# ToolPlane sandbox environment list.
#
# Runs inside a Docker sandbox as `sh -c "<this file>" toolplane-env <command>`.
# Sessions share one writable container rootfs, so packages they install are
# visible to every conversation of the Agent but disappear when the container
# is recreated. This script records them in the sandbox volume and reinstalls
# them into the next container.
#
#   sync    Record the default package set of a new container, or capture the
#           installed packages into packages.list. Prints "replay" when
#           packages.list still has to be installed into this container.
#   replay  Install packages.list into a new container. Run it detached.

# Package lists are split into words on purpose; never expand globs.
set -uf

DIR=/workspace/.toolplane/environment
MARKER_DIR=/var/lib/toolplane
MARKER="$MARKER_DIR/environment-generation"
MANIFEST="$DIR/packages.list"
BASELINE="$DIR/baseline.list"
BASELINE_GENERATION="$DIR/baseline.generation"
STATE="$DIR/state"
FAILED="$DIR/failed.list"
LOG="$DIR/replay.log"

# The list lives in the volume; the marker lives in the rootfs and therefore
# identifies the current container. Without both (non-root image) do nothing.
[ -d /workspace ] || exit 0
mkdir -p "$DIR" "$MARKER_DIR" 2>/dev/null || exit 0
[ -w "$DIR" ] && [ -w "$MARKER_DIR" ] || exit 0

lock() {
  command -v flock >/dev/null 2>&1 || return 0
  exec 9>"$DIR/.lock"
  flock -w 120 9 || exit 0
}

unlock() {
  command -v flock >/dev/null 2>&1 || return 0
  flock -u 9
  exec 9>&-
}

# One "<manager> <name> [version]" line per explicitly installed package.
installed() {
  if command -v apt-mark >/dev/null 2>&1; then
    apt-mark showmanual 2>/dev/null | awk 'NF == 1 { print "apt " $1 }'
  fi
  if command -v npm >/dev/null 2>&1; then
    npm ls -g --depth=0 --parseable --long 2>/dev/null | awk -F: 'NF >= 2 {
      spec = $2; at = 0
      for (i = length(spec); i > 1; i--) if (substr(spec, i, 1) == "@") { at = i; break }
      if (at > 1 && at < length(spec)) print "npm " substr(spec, 1, at - 1) " " substr(spec, at + 1)
    }'
  fi
  if command -v python3 >/dev/null 2>&1; then
    # Only pip/uv installs; Debian-packaged Python modules come from apt.
    python3 - 2>/dev/null <<'PY'
import importlib.metadata as metadata
import re

for dist in metadata.distributions():
    try:
        installer = (dist.read_text("INSTALLER") or "").strip()
    except Exception:
        continue
    name = dist.metadata["Name"]
    if installer in ("pip", "uv") and name:
        print("pip", re.sub(r"[-_.]+", "-", name).lower(), dist.version)
PY
  fi
}

# packages.list = installed packages the container did not start with (or that
# the list already tracks), plus tracked packages whose reinstall failed.
capture() {
  installed | sort -u >"$DIR/current.$$"
  {
    echo "# Packages installed in this Agent's shared sandbox. ToolPlane updates this"
    echo "# list after each turn and reinstalls it when the container is recreated."
    awk -v baseline="$BASELINE" -v previous="$MANIFEST" -v failed="$FAILED" '
      function key(line, field) { split(line, field, " "); return field[1] " " field[2] }
      BEGIN {
        while ((getline line < baseline) > 0) if (line ~ /^[a-z]/) base[key(line)] = 1
        while ((getline line < previous) > 0) if (line ~ /^[a-z]/) prev[key(line)] = line
        while ((getline line < failed) > 0) if (line ~ /^[a-z]/) missing[key(line)] = 1
      }
      {
        k = key($0)
        if (k in seen) next
        seen[k] = 1
        if (!(k in base) || (k in prev)) print
      }
      END { for (k in prev) if (!(k in seen) && (k in missing)) print prev[k] }
    ' "$DIR/current.$$" | sort
  } >"$MANIFEST.$$"
  rm -f "$DIR/current.$$"
  if cmp -s "$MANIFEST.$$" "$MANIFEST"; then
    rm -f "$MANIFEST.$$"
  else
    mv "$MANIFEST.$$" "$MANIFEST"
  fi
}

read_state() {
  state='' state_generation='' pid=''
  if [ -f "$STATE" ]; then
    read -r state state_generation pid <"$STATE" || :
  fi
}

replay_alive() {
  # The script text is part of argv; only the trailing arguments identify a replay.
  [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] &&
    tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q 'toolplane-env replay $'
}

sync_environment() {
  lock
  generation=$(cat "$MARKER" 2>/dev/null || :)
  if [ -z "$generation" ] ||
    [ "$generation" != "$(cat "$BASELINE_GENERATION" 2>/dev/null || :)" ]; then
    [ -n "$generation" ] || generation=$(cat /proc/sys/kernel/random/uuid)
    installed | sort -u >"$BASELINE.$$" && mv "$BASELINE.$$" "$BASELINE"
    printf '%s\n' "$generation" >"$BASELINE_GENERATION"
    printf '%s\n' "$generation" >"$MARKER"
    if grep -q '^[a-z]' "$MANIFEST" 2>/dev/null; then
      printf 'pending %s\n' "$generation" >"$STATE"
      echo replay
    else
      printf 'done %s\n' "$generation" >"$STATE"
    fi
    unlock
    return 0
  fi
  read_state
  if [ "$state_generation" = "$generation" ]; then
    case "$state" in
      pending)
        echo replay
        unlock
        return 0
        ;;
      running)
        if ! replay_alive; then
          printf 'pending %s\n' "$generation" >"$STATE"
          echo replay
        fi
        unlock
        return 0
        ;;
    esac
  fi
  # Capturing mid-replay would drop packages that are not reinstalled yet.
  capture
  unlock
}

install_packages() {
  list=$1
  failed=$2
  echo "ToolPlane environment replay started $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  apt_packages=$(awk '$1 == "apt" && $2 ~ /^[a-z0-9][a-z0-9+.:-]*$/ { print $2 }' "$list")
  if [ -n "$apt_packages" ]; then
    export DEBIAN_FRONTEND=noninteractive
    # shellcheck disable=SC2086
    if ! { apt-get update && apt-get install -y --no-install-recommends $apt_packages; } </dev/null; then
      for package in $apt_packages; do
        apt-get install -y --no-install-recommends "$package" </dev/null ||
          echo "apt $package" >>"$failed"
      done
    fi
  fi

  npm_specs=$(awk '$1 == "npm" && $2 ~ /^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/ && $3 ~ /^[0-9A-Za-z.+-]+$/ { print $2 "@" $3 }' "$list")
  if [ -n "$npm_specs" ]; then
    # shellcheck disable=SC2086
    if ! npm install -g --no-audit --no-fund $npm_specs </dev/null; then
      for spec in $npm_specs; do
        npm install -g --no-audit --no-fund "$spec" </dev/null ||
          echo "npm ${spec%@*} ${spec##*@}" >>"$failed"
      done
    fi
  fi

  pip_specs=$(awk '$1 == "pip" && $2 ~ /^[a-z0-9][a-z0-9.-]*$/ && $3 ~ /^[0-9A-Za-z.+!-]+$/ { print $2 "==" $3 }' "$list")
  if [ -n "$pip_specs" ]; then
    export PIP_BREAK_SYSTEM_PACKAGES=1 PIP_ROOT_USER_ACTION=ignore PIP_DISABLE_PIP_VERSION_CHECK=1
    # shellcheck disable=SC2086
    if ! python3 -m pip install --no-input $pip_specs </dev/null; then
      for spec in $pip_specs; do
        python3 -m pip install --no-input "$spec" </dev/null ||
          echo "pip ${spec%%==*} ${spec#*==}" >>"$failed"
      done
    fi
  fi

  echo "ToolPlane environment replay finished $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ -s "$failed" ]; then
    echo "Not reinstalled:"
    cat "$failed"
  fi
}

replay() {
  lock
  generation=$(cat "$MARKER" 2>/dev/null || :)
  read_state
  if [ -z "$generation" ] || [ "$state" != pending ] ||
    [ "$state_generation" != "$generation" ]; then
    unlock
    return 0
  fi
  printf 'running %s %s\n' "$generation" "$$" >"$STATE"
  grep '^[a-z]' "$MANIFEST" >"$DIR/replay.list" 2>/dev/null || :
  unlock

  : >"$DIR/failed.next"
  install_packages "$DIR/replay.list" "$DIR/failed.next" >"$LOG" 2>&1

  lock
  mv "$DIR/failed.next" "$FAILED"
  rm -f "$DIR/replay.list"
  printf 'done %s\n' "$generation" >"$STATE"
  capture
  unlock
}

case "${1:-}" in
  sync) sync_environment ;;
  replay) replay ;;
  *)
    echo "usage: toolplane-env sync|replay" >&2
    exit 2
    ;;
esac
