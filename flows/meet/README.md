# meet

One command for meeting notes. It records the call (your mic plus whatever your speakers play), transcribes
locally with [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (GPU if available), summarises with a
self-hosted model, and files everything in your vault.

```bash
meet start with Anna and Ben, Acme pricing review   # context helps names and the client link
meet stop                                         # stop → transcribe → summarise, in the background
meet                                              # toggle start/stop
meet status                                       # recording? last log lines
meet redo <meeting-folder>                        # re-run transcript + summary
```

Each meeting gets a folder `MEET_DIR/<YYYY-MM-DD-HHMM>-<slug>/` containing the recording, a timestamped
transcript, and a summary. The summary covers context, decisions, `- [ ]` actions with owners, and open
questions, and links the client note if you set `MEET_CLIENTS_DIR`.

**Config:** `~/.config/automations/meet.env` (see [`meet.env.example`](meet.env.example)). Set `MEET_DIR`
to a folder in your vault, and fill in `MEET_OWNER`, `MEET_ABOUT` and `MEET_GLOSSARY` so names and jargon come
out right.

**Models:** summaries never go to a cloud provider. Backends are tried in order: `MEET_LLM_URL`
(any OpenAI-compatible server), then a provider from pi's `models.json` (`MEET_PI_PROVIDER`), then local Ollama.

Plug in your headset *before* `meet start`: the recording uses the default mic and speakers at that moment.
