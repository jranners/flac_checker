import unittest
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from analyzer import _detect_cutoff, _sample_starts, analyze_file


class CutoffDetectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.sample_rate = 44100
        self.frequencies = np.linspace(0, self.sample_rate / 2, 32769)

    def test_detects_a_brickwall_cutoff_and_estimates_bitrate(self) -> None:
        power = np.full(self.frequencies.shape, 1e-4)
        power[self.frequencies >= 16000] = 1e-12

        cutoff, confidence, bitrate = _detect_cutoff(
            self.frequencies, power, self.sample_rate
        )

        self.assertEqual(cutoff, 16000)
        self.assertGreaterEqual(confidence, 68)
        self.assertEqual(bitrate, 128)

    def test_does_not_flag_a_gradual_spectral_rolloff(self) -> None:
        power = np.exp(-self.frequencies / 5000)

        cutoff, confidence, bitrate = _detect_cutoff(
            self.frequencies, power, self.sample_rate
        )

        self.assertIsNone(cutoff)
        self.assertEqual(confidence, 0)
        self.assertIsNone(bitrate)

    def test_sample_windows_cover_short_and_long_tracks(self) -> None:
        self.assertEqual(_sample_starts(5 * 44100, 44100), [0])
        starts = _sample_starts(60 * 44100, 44100)
        self.assertEqual(len(starts), 3)
        self.assertEqual(starts, sorted(starts))

    def test_analyze_file_returns_metadata_and_md5_as_hex(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "short.flac"
            samples = np.zeros(4410, dtype=np.float32)
            sf.write(path, samples, 44100, format="FLAC", subtype="PCM_16")

            result = analyze_file(path)

        self.assertEqual(result.sample_rate, 44100)
        self.assertEqual(result.bit_depth, 16)
        self.assertEqual(result.channels, 1)
        self.assertEqual(len(result.md5_hash), 32)
        self.assertGreater(result.spectrogram_db.size, 0)


if __name__ == "__main__":
    unittest.main()
