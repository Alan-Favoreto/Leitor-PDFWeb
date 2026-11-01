"""Pós-processamento do áudio gerado e codificação em WAV PCM 16-bit mono."""

from __future__ import annotations

import io
import wave

import numpy as np


def trim_silence(audio: np.ndarray, sr: int, *, threshold_db: float = -42.0,
                 keep_start: float = 0.05, keep_end: float = 0.12) -> np.ndarray:
    """Corta silêncio excessivo no início e no fim, deixando uma pequena folga.

    O limiar é relativo ao pico do próprio áudio, medido em janelas de 10 ms.
    """
    if audio.size == 0:
        return audio
    peak = float(np.max(np.abs(audio)))
    if peak <= 1e-6:
        return audio[:0]
    win = max(1, int(sr * 0.01))
    n = audio.size // win
    if n < 3:
        return audio
    frames = audio[: n * win].reshape(n, win)
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
    limit = peak * (10.0 ** (threshold_db / 20.0))
    voiced = np.nonzero(rms > limit)[0]
    if voiced.size == 0:
        return audio
    start = max(0, voiced[0] * win - int(sr * keep_start))
    end = min(audio.size, (voiced[-1] + 1) * win + int(sr * keep_end))
    return audio[start:end]


def normalize(audio: np.ndarray, *, target_rms_db: float = -20.0, peak_limit: float = 0.93,
              max_gain: float = 4.0, min_gain: float = 0.35) -> np.ndarray:
    """Normalização leve de volume: aproxima o RMS de -20 dBFS sem passar do teto de pico."""
    if audio.size == 0:
        return audio
    peak = float(np.max(np.abs(audio)))
    if peak <= 1e-6:
        return audio
    rms = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))
    gain = (10.0 ** (target_rms_db / 20.0)) / max(rms, 1e-9)
    gain = min(max(gain, min_gain), max_gain, peak_limit / peak)
    return audio * gain


def silence(sr: int, seconds: float) -> np.ndarray:
    return np.zeros(int(sr * seconds), dtype=np.float32)


def postprocess(audio: np.ndarray, sr: int) -> np.ndarray:
    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    audio = np.nan_to_num(audio, nan=0.0, posinf=0.0, neginf=0.0)
    audio = trim_silence(audio, sr)
    audio = normalize(audio)
    return np.clip(audio, -1.0, 1.0).astype(np.float32)


def to_wav_bytes(audio: np.ndarray, sr: int) -> bytes:
    """Codifica float32 [-1, 1] como WAV PCM 16-bit mono."""
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).round().astype('<i2')
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm.tobytes())
    return buf.getvalue()
