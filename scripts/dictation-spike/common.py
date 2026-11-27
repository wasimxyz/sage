"""Paths and small helpers shared by the dictation voice test."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

import numpy as np
import soundfile as sf

SPIKE_DIR = Path(__file__).resolve().parent
REPO_DIR = SPIKE_DIR.parents[1]
MODELS_DIR = REPO_DIR / "third_party" / "dictation-spike"
PARAKEET_DIR = MODELS_DIR / "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"
VAD_MODEL = MODELS_DIR / "silero_vad.onnx"
APPLE_BIN = SPIKE_DIR / ".build" / "transcribe-apple"
SCRIPT_DIR = SPIKE_DIR / "script"

SAMPLE_RATE = 16_000


def read_mono(path: Path) -> tuple[np.ndarray, int]:
    """Reads a WAV as float32 in [-1, 1], mixing stereo down to mono."""
    samples, rate = sf.read(str(path), dtype="float32", always_2d=True)
    return samples.mean(axis=1).astype(np.float32), int(rate)


def write_pcm16(path: Path, samples: np.ndarray, rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if samples.dtype != np.int16:
        samples = np.clip(np.rint(samples * 32767.0), -32768, 32767).astype(np.int16)
    sf.write(str(path), samples, rate, subtype="PCM_16")


def read_events(path: Path) -> list[dict]:
    with path.open() as handle:
        return [json.loads(line) for line in handle if line.strip()]


class EventLog:
    """Writes one JSON object per line, the same shape the Swift runner writes."""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = path.open("w")

    def write(self, event: dict) -> None:
        self.handle.write(json.dumps(event, sort_keys=True, ensure_ascii=False) + "\n")
        self.handle.flush()

    def close(self) -> None:
        self.handle.close()


def collapse_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def final_text(events: list[dict]) -> str:
    """The settled transcript: every final result, in order."""
    return collapse_spaces(" ".join(e["text"] for e in events if e["kind"] == "final"))


def reference_text(path: Path) -> str:
    """A reference transcript, with any [bracketed directions] removed."""
    return collapse_spaces(re.sub(r"\[[^\]]*\]", " ", path.read_text()))


class Stopwatch:
    def __init__(self) -> None:
        self.start = time.perf_counter()

    def ms(self) -> float:
        return (time.perf_counter() - self.start) * 1000.0


def clip_names(clips_dir: Path, only: list[str] | None) -> list[str]:
    names = sorted(p.stem for p in clips_dir.glob("*.wav"))
    if only:
        missing = [name for name in only if name not in names]
        if missing:
            raise SystemExit(f"No WAV for: {', '.join(missing)} in {clips_dir}")
        names = [name for name in names if name in only]
    return names
