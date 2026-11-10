#!/usr/bin/env bash
# Wire session-review into Claude Code and pi, and start the hourly safety-net sweep.
# Called by the top-level ./install.sh; safe to re-run (it replaces its own entries, nothing else).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
CLI="$ROOT/bin/session-review.mjs"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

# Claude Code: SessionEnd hook (drop any old session-review entry, then add the current one)
if command -v claude >/dev/null || [ -d "$CLAUDE_DIR" ]; then
  S="$CLAUDE_DIR/settings.json"
  mkdir -p "$CLAUDE_DIR"; [ -f "$S" ] || echo '{}' > "$S"
  cp "$S" "$S.bak-session-review"
  jq --arg cmd "$NODE $CLI hook claude" '
    .hooks.SessionEnd = ([(.hooks.SessionEnd // [])[]
                          | .hooks |= map(select(.command | tostring | contains("session-review") | not))
                          | select(.hooks | length > 0)]
                         + [{hooks: [{type: "command", command: $cmd, timeout: 10}]}])' \
    "$S" > "$S.tmp" && mv "$S.tmp" "$S"
  mkdir -p "$CLAUDE_DIR/skills" && ln -sfn "$ROOT/skill" "$CLAUDE_DIR/skills/session-review"
  echo "  Claude Code: SessionEnd hook + skill"
fi

# pi: extension + skill
if command -v pi >/dev/null || [ -d "$PI_DIR" ]; then
  mkdir -p "$PI_DIR/extensions" "$PI_DIR/skills"
  sed "s#__ROOT__#$ROOT#g; s#__NODE__#$NODE#g" "$ROOT/integrations/pi-extension.ts" > "$PI_DIR/extensions/session-review.ts"
  ln -sfn "$ROOT/skill" "$PI_DIR/skills/session-review"
  echo "  pi: session_shutdown extension + skill"
fi

# Hourly sweep for sessions the hooks missed (killed terminals, model server down, ...)
if ! command -v systemctl >/dev/null || ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "  no systemd user session: skipping the hourly sweep (run 'session-review sweep' from cron instead)"
  exit 0
fi
U="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; mkdir -p "$U"
cat > "$U/session-review-sweep.service" <<UNIT
[Unit]
Description=Review finished coding-agent sessions into Obsidian

[Service]
Type=oneshot
Environment=SESSION_REVIEW_CHILD=1
ExecStart=$NODE $CLI sweep
Nice=10
UNIT
cat > "$U/session-review-sweep.timer" <<'UNIT'
[Unit]
Description=Hourly sweep for unreviewed coding-agent sessions

[Timer]
OnBootSec=10min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
if systemctl --user daemon-reload && systemctl --user enable --now session-review-sweep.timer >/dev/null 2>&1; then
  echo "  systemd: hourly sweep timer"
else
  echo "  could not enable the systemd timer; run 'session-review sweep' from cron instead"
fi
