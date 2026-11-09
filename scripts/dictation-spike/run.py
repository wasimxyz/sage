"""Runs the dictation voice test from start to finish. See README.md.

  uv run run.py setup          make the data folder and copy in the reference scripts
  uv run run.py                prepare audio, run both engines, score
  uv run run.py score          score the runs already on disk

Useful options for `run`:
  --clips clip-1,clip-3        only these clips
  --skip-loaded                no pass with the Chat model loaded in Ollama
  --skip-resample              no check of the Native SDK's resampler
  --busy                       keep the Chat model generating during the loaded pass,
                               as if Dream were running
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from common import (
    APPLE_BIN,
    PARAKEET_DIR,
    REPO_DIR,
    SCRIPT_DIR,
    SPIKE_DIR,
    VAD_MODEL,
    clip_names,
    reference_text,
)
from prep import prepare_clip
from score import APPLE_ENGINES, best_apple, score_run, write_report

OLLAMA_URL = "http://127.0.0.1:11436"  # the port make dev uses; Sage never uses 11434
SCRIPTED_CLIPS = [f"clip-{n}" for n in range(1, 6)]


def setup(data: Path) -> None:
    for folder in ("clips", "refs", "out"):
        (data / folder).mkdir(parents=True, exist_ok=True)
    for clip in SCRIPTED_CLIPS:
        ref = data / "refs" / f"{clip}.txt"
        if ref.exists():
            print(f"kept     {ref}")
            continue
        ref.write_text(reference_text(SCRIPT_DIR / f"{clip}.txt") + "\n")
        print(f"wrote    {ref}")
    print(f"\nRead from {SCRIPT_DIR / 'reading-script.md'}.")
    print(f"Put clip-1.wav ... clip-6.wav in {data / 'clips'}, and write {data / 'refs' / 'clip-6.txt'} by hand.")


# --- engines ----------------------------------------------------------------


def ensure_models() -> None:
    if VAD_MODEL.exists() and (PARAKEET_DIR / "encoder.int8.onnx").exists():
        return
    subprocess.run([str(SPIKE_DIR / "fetch-models.sh")], check=True)


def ensure_apple_built() -> None:
    source = SPIKE_DIR / "apple" / "Transcribe.swift"
    if APPLE_BIN.exists() and APPLE_BIN.stat().st_mtime >= source.stat().st_mtime:
        return
    print("Building the Apple runner…", flush=True)
    subprocess.run([str(SPIKE_DIR / "apple" / "build.sh")], check=True)


APPLE_MODELS = {"apple": "speech", "apple-dictation": "dictation"}


def run_apple(engine: str, audio: Path, out: Path, fast: bool) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    command = [str(APPLE_BIN), "run", "--model", APPLE_MODELS[engine], "--input", str(audio), "--out", str(out)]
    if fast:
        command.append("--fast")
    subprocess.run(command, check=True)


class Parakeet:
    """Loads the model once and reuses it for every clip."""

    def __init__(self, threads: int):
        import parakeet_stream

        self.module = parakeet_stream
        self.threads = threads
        self.recognizer = None

    def run(self, audio: Path, out: Path) -> None:
        if self.recognizer is None:
            print("Loading Parakeet…", flush=True)
            self.recognizer = self.module.make_recognizer(self.threads)
        self.module.run(audio, out, recognizer=self.recognizer, threads=self.threads)


def run_config(
    config: str, variant: str, fast_apple: bool, clips: list[str], engines: list[str], out: Path, parakeet: Parakeet
) -> None:
    for clip in clips:
        audio = out / "audio" / f"{clip}.{variant}.wav"
        for engine in engines:
            target = out / "runs" / config / engine / f"{clip}.jsonl"
            if engine in APPLE_ENGINES:
                pace = "fast" if fast_apple else "real time"
            else:
                pace = "simulated clock"
            print(f"[{config}] {engine:<15} {clip} ({pace})", flush=True)
            if engine in APPLE_ENGINES:
                run_apple(engine, audio, target, fast=fast_apple)
            else:
                parakeet.run(audio, target)


# --- Ollama -------------------------------------------------------------------


def ollama_request(path: str, body: dict | None = None, timeout: float = 600.0) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(OLLAMA_URL + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read() or b"{}")


def ollama_up() -> bool:
    try:
        ollama_request("/api/tags", timeout=2.0)
        return True
    except (urllib.error.URLError, OSError):
        return False


def start_ollama(log_path: Path) -> subprocess.Popen:
    binary = (
        subprocess.run([str(REPO_DIR / "scripts" / "fetch-ollama.sh")], check=True, capture_output=True, text=True)
        .stdout.strip()
        .splitlines()[-1]
    )
    env = {**os.environ, "OLLAMA_HOST": OLLAMA_URL.removeprefix("http://"), "OLLAMA_NO_CLOUD": "1"}
    log = log_path.open("a")
    process = subprocess.Popen([binary, "serve"], env=env, stdout=log, stderr=log, start_new_session=True)
    for _ in range(60):
        if ollama_up():
            return process
        time.sleep(0.5)
    process.terminate()
    raise SystemExit(f"Ollama did not start on {OLLAMA_URL}; see {log_path}")


BUSY_PROMPT = (
    "Summarize this journal entry in three sentences.\n\n"
    + "Today I walked to the market, spoke with a neighbor about the garden, and spent the afternoon "
    "reading. I felt calm but a little restless, and I keep wondering whether I should change jobs. " * 20
)


class LoadedModel:
    """Loads the Chat model for the loaded pass, and optionally keeps it busy."""

    def __init__(self, model: str, busy: bool, out: Path):
        self.model, self.busy, self.out = model, busy, out
        self.server: subprocess.Popen | None = None
        self.stop = threading.Event()
        self.thread: threading.Thread | None = None

    def __enter__(self) -> LoadedModel:
        if not ollama_up():
            print(f"Starting Sage's pinned Ollama on {OLLAMA_URL}…", flush=True)
            self.server = start_ollama(self.out / "ollama.log")
        names = {m["name"] for m in ollama_request("/api/tags").get("models", [])}
        if self.model not in names:
            self.__exit__(None, None, None)
            raise SystemExit(f"{self.model} is not pulled. Pull it, or use --skip-loaded.")
        print(f"Loading {self.model}…", flush=True)
        ollama_request("/api/generate", {"model": self.model, "keep_alive": "30m", "stream": False})
        if self.busy:
            self.thread = threading.Thread(target=self._keep_busy, daemon=True)
            self.thread.start()
        return self

    def _keep_busy(self) -> None:
        while not self.stop.is_set():
            try:
                ollama_request(
                    "/api/generate",
                    {
                        "model": self.model,
                        "prompt": BUSY_PROMPT,
                        "stream": False,
                        "think": False,
                        "keep_alive": "30m",
                        "options": {"num_predict": 200},
                    },
                )
            except (urllib.error.URLError, OSError):
                time.sleep(1.0)

    def __exit__(self, *_: object) -> None:
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=120)
        try:
            ollama_request("/api/generate", {"model": self.model, "keep_alive": 0, "stream": False}, timeout=30)
        except (urllib.error.URLError, OSError):
            pass
        if self.server:
            self.server.terminate()
            self.server.wait(timeout=10)


# --- main ---------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", nargs="?", default="run", choices=["setup", "run", "score"])
    parser.add_argument("--data", type=Path, default=Path.home() / "SageDictationSpike")
    parser.add_argument("--clips", type=lambda s: [c.strip() for c in s.split(",") if c.strip()])
    parser.add_argument("--engines", type=lambda s: s.split(","), default=["apple", "apple-dictation", "parakeet"])
    parser.add_argument("--model", default="qwen3.5:9b")
    parser.add_argument("--threads", type=int, default=6)
    parser.add_argument("--busy", action="store_true")
    parser.add_argument("--skip-loaded", action="store_true")
    parser.add_argument("--skip-resample", action="store_true")
    args = parser.parse_args()

    data = args.data.expanduser()
    if args.command == "setup":
        setup(data)
        return

    out, refs = data / "out", data / "refs"
    if args.command == "run":
        clips = clip_names(data / "clips", args.clips)
        if not clips:
            raise SystemExit(f"No clips in {data / 'clips'}. Run `uv run run.py setup` and record first.")
        missing = [c for c in clips if not (refs / f"{c}.txt").exists()]
        if missing:
            print(f"No reference transcript for {', '.join(missing)}: timing only, no accuracy.", file=sys.stderr)
        ensure_models()

        for clip in clips:
            info = prepare_clip(data / "clips" / f"{clip}.wav", out)
            print(
                f"prepared {clip}: {info['duration_ms'] / 1000:.0f} s at {info['source_rate']} Hz, "
                f"{len(info['segments'])} stretches of speech",
                flush=True,
            )
            if info["source_rate"] != 48_000:
                print(f"  note: {clip} is {info['source_rate']} Hz, not 48 kHz", file=sys.stderr)

        if any(engine in APPLE_ENGINES for engine in args.engines):
            ensure_apple_built()
        parakeet = Parakeet(args.threads)
        for config in ("live", "fast-soxr", "fast-sdk", "loaded"):
            shutil.rmtree(out / "runs" / config, ignore_errors=True)

        run_config("live", "soxr", False, clips, args.engines, out, parakeet)
        if not args.skip_resample:
            run_config("fast-soxr", "soxr", True, clips, args.engines, out, parakeet)
            run_config("fast-sdk", "sdk", True, clips, args.engines, out, parakeet)
        if not args.skip_loaded:
            # Only Apple's better mode from the live pass runs again, to save time.
            live = {
                name: score
                for name in args.engines
                if (score := score_run(out / "runs" / "live" / name, refs, out / "vad"))
            }
            apple = best_apple(live)
            engines = [name for name in args.engines if name not in APPLE_ENGINES or name == apple]
            with LoadedModel(args.model, args.busy, out):
                run_config("loaded", "soxr", False, clips, engines, out, parakeet)

    print()
    print(write_report(out, refs))
    print(f"\nReport: {out / 'report.md'}")


if __name__ == "__main__":
    main()
