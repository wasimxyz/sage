"""Scores every run against the reference transcripts and writes out/report.md.

Runs live in out/runs/<config>/<engine>/<clip>.jsonl. The configs are:
  live       filtered audio, Apple fed at real-time speed, Parakeet on its
             simulated clock. Accuracy and live-text timing come from here.
  fast-soxr  filtered audio, fed as fast as possible. Accuracy only.
  fast-sdk   audio resampled the way the Native SDK does it. Accuracy only.
  loaded     like live, with the Chat model loaded in Ollama.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import jiwer
import numpy as np
from whisper_normalizer.english import EnglishTextNormalizer

from common import collapse_spaces, final_text, read_events, reference_text

ENGINES = ("apple", "apple-dictation", "parakeet")
APPLE_ENGINES = ("apple", "apple-dictation")
NAMES = {"apple": "Apple (speech)", "apple-dictation": "Apple (dictation)", "parakeet": "Parakeet"}
CONFIGS = ("live", "fast-soxr", "fast-sdk", "loaded")

PAUSE_MS = 1000.0  # a gap this long is a pause you would notice
EDGE_MS = 300.0  # slack between the offline VAD's edges and an engine's ranges

# The decision rule from the plan.
CLEARLY_BETTER = 0.75  # Parakeet must make at most 75% of Apple's word errors
MAX_FIRST_TEXT_MS = 1000.0
MAX_SETTLE_MS = 1500.0
MAX_DECODE_15S_MS = 300.0
MAX_PEAK_BYTES = 1.5e9
MAX_RESAMPLER_COST = 0.01  # one point of word error rate

normalizer = EnglishTextNormalizer()


@dataclass
class Errors:
    words: int = 0
    substitutions: int = 0
    deletions: int = 0
    insertions: int = 0

    @property
    def errors(self) -> int:
        return self.substitutions + self.deletions + self.insertions

    @property
    def rate(self) -> float:
        return self.errors / self.words if self.words else math.nan

    def __add__(self, other: Errors) -> Errors:
        return Errors(
            self.words + other.words,
            self.substitutions + other.substitutions,
            self.deletions + other.deletions,
            self.insertions + other.insertions,
        )


def count_errors(reference: str, hypothesis: str, normalize: bool) -> Errors:
    if normalize:
        reference, hypothesis = normalizer(reference), normalizer(hypothesis)
    reference, hypothesis = collapse_spaces(reference), collapse_spaces(hypothesis)
    words = len(reference.split())
    if words == 0:
        return Errors()
    if not hypothesis:
        return Errors(words=words, deletions=words)
    result = jiwer.process_words(reference, hypothesis)
    return Errors(words, result.substitutions, result.deletions, result.insertions)


def phrases(segments: list[dict]) -> list[tuple[float, float]]:
    """Joins stretches of speech separated by less than PAUSE_MS."""
    joined: list[list[float]] = []
    for segment in segments:
        if joined and segment["start_ms"] - joined[-1][1] < PAUSE_MS:
            joined[-1][1] = segment["end_ms"]
        else:
            joined.append([segment["start_ms"], segment["end_ms"]])
    return [(a, b) for a, b in joined]


def visible_words(events: list[dict]) -> list[tuple[float, int, dict]]:
    """After each result: (time, words on screen, the result). Words on screen
    are every final so far plus the current grey tail."""
    settled, grey, timeline = 0, 0, []
    for event in events:
        if event["kind"] == "final":
            settled += len(normalizer(event["text"]).split())
            grey = 0
        elif event["kind"] == "volatile":
            grey = len(normalizer(event["text"]).split())
        else:
            continue
        timeline.append((event["wall_ms"], settled + grey, event))
    return timeline


def first_text_ms(events: list[dict], spoken: list[tuple[float, float]]) -> list[float]:
    """For each phrase: how long after you start talking its first words show.

    That is the first result after the phrase starts that puts more words on
    screen. A final that only settles the previous phrase doesn't count. Grey
    results can't be told apart by audio range, because Apple's runs ahead.
    """
    timeline = visible_words(events)
    delays = []
    for start, _ in spoken:
        before = max((count for wall, count, _ in timeline if wall < start), default=0)
        for wall, count, event in timeline:
            if wall < start or count <= before:
                continue
            if event["kind"] == "final" and event.get("audio_end_ms", math.inf) <= start + EDGE_MS:
                before = count
                continue
            delays.append(wall - start)
            break
    return delays


def settle_ms(events: list[dict], spoken: list[tuple[float, float]]) -> tuple[list[float], int]:
    """For each pause: how long after you stop talking the phrase is final.

    The last phrase is left out, because pressing Stop settles it. Also returns
    how many phrases were still grey when you started talking again.
    """
    finals = [e for e in events if e["kind"] == "final" and e["text"].strip()]
    delays, still_grey = [], 0
    for index in range(len(spoken) - 1):
        start, end = spoken[index]
        next_start = spoken[index + 1][0]
        hit = next(
            (
                f
                for f in finals
                if f.get("audio_end_ms", f["wall_ms"]) >= end - EDGE_MS and f.get("audio_start_ms", -math.inf) < end
            ),
            None,
        )
        if hit is None:
            continue
        delay = max(0.0, hit["wall_ms"] - end)
        delays.append(delay)
        if end + delay > next_start:
            still_grey += 1
    return delays, still_grey


def rewrites(events: list[dict]) -> tuple[int, int]:
    """How often grey text changes words it already showed, not counting its
    last word, which is often half-heard. Returns (rewrites, updates)."""
    changed = updates = 0
    previous: list[str] | None = None
    for event in events:
        if event["kind"] == "final":
            previous = None
            continue
        if event["kind"] != "volatile":
            continue
        words = normalizer(event["text"]).split()
        if previous is not None:
            updates += 1
            kept = previous[:-1]
            if words[: len(kept)] != kept:
                changed += 1
        previous = words
    return changed, updates


def percentile(values: list[float], p: float) -> float:
    return float(np.percentile(values, p)) if values else math.nan


@dataclass
class RunScore:
    normalized: Errors = field(default_factory=Errors)
    formatted: Errors = field(default_factory=Errors)
    per_clip: dict[str, tuple[Errors, Errors]] = field(default_factory=dict)
    first_text: list[float] = field(default_factory=list)
    settle: list[float] = field(default_factory=list)
    pauses: int = 0
    still_grey: int = 0
    stop_ms: list[float] = field(default_factory=list)
    rewrites: int = 0
    updates: int = 0
    startup_ms: list[float] = field(default_factory=list)
    peak_bytes: int = 0
    decodes: list[tuple[float, float]] = field(default_factory=list)  # (audio ms, decode ms)
    finals: dict[str, str] = field(default_factory=dict)

    def decode_15s_p90(self) -> float:
        """How long Parakeet takes to read a 15 s phrase, 90th percentile.

        Uses reads of 10-20 s of audio, scaled to 15 s. With too few of those,
        fits a line through every read instead."""
        long_reads = [d * 15000.0 / a for a, d in self.decodes if 10000.0 <= a <= 20000.0]
        if len(long_reads) >= 10:
            return percentile(long_reads, 90)
        if len(self.decodes) < 2:
            return math.nan
        audio = np.array([a for a, _ in self.decodes])
        took = np.array([d for _, d in self.decodes])
        slope, intercept = np.polyfit(audio, took, 1)
        residual = np.percentile(took - (slope * audio + intercept), 90)
        return float(slope * 15000.0 + intercept + residual)


def score_run(run_dir: Path, refs_dir: Path, vad_dir: Path) -> RunScore | None:
    files = sorted(run_dir.glob("*.jsonl"))
    if not files:
        return None
    score = RunScore()
    for path in files:
        clip = path.stem
        events = read_events(path)
        hypothesis = final_text(events)
        score.finals[clip] = hypothesis

        ref_path = refs_dir / f"{clip}.txt"
        if ref_path.exists():
            reference = reference_text(ref_path)
            normalized = count_errors(reference, hypothesis, normalize=True)
            formatted = count_errors(reference, hypothesis, normalize=False)
            score.normalized += normalized
            score.formatted += formatted
            score.per_clip[clip] = (normalized, formatted)

        vad_path = vad_dir / f"{clip}.json"
        if vad_path.exists():
            spoken = phrases(json.loads(vad_path.read_text())["segments"])
            score.first_text += first_text_ms(events, spoken)
            delays, grey = settle_ms(events, spoken)
            score.settle += delays
            score.pauses += max(0, len(spoken) - 1)
            score.still_grey += grey

        marks = {e["kind"]: e for e in events if e["kind"] in ("meta", "input_end", "end")}
        if "input_end" in marks and "end" in marks:
            score.stop_ms.append(marks["end"]["wall_ms"] - marks["input_end"]["wall_ms"])
        meta = marks.get("meta", {})
        startup = meta.get("prepare_ms", meta.get("load_ms"))
        if startup is not None:
            score.startup_ms.append(startup)
        score.peak_bytes = max(score.peak_bytes, int(marks.get("end", {}).get("peak_rss_bytes", 0)))

        changed, updates = rewrites(events)
        score.rewrites += changed
        score.updates += updates
        score.decodes += [(e["audio_len_ms"], e["decode_ms"]) for e in events if e["kind"] == "decode"]
    return score


# --- report ---------------------------------------------------------------


def pct(value: float) -> str:
    return "–" if math.isnan(value) else f"{value * 100:.1f}%"


def millis(value: float) -> str:
    return "–" if math.isnan(value) else f"{value:,.0f} ms"


def gigabytes(value: float) -> str:
    return "–" if not value else f"{value / 1e9:.2f} GB"


def table(header: list[str], rows: list[list[str]]) -> str:
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    lines += ["| " + " | ".join(row) + " |" for row in rows]
    return "\n".join(lines)


def timing_rows(scores: dict[str, RunScore]) -> list[list[str]]:
    rows = []
    for engine, s in scores.items():
        rows.append(
            [
                NAMES[engine],
                millis(percentile(s.first_text, 50)),
                millis(percentile(s.first_text, 90)),
                millis(percentile(s.settle, 50)),
                millis(percentile(s.settle, 90)),
                f"{s.still_grey} of {s.pauses}",
                millis(percentile(s.stop_ms, 50)),
                pct(s.rewrites / s.updates) if s.updates else "–",
                millis(max(s.startup_ms) if s.startup_ms else math.nan),
            ]
        )
    return rows


TIMING_HEADER = [
    "Engine",
    "First text p50",
    "p90",
    "Settle p50",
    "p90",
    "Still grey when you talk again",
    "Settle after Stop",
    "Grey text rewritten",
    "Start-up",
]


def lag_reasons(score: RunScore) -> list[str]:
    """Why an engine's live text counts as laggy, if it does."""
    reasons = []
    first_p50, settle_p50 = percentile(score.first_text, 50), percentile(score.settle, 50)
    if first_p50 > MAX_FIRST_TEXT_MS:
        reasons.append(f"first text p50 is {millis(first_p50)} (limit 1,000 ms)")
    if settle_p50 > MAX_SETTLE_MS:
        reasons.append(f"settle p50 is {millis(settle_p50)} (limit 1,500 ms)")
    return reasons


