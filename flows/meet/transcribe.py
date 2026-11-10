# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["faster-whisper>=1.0", "numpy"]
# ///
"""Transcribe a meeting recording with faster-whisper.

Usage: uv run transcribe.py <audio.wav> [model] [language]
  model defaults to small.en (already cached); try large-v3-turbo for non-English / better accuracy.
"""
import sys, time, subprocess
import numpy as np
from pathlib import Path
from faster_whisper import WhisperModel

audio = Path(sys.argv[1])
model_name = sys.argv[2] if len(sys.argv) > 2 else "small.en"
language = sys.argv[3] if len(sys.argv) > 3 else None

# decode with system ffmpeg (avoids PyAV version issues)
raw = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(audio), "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
                     capture_output=True, check=True).stdout
pcm = np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0

try:
    model = WhisperModel(model_name, device="cuda", compute_type="int8_float16")
    # force a tiny run so missing CUDA libs fail here, not mid-transcript
    list(model.transcribe(pcm[:16000], language=language or ("en" if model_name.endswith(".en") else None))[0])
    print("using GPU", file=sys.stderr)
except Exception as e:
    print(f"GPU unavailable ({e.__class__.__name__}), using CPU", file=sys.stderr)
    model = WhisperModel(model_name, device="cpu", compute_type="int8")

t0 = time.time()
segments, info = model.transcribe(pcm, language=language, vad_filter=True, beam_size=5)
print(f"language={info.language} duration={info.duration/60:.1f}min", file=sys.stderr)

def ts(s):
    return f"{int(s//3600):02d}:{int(s%3600//60):02d}:{int(s%60):02d}"

stamp = audio.stem.removesuffix("-recording")
out = audio.with_name(f"{stamp}-transcript.md") if audio.stem.endswith("-recording") else audio.with_suffix(".md")
with out.open("w") as f:
    if audio.stem.endswith("-recording"):  # Obsidian meeting folder: link back to summary + audio
        f.write(f'---\ntype: transcript\nsummary: "[[{stamp}-summary]]"\n---\n\n')
        f.write(f"# Raw transcript — {stamp}\n\n> Summary: [[{stamp}-summary]] · Audio: ![[{audio.name}]]\n\n")
    else:
        f.write(f"# Transcript — {audio.stem}\n\n")
    for seg in segments:
        line = f"[{ts(seg.start)}] {seg.text.strip()}"
        print(line, flush=True)
        f.write(line + "\n\n")
print(f"\nwrote {out} in {time.time()-t0:.0f}s", file=sys.stderr)
