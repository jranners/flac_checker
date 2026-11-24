"""Audio metadata and spectral analysis for FLAC authenticity checks."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf
from mutagen.flac import FLAC
from scipy import signal
from scipy.ndimage import median_filter


TRUE_LOSSLESS = "TRUE_LOSSLESS"
SUSPICIOUS = "SUSPICIOUS"
FAKE_TRANSCODE = "FAKE_TRANSCODE"


@dataclass
class AnalysisResult:
    path: str
    status: str
    confidence: int
    sample_rate: int
    bit_depth: int
    bitrate: int
    duration: float
    channels: int
    md5_hash: str | None
    cutoff_hz: float | None
    estimated_bitrate: int | None
    explanation: str
    frequencies: np.ndarray
    times: np.ndarray
    spectrogram_db: np.ndarray


def _detect_cutoff(
    frequencies: np.ndarray, power: np.ndarray, sample_rate: int
) -> tuple[float | None, float, int | None]:
    """Find a sharp upper-spectrum energy collapse characteristic of lossy encoding."""
    frequencies = np.asarray(frequencies, dtype=float)
    power = np.asarray(power, dtype=float)
    if frequencies.size < 8 or power.size != frequencies.size:
        return None, 0.0, None

    relative_db = 10.0 * np.log10(np.maximum(power, np.finfo(float).tiny))
    relative_db -= float(np.max(relative_db))
    smoothed_db = median_filter(relative_db, size=5, mode="nearest")
    nyquist = sample_rate / 2.0
    candidates = [
        (16000.0, 128),
        (18500.0, 192),
        (20200.0, 320),
    ]

    strongest: tuple[float, float, int] | None = None
    for candidate_hz, bitrate in candidates:
        if candidate_hz >= nyquist - 1500:
            continue
        before = smoothed_db[
            (frequencies >= candidate_hz - 1000)
            & (frequencies <= candidate_hz - 250)
        ]
        after = smoothed_db[
            (frequencies >= candidate_hz + 250)
            & (frequencies <= min(candidate_hz + 1300, nyquist - 100))
        ]
        if before.size < 4 or after.size < 4:
            continue
        before_level = float(np.median(before))
        after_level = float(np.median(after))
        drop_db = before_level - after_level
        if before_level < -65.0 or drop_db < 16.0:
            continue
        if strongest is None or drop_db > strongest[0]:
            strongest = (drop_db, candidate_hz, bitrate)

    if strongest is None:
        return None, 0.0, None
    drop_db, cutoff_hz, bitrate = strongest
    confidence = int(np.clip(68 + (drop_db - 16) * 1.4, 68, 98))
    return cutoff_hz, float(confidence), bitrate


def _sample_starts(total_frames: int, sample_rate: int) -> list[int]:
    segment_frames = min(total_frames, max(1, sample_rate * 10))
    if total_frames <= segment_frames:
        return [0]
    available = total_frames - segment_frames
    return sorted({int(available * fraction) for fraction in (0.2, 0.5, 0.8)})


def analyze_file(path: str | Path) -> AnalysisResult:
    """Analyze a FLAC file and return metadata, a verdict, and visualization data."""
    file_path = Path(path).expanduser().resolve()
    if file_path.suffix.lower() != ".flac":
        raise ValueError(f"Not a FLAC file: {file_path.name}")

    try:
        metadata = FLAC(str(file_path))
        info = metadata.info
        audio_info = sf.info(str(file_path))
    except Exception as exc:
        raise ValueError(f"Unable to read FLAC file: {exc}") from exc

    if audio_info.frames <= 0 or audio_info.samplerate <= 0:
        raise ValueError("The FLAC file contains no decodable audio.")

    sample_rate = int(info.sample_rate or audio_info.samplerate)
    channels = int(info.channels or audio_info.channels)
    duration = float(info.length or audio_info.duration)
    bit_depth = int(info.bits_per_sample or _bit_depth(audio_info.subtype))
    bitrate = int(getattr(info, "bitrate", 0) or 0)
    if not bitrate and duration > 0:
        bitrate = int(file_path.stat().st_size * 8 / duration)
    md5_hash = getattr(info, "md5_signature", None)
    if isinstance(md5_hash, bytes):
        md5_hash = md5_hash.hex()
    elif isinstance(md5_hash, int):
        md5_hash = f"{md5_hash:032x}"
    elif md5_hash:
        md5_hash = str(md5_hash)

    segment_psds: list[np.ndarray] = []
    chosen_mono: np.ndarray | None = None
    starts = _sample_starts(audio_info.frames, sample_rate)
    with sf.SoundFile(str(file_path)) as audio:
        for index, start in enumerate(starts):
            audio.seek(start)
            samples = audio.read(
                min(sample_rate * 10, audio_info.frames - start),
                dtype="float32",
                always_2d=True,
            )
            mono = np.mean(samples, axis=1, dtype=np.float32)
            if mono.size == 0:
                continue
            nperseg = min(65536, mono.size)
            frequencies, density = signal.welch(
                mono,
                fs=sample_rate,
                window="hann",
                nperseg=nperseg,
                noverlap=nperseg // 2,
                scaling="density",
            )
            segment_psds.append(density)
            if chosen_mono is None or index == len(starts) // 2:
                chosen_mono = mono

    if not segment_psds or chosen_mono is None:
        raise ValueError("No audio samples could be decoded from this FLAC file.")

    averaged_power = np.mean(np.stack(segment_psds), axis=0)
    cutoff_hz, cutoff_confidence, estimated_bitrate = _detect_cutoff(
        frequencies, averaged_power, sample_rate
    )
    if cutoff_hz is not None:
        status = FAKE_TRANSCODE
        confidence = int(cutoff_confidence)
        explanation = (
            f"A sharp spectral cutoff near {cutoff_hz / 1000:.1f} kHz is consistent "
            f"with a lossy source around {estimated_bitrate} kbps."
        )
    else:
        high_band = (frequencies >= min(18000, sample_rate * 0.4)) & (
            frequencies <= sample_rate / 2 * 0.98
        )
        peak = max(float(np.max(averaged_power)), np.finfo(float).tiny)
        high_energy_db = (
            10.0 * np.log10(max(float(np.mean(averaged_power[high_band])), np.finfo(float).tiny) / peak)
            if np.any(high_band)
            else -100.0
        )
        if high_energy_db < -58.0:
            status = SUSPICIOUS
            confidence = 55
            explanation = (
                "Little energy is present near the top of the spectrum. This can be "
                "normal for the material, so review the spectrogram manually."
            )
        else:
            status = TRUE_LOSSLESS
            confidence = 82
            explanation = (
                "No characteristic lossy-encoder brickwall cutoff was found in the "
                "sampled sections; the spectrum remains naturally shaped."
            )

    nperseg = min(4096, chosen_mono.size)
    noverlap = nperseg - min(512, max(1, nperseg // 2))
    frequencies, times, spectrum = signal.stft(
        chosen_mono,
        fs=sample_rate,
        window="hann",
        nperseg=nperseg,
        noverlap=noverlap,
        boundary=None,
    )
    spectrogram_db = 20.0 * np.log10(np.maximum(np.abs(spectrum), 1e-8))
    return AnalysisResult(
        path=str(file_path),
        status=status,
        confidence=confidence,
        sample_rate=sample_rate,
        bit_depth=bit_depth,
        bitrate=bitrate,
        duration=duration,
        channels=channels,
        md5_hash=md5_hash,
        cutoff_hz=cutoff_hz,
        estimated_bitrate=estimated_bitrate,
        explanation=explanation,
        frequencies=frequencies,
        times=times,
        spectrogram_db=spectrogram_db,
    )


def _bit_depth(subtype: str) -> int:
    if "24" in subtype:
        return 24
    if "32" in subtype:
        return 32
    return 16