def best_apple(live: dict[str, RunScore]) -> str | None:
    """Apple counts as whichever of its two modes does better: one that keeps
    up beats one that lags, then fewer word errors wins."""
    scored = [name for name in APPLE_ENGINES if name in live and live[name].normalized.words]
    if not scored:
        scored = [name for name in APPLE_ENGINES if name in live]
    if not scored:
        return None
    return min(scored, key=lambda name: (bool(lag_reasons(live[name])), live[name].normalized.rate))


def decide(live: dict[str, RunScore], loaded: dict[str, RunScore]) -> list[str]:
    apple_name = best_apple(live)
    parakeet = live.get("parakeet")
    if not apple_name or not parakeet or not live[apple_name].normalized.words:
        return ["Not enough runs with reference transcripts to decide."]
    apple = live[apple_name]
    a, p = apple.normalized.rate, parakeet.normalized.rate
    lines = [
        f"- Apple is judged on its better mode, {NAMES[apple_name]}.",
        f"- Word error rate, all clips: {NAMES[apple_name]} {pct(a)}, Parakeet {pct(p)}. "
        f"Parakeet makes {pct(p / a) if a else '–'} of Apple's errors (it needs 75% or less to win on accuracy).",
    ]
    clearly_better = a > 0 and p <= CLEARLY_BETTER * a

    laggy = lag_reasons(apple)
    if laggy:
        lines.append("- Apple's live text: laggy, " + "; ".join(laggy) + ".")
    else:
        lines.append(
            f"- Apple's live text: keeps up (first text p50 {millis(percentile(apple.first_text, 50))}, "
            f"settle p50 {millis(percentile(apple.settle, 50))})."
        )

    checked = loaded.get("parakeet") or parakeet
    where = "with the Chat model loaded" if loaded.get("parakeet") else "without the Chat model loaded (no loaded run)"
    decode_15 = checked.decode_15s_p90()
    peak = checked.peak_bytes
    failures = []
    if not decode_15 < MAX_DECODE_15S_MS:
        failures.append(f"reading a 15 s phrase takes {millis(decode_15)} at p90 (limit 300 ms)")
    if not peak < MAX_PEAK_BYTES:
        failures.append(f"peak memory is {gigabytes(peak)} (limit 1.5 GB)")
    lines.append(
        f"- Parakeet's checks, {where}: "
        + (
            "fails: " + "; ".join(failures) + "."
            if failures
            else f"pass (15 s read p90 {millis(decode_15)}, peak memory {gigabytes(peak)})."
        )
    )

    if clearly_better or laggy:
        why = "it is clearly more accurate" if clearly_better else "Apple's live text is laggy"
        if failures:
            verdict = (
                f"**Parakeet would win because {why}, but it fails its checks through sherpa-onnx. "
                "Look closer before choosing, for example at FluidAudio's Core ML build of Parakeet.**"
            )
        else:
            verdict = f"**Choose Parakeet: {why}, and it passes its checks.**"
    else:
        verdict = (
            f"**Choose Apple, with {NAMES[apple_name]}: Parakeet is not clearly more accurate, "
            "and Apple's live text keeps up.**"
        )
    return [verdict, ""] + lines


