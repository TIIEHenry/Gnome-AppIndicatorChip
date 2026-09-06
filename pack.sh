#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
cd "$root"

if [[ $# -gt 0 ]]; then
  out_dir="$1"
else
  out_dir="$root/.."
fi
mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"

gnome-extensions pack -f -o "$out_dir" \
  --extra-source=appIndicator.js \
  --extra-source=boxOrderManager.js \
  --extra-source=dbusMenu.js \
  --extra-source=iconCache.js \
  --extra-source=indicatorStatusIcon.js \
  --extra-source=interfaces.js \
  --extra-source=overflowManager.js \
  --extra-source=pixmapsUtils.js \
  --extra-source=prefsBoxOrder.js \
  --extra-source=promiseUtils.js \
  --extra-source=settingsManager.js \
  --extra-source=statusNotifierWatcher.js \
  --extra-source=systemStats.js \
  --extra-source=trayIconsManager.js \
  --extra-source=util.js \
  --extra-source=interfaces-xml \
  --extra-source=locale

echo "Wrote $out_dir/appindicator-overflow@tiiehenry.github.io.shell-extension.zip"
