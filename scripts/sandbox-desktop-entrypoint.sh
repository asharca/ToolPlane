#!/bin/sh
# ToolPlane desktop sandbox entrypoint. Starts a loopback-only VNC display, a
# window manager and Chromium (CDP on loopback), restarting each if it exits,
# then execs the container command (`sleep infinity` for ToolPlane sandboxes).
set -eu

display="${TOOLPLANE_DESKTOP_DISPLAY:-:1}"
rfb_port="${TOOLPLANE_DESKTOP_RFB_PORT:-5900}"
cdp_port="${TOOLPLANE_DESKTOP_CDP_PORT:-9222}"
size="${TOOLPLANE_DESKTOP_SIZE:-1280x800}"
state=/tmp/.toolplane-desktop
profile="${HOME:-/root}/.config/toolplane-chromium"

mkdir -p "$state"
chmod 1777 "$state"
rm -f "$state/user-control"

supervise() {
  name="$1"
  shift
  (
    while :; do
      "$@" >"$state/$name.log" 2>&1 || true
      sleep 1
    done
  ) &
}

display_number="${display#:}"
rm -f "/tmp/.X${display_number}-lock" "/tmp/.X11-unix/X${display_number}"

supervise xvnc Xvnc "$display" \
  -geometry "$size" -depth 24 \
  -rfbport "$rfb_port" -localhost \
  -SecurityTypes None -AlwaysShared \
  -desktop ToolPlane

i=0
while [ ! -S "/tmp/.X11-unix/X${display_number}" ] && [ "$i" -lt 50 ]; do
  i=$((i + 1))
  sleep 0.1
done

export DISPLAY="$display"
supervise openbox openbox

mkdir -p "$profile"
supervise chromium sh -c '
  rm -f "$1/SingletonLock" "$1/SingletonSocket" "$1/SingletonCookie"
  exec chromium \
    --no-sandbox \
    --disable-dev-shm-usage \
    --no-first-run \
    --no-default-browser-check \
    --disable-features=Translate \
    --test-type \
    --password-store=basic \
    --start-maximized \
    --window-size="$3" \
    --disable-background-networking \
    --disable-component-update \
    --disable-sync \
    --window-position=0,0 \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="$2" \
    --user-data-dir="$1" \
    about:blank
' toolplane-chromium "$profile" "$cdp_port" "$(printf %s "$size" | tr x ,)"

exec "$@"
