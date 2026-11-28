import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAdaptiveTransientSegments } from './audioDecoder';
import { runForensicAnalysis } from './cutoffDetector';
import { fftInPlace } from './fft';
import { checkRaw24BitPcmPadding } from './headerParser';
import type { HeaderMetadata } from './types';

// Deterministic PRNG (Mulberry32) so tests are 100% reproducible
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
 * Synthesize broadband noise with optional sharp spectral brickwall cutoff via FFT filtering.
 */
function synthesizeSpectrumSignal(
  sampleRate: number,
  durationSec: number,
  cutoffHz: number | null,
  seed = 42,
): Float32Array {
  const rand = mulberry32(seed);
  const n = Math.floor(sampleRate * durationSec);
  const out = new Float32Array(n);

  if (cutoffHz === null) {
    for (let i = 0; i < n; i++) {
      out[i] = (rand() * 2 - 1) * 0.28;
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
    re[b] *= 1e-6;
    im[b] *= 1e-6;
    if (b > 0 && b < nyqBin) {
      re[fftLen - b] *= 1e-6;
      im[fftLen - b] *= 1e-6;
    }
  }
  for (let i = 0; i < fftLen; i++) im[i] = -im[i];
  fftInPlace(re, im);
  const invN = 1 / fftLen;
  for (let i = 0; i < n; i++) {
    out[i] = re[i] * invN;
  }

  return out;
}

function makeLosslessMeta(sampleRate: number, duration: number): HeaderMetadata {
  return {
    container: 'FLAC',
    codecHint: 'FLAC Lossless',
    isLossyContainer: false,
    sampleRate,
    bitDepth: 16,
    channels: 2,
    totalSamples: Math.floor(sampleRate * duration),
    duration,
    bitrate: 920_000,
    md5Hash: '1234567890abcdef1234567890abcdef',
  };
}

test('classifies broadband 44.1 kHz signal as GENUINE_LOSSLESS with no cutoff', () => {
  const sr = 44100;
  const mono = synthesizeSpectrumSignal(sr, 3, null, 101);
  const result = runForensicAnalysis({
    monoSamples: mono,
    diffSamples: null,
    decodedSampleRate: sr,
    metadata: makeLosslessMeta(sr, 3),
    securityChecks: ['Magic bytes verified (FLAC)'],
    analyzedSegments: 1,
    analyzedDurationSec: 3,
  });

  assert.equal(result.verdict, 'GENUINE_LOSSLESS');
  assert.equal(result.cutoffKhz, null);
  assert.ok(result.confidence >= 80);
  assert.ok(result.spectrogram.dbMatrix.length > 0);
  assert.ok(result.psdCurve.p95Db.length > 0);
});

test('detects 16 kHz brickwall transcode as FAKE_TRANSCODE (~128 kbps)', () => {
  const sr = 44100;
  const mono = synthesizeSpectrumSignal(sr, 3, 16000, 202);
  const result = runForensicAnalysis({
    monoSamples: mono,
    diffSamples: null,
    decodedSampleRate: sr,
    metadata: makeLosslessMeta(sr, 3),
    securityChecks: ['Magic bytes verified (FLAC)'],
    analyzedSegments: 1,
    analyzedDurationSec: 3,
  });

  assert.equal(result.verdict, 'FAKE_TRANSCODE');
  assert.ok(result.cutoffKhz !== null && Math.abs(result.cutoffKhz - 16.0) < 0.8);
  assert.ok(result.estimatedSource.includes('128'));
  assert.ok(result.confidence >= 72);
});

test('protects vintage/acoustic low-HF recordings via 8-13 kHz content gate (SUSPICIOUS, not FAKE)', () => {
  const sr = 44100;
  // Energy only below 6 kHz (simulating old mono/vintage/acoustic recording)
  const mono = synthesizeSpectrumSignal(sr, 3, 6000, 303);
  const result = runForensicAnalysis({
    monoSamples: mono,
    diffSamples: null,
    decodedSampleRate: sr,
    metadata: makeLosslessMeta(sr, 3),
    securityChecks: ['Magic bytes verified (FLAC)'],
    analyzedSegments: 1,
    analyzedDurationSec: 3,
  });

  assert.equal(result.verdict, 'SUSPICIOUS');
  assert.equal(result.subLabel, 'Low High-Frequency Source Material');
  assert.ok(result.confidence <= 50);
});

test('classifies 96 kHz container holding a clean 44.1 kHz master as UPSAMPLED_LOSSLESS', () => {
  const sr = 96000;
  // Clean signal up to 21.8 kHz inside 96 kHz container
  const mono = synthesizeSpectrumSignal(sr, 2.5, 21800, 404);
  const result = runForensicAnalysis({
    monoSamples: mono,
    diffSamples: null,
    decodedSampleRate: sr,
    metadata: makeLosslessMeta(sr, 2.5),
    securityChecks: ['Magic bytes verified (FLAC)'],
    analyzedSegments: 1,
    analyzedDurationSec: 2.5,
  });

  assert.equal(result.verdict, 'UPSAMPLED_LOSSLESS');
  assert.equal(result.cutoffKhz, 22.05);
  assert.ok(result.subLabel?.includes('44.1 kHz'));
});

test('tags inherently lossy MP3 container as LOSSY_FORMAT while computing spectrogram', () => {
  const sr = 44100;
  const mono = synthesizeSpectrumSignal(sr, 2, 18500, 505);
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
    monoSamples: mono,
    diffSamples: null,
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
  // Fake 24-bit: every 3-byte sample has byte 0 === 0
  const fakeBuf = new Uint8Array(300 * 3);
  for (let i = 0; i < 300; i++) {
    fakeBuf[i * 3] = 0x00;
    fakeBuf[i * 3 + 1] = (i * 37) & 0xff;
    fakeBuf[i * 3 + 2] = (i * 13 + 1) & 0xff;
  }
  const fakeCheck = checkRaw24BitPcmPadding(fakeBuf);
  assert.equal(fakeCheck.isFake24Bit, true);

  // Genuine 24-bit: active non-zero LSB values
  const realBuf = new Uint8Array(300 * 3);
  for (let i = 0; i < 300; i++) {
    realBuf[i * 3] = (i * 53 + 7) & 0xff;
    realBuf[i * 3 + 1] = (i * 37) & 0xff;
    realBuf[i * 3 + 2] = (i * 13 + 1) & 0xff;
  }
  const realCheck = checkRaw24BitPcmPadding(realBuf);
  assert.equal(realCheck.isFake24Bit, false);
});

test('selectAdaptiveTransientSegments picks non-overlapping 4s high-transient segments on long tracks', () => {
  const sr = 44100;
  const totalSec = 70;
  const mono = new Float32Array(sr * totalSec);
  const rand = mulberry32(999);

  // Fill track with quiet low sine, then inject crisp HF transient bursts across 12s..58s
  for (let i = 0; i < mono.length; i++) {
    mono[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * 0.05;
  }
  for (const burstSec of [12, 20, 28, 36, 44, 52]) {
    const start = burstSec * sr;
    for (let i = 0; i < sr; i++) {
      mono[start + i] += (rand() * 2 - 1) * 0.45;
    }
  }

  const selected = selectAdaptiveTransientSegments(mono, null, sr);
  assert.equal(selected.analyzedSegments, 6);
  assert.equal(selected.monoSamples.length, 6 * 4 * sr);
  // Ensure segments are sorted and non-overlapping (>= 4s apart)
  for (let i = 1; i < selected.segmentStartsSec.length; i++) {
    assert.ok(selected.segmentStartsSec[i] - selected.segmentStartsSec[i - 1] >= 3.99);
  }
});
