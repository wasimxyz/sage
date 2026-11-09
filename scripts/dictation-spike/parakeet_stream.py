"""Streams a 16 kHz clip through Parakeet the way Sage would, and writes one
JSON line per result (the same shape as the Apple runner).

Parakeet reads a whole stretch of audio at once, so live text works like this:
  - Silero VAD watches 20 ms chunks for speech.
  - Once it hears speech, Sage re-reads the phrase so far: first after 250 ms,
    then every 500 ms. That is the grey text.
  - When the VAD hears 0.5 s of silence, or a phrase reaches 20 s, Sage reads
    the phrase once more. That is the final text.

One worker does all the reading, as it would in Sage. With --realtime the
audio is fed against the wall clock. Without it, the clip runs as fast as the
model allows and a simulated clock replays the timing: a read starts once its
audio has arrived and the worker is free, and takes as long as it really took.
A re-read is skipped while the worker is still busy, as Sage would skip it.

  uv run parakeet_stream.py --input clip.wav --out events.jsonl [--realtime]
"""

from __future__ import annotations

import argparse
import re
import resource
import time
from pathlib import Path

import numpy as np
import sherpa_onnx

from common import PARAKEET_DIR, SAMPLE_RATE, EventLog, Stopwatch, read_mono
from prep import make_vad

CHUNK = SAMPLE_RATE // 50  # 20 ms, like the SDK's capture chunks
PAD = SAMPLE_RATE // 5  # 200 ms of context around a phrase


def make_recognizer(threads: int) -> sherpa_onnx.OfflineRecognizer:
    d = PARAKEET_DIR
    return sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(d / "encoder.int8.onnx"),
        decoder=str(d / "decoder.int8.onnx"),
        joiner=str(d / "joiner.int8.onnx"),
        tokens=str(d / "tokens.txt"),
        num_threads=threads,
        sample_rate=SAMPLE_RATE,
        feature_dim=80,
        decoding_method="greedy_search",
        model_type="nemo_transducer",
    )


def transcribe(recognizer: sherpa_onnx.OfflineRecognizer, samples: np.ndarray) -> str:
    stream = recognizer.create_stream()
    stream.accept_waveform(SAMPLE_RATE, samples)
    recognizer.decode_stream(stream)
    # sherpa-onnx joins a "$" token to the word before it ("are$1,284").
    # Sage would put the space back the same way.
    return re.sub(r"(?<=\S)\$", " $", stream.result.text.strip())


def ms(samples: int) -> float:
    return samples * 1000.0 / SAMPLE_RATE


def run(
    wav: Path,
    out: Path,
    *,
    recognizer: sherpa_onnx.OfflineRecognizer | None = None,
    threads: int = 6,
    realtime: bool = False,
    first_partial_ms: float = 250.0,
    partial_every_ms: float = 500.0,
    min_silence_s: float = 0.5,
) -> None:
    load = Stopwatch()
    if recognizer is None:
        recognizer = make_recognizer(threads)
    load_ms = load.ms()

    samples, rate = read_mono(wav)
    if rate != SAMPLE_RATE:
        raise SystemExit(f"{wav} is {rate} Hz; run prep first")
    vad = make_vad(min_silence_s=min_silence_s, max_speech_s=20.0)
    log = EventLog(out)
    log.write(
        {
            "kind": "meta",
            "engine": "parakeet",
            "mode": "realtime" if realtime else "simulated",
            "threads": threads,
            "audio_ms": ms(len(samples)),
            "load_ms": load_ms,
            "first_partial_ms": first_partial_ms,
            "partial_every_ms": partial_every_ms,
            "min_silence_s": min_silence_s,
        }
    )

    clock = Stopwatch()
    worker_free_ms = 0.0
    next_partial_ms: float | None = None

    def read(what: str, start: int, end: int, due_ms: float) -> tuple[str, float]:
        nonlocal worker_free_ms
        audio = samples[max(0, start) : end]
        began = time.perf_counter()
        text = transcribe(recognizer, audio)
        took = (time.perf_counter() - began) * 1000.0
        if realtime:
            wall = clock.ms()
        else:
            wall = max(due_ms, worker_free_ms) + took
            worker_free_ms = wall
        log.write({"kind": "decode", "what": what, "audio_len_ms": ms(len(audio)), "decode_ms": took, "wall_ms": wall})
        return text, wall

    def settle_finished(received: int, now_ms: float) -> None:
        nonlocal next_partial_ms
        while not vad.empty():
            # Read the segment before pop(), which frees it.
            segment = vad.front
            start = segment.start
            end = start + len(segment.samples)
            vad.pop()
            text, wall = read("final", start - PAD, min(received, end + PAD), now_ms)
            log.write(
                {"kind": "final", "text": text, "wall_ms": wall, "audio_start_ms": ms(start), "audio_end_ms": ms(end)}
            )
            next_partial_ms = None

    received = 0
    for offset in range(0, len(samples), CHUNK):
        received = min(offset + CHUNK, len(samples))
        now_ms = ms(received)
        if realtime:
            ahead = now_ms - clock.ms()
            if ahead > 0:
                time.sleep(ahead / 1000.0)
        vad.accept_waveform(samples[offset:received])
        settle_finished(received, now_ms)

        if not vad.is_speech_detected():
            next_partial_ms = None
            continue
        if next_partial_ms is None:
            next_partial_ms = now_ms + first_partial_ms
        if now_ms < next_partial_ms:
            continue
        busy = (clock.ms() - now_ms > 100.0) if realtime else (worker_free_ms > now_ms)
        if busy:
            continue
        current = vad.current_segment
        text, wall = read("partial", current.start - PAD, received, now_ms)
        if text:
            log.write(
                {
                    "kind": "volatile",
                    "text": text,
                    "wall_ms": wall,
                    "audio_start_ms": ms(current.start),
                    "audio_end_ms": now_ms,
                }
            )
        next_partial_ms = now_ms + partial_every_ms

    # Pressing Stop: no more audio, settle whatever is still grey.
    end_ms = ms(len(samples))
    log.write({"kind": "input_end", "wall_ms": clock.ms() if realtime else end_ms})
    vad.flush()
    settle_finished(len(samples), end_ms)
    log.write(
        {
            "kind": "end",
            "wall_ms": clock.ms() if realtime else max(end_ms, worker_free_ms),
            "peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        }
    )
    log.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=6)
    parser.add_argument("--realtime", action="store_true")
    args = parser.parse_args()
    run(args.input, args.out, threads=args.threads, realtime=args.realtime)


if __name__ == "__main__":
    main()
