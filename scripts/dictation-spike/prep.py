"""Turns each recorded clip into the 16 kHz audio both engines read, and finds
where speech starts and stops.

For every clip it writes:
  out/audio/<clip>.soxr.wav  resampled with a proper filter (soxr, high quality)
  out/audio/<clip>.sdk.wav   resampled the way the Native SDK does it
  out/vad/<clip>.json        stretches of speech, found offline on the filtered audio
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import sherpa_onnx
import soxr

from common import SAMPLE_RATE, VAD_MODEL, read_mono, write_pcm16
from resample_sdk import sdk_resample


def make_vad(min_silence_s: float, max_speech_s: float = 20.0) -> sherpa_onnx.VoiceActivityDetector:
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = str(VAD_MODEL)
    config.silero_vad.threshold = 0.5
    config.silero_vad.min_silence_duration = min_silence_s
    config.silero_vad.min_speech_duration = 0.25
    config.silero_vad.max_speech_duration = max_speech_s
    config.silero_vad.window_size = 512
    config.sample_rate = SAMPLE_RATE
    config.num_threads = 1
    return sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=600)


def speech_segments(samples: np.ndarray) -> list[dict]:
    """Every stretch of speech, split at silences of 0.25 s or more."""
    vad = make_vad(min_silence_s=0.25, max_speech_s=600.0)
    segments = []
    window = 512
    for start in range(0, len(samples), window):
        vad.accept_waveform(samples[start : start + window])
        while not vad.empty():
            segment = vad.front
            segments.append((segment.start, segment.start + len(segment.samples)))
            vad.pop()
    vad.flush()
    while not vad.empty():
        segment = vad.front
        segments.append((segment.start, segment.start + len(segment.samples)))
        vad.pop()
    to_ms = 1000.0 / SAMPLE_RATE
    return [{"start_ms": a * to_ms, "end_ms": b * to_ms} for a, b in segments]


def prepare_clip(wav: Path, out_dir: Path) -> dict:
    samples, rate = read_mono(wav)
    filtered = soxr.resample(samples, rate, SAMPLE_RATE, quality="HQ").astype(np.float32)
    write_pcm16(out_dir / "audio" / f"{wav.stem}.soxr.wav", filtered, SAMPLE_RATE)
    write_pcm16(out_dir / "audio" / f"{wav.stem}.sdk.wav", sdk_resample(samples, rate, SAMPLE_RATE), SAMPLE_RATE)

    segments = speech_segments(filtered)
    info = {
        "clip": wav.stem,
        "source_rate": rate,
        "duration_ms": len(samples) * 1000.0 / rate,
        "segments": segments,
    }
    vad_path = out_dir / "vad" / f"{wav.stem}.json"
    vad_path.parent.mkdir(parents=True, exist_ok=True)
    vad_path.write_text(json.dumps(info, indent=2))
    return info
