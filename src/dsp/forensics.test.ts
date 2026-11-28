import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAdaptiveTransientSegments } from './audioDecoder';
import { runForensicAnalysis } from './cutoffDetector';
import { fftInPlace } from './fft';
import { checkRaw24BitPcmPadding } from './headerParser';
import type { HeaderMetadata } from './types';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Synthesize broadband noise with optional sharp spectral brickwall cutoff via single-pass FFT filtering.
 */
function synthesizeSpectrumSignal(
  sampleRate: number,
  durationSec: number,
  cutoffHz: number | null,
  seed = 42,
  addTpdfDither = false,
): Float32Array {
  const rand = mulberry32(seed);
  const n = Math.floor(sampleRate * durationSec);
  const out = new Float32Array(n);

  if (cutoffHz === null) {
    for (let i = 0; i < n; i++) {
      let s = (rand() * 2 - 1) * 0.25;
      if (addTpdfDither) {
        s += (rand() - rand()) / 32768;
      }
      out[i] = s;
    }
    return out;
  }

  let fftLen = 1;
  while (fftLen < n) fftLen <<= 1;
  const re = new Float64Array(fftLen);
  const im = new Float64Array(fftLen);
  for (let i = 0; i < n; i++) {
    re[i] = (rand() * 2 - 1) * 0.28;
  }

  fftInPlace(re, im);
  const df = sampleRate / fftLen;
  const cutBin = Math.floor(cutoffHz / df);
  const nyqBin = fftLen >>> 1;
  for (let b = cutBin; b <= nyqBin; b++) {
    re[b] *= 1e-7;
    im[b] *= 1e-7;
    if (b > 0 && b < nyqBin) {
      re[fftLen - b] *= 1e-7;
      im[fftLen - b] *= 1e-7;
    }
  }
  for (let i = 0; i < fftLen; i++) im[i] = -im[i];
  fftInPlace(re, im);
  const invN = 1 / fftLen;
  for (let i = 0; i < n; i++) {
    let s = re[i] * invN;
    if (addTpdfDither) {
      // Simulate re-encoding a decoded MP3 into 16-bit FLAC with live TPDF dither
      s += (rand() - rand()) / 32768;
    }
    out[i] = s;
  }

  return out;
}

/**
 * Synthesize an AAC/Opus/VBR-style signal with periodic 350 Hz MDCT scalefactor sub-band dropouts
 * gated on and off across frames above 14 kHz using Hann overlap-add synthesis.
 */
function synthesizeMdctSubBandDropouts(
  sampleRate: number,
  durationSec: number,
  seed = 808,
): Float32Array {
  const rand = mulberry32(seed);
  const n = Math.floor(sampleRate * durationSec);
  const out = new Float32Array(n);
  const winLen = 4096;
  const hop = winLen >>> 1;
  const hann = new Float64Array(winLen);
  for (let i = 0; i < winLen; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (winLen - 1)));
  }

  const re = new Float64Array(winLen);
  const im = new Float64Array(winLen);
  const df = sampleRate / winLen;
  const nyqBin = winLen >>> 1;

  let frameIdx = 0;
  for (let start = 0; start + winLen <= n; start += hop) {
    for (let i = 0; i < winLen; i++) {
      re[i] = (rand() * 2 - 1) * 0.26 * hann[i];
      im[i] = 0;
    }
    fftInPlace(re, im);

    // Zero alternating ~450 Hz scalefactor bands above 14 kHz in 3-frame (~140 ms) psychoacoustic blocks
    const blockIdx = Math.floor(frameIdx / 3);
    for (let b = 0; b <= nyqBin; b++) {
      const fKhz = (b * df) / 1000;
      let zero = false;
      if (fKhz > 19.6) {
        zero = true;
      } else if (fKhz >= 13.8 && fKhz <= 19.2) {
        const bandIndex = Math.floor((fKhz - 13.8) / 0.45);
        if ((bandIndex + blockIdx) % 2 === 0 && bandIndex % 2 === 1) {
          zero = true;
        }
      }
      if (zero) {
        re[b] *= 1e-6;
        im[b] *= 1e-6;
        if (b > 0 && b < nyqBin) {
          re[winLen - b] *= 1e-6;
          im[winLen - b] *= 1e-6;
        }
      }
    }

    for (let i = 0; i < winLen; i++) im[i] = -im[i];
    fftInPlace(re, im);
    const invN = 1 / winLen;
    for (let i = 0; i < winLen; i++) {
      out[start + i] += re[i] * invN * hann[i];
    }
    frameIdx++;
  }

  return out;
}

