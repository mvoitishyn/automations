---
name: session-review
description: Summarize and analyse coding-agent sessions (Claude Code, pi) into Obsidian — prompts, outputs, what went well, what went wrong, corrections, lessons, follow-ups. Runs automatically when a session ends; use this skill to review a session on demand, re-run a review, find past session notes, or check that the automation is healthy. Triggers: "review this session", "summarize the session into obsidian", "session notes", "is session review working", "what went wrong in my last sessions", "/session-review".
---

# Session review

Every Claude Code and pi session is reviewed automatically when it ends, and a note is written to an Obsidian vault.
Which vault, folder and model is decided per project directory in `~/.config/automations/session-review.json`
(`routes` → first matching `match` prefix; otherwise `default`). Read that file to know where notes land and which
routes are restricted to self-hosted models.

CLI: `session-review <command>` (on PATH after install).

## What to do

**"Is it working?"** → run `session-review status` and report each ✗ with its fix:
- hook / extension / timer missing → re-run `./install.sh session-review` in the automations repo.
- a backend ✗ → that model server is unreachable; the next backend in the route is used, and the hourly sweep retries.
- unreviewed sessions > 0 → `session-review sweep` (foreground; can take a while).

**"Review this session" / "summarize this into Obsidian"** → the current session is still open, so review it as it stands:
- Claude Code: the newest `.jsonl` in `~/.claude/projects/<cwd with every / replaced by ->/`. Run `session-review review claude <file> --force`.
- pi: the newest `.jsonl` in `~/.pi/agent/sessions/--<cwd>--/`. Run `session-review review pi <file> --force`.
It is reviewed again when the session ends; the note is updated in place and anything under `## My notes` is kept.

**"Show my last session notes"** → `session-review last 10`, then read the notes asked about.

**"What keeps going wrong?" / patterns across sessions** → grep the `## What went wrong`, `## Friction and corrections`
and `## Agent lessons` sections of recent notes (don't load whole notes) and summarize recurring themes.
If those notes come from a route restricted to self-hosted models and you are a cloud model, say so and ask first.

**Turn lessons into rules** → when asked, propose concrete additions to the project's `CLAUDE.md` / `AGENTS.md`
from the `## Agent lessons` sections, and show them before writing.

Never send the content of a route restricted to self-hosted models to a cloud model or external service.
