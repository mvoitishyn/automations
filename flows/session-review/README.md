# session-review

Reviews finished Claude Code and pi sessions and writes an analysis note into Obsidian: summary,
what went well, what went wrong, friction and corrections, prompting lessons, agent lessons,
follow-ups, stats, and the full prompt/reply log.

- **When:** Claude Code `SessionEnd` hook and pi `session_shutdown` extension queue the session and
  return immediately; a background worker reviews it. An hourly systemd timer sweeps up anything missed.
- **Where and with what:** `~/.config/automations/session-review.json` (start from
  [`session-review.example.json`](session-review.example.json)) routes by working directory: each route picks a
  vault, a folder, and a list of model backends tried in order (Ollama, any OpenAI-compatible server, or Claude).
  Keep sensitive projects on self-hosted backends only; unmatched sessions use `default`.
- **Install / repair:** `./install.sh session-review` from the repo root. **Health:** `session-review status`.
- **Use by hand:** `session-review review <claude|pi> <file>`, `session-review last`, `session-review sweep`,
  or the `/session-review` skill inside Claude Code / pi.

State (queue, index, log): `~/.local/state/session-review/`. A note keeps anything you write
under `## My notes` when it is regenerated.
