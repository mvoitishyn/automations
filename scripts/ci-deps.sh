#!/usr/bin/env sh
# Install every flow's dependencies on a fresh container (used by CI; also a handy reference).
set -eu
if command -v apt-get >/dev/null; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bash git curl ca-certificates jq nodejs ffmpeg pulseaudio-utils python3 libnotify-bin >/dev/null
elif command -v dnf >/dev/null; then
  dnf install -y -q bash git curl jq nodejs ffmpeg-free pulseaudio-utils python3 libnotify findutils >/dev/null
elif command -v pacman >/dev/null; then
  pacman -Sy --noconfirm --needed --quiet bash git curl jq nodejs ffmpeg libpulse python libnotify >/dev/null
else
  echo "unsupported distro" >&2; exit 1
fi
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh >/dev/null
