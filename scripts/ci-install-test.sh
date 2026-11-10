#!/usr/bin/env bash
# Install from a clean checkout as a brand-new user would, then check the result.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== $(. /etc/os-release && echo "$PRETTY_NAME"), node $(node --version)"
./install.sh --list
./install.sh
export PATH="$HOME/.local/bin:$PATH"
test -L "$HOME/.local/bin/meet" && test -L "$HOME/.local/bin/session-review"
test -f "$HOME/.config/automations/meet.env" && test -f "$HOME/.config/automations/session-review.json"
meet help | grep 'meet start' >/dev/null
meet status | grep 'not recording' >/dev/null
session-review status || true   # model servers and vaults are absent here; it must still run
session-review status | grep 'config:' >/dev/null
echo "✓ install OK"
