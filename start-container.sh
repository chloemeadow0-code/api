#!/bin/sh
set -eu

mkdir -p /data/browser-profile /tmp/browser-runtime
rm -f /data/browser-profile/SingletonLock /data/browser-profile/SingletonSocket /data/browser-profile/SingletonCookie
export DISPLAY=:99

Xvfb :99 -screen 0 1365x768x24 -ac +extension RANDR >/tmp/xvfb.log 2>&1 &
sleep 1
openbox >/tmp/openbox.log 2>&1 &
x11vnc -display :99 -forever -shared -localhost -nopw -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
websockify 127.0.0.1:6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &
chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --disable-extensions --disable-sync --disable-default-apps --disable-component-update --disable-background-networking --disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints --renderer-process-limit="${BROWSER_RENDERER_PROCESS_LIMIT:-1}" --disk-cache-size=33554432 --media-cache-size=8388608 --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --remote-allow-origins='*' --user-data-dir=/data/browser-profile --no-first-run --no-default-browser-check --start-maximized about:blank >/tmp/chromium.log 2>&1 &
browser_pid=$!
browser_ready=0
attempt=0
while [ "$attempt" -lt 30 ]; do
  if node -e "fetch('http://127.0.0.1:9222/json/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    browser_ready=1
    break
  fi
  if ! kill -0 "$browser_pid" 2>/dev/null; then break; fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ "$browser_ready" -ne 1 ]; then
  echo "[browser] Chromium failed to become ready"
  tail -n 30 /tmp/chromium.log || true
fi

exec npm start
