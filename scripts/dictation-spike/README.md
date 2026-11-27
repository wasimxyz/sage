# Dictation voice test

This test picks the speech engine for dictation in Sage. It runs your own recorded clips through on-device engines and scores them:

- **Apple (speech)**: SpeechAnalyzer with SpeechTranscriber, built into macOS 26 and later, asking for fast results.
- **Apple (dictation)**: SpeechAnalyzer with DictationTranscriber, Apple's module for dictation, finalizing often.
- **Parakeet**: NVIDIA Parakeet TDT 0.6B v2, int8, run through sherpa-onnx on the CPU with 6 threads.

Apple is judged on whichever of its two modes does better. A mode that keeps up beats one that lags, and then fewer word errors wins.

Nothing leaves this Mac. Your clips and transcripts stay in `~/SageDictationSpike`, outside the repo.

## How Sage decides

Sage uses Apple unless one of these holds:

- Parakeet makes at most 75% of Apple's word errors, counted over all clips.
- Apple's live text is laggy: the first words of a phrase take more than 1 s to show (median), or a phrase takes more than 1.5 s to settle after you pause (median).

Parakeet also has to pass two checks with `qwen3.5:9b` loaded: reading a 15 s phrase must take under 300 ms (90th percentile), and peak memory must stay under 1.5 GB.

A last check covers the Native SDK, which turns 48 kHz mic audio into 16 kHz by keeping every third sample, with no filter. If that costs either engine more than one point of word error rate, Sage should capture at 48 kHz and filter the audio itself.

## Running it

You need macOS 26 or later, the Xcode or Command Line Tools SDK, and `uv`.

1. Set up the data folder. This makes `~/SageDictationSpike/{clips,refs,out}` and copies the reference text for clips 1 to 5:

   ```
   uv run run.py setup
   ```

2. Record the six clips in [the reading script](script/reading-script.md), and put them in `~/SageDictationSpike/clips/` as `clip-1.wav` to `clip-6.wav`. Write `refs/clip-6.txt` by hand.

3. Run the test:

   ```
   uv run run.py
   ```

   The first run downloads Parakeet (about 480 MB) and builds the Apple runner. Apple's engine has to be fed at real-time speed, and both Apple modes run, so the test takes about three times the length of your clips: about 40 minutes for six two-minute clips. The loaded pass runs only Apple's better mode.

4. Read `~/SageDictationSpike/out/report.md`. Each engine's transcripts are in `out/transcripts/`.

After you fix a reference transcript, `uv run run.py score` scores again without running the engines.

### Options

- `--clips clip-1,clip-3` runs only those clips.
- `--skip-loaded` skips the pass with the Chat model loaded.
- `--skip-resample` skips the check of the SDK's resampler.
- `--busy` keeps the Chat model generating during the loaded pass, as if Dream were running.
- `--data DIR` uses another data folder.

The loaded pass uses Sage's dev Ollama on port 11436. If `make dev` is not running it, the test starts the pinned copy from `scripts/fetch-ollama.sh` and stops it afterward.

## What the report measures

- **Word error rate**: words substituted, dropped, or added, divided by the words in the reference. Case, punctuation, numbers, and British spellings are normalized first, with Whisper's English normalizer. The "with punctuation" column counts case and punctuation as errors too.
- **Added words**: on clip 5, these are mostly words an engine made up during silence.
- **First text**: from when you start a phrase to when its first words show.
- **Settle**: from when you pause for 1 s or more to when the phrase is final. The last phrase is left out, because pressing Stop settles it.
- **Grey text rewritten**: how often the grey text changes words it already showed.
- **Start-up**: Apple's time to prepare, or Parakeet's time to load the model.

Where speech starts and stops comes from running Silero VAD over the filtered audio.

## How each engine is run

`apple/Transcribe.swift` reads the clip, converts it to the format SpeechAnalyzer asks for, and feeds it in 100 ms buffers, each sent once the mic would have heard all of it. It asks for grey ("volatile") results and audio time ranges. `--model speech` uses SpeechTranscriber with fast results. Without fast results, SpeechTranscriber works through audio about 4 s at a time, which is too slow for dictation. `--model dictation` uses DictationTranscriber with punctuation and frequent finalization. `apple/build.sh` builds it into `.build/transcribe-apple`.

`parakeet_stream.py` feeds 20 ms chunks to Silero VAD. While you talk, it re-reads the phrase so far after 250 ms and then every 500 ms. That is the grey text. After 0.5 s of silence, or once a phrase reaches 20 s, it reads the phrase once more for the final text. One worker does all the reading, as in Sage. A simulated clock replays the timing: a read starts once its audio has arrived and the worker is free, and takes as long as it really took. `--realtime` feeds against the wall clock instead.

sherpa-onnx joins a `$` to the word before it ("are$1,284"), so the runner puts the space back, as Sage would. On an M2 Pro, 6 threads read fastest. The CoreML backend of onnxruntime was slower and used about 5 GB, so the test uses the CPU. If Parakeet wins on accuracy but fails its checks, FluidAudio's native Core ML build of Parakeet is the next thing to try.

`resample_sdk.py` is a copy of the Native SDK's resampler. `prep.py` writes each clip twice at 16 kHz, once filtered with soxr and once the SDK's way.

## Files

| File | What it does |
| --- | --- |
| `run.py` | Runs everything: setup, prep, the engines, score |
| `fetch-models.sh` | Downloads Parakeet and Silero VAD, pinned by SHA-256 |
| `prep.py` | Resamples each clip both ways and finds speech |
| `apple/` | The SpeechAnalyzer runner and its build script |
| `parakeet_stream.py` | The Parakeet runner |
| `resample_sdk.py` | The copy of the SDK's resampler |
| `score.py` | Scores the runs and writes the report |
| `script/` | The reading script and the reference text for clips 1 to 5 |