def write_report(out_dir: Path, refs_dir: Path) -> str:
    vad_dir = out_dir / "vad"
    results: dict[str, dict[str, RunScore]] = {}
    for config in CONFIGS:
        for engine in ENGINES:
            score = score_run(out_dir / "runs" / config / engine, refs_dir, vad_dir)
            if score:
                results.setdefault(config, {})[engine] = score

    live, loaded = results.get("live", {}), results.get("loaded", {})
    parts = ["# Dictation voice test", ""]
    parts += ["## Decision", ""] + decide(live, loaded) + [""]

    if live:
        engines = [name for name in ENGINES if name in live]
        clips = sorted({clip for score in live.values() for clip in score.per_clip})
        rows = []
        for clip in clips:
            words = next((sc.per_clip[clip][0].words for sc in live.values() if clip in sc.per_clip), 0)
            row = [clip, str(words)]
            for name in engines:
                row.append(pct(live[name].per_clip[clip][0].rate) if clip in live[name].per_clip else "–")
            rows.append(row)
        totals = [
            [
                NAMES[name],
                pct(live[name].normalized.rate),
                str(live[name].normalized.insertions),
                pct(live[name].formatted.rate),
            ]
            for name in engines
        ]
        parts += [
            "## Accuracy",
            "",
            "Word error rate after normalizing case, punctuation, numbers, and spelling.",
            "",
            table(["Clip", "Words"] + [NAMES[name] for name in engines], rows),
            "",
            "All clips together. Added words are insertions; on clip-5 they are mostly words made up during "
            "silence. With punctuation also counts case and punctuation as errors.",
            "",
            table(["Engine", "Word error rate", "Added words", "With punctuation"], totals),
            "",
            "## Live text",
            "",
            "First text: from when you start a phrase to when its first words show. "
            "Settle: from when you pause (1 s or more) to when the phrase is final.",
            "",
            table(TIMING_HEADER, timing_rows(live)),
            "",
        ]

    if loaded:
        parts += [
            "## With the Chat model loaded",
            "",
            table(TIMING_HEADER, timing_rows(loaded)),
            "",
        ]
        if "parakeet" in loaded:
            s = loaded["parakeet"]
            parts += [
                f"Parakeet: reading a 15 s phrase takes {millis(s.decode_15s_p90())} at p90. Peak memory {gigabytes(s.peak_bytes)}.",
                "",
            ]

    if "parakeet" in live:
        s = live["parakeet"]
        parts += [
            f"Parakeet without the Chat model: reading a 15 s phrase takes {millis(s.decode_15s_p90())} at p90. "
            f"Peak memory {gigabytes(s.peak_bytes)}. Apple's engine runs in a macOS process, so its memory isn't measured here.",
            "",
        ]

    soxr_runs, sdk_runs = results.get("fast-soxr", {}), results.get("fast-sdk", {})
    if soxr_runs and sdk_runs:
        rows = []
        for engine in ENGINES:
            if engine in soxr_runs and engine in sdk_runs:
                good, sdk = soxr_runs[engine].normalized.rate, sdk_runs[engine].normalized.rate
                cost = sdk - good
                rows.append(
                    [
                        NAMES[engine],
                        pct(good),
                        pct(sdk),
                        f"{cost * 100:+.1f} points",
                        "capture at 48 kHz and filter in Sage" if cost > MAX_RESAMPLER_COST else "fine",
                    ]
                )
        parts += [
            "## The Native SDK's resampler",
            "",
            "Same clips fed as fast as possible, once resampled with a proper filter and once the way the SDK does it.",
            "",
            table(["Engine", "Filtered", "SDK", "Cost", "Verdict"], rows),
            "",
        ]

    if live:
        clip = "clip-3" if any("clip-3" in s.finals for s in live.values()) else None
        if clip:
            parts += [
                "## Clip 3 side by side",
                "",
                "Numbers can be right in more than one form, so read these yourself.",
                "",
            ]
            ref = refs_dir / f"{clip}.txt"
            if ref.exists():
                parts += ["**Reference**", "", reference_text(ref), ""]
            for engine in ENGINES:
                if engine in live and clip in live[engine].finals:
                    parts += [f"**{NAMES[engine]}**", "", live[engine].finals[clip], ""]

        transcripts = out_dir / "transcripts"
        transcripts.mkdir(parents=True, exist_ok=True)
        for engine, s in live.items():
            for name, text in s.finals.items():
                (transcripts / f"{name}.{engine}.txt").write_text(text + "\n")
        parts += [f"Every transcript is in `{transcripts}`.", ""]

    report = "\n".join(parts)
    (out_dir / "report.md").write_text(report)
    return report


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, default=Path.home() / "SageDictationSpike")
    args = parser.parse_args()
    print(write_report(args.data / "out", args.data / "refs"))