/**
 * Synthesize a warm acoustic-like recording with a smooth -5 dB/kHz roll-off above 3 kHz.
 */
function synthesizeWarmAcousticRollOff(
  sampleRate: number,
  durationSec: number,
  slopeDbPerKhz = -5.0,
  seed = 777,
): Float32Array {
  const rand = mulberry32(seed);
  const n = Math.floor(sampleRate * durationSec);
  let fftLen = 1;
  while (fftLen < n) fftLen <<= 1;

  const re = new Float64Array(fftLen);
  const im = new Float64Array(fftLen);
  for (let i = 0; i < n; i++) {
    re[i] = (rand() * 2 - 1) * 0.4;
  }

  fftInPlace(re, im);
  const df = sampleRate / fftLen;
  const nyqBin = fftLen >>> 1;
  for (let b = 0; b <= nyqBin; b++) {
    const fKhz = (b * df) / 1000;
    const attenDb = fKhz > 3.0 ? slopeDbPerKhz * (fKhz - 3.0) : 0;
    const gain = Math.pow(10, attenDb / 20);
    re[b] *= gain;
    im[b] *= gain;
    if (b > 0 && b < nyqBin) {
      re[fftLen - b] *= gain;
      im[fftLen - b] *= gain;
    }
  }

  for (let i = 0; i < fftLen; i++) im[i] = -im[i];
  fftInPlace(re, im);
  const invN = 1 / fftLen;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = 0.55 + 0.45 * Math.sin((2 * Math.PI * 1.3 * i) / sampleRate);
    const dither = (rand() - rand()) / 32768;
    out[i] = re[i] * invN * env + dither;
  }
  return out;
}

function makeLosslessMeta(sampleRate: number, duration: number, channels = 2): HeaderMetadata {
  return {
    container: 'FLAC',
    codecHint: 'FLAC Lossless',
    isLossyContainer: false,
    sampleRate,
    bitDepth: 16,
    channels,
    totalSamples: Math.floor(sampleRate * duration),
    duration,
    bitrate: 920_000,
    md5Hash: '1234567890abcdef1234567890abcdef',
  };
}

test('Fix 1: Genuine 44.1 kHz stereo track with hard-panned HF transients + TPDF dither -> GENUINE_LOSSLESS', () => {
  const sr = 44100;
  // Base stereo body cut at 12 kHz, plus out-of-phase / hard-panned Left full-band HF cymbal transients!
  // Pre-collapsing to mono would cancel out-of-phase HF cymbals; max(power_L, power_R) preserves them cleanly.
  const base = synthesizeSpectrumSignal(sr, 3, 12000, 101, true);
  const hfLeftOnly = synthesizeSpectrumSignal(sr, 3, null, 102, true);
  const left = new Float32Array(base.length);
  const right = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) {
    // Out-of-phase HF stereo transients (would cancel 100% if averaged (L+R)/2!)
    left[i] = base[i] * 0.6 + hfLeftOnly[i] * 0.5;
    right[i] = base[i] * 0.6 - hfLeftOnly[i] * 0.5;
  }

  const result = runForensicAnalysis({
    leftSamples: left,
    rightSamples: right,
    segmentLengthSamples: left.length,
    decodedSampleRate: sr,
    metadata: makeLosslessMeta(sr, 3, 2),
    securityChecks: ['Magic bytes verified (FLAC)'],
    analyzedSegments: 1,
    analyzedDurationSec: 3,
  });

  assert.equal(result.verdict, 'GENUINE_LOSSLESS');
  assert.equal(result.cutoffKhz, null);
  assert.ok(result.confidence >= 80);
});

