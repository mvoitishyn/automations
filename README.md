# automations

Small Linux automations for working with AI agents and Obsidian. Each one is a **flow**: a command you run
(or a hook that runs by itself) that turns something you did into a note in your vault, summarised by a
model **you choose**. Sensitive work can stay on self-hosted models end to end.

| Flow | What it does | Runs |
|---|---|---|
| [`meet`](flows/meet) | Records a call (mic + speakers), transcribes it locally with Whisper, summarises it with a self-hosted model, files it in your vault | `meet start …` / `meet stop` |
| [`session-review`](flows/session-review) | When a Claude Code or pi session ends, writes a review note: summary, what went well and wrong, corrections, prompting and agent lessons, follow-ups, full prompt log | automatically, plus an hourly sweep |

## Install

```bash
git clone https://github.com/mvoitishyn/automations.git ~/automations && cd ~/automations
./install.sh --list        # flows and what each needs
./install.sh               # all flows (or: ./install.sh meet)
```

The installer is safe to re-run. It:
- checks each flow's dependencies and skips a flow that is missing some
- links commands into `~/.local/bin`
- creates any missing config in `~/.config/automations/` from the flow's `*.example*` file. **Edit that file**
- runs the flow's own setup, if it has one (hooks, timers)

## Requirements

Any Linux distribution. Tested on Ubuntu 24.04, Debian 12, Fedora 41 and Arch on every push.
`scripts/ci-deps.sh` shows the packages for each distro. Per flow:

- **meet:** `ffmpeg`, `pactl` (PipeWire or PulseAudio), [`uv`](https://docs.astral.sh/uv/), `python3`.
  `notify-send` is optional.
- **session-review:** Node.js ≥ 18 and `jq`, plus Claude Code and/or [pi](https://github.com/earendil-works/pi).
  A systemd user session is optional: it runs the hourly safety-net sweep, and without it you can run
  `session-review sweep` from cron.

For models: [Ollama](https://ollama.com) on your machine is the default. Pull the default model once:
`ollama pull qwen3:4b-instruct-2507-q4_K_M` (about 2.5 GB, fits a 6 GB GPU), or point the config at any model you have. Any OpenAI-compatible server works, such
as vLLM on a GPU box, and `session-review` can also use Claude for projects you allow.

## Layout and rules

```
install.sh                 one installer for every flow
bin/                       the commands (links into flows/)
flows/<name>/              code, README, *.example config, optional install.sh, optional skill/
```

- **Code only.** Config lives in `~/.config/automations/`, outputs in your vault, and state in `~/.local/state/`.
  Nothing personal goes in this repo: no paths, server addresses, names or keys.
- **Self-hosted by default.** A flow only sends data to a cloud model if your config says so.

## Contributing

Turn on the privacy check once per clone: `git config core.hooksPath .githooks`. Before every commit and push,
`scripts/check-private.sh` blocks the following: private IP addresses, home-directory paths, email addresses,
anything shaped like a key, and any word you list in `~/.config/automations/private-words`, such as client names
or internal hostnames. That file stays local. CI runs the same generic checks.

## Adding a flow

1. Create `flows/<name>/` with the code, a `README.md`, and a `<name>.example.*` config if it needs one.
2. Link its command: `ln -s ../flows/<name>/<entry> bin/<name>`.
3. Add it to `needs()` and `provides()` in `install.sh`.
4. If it needs hooks or timers, add an executable `flows/<name>/install.sh`.
5. Add a row to the table above.
