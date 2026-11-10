#!/usr/bin/env python3
"""Summarise a meeting transcript with a LOCAL model (never a cloud provider).

Usage: summarize.py <meeting-folder> [--force]
  Reads  <folder>/<stamp>-transcript.md, writes <folder>/<stamp>-summary.md,
  then renames the folder to <stamp>-<slug> if it has no slug yet. Prints the final folder path.

Backends, first reachable wins (all self-hosted; a cloud provider is never used):
  1. MEET_LLM_URL / MEET_LLM_MODEL / MEET_LLM_KEY, if set (any OpenAI-compatible server)
  2. a provider from pi's ~/.pi/agent/models.json, if MEET_PI_PROVIDER names one (e.g. "vllm")
  3. Ollama on this machine: MEET_LOCAL_URL / MEET_LOCAL_MODEL (chunked, since its context is small)

Prompt context, all optional (from ~/.config/automations/meet.env):
  MEET_OWNER     your name, so the notes know who "I" am
  MEET_ABOUT     one or two lines about your role and organisation, and any jargon
  MEET_GLOSSARY  names the transcriber mishears, e.g. "Akme -> Acme; cubernetes -> Kubernetes"
  MEET_CLIENTS_DIR  a vault folder with one note per client; the summary links the matching one
"""
import json, os, re, sys, urllib.request
from pathlib import Path

env = os.environ.get
PI_MODELS = Path(env("PI_CODING_AGENT_DIR", Path.home() / ".pi/agent")) / "models.json"
LOCAL_URL = env("MEET_LOCAL_URL", "http://localhost:11434/v1")
LOCAL_MODEL = env("MEET_LOCAL_MODEL", "qwen3:4b-instruct-2507-q4_K_M")
OWNER = env("MEET_OWNER", "").strip()
ABOUT = env("MEET_ABOUT", "").strip()
GLOSSARY = env("MEET_GLOSSARY", "").strip()
CLIENTS_DIR = Path(os.path.expanduser(env("MEET_CLIENTS_DIR", ""))) if env("MEET_CLIENTS_DIR") else None