test('Fix 2: Dithered 16 kHz MP3-to-16-bit-FLAC transcode (brickwall + live -96 dBFS TPDF dither) -> FAKE_TRANSCODE', () => {
  const sr = 44100;
  const mono = synthesizeSpectrumSignal(sr, 3, 16000, 202, true);
  const result = runForensicAnalysis({
    leftSamples: mono,
    rightSamples: null,
    segmentLengthSamples: mono.length,
    decodedSampleRate: sr,
    metadata: makeLosslessMeta(sr, 3, 1),
    securityChecks: ['Magic bytes verified (FLAC)'],
    analyzedSegments: 1,
    analyzedDurationSec: 3,
  });

  assert.equal(result.verdict, 'FAKE_TRANSCODE');
  assert.ok(result.cutoffKhz !== null && Math.abs(result.cutoffKhz - 16.0) < 0.8);
  assert.ok(result.metrics.cutoffIQRHz !== null && result.metrics.cutoffIQRHz < 350);
  const ditherFactor = result.evidenceFactors.find((f) => f.id === 'dead-zone-dither');
  assert.equal(ditherFactor?.impact, 'negative');
  assert.ok(ditherFactor?.detail.toLowerCase().includes('re-dithered'));
});

test('Fix 3: AAC/VBR-style signal with 350 Hz MDCT sub-band dropouts above 14 kHz -> FAKE_TRANSCODE', () => {
  const sr = 44100;
  const mono = synthesizeMdctSubBandDropouts(sr, 3, 303);
  const result = runForensicAnalysis({
    leftSamples: mono,
    rightSamples: null,
    segmentLengthSamples: mono.length,
    decodedSampleRate: sr,
    metadata: makeLosslessMeta(sr, 3, 1),
    securityChecks: ['Magic bytes verified (FLAC)'],
    analyzedSegments: 1,
    analyzedDurationSec: 3,
  });

  const mdctFactor = result.evidenceFactors.find((f) => f.id === 'mdct-holes');
  assert.equal(mdctFactor?.impact, 'negative');
  assert.ok(
    result.metrics.spectralHolePercent >= 2.0 || result.metrics.broadBandZeroingPercent >= 3.5,
    `Expected MDCT dropouts detected, got bands=${result.metrics.spectralHolePercent}%, gate=${result.metrics.broadBandZeroingPercent}%`,
  );
  assert.equal(result.verdict, 'FAKE_TRANSCODE');
});

test('Fix 4: Clean 20.0 kHz mastering LPF without MDCT/shelf/stereo artifacts -> INCONCLUSIVE (not high-confidence fake)', () => {
  const sr = 44100;
  const mono = synthesizeSpectrumSignal(sr, 3, 20000, 404, false);
  const result = runForensicAnalysis({
    leftSamples: mono,
    rightSamples: null,
    segmentLengthSamples: mono.length,
    decodedSampleRate: sr,
    metadata: makeLosslessMeta(sr, 3, 1),
    securityChecks: ['Magic bytes verified (FLAC)'],
    analyzedSegments: 1,
    analyzedDurationSec: 3,
  });

  assert.equal(result.verdict, 'INCONCLUSIVE');
  assert.ok(result.subLabel?.includes('20 kHz Low-Pass Filter'));
  assert.ok(result.cutoffKhz !== null && Math.abs(result.cutoffKhz - 20.0) < 0.7);
});

test('Fix 5: 192 kHz file decoded at 96 kHz containing a 44.1 kHz master -> UPSAMPLED_LOSSLESS', () => {
  const decodedSr = 96000;
  const mono = synthesizeSpectrumSignal(decodedSr, 2.5, 21800, 505, false);
  const result = runForensicAnalysis({
    leftSamples: mono,
    rightSamples: null,
    segmentLengthSamples: mono.length,
    decodedSampleRate: decodedSr,
    // Original file header was 192 kHz; OfflineAudioContext clamped to 96 kHz -> browserResampled=true
    metadata: makeLosslessMeta(192000, 2.5, 1),
    securityChecks: ['Magic bytes verified (FLAC)'],
    analyzedSegments: 1,
    analyzedDurationSec: 2.5,
  });

  assert.equal(result.metrics.browserResampled, true);
  assert.equal(result.verdict, 'UPSAMPLED_LOSSLESS');
  assert.equal(result.cutoffKhz, 22.05);
  assert.ok(result.subLabel?.includes('44.1 kHz'));
});

