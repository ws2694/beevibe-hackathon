#!/usr/bin/env python3
"""
Generate `public/voiceover.wav` from `SCRIPT.md` using Kokoro-82M TTS.

Each `## scene-name (Ns)` block in SCRIPT.md becomes one segment. The
script renders each block, pads with silence (or truncates with a warning)
to match the declared duration, and concatenates them in document order so
the timing lines up scene-for-scene with `BeevibeLaunch` in
`src/theme.ts:SCENE_SECONDS`.

When SCRIPT.md durations match SCENE_SECONDS, the resulting WAV plays in
perfect sync with the on-screen scenes when Remotion mounts it.

------------------------------------------------------------------------
Setup (once):

    cd beevibe/video
    python3 -m venv .venv
    source .venv/bin/activate
    pip install kokoro soundfile numpy

------------------------------------------------------------------------
Run:

    python scripts/generate-vo.py

Pick a voice or pace:

    python scripts/generate-vo.py --voice am_adam --speed 1.0
    python scripts/generate-vo.py --voice bf_emma --speed 0.95

Voices (lang_code='a' = American English; 'b' = British):
    am_michael · am_adam · am_eric            (American male)
    af_bella · af_nicole · af_sky · af_sarah  (American female)
    bm_george · bm_lewis                      (British male)
    bf_emma · bf_isabella · bf_alice          (British female)

------------------------------------------------------------------------
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

try:
    import numpy as np
    import soundfile as sf
    from kokoro import KPipeline
except ImportError as e:
    missing = e.name or "dependency"
    print(f"Missing dependency: {missing}", file=sys.stderr)
    print("Install with:  pip install kokoro soundfile numpy", file=sys.stderr)
    sys.exit(1)


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SCRIPT = ROOT / "SCRIPT.md"
DEFAULT_OUT = ROOT / "public" / "voiceover.wav"
SAMPLE_RATE = 24_000  # Kokoro's native rate

# Matches headers like:  ## intro (5s)      ## general (17.5s)
SCENE_HEADER = re.compile(
    r"^##\s+([\w-]+)\s*\(\s*(\d+(?:\.\d+)?)\s*s\s*\)\s*$",
    re.MULTILINE,
)


def parse_scenes(markdown: str) -> list[tuple[str, float, str]]:
    """Return [(name, duration_sec, text)] in document order."""
    matches = list(SCENE_HEADER.finditer(markdown))
    if not matches:
        raise ValueError(
            "No '## name (Ns)' scene headers found. SCRIPT.md must use "
            "headers like:  ## intro (5s)"
        )

    scenes: list[tuple[str, float, str]] = []
    for i, m in enumerate(matches):
        name = m.group(1)
        duration = float(m.group(2))
        body_start = m.end()
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(markdown)
        body = markdown[body_start:body_end].strip()

        # Drop comment-ish lines, collapse blank lines into one flowing passage
        # so Kokoro reads it naturally instead of pausing for paragraph breaks.
        lines = [
            line.strip()
            for line in body.splitlines()
            if line.strip() and not line.startswith(("#", "<!--", "---"))
        ]
        text = " ".join(lines)
        if not text:
            print(f"⚠ scene '{name}' is empty — emitting silence", file=sys.stderr)
        scenes.append((name, duration, text))
    return scenes


def synth(pipeline: KPipeline, text: str, voice: str, speed: float) -> np.ndarray:
    if not text:
        return np.zeros(0, dtype=np.float32)
    chunks = [audio for _, _, audio in pipeline(text, voice=voice, speed=speed)]
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks)


def fit_to_duration(audio: np.ndarray, duration: float, name: str) -> np.ndarray:
    """Pad with trailing silence to `duration` seconds, or truncate with a warning."""
    target = int(round(duration * SAMPLE_RATE))
    have = len(audio)
    if have == target:
        return audio
    if have > target:
        over = (have - target) / SAMPLE_RATE
        print(
            f"  ⚠ '{name}' is {over:.2f}s over the scene window — truncating. "
            f"Shorten the copy or bump the duration in SCRIPT.md + SCENE_SECONDS.",
            file=sys.stderr,
        )
        return audio[:target]
    pad = np.zeros(target - have, dtype=audio.dtype if audio.size else np.float32)
    return np.concatenate([audio, pad]) if audio.size else pad


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--voice", default="am_michael", help="Kokoro voice id")
    ap.add_argument("--speed", type=float, default=1.0, help="playback speed multiplier")
    ap.add_argument("--lang", default="a", help="Kokoro lang_code ('a'=US, 'b'=UK)")
    ap.add_argument("--script", default=str(DEFAULT_SCRIPT), help="path to SCRIPT.md")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output .wav path")
    args = ap.parse_args()

    script_path = Path(args.script)
    out_path = Path(args.out)

    if not script_path.exists():
        print(f"Script not found: {script_path}", file=sys.stderr)
        sys.exit(2)

    print(f"Reading {script_path}")
    scenes = parse_scenes(script_path.read_text())
    declared_total = sum(d for _, d, _ in scenes)
    print(
        f"Parsed {len(scenes)} scenes, declared total {declared_total:.1f}s "
        f"({int(declared_total // 60)}:{int(declared_total % 60):02d})"
    )

    print(f"Loading Kokoro (lang={args.lang}, voice={args.voice}, speed={args.speed})")
    pipeline = KPipeline(lang_code=args.lang)

    print("Synthesizing:")
    track: list[np.ndarray] = []
    cursor = 0.0
    for name, duration, text in scenes:
        preview = (text[:64] + "…") if len(text) > 64 else text
        print(f"  [{cursor:6.2f}s] {name:>11} ({duration:4.1f}s) — {preview}")
        audio = synth(pipeline, text, args.voice, args.speed)
        track.append(fit_to_duration(audio, duration, name))
        cursor += duration

    out_path.parent.mkdir(parents=True, exist_ok=True)
    final = np.concatenate(track) if track else np.zeros(0, dtype=np.float32)
    sf.write(str(out_path), final, SAMPLE_RATE)
    actual = len(final) / SAMPLE_RATE
    print(f"\nWrote {out_path}  ({actual:.2f}s, target {declared_total:.2f}s)")


if __name__ == "__main__":
    main()