def http(url, body=None, key=None, timeout=10):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json",
                                          **({"Authorization": f"Bearer {key}"} if key else {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def backends():
    if os.environ.get("MEET_LLM_URL"):
        yield os.environ["MEET_LLM_URL"], os.environ.get("MEET_LLM_MODEL"), os.environ.get("MEET_LLM_KEY"), 100_000
    if os.environ.get("MEET_PI_PROVIDER"):
        try:
            p = json.loads(PI_MODELS.read_text())["providers"][os.environ["MEET_PI_PROVIDER"]]
            yield p["baseUrl"], os.environ.get("MEET_PI_MODEL"), p.get("apiKey"), 100_000
        except Exception:
            pass
    yield LOCAL_URL, LOCAL_MODEL, None, 12_000


def pick_backend():
    for url, model, key, ctx_chars in backends():
        try:
            served = [m["id"] for m in http(f"{url}/models", key=key, timeout=4)["data"]]
            model = model if model in served else (served[0] if model is None and served else None)
            if model:
                return url, model, key, ctx_chars
        except Exception as e:
            print(f"  backend {url} unavailable ({e.__class__.__name__})", file=sys.stderr)
    sys.exit("no local LLM backend reachable")


def chat(be, system, user, max_tokens=2500):
    url, model, key, _ = be
    body = {"model": model, "temperature": 0.2, "max_tokens": max_tokens,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    if "11434" in url:
        body["options"] = {"num_ctx": 16384}
    out = http(f"{url}/chat/completions", body, key, timeout=900)["choices"][0]["message"]["content"]
    return re.sub(r"<think>.*?</think>", "", out, flags=re.S).strip()


clients = sorted(p.stem for p in CLIENTS_DIR.glob("*.md")) if CLIENTS_DIR and CLIENTS_DIR.is_dir() else []
me = OWNER or "the user"
SYSTEM = "\n".join(l for l in [
    f"You write concise meeting notes for {me}." + (f" About them: {ABOUT}" if ABOUT else ""),
    "The transcript is automatic speech recognition: names, companies and product names are often misheard; fix obvious ones.",
    f"Known mishearings: {GLOSSARY}." if GLOSSARY else "",
    f"Known clients (vault slugs): {', '.join(clients)}." if clients else "",
    "Rules:",
    "- Write only the corrected names; never repeat a misheard form, never \"(corrected from ...)\".",
    "- The transcript has no speaker labels. Use the CONTEXT line (if given) to know who attended."
    + (f" People addressed as \"{OWNER}\" are talking TO {OWNER}." if OWNER else ""),
    "- Every action is \"- [ ]\" (unchecked). Deadlines only if said explicitly.",
    "- Ignore small talk and anything after the meeting clearly ends. Be factual; don't invent decisions or names.",
] if l)

FORMAT = """Reply in EXACTLY this format, nothing before it:
TITLE: <short descriptive title>
SLUG: <kebab-case, 2-6 words, start with the client slug if there is one>
CLIENT: <one known client slug, or none>
ATTENDEES: <comma-separated names that clearly took part>
---
## Context
- <what this meeting was about, data/background mentioned>
## Key points / decisions
- <bullets>
## Actions
- [ ] **<owner>:** <action> (<deadline if said>)
## Open questions
- <bullets, or "- none">"""


def main():
    folder = Path(sys.argv[1]).resolve()
    force = "--force" in sys.argv
    tx = next(folder.glob("*-transcript.md"))
    stamp = tx.name.removesuffix("-transcript.md")
    out = folder / f"{stamp}-summary.md"
    if out.exists() and not force:
        print(f"  {out.name} exists, not overwriting (use --force)", file=sys.stderr)
        print(folder); return

    body = "\n".join(l for l in tx.read_text().splitlines() if re.match(r"\[\d\d:\d\d:\d\d\]", l))
    if len(body) < 200:
        print("  transcript too short to summarise", file=sys.stderr); print(folder); return

    be = pick_backend()
    print(f"  summarising with {be[1]} @ {be[0]}", file=sys.stderr)
    limit = be[3]
    if len(body) > limit:  # map-reduce for small-context models
        lines, chunks, cur = body.splitlines(), [], ""
        for l in lines:
            if len(cur) + len(l) > limit:
                chunks.append(cur); cur = ""
            cur += l + "\n"
        chunks.append(cur)
        notes = [chat(be, SYSTEM, f"Part {i+1}/{len(chunks)} of a meeting transcript. Extract detailed factual notes: "
                      f"topics, data, decisions, action items with owners, names.\n\n{c}", 1500)
                 for i, c in enumerate(chunks)]
        body = "Notes from consecutive parts of one meeting:\n\n" + "\n\n".join(notes)
    ctx_file = folder / "context.txt"
    ctx = f"CONTEXT: {ctx_file.read_text().strip()}\n\n" if ctx_file.exists() else ""
    raw = chat(be, SYSTEM, f"{FORMAT}\n\n{ctx}TRANSCRIPT:\n{body}")

    raw = "\n".join(l.rstrip() for l in raw.splitlines())
    parts = re.split(r"^-{3,}$", raw, maxsplit=1, flags=re.M)
    head, md = (parts[0], parts[1]) if len(parts) == 2 else (raw, "")
    if not md:  # no separator: drop header lines from the body
        md = "\n".join(l for l in raw.splitlines() if not re.match(r"^(TITLE|SLUG|CLIENT|ATTENDEES):", l))
    meta = dict(re.findall(r"^(TITLE|SLUG|CLIENT|ATTENDEES):\s*(.+)$", head, re.M))
    title = meta.get("TITLE", f"Meeting {stamp}").strip()
    slug = re.sub(r"[^a-z0-9]+", "-", meta.get("SLUG", "").lower()).strip("-")[:60]
    client = meta.get("CLIENT", "none").strip().lower()
    client_fm = f'"[[{client}]]"' if client in clients else ""
    date = stamp[:10]
    note = f"""---
type: meeting
date: {date}
client: {client_fm}
attendees: {meta.get("ATTENDEES", "").strip()}
status: active
tags: [type/meeting]
recording: "[[{stamp}-recording.wav]]"
transcript: "[[{stamp}-transcript]]"
summarised_by: {be[1]} (local)
---

# {title}

{md.strip()}

## Recording
- Raw audio: ![[{stamp}-recording.wav]]
- Full transcript: [[{stamp}-transcript]]
"""
    out.write_text(note)
    if slug and folder.name == stamp:
        new = folder.with_name(f"{stamp}-{slug}")
        if not new.exists():
            folder.rename(new); folder = new
    print(folder)


if __name__ == "__main__":
    main()