test('Warm acoustic-like smooth -5 dB/kHz roll-off is NOT flagged as FAKE_TRANSCODE', () => {
  const sr = 44100;
  const mono = synthesizeWarmAcousticRollOff(sr, 4, -5.0, 606);
  const result = runForensicAnalysis({
    leftSamples: mono,
    rightSamples: null,
    segmentLengthSamples: mono.length,
    decodedSampleRate: sr,
    metadata: makeLosslessMeta(sr, 4, 1),
    securityChecks: ['Magic bytes verified (FLAC)'],
    analyzedSegments: 1,
    analyzedDurationSec: 4,
  });

  assert.notEqual(result.verdict, 'FAKE_TRANSCODE');
  assert.ok(result.verdict === 'GENUINE_LOSSLESS' || result.verdict === 'INCONCLUSIVE');
});

test('Track with almost no energy above 8 kHz -> INCONCLUSIVE (never FAKE_TRANSCODE)', () => {
  const sr = 44100;
  const mono = synthesizeSpectrumSignal(sr, 3, 6000, 707);
  const result = runForensicAnalysis({
    leftSamples: mono,
    rightSamples: null,
    segmentLengthSamples: mono.length,
    decodedSampleRate: sr,
    metadata: makeLosslessMeta(sr, 3, 1),
    securityChecks: ['Magic bytes verified (FLAC)'],
    analyzedSegments: 1,
    analyzedDurationSec: 3,
  });

  assert.equal(result.verdict, 'INCONCLUSIVE');
  assert.equal(result.subLabel, 'Low High-Frequency Source Material');
});

test('Detects HF stereo side-channel collapse strictly inside active passband', () => {
  const sr = 44100;
  const mid = synthesizeSpectrumSignal(sr, 3, null, 801);
  // Side channel cut at 14 kHz -> Mid = (L+R)/2, Side = (L-R)/2 -> L = mid + side, R = mid - side
  const side = synthesizeSpectrumSignal(sr, 3, 14000, 802);
  const left = new Float32Array(mid.length);
  const right = new Float32Array(mid.length);
  for (let i = 0; i < mid.length; i++) {
    left[i] = (mid[i] + side[i]) * 0.5;
    right[i] = (mid[i] - side[i]) * 0.5;
  }

  const result = runForensicAnalysis({
    leftSamples: left,
    rightSamples: right,
    segmentLengthSamples: left.length,
    decodedSampleRate: sr,
    metadata: makeLosslessMeta(sr, 3, 2),
    securityChecks: ['Magic bytes verified (FLAC)'],
    analyzedSegments: 1,
    analyzedDurationSec: 3,
  });

  assert.ok(
    result.metrics.hfStereoCollapseDb !== null && result.metrics.hfStereoCollapseDb > 14,
    `Expected HF stereo collapse > 14 dB, got ${result.metrics.hfStereoCollapseDb}`,
  );
  const stereoFactor = result.evidenceFactors.find((f) => f.id === 'stereo-hf-collapse');
  assert.equal(stereoFactor?.impact, 'negative');
});

