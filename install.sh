#!/usr/bin/env bash
# Install automation flows.
#   ./install.sh                 install every flow
#   ./install.sh meet            install only the flows named
#   ./install.sh --list          show the flows and what each needs
# Safe to re-run. Commands go to ~/.local/bin (override with BIN_DIR), config to ~/.config/automations.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}/automations"

# flow -> commands it needs on PATH
needs() {
  case "$1" in
    meet) echo "ffmpeg pactl uv python3" ;;
    session-review) echo "node jq" ;;
    *) echo "" ;;
  esac
}
# flow -> commands it uses if present (works without them, with less)
wants() {
  case "$1" in
    meet) echo "notify-send" ;;
    session-review) echo "systemctl notify-send claude pi" ;;
    *) echo "" ;;
  esac
}
# flow -> commands it puts on PATH (files in bin/)
provides() {
  case "$1" in
    meet) echo "meet" ;;
    session-review) echo "session-review" ;;
    *) echo "" ;;
  esac
}

all_flows() { ls "$ROOT/flows"; }

if [ "${1:-}" = "--list" ]; then
  for f in $(all_flows); do printf '%-16s needs: %-28s optional: %s\n' "$f" "$(needs "$f")" "$(wants "$f")"; done
  exit 0
fi

flows=("$@"); [ ${#flows[@]} -eq 0 ] && mapfile -t flows < <(all_flows)
mkdir -p "$BIN_DIR" "$CONF"
failed=()

for f in "${flows[@]}"; do
  dir="$ROOT/flows/$f"
  [ -d "$dir" ] || { echo "✗ unknown flow: $f (try --list)"; failed+=("$f"); continue; }
  echo "→ $f"
  missing=()
  for c in $(needs "$f"); do command -v "$c" >/dev/null || missing+=("$c"); done
  if [ "$f" = session-review ] && command -v node >/dev/null; then
    [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || missing+=("node>=18")
  fi
  if [ ${#missing[@]} -gt 0 ]; then
    echo "  ✗ missing: ${missing[*]} (install them, then re-run)"; failed+=("$f"); continue
  fi
  for c in $(wants "$f"); do command -v "$c" >/dev/null || echo "  (optional, not found: $c)"; done
  for cmd in $(provides "$f"); do ln -sfn "$ROOT/bin/$cmd" "$BIN_DIR/$cmd"; echo "  command: $cmd"; done
  for ex in "$dir"/*.example*; do
    [ -e "$ex" ] || continue
    name="$(basename "$ex")"; target="$CONF/${name/.example/}"
    if [ ! -e "$target" ]; then
      cp "$ex" "$target"; chmod 600 "$target"
      echo "  config: created $target  ← edit this"
    else
      echo "  config: $target"
    fi
  done
  [ -x "$dir/install.sh" ] && "$dir/install.sh"
done

case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "note: add $BIN_DIR to your PATH" ;; esac
[ ${#failed[@]} -eq 0 ] || { echo "not installed: ${failed[*]}"; exit 1; }
