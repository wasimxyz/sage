"""A copy of the Native SDK's microphone resampler, to measure what it costs.

The SDK (0.11.0, `NativeSdkAudioCaptureTarget consumeBufferList:` in
`src/platform/macos/appkit_host.m`) turns the mic's float samples into int16 at
the requested rate by linear interpolation between neighbouring samples, with
no low-pass filter first. From 48 kHz to 16 kHz the step is exactly 3, so it
keeps every third sample. Sounds above 8 kHz fold back into the speech band.

The SDK works one tap buffer at a time but carries its position and the last
sample across buffers, so running it over the whole clip at once gives the
same output.
"""

from __future__ import annotations

import numpy as np


def sdk_resample(samples: np.ndarray, in_rate: int, out_rate: int) -> np.ndarray:
    """float32 mono in [-1, 1] -> int16 mono at out_rate, as the SDK does it."""
    if len(samples) == 0:
        return np.zeros(0, dtype=np.int16)
    step = in_rate / out_rate
    count = int(np.floor((len(samples) - 1) / step)) + 1
    positions = np.arange(count, dtype=np.float64) * step
    first = np.floor(positions).astype(np.int64)
    fraction = (positions - first).astype(np.float32)
    second = np.minimum(first + 1, len(samples) - 1)
    mixed = samples[first] + (samples[second] - samples[first]) * fraction
    mixed = np.clip(mixed, -1.0, 1.0)
    # lrintf rounds half to even, like np.rint.
    return np.rint(mixed * 32767.0).astype(np.int16)


if __name__ == "__main__":
    # Spot checks: a 48 kHz ramp keeps every third sample.
    ramp = np.arange(12, dtype=np.float32) / 32767.0
    print(sdk_resample(ramp, 48_000, 16_000))  # [0 3 6 9]
    print(len(sdk_resample(np.zeros(44_100, dtype=np.float32), 44_100, 16_000)))  # 16000