test('Segment-boundary isolation prevents splice clicks from corrupting 16 kHz brickwall detection', () => {
  const sr = 44100;
  const segLen = 4 * sr;
  const seg1 = synthesizeSpectrumSignal(sr, 4, 16000, 901);
  const seg2 = synthesizeSpectrumSignal(sr, 4, 16000, 902);
  // Inject large opposite DC offsets at the splice boundary to prove STFT never crosses it
  const packed = new Float32Array(segLen * 2);
  for (let i = 0; i < segLen; i++) {
    packed[i] = seg1[i] + 0.35;
    packed[segLen + i] = seg2[i] - 0.35;
  }

  const result = runForensicAnalysis({
    leftSamples: packed,
    rightSamples: null,
    segmentLengthSamples: segLen,
    decodedSampleRate: sr,
    metadata: makeLosslessMeta(sr, 8, 1),
    securityChecks: ['Magic bytes verified (FLAC)'],
    analyzedSegments: 2,
    analyzedDurationSec: 8,
  });

  assert.equal(result.verdict, 'FAKE_TRANSCODE');
  assert.ok(result.cutoffKhz !== null && Math.abs(result.cutoffKhz - 16.0) < 0.8);
});

test('tags inherently lossy MP3 container as LOSSY_FORMAT while computing spectrogram', () => {
  const sr = 44100;
  const mono = synthesizeSpectrumSignal(sr, 2, 18500, 705);
  const mp3Meta: HeaderMetadata = {
    container: 'MP3',
    codecHint: 'MP3 (MPEG-1 Layer III)',
    isLossyContainer: true,
    sampleRate: sr,
    bitDepth: null,
    channels: 2,
    totalSamples: null,
    duration: 2,
    bitrate: 192_000,
    md5Hash: null,
  };

  const result = runForensicAnalysis({
    leftSamples: mono,
    rightSamples: null,
    segmentLengthSamples: mono.length,
    decodedSampleRate: sr,
    metadata: mp3Meta,
    securityChecks: ['Magic bytes verified (MP3)'],
    analyzedSegments: 1,
    analyzedDurationSec: 2,
  });

  assert.equal(result.verdict, 'LOSSY_FORMAT');
  assert.ok(result.spectrogram.dbMatrix.length > 0);
});

test('detects fake zero-padded 24-bit WAV vs true 24-bit PCM LSB activity', () => {
  const fakeBuf = new Uint8Array(300 * 3);
  for (let i = 0; i < 300; i++) {
    fakeBuf[i * 3] = 0x00;
    fakeBuf[i * 3 + 1] = (i * 37) & 0xff;
    fakeBuf[i * 3 + 2] = (i * 13 + 1) & 0xff;
  }
  assert.equal(checkRaw24BitPcmPadding(fakeBuf).isFake24Bit, true);

  const realBuf = new Uint8Array(300 * 3);
  for (let i = 0; i < 300; i++) {
    realBuf[i * 3] = (i * 53 + 7) & 0xff;
    realBuf[i * 3 + 1] = (i * 37) & 0xff;
    realBuf[i * 3 + 2] = (i * 13 + 1) & 0xff;
  }
  assert.equal(checkRaw24BitPcmPadding(realBuf).isFake24Bit, false);
});

test('selectAdaptiveTransientSegments selects up to 8 non-overlapping 4s stereo windows and preserves segmentLengthSamples', () => {
  const sr = 44100;
  const totalSec = 90;
  const left = new Float32Array(sr * totalSec);
  const right = new Float32Array(sr * totalSec);
  const rand = mulberry32(999);

  for (let i = 0; i < left.length; i++) {
    const s = Math.sin((2 * Math.PI * 220 * i) / sr) * 0.05;
    left[i] = s;
    right[i] = s;
  }
  for (const burstSec of [10, 18, 26, 34, 42, 50, 58, 66, 74]) {
    const start = burstSec * sr;
    for (let i = 0; i < sr; i++) {
      // Inject hard-panned HF transients on Left only
      left[start + i] += (rand() * 2 - 1) * 0.45;
    }
  }

  const selected = selectAdaptiveTransientSegments(left, right, sr);
  assert.equal(selected.analyzedSegments, 8);
  assert.equal(selected.segmentLengthSamples, 4 * sr);
  assert.equal(selected.leftSamples.length, 8 * 4 * sr);
  assert.equal(selected.rightSamples?.length, 8 * 4 * sr);
  for (let i = 1; i < selected.segmentStartsSec.length; i++) {
    assert.ok(selected.segmentStartsSec[i] - selected.segmentStartsSec[i - 1] >= 3.99);
  }
});
