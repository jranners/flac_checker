import { fftInPlace, getFftPlan, largestPow2Leq } from './fft';
import type {
  AnalysisResult,
  ForensicMetrics,
  HeaderMetadata,
  PsdCurveData,
  SpectrogramData,
  Verdict,
} from './types';

const FLOOR_DB = -130;
const MIN_LINEAR_POWER = 1e-13; // -130 dBFS

export interface ForensicDspInput {
  monoSamples: Float32Array;
  diffSamples: Float32Array | null;
  decodedSampleRate: number;
  metadata: HeaderMetadata;
  securityChecks: string[];
  analyzedSegments: number;
  analyzedDurationSec: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function percentileSorted(sorted: Float32Array | number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return FLOOR_DB;
  if (n === 1) return sorted[0];
  const idx = clamp(p, 0, 1) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(n - 1, lo + 1);
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function medianSmooth(data: Float32Array, windowSize = 5): Float32Array {
  const n = data.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const half = Math.floor(windowSize / 2);
  const buf = new Array<number>(windowSize);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < windowSize; k++) {
      const idx = clamp(i + k - half, 0, n - 1);
      buf[k] = data[idx];
    }
    buf.sort((a, b) => a - b);
    out[i] = buf[half];
  }
  return out;
}

function bandPercentile(
  freqsKhz: Float32Array,
  curveDb: Float32Array,
  minKhz: number,
  maxKhz: number,
  pct = 0.5,
): number {
  const vals: number[] = [];
  for (let i = 0; i < freqsKhz.length; i++) {
    const f = freqsKhz[i];
    if (f >= minKhz && f <= maxKhz) {
      vals.push(curveDb[i]);
    }
  }
  if (vals.length === 0) return FLOOR_DB;
  vals.sort((a, b) => a - b);
  return percentileSorted(vals, pct);
}

function bandMean(
  freqsKhz: Float32Array,
  values: Float32Array,
  minKhz: number,
  maxKhz: number,
): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < freqsKhz.length; i++) {
    const f = freqsKhz[i];
    if (f >= minKhz && f <= maxKhz) {
      sum += values[i];
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Downsample STFT dB matrix to compact display resolution using max-pooling
 * so high-frequency transients and spectral holes remain visually crisp.
 */
function buildDisplaySpectrogram(
  frameDbCols: Float32Array[],
  rawFreqsKhz: Float32Array,
  rawTimesSec: Float32Array,
  maxFreqBins = 256,
  maxTimeCols = 320,
): SpectrogramData {
  const rawNFreq = rawFreqsKhz.length;
  const rawNTime = frameDbCols.length;
  const nFreq = Math.min(rawNFreq, maxFreqBins);
  const nTime = Math.min(rawNTime, maxTimeCols);

  const frequenciesKhz = new Float32Array(nFreq);
  const timesSec = new Float32Array(nTime);
  const dbMatrix = new Float32Array(nFreq * nTime);

  const nyquistKhz = rawFreqsKhz[rawNFreq - 1] ?? 22.05;
  for (let f = 0; f < nFreq; f++) {
    frequenciesKhz[f] = (f / Math.max(1, nFreq - 1)) * nyquistKhz;
  }

  for (let t = 0; t < nTime; t++) {
    const rawT = Math.min(
      rawNTime - 1,
      Math.floor((t / Math.max(1, nTime - 1)) * (rawNTime - 1)),
    );
    timesSec[t] = rawTimesSec[rawT] ?? 0;
  }

  let maxDb = -Infinity;
  let minDb = Infinity;

  for (let f = 0; f < nFreq; f++) {
    const f0 = Math.floor((f * rawNFreq) / nFreq);
    const f1 = Math.max(f0 + 1, Math.floor(((f + 1) * rawNFreq) / nFreq));

    for (let t = 0; t < nTime; t++) {
      const t0 = Math.floor((t * rawNTime) / nTime);
      const t1 = Math.max(t0 + 1, Math.floor(((t + 1) * rawNTime) / nTime));

      let cellMax = FLOOR_DB;
      for (let ti = t0; ti < t1; ti++) {
        const col = frameDbCols[ti];
        for (let fi = f0; fi < f1; fi++) {
          const val = col[fi];
          if (val > cellMax) cellMax = val;
        }
      }

      dbMatrix[f * nTime + t] = cellMax;
      if (cellMax > maxDb) maxDb = cellMax;
      if (cellMax < minDb) minDb = cellMax;
    }
  }

  if (!Number.isFinite(maxDb)) maxDb = 0;
  if (!Number.isFinite(minDb)) minDb = FLOOR_DB;

  return {
    frequenciesKhz,
    timesSec,
    dbMatrix,
    nFreq,
    nTime,
    maxDb,
    minDb,
  };
}

/**
 * Downsample PSD frequency curves for smooth canvas rendering (up to 512 bins).
 */
function buildDisplayPsdCurve(
  rawFreqsKhz: Float32Array,
  meanDb: Float32Array,
  medianDb: Float32Array,
  p95Db: Float32Array,
  targetBins = 512,
): PsdCurveData {
  const n = rawFreqsKhz.length;
  if (n <= targetBins) {
    return {
      frequenciesKhz: new Float32Array(rawFreqsKhz),
      meanDb: new Float32Array(meanDb),
      medianDb: new Float32Array(medianDb),
      p95Db: new Float32Array(p95Db),
    };
  }

  const outFreq = new Float32Array(targetBins);
  const outMean = new Float32Array(targetBins);
  const outMed = new Float32Array(targetBins);
  const outP95 = new Float32Array(targetBins);

  for (let i = 0; i < targetBins; i++) {
    const start = Math.floor((i * n) / targetBins);
    const end = Math.max(start + 1, Math.floor(((i + 1) * n) / targetBins));
    let sumF = 0;
    let sumMean = 0;
    let sumMed = 0;
    let maxP95 = FLOOR_DB;
    const count = end - start;
    for (let k = start; k < end; k++) {
      sumF += rawFreqsKhz[k];
      sumMean += meanDb[k];
      sumMed += medianDb[k];
      if (p95Db[k] > maxP95) maxP95 = p95Db[k];
    }
    outFreq[i] = sumF / count;
    outMean[i] = sumMean / count;
    outMed[i] = sumMed / count;
    outP95[i] = maxP95;
  }

  return {
    frequenciesKhz: outFreq,
    meanDb: outMean,
    medianDb: outMed,
    p95Db: outP95,
  };
}

/**
 * Core synchronous forensic DSP pipeline.
 * Designed to run inside the Web Worker or via the chunked main-thread fallback.
 */
export function runForensicAnalysis(input: ForensicDspInput): AnalysisResult {
  const {
    monoSamples,
    diffSamples,
    decodedSampleRate,
    metadata,
    securityChecks,
    analyzedSegments,
    analyzedDurationSec,
  } = input;

  if (monoSamples.length < 512 || decodedSampleRate <= 0) {
    throw new Error('Insufficient decoded PCM audio samples for spectral forensics.');
  }

  const headerSampleRate = metadata.sampleRate || decodedSampleRate;
  const browserResampled =
    headerSampleRate > 0 && Math.abs(decodedSampleRate - headerSampleRate) > 10;
  const effectiveSampleRate = Math.min(headerSampleRate, decodedSampleRate);
  const effectiveNyquist = effectiveSampleRate / 2;
  const effectiveNyquistKhz = effectiveNyquist / 1000;

  // FFT size: 4096 for <= 48 kHz, 8192 for > 48 kHz (clamped to sample length)
  const targetFft = decodedSampleRate > 48_000 ? 8192 : 4096;
  const fftSize = Math.max(256, largestPow2Leq(Math.min(targetFft, monoSamples.length)));
  const hop = fftSize >>> 1;
  const plan = getFftPlan(fftSize);
  const { hann, hannSum } = plan;
  const scaleFactor = 2.0 / Math.max(1, hannSum); // Full-scale sine -> 0 dBFS

  // Limit max frequency bin to effectiveNyquist so browser upsampling stopbands aren't evaluated
  const df = decodedSampleRate / fftSize;
  const rawNyquistBins = (fftSize >>> 1) + 1;
  const activeBins = Math.min(
    rawNyquistBins,
    Math.floor(effectiveNyquist / df) + 1,
  );

  const freqsKhz = new Float32Array(activeBins);
  for (let b = 0; b < activeBins; b++) {
    freqsKhz[b] = (b * df) / 1000;
  }

  const totalFrames = Math.max(
    1,
    Math.floor((monoSamples.length - fftSize) / hop) + 1,
  );

  // Cap frame count to ~600 evenly strided frames for bounded memory & speed
  const frameStride = Math.max(1, Math.ceil(totalFrames / 600));
  const frameDbCols: Float32Array[] = [];
  const frameTimes: number[] = [];

  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  // Stereo HF collapse accumulators
  const hasStereoDiff =
    diffSamples !== null && diffSamples.length >= monoSamples.length;
  let midEnergyMidBand = 0;
  let sideEnergyMidBand = 0;
  let midEnergyHfBand = 0;
  let sideEnergyHfBand = 0;
  const reDiff = hasStereoDiff ? new Float64Array(fftSize) : null;
  const imDiff = hasStereoDiff ? new Float64Array(fftSize) : null;

  const bin2k = Math.min(activeBins - 1, Math.round(2000 / df));
  const bin8k = Math.min(activeBins - 1, Math.round(8000 / df));
  const bin14k = Math.min(activeBins - 1, Math.round(14000 / df));
  const bin19k = Math.min(activeBins - 1, Math.round(Math.min(19000, effectiveNyquist - 500) / df));

  for (let frameIdx = 0; frameIdx < totalFrames; frameIdx += frameStride) {
    const start = frameIdx * hop;
    for (let i = 0; i < fftSize; i++) {
      const idx = start + i;
      re[i] = idx < monoSamples.length ? monoSamples[idx] * hann[i] : 0;
      im[i] = 0;
    }
    fftInPlace(re, im);

    const colDb = new Float32Array(activeBins);
    for (let b = 0; b < activeBins; b++) {
      const mag = Math.hypot(re[b], im[b]) * scaleFactor;
      const power = mag * mag;
      colDb[b] =
        power > MIN_LINEAR_POWER
          ? Math.max(FLOOR_DB, 10 * Math.log10(power))
          : FLOOR_DB;
    }
    frameDbCols.push(colDb);
    frameTimes.push((start + fftSize * 0.5) / decodedSampleRate);

    if (hasStereoDiff && diffSamples && reDiff && imDiff) {
      for (let i = 0; i < fftSize; i++) {
        const idx = start + i;
        reDiff[i] = idx < diffSamples.length ? diffSamples[idx] * hann[i] : 0;
        imDiff[i] = 0;
      }
      fftInPlace(reDiff, imDiff);

      for (let b = bin2k; b <= bin8k; b++) {
        midEnergyMidBand += (re[b] * re[b] + im[b] * im[b]) * scaleFactor * scaleFactor;
        sideEnergyMidBand +=
          (reDiff[b] * reDiff[b] + imDiff[b] * imDiff[b]) * scaleFactor * scaleFactor;
      }
      if (bin19k > bin14k) {
        for (let b = bin14k; b <= bin19k; b++) {
          midEnergyHfBand += (re[b] * re[b] + im[b] * im[b]) * scaleFactor * scaleFactor;
          sideEnergyHfBand +=
            (reDiff[b] * reDiff[b] + imDiff[b] * imDiff[b]) * scaleFactor * scaleFactor;
        }
      }
    }
  }

  const numFrames = frameDbCols.length;

  // Identify active frames (excluding near-silent frames from percentile distortion)
  const activeFrameIndices: number[] = [];
  for (let t = 0; t < numFrames; t++) {
    const col = frameDbCols[t];
    let peakCore = FLOOR_DB;
    const cStart = Math.max(1, Math.round(500 / df));
    const cEnd = Math.min(activeBins - 1, Math.round(5000 / df));
    for (let b = cStart; b <= cEnd; b++) {
      if (col[b] > peakCore) peakCore = col[b];
    }
    if (peakCore > -75) {
      activeFrameIndices.push(t);
    }
  }
  const evalFrames =
    activeFrameIndices.length >= 4
      ? activeFrameIndices
      : Array.from({ length: numFrames }, (_, i) => i);
  const evalCount = evalFrames.length;

  // 1. Multi-Percentile Spectral Envelopes (Mean, Median P50, P95) + per-bin temporal std
  const meanDb = new Float32Array(activeBins);
  const medianDb = new Float32Array(activeBins);
  const p95Db = new Float32Array(activeBins);
  const binStdDb = new Float32Array(activeBins);
  const scratch = new Float32Array(evalCount);

  for (let b = 0; b < activeBins; b++) {
    let sum = 0;
    for (let i = 0; i < evalCount; i++) {
      const v = frameDbCols[evalFrames[i]][b];
      scratch[i] = v;
      sum += v;
    }
    const mean = sum / evalCount;
    meanDb[b] = mean;

    let varSum = 0;
    for (let i = 0; i < evalCount; i++) {
      const diff = scratch[i] - mean;
      varSum += diff * diff;
    }
    binStdDb[b] = Math.sqrt(varSum / evalCount);

    scratch.sort();
    medianDb[b] = percentileSorted(scratch, 0.5);
    p95Db[b] = percentileSorted(scratch, 0.95);
  }

  const smoothedP95 = medianSmooth(p95Db, 5);

  // 2. High-Frequency Content Gate (8-13 kHz vs 1-5 kHz core)
  const coreBand1To5KhzDb = bandPercentile(freqsKhz, smoothedP95, 1.0, 5.0, 0.75);
  const refBand8To13KhzDb = bandPercentile(freqsKhz, smoothedP95, 8.0, 13.0, 0.75);
  const hfDeficitDb = coreBand1To5KhzDb - refBand8To13KhzDb;
  const lowHfSourceMaterial =
    effectiveNyquistKhz >= 16 &&
    (hfDeficitDb > 42.0 || refBand8To13KhzDb < -72.0);

  // 3. Hi-Res Upsample Detection (>= 88.2 kHz container with intact 44.1 / 48 kHz master)
  let upsampledMasterRate: 44100 | 48000 | null = null;
  if (
    !metadata.isLossyContainer &&
    !browserResampled &&
    effectiveSampleRate >= 88_200 &&
    !lowHfSourceMaterial
  ) {
    const pre21 = bandPercentile(freqsKhz, smoothedP95, 18.5, 20.8, 0.75);
    const band22to235 = bandPercentile(freqsKhz, smoothedP95, 22.3, 23.4, 0.75);
    const above25 = bandPercentile(
      freqsKhz,
      smoothedP95,
      25.2,
      Math.min(34.0, effectiveNyquistKhz - 0.5),
      0.75,
    );
    const above25Std = bandMean(
      freqsKhz,
      binStdDb,
      25.2,
      Math.min(34.0, effectiveNyquistKhz - 0.5),
    );

    if (pre21 > -75 && above25 < -80 && pre21 - above25 > 22 && above25Std < 7.5) {
      if (band22to235 < -80 && pre21 - band22to235 > 20) {
        upsampledMasterRate = 44100;
      } else if (band22to235 > -76 && band22to235 - above25 > 18) {
        upsampledMasterRate = 48000;
      }
    }
  }

  // 4. Brickwall Cliff vs. Natural Roll-off Scanner (13.5 kHz to min(21.5, effectiveNyquist - 0.5))
  const scanMaxKhz = Math.min(
    effectiveNyquistKhz - 0.5,
    effectiveSampleRate >= 88_200 ? 25.0 : effectiveNyquistKhz - 0.5,
  );
  let bestCliffKhz: number | null = null;
  let bestCliffDropDb = 0;
  let bestCliffSlopeDbPerKhz = 0;
  let bestPreLevelDb = FLOOR_DB;

  if (scanMaxKhz > 14.0) {
    for (let f = 13.5; f <= scanMaxKhz; f += 0.15) {
      const preLevel = bandPercentile(freqsKhz, smoothedP95, f - 0.85, f - 0.15, 0.5);
      const postLevel = bandPercentile(
        freqsKhz,
        smoothedP95,
        f + 0.15,
        Math.min(f + 0.85, effectiveNyquistKhz - 0.1),
        0.5,
      );
      const drop = preLevel - postLevel;
      const slope = drop / 0.7; // dB per kHz across the 700 Hz transition

      // Require audible energy before the cliff so we don't trigger on deep noise floor bumps
      if (preLevel > -78 && drop > bestCliffDropDb) {
        bestCliffDropDb = drop;
        bestCliffSlopeDbPerKhz = slope;
        bestCliffKhz = f;
        bestPreLevelDb = preLevel;
      }
    }
  }

  // Evaluate dead-zone floor & temporal variance collapse above the detected cliff
  const evalCutoffKhz = bestCliffKhz ?? Math.min(20.0, effectiveNyquistKhz - 1.0);
  const deadStartKhz = Math.min(effectiveNyquistKhz - 0.4, evalCutoffKhz + 0.6);
  const deadEndKhz = Math.min(effectiveNyquistKhz - 0.15, evalCutoffKhz + 3.5);

  const deadZoneFloorDb =
    deadEndKhz > deadStartKhz + 0.2
      ? bandPercentile(freqsKhz, smoothedP95, deadStartKhz, deadEndKhz, 0.5)
      : bandPercentile(
          freqsKhz,
          smoothedP95,
          Math.max(14.0, effectiveNyquistKhz - 1.5),
          effectiveNyquistKhz - 0.15,
          0.5,
        );

  const aboveCutoffStdDb =
    deadEndKhz > deadStartKhz + 0.2
      ? bandMean(freqsKhz, binStdDb, deadStartKhz, deadEndKhz)
      : bandMean(
          freqsKhz,
          binStdDb,
          Math.max(14.0, effectiveNyquistKhz - 1.5),
          effectiveNyquistKhz - 0.15,
        );
  const belowCutoffStdDb = bandMean(
    freqsKhz,
    binStdDb,
    Math.max(10.0, evalCutoffKhz - 3.0),
    Math.max(11.0, evalCutoffKhz - 0.5),
  );
  const temporalVarianceDropDb = Math.max(0, belowCutoffStdDb - aboveCutoffStdDb);

  // 5. Subtle Transcode Fingerprints:
  // 5a. Spectral Hole ("Swiss Cheese") Detector between 14 kHz and cutoff
  const holeStartBin = Math.min(activeBins - 2, Math.max(2, Math.round(14_000 / df)));
  const holeUpperKhz =
    bestCliffKhz !== null && bestCliffDropDb >= 12
      ? Math.min(bestCliffKhz, effectiveNyquistKhz - 0.4)
      : Math.min(20.5, effectiveNyquistKhz - 0.4);
  const holeEndBin = Math.min(
    activeBins - 2,
    Math.max(holeStartBin, Math.round((holeUpperKhz * 1000) / df)),
  );

  let holeCandidates = 0;
  let holeHits = 0;
  if (holeEndBin > holeStartBin + 4) {
    for (let i = 0; i < evalCount; i++) {
      const col = frameDbCols[evalFrames[i]];
      for (let b = holeStartBin; b <= holeEndBin; b++) {
        const left = col[b - 1];
        const right = col[b + 1];
        const center = col[b];
        if (left > -58 || right > -58) {
          holeCandidates++;
          if (center < -92) {
            holeHits++;
          }
        }
      }
    }
  }
  const spectralHolePercent =
    holeCandidates >= 20 ? (holeHits / holeCandidates) * 100 : 0;

  // 5b. LAME sfb21 16 kHz Shelf Detector (step drop around 15.8-16.3 kHz)
  const shelfPreDb = bandPercentile(freqsKhz, smoothedP95, 14.4, 15.6, 0.5);
  const shelfPostDb = bandPercentile(freqsKhz, smoothedP95, 16.3, 17.8, 0.5);
  const shelf16KhzDropDb =
    effectiveNyquistKhz > 18.5 && shelfPreDb > -74
      ? Math.max(0, shelfPreDb - shelfPostDb)
      : 0;
  const has16KhzShelf =
    shelf16KhzDropDb >= 8.5 && shelfPostDb > -96 && shelfPostDb < shelfPreDb - 8.5;

  // 5c. High-Frequency Stereo Collapse Indicator
  let hfStereoCollapseDb: number | null = null;
  if (hasStereoDiff && midEnergyMidBand > 1e-10 && midEnergyHfBand > 1e-11) {
    const midBandRatioDb =
      10 * Math.log10(Math.max(sideEnergyMidBand, 1e-13) / midEnergyMidBand);
    const hfBandRatioDb =
      10 * Math.log10(Math.max(sideEnergyHfBand, 1e-13) / midEnergyHfBand);
    // Positive number means side channel attenuated more at HF than in 2-8 kHz
    // Only meaningful if track actually has stereo width in 2-8 kHz (ratio > -24 dB)
    if (midBandRatioDb > -24) {
      hfStereoCollapseDb = Math.max(0, midBandRatioDb - hfBandRatioDb);
    }
  }

  // Check active energy near Nyquist
  const nearNyquistStart =
    effectiveSampleRate >= 47_500 ? 21.2 : Math.min(20.6, effectiveNyquistKhz - 1.2);
  const nearNyquistEnd = effectiveNyquistKhz - 0.25;
  const nearNyquistP95Db =
    nearNyquistEnd > nearNyquistStart
      ? bandPercentile(freqsKhz, smoothedP95, nearNyquistStart, nearNyquistEnd, 0.75)
      : FLOOR_DB;

  // 6. Multi-Feature Classification Decision Tree
  let verdict: Verdict;
  let subLabel: string | null = null;
  let confidence: number;
  let cutoffKhz: number | null = null;
  let estimatedSource: string;
  let reasoning: string;

  const hasDeadZone =
    deadZoneFloorDb < -85 || bestPreLevelDb - deadZoneFloorDb >= 32;
  const hasVarianceCollapse =
    aboveCutoffStdDb < 3.2 || temporalVarianceDropDb >= 4.0;
  const hasCorroboratingLossy =
    has16KhzShelf ||
    spectralHolePercent >= 6.0 ||
    (hfStereoCollapseDb !== null && hfStereoCollapseDb >= 10.0);

  const isSharpBrickwallBelow20_5 =
    bestCliffKhz !== null &&
    bestCliffKhz <= 20.55 &&
    bestCliffDropDb >= 14.0 &&
    bestCliffSlopeDbPerKhz >= 14.0 &&
    (hasDeadZone || (hasVarianceCollapse && bestCliffDropDb >= 18.0));

  const isSevereSpectralHoleLossy =
    spectralHolePercent >= 12.0 && (has16KhzShelf || deadZoneFloorDb < -80);

  if (metadata.isLossyContainer) {
    verdict = 'LOSSY_FORMAT';
    cutoffKhz =
      bestCliffKhz !== null && bestCliffDropDb >= 12
        ? Number(bestCliffKhz.toFixed(2))
        : null;
    confidence = 99;
    estimatedSource = `${metadata.codecHint}${metadata.bitrate > 0 ? ` · ~${Math.round(metadata.bitrate / 1000)} kbps` : ''}`;
    reasoning =
      cutoffKhz !== null
        ? `File is stored in an inherently lossy ${metadata.container} container (${metadata.codecHint}). Spectral analysis confirms an encoder low-pass ceiling near ${cutoffKhz.toFixed(1)} kHz.`
        : `File is stored in an inherently lossy ${metadata.container} container (${metadata.codecHint}). Full spectrogram and P95 envelope were computed for inspection.`;
  } else if (upsampledMasterRate !== null) {
    verdict = 'UPSAMPLED_LOSSLESS';
    subLabel =
      upsampledMasterRate === 44100
        ? '44.1 kHz CD Master in Hi-Res Container'
        : '48 kHz Master in Hi-Res Container';
    cutoffKhz = upsampledMasterRate === 44100 ? 22.05 : 24.0;
    confidence = 91;
    estimatedSource = `Genuine ${upsampledMasterRate / 1000} kHz Lossless Master (Upsampled)`;
    reasoning =
      `Intact lossless spectral energy extends cleanly up to the ${upsampledMasterRate / 1000} kHz Nyquist limit (~${cutoffKhz.toFixed(1)} kHz) with a clean anti-aliasing stopband above it. This appears to be a genuine standard-definition lossless master upsampled into a ${(effectiveSampleRate / 1000).toFixed(1)} kHz container rather than a lossy transcode.`;
  } else if (lowHfSourceMaterial) {
    verdict = 'SUSPICIOUS';
    subLabel = 'Low High-Frequency Source Material';
    cutoffKhz =
      bestCliffKhz !== null && bestCliffDropDb >= 12
        ? Number(bestCliffKhz.toFixed(2))
        : null;
    confidence = 42;
    estimatedSource = 'Acoustic / Vintage / Bandwidth-Limited Recording';
    reasoning =
      `The 8–13 kHz reference band is naturally depleted (${refBand8To13KhzDb.toFixed(1)} dBFS, ${hfDeficitDb.toFixed(1)} dB below the 1–5 kHz core). Because the source recording lacks strong high-frequency transients, a transcode cannot be conclusively proven—inspect the spectrogram manually.`;
  } else if (isSharpBrickwallBelow20_5 || isSevereSpectralHoleLossy) {
    verdict = 'FAKE_TRANSCODE';
    cutoffKhz =
      bestCliffKhz !== null ? Number(bestCliffKhz.toFixed(2)) : 19.5;

    if (cutoffKhz <= 16.8) {
      estimatedSource = 'MP3 ~128 kbps / Low-Bitrate Lossy';
    } else if (cutoffKhz <= 19.3) {
      estimatedSource = 'MP3 192–256 kbps / AAC 128–192 kbps';
    } else {
      estimatedSource = has16KhzShelf
        ? 'MP3 320 kbps / LAME V0 (sfb21 shelf)'
        : 'MP3 320 kbps / V0 / AAC 256 kbps';
    }

    let rawConf = 72;
    if (bestCliffDropDb >= 20) rawConf += 10;
    if (bestCliffSlopeDbPerKhz >= 22) rawConf += 6;
    if (hasDeadZone) rawConf += 6;
    if (hasVarianceCollapse) rawConf += 4;
    if (hasCorroboratingLossy) rawConf += 6;
    confidence = Math.round(clamp(rawConf, 72, 98));

    const evidenceParts: string[] = [];
    if (isSharpBrickwallBelow20_5) {
      evidenceParts.push(
        `a steep brickwall cutoff near ${cutoffKhz.toFixed(1)} kHz (${bestCliffSlopeDbPerKhz.toFixed(1)} dB/kHz slope, dead-zone floor at ${deadZoneFloorDb.toFixed(0)} dBFS)`,
      );
    }
    if (has16KhzShelf) {
      evidenceParts.push(
        `a ${shelf16KhzDropDb.toFixed(1)} dB LAME sfb21 shelf near 16 kHz`,
      );
    }
    if (spectralHolePercent >= 6.0) {
      evidenceParts.push(
        `${spectralHolePercent.toFixed(1)}% psychoacoustic spectral holes above 14 kHz`,
      );
    }
    if (hfStereoCollapseDb !== null && hfStereoCollapseDb >= 10.0) {
      evidenceParts.push(
        `${hfStereoCollapseDb.toFixed(1)} dB high-frequency stereo side collapse`,
      );
    }

    reasoning = `Detected ${evidenceParts.join(' combined with ')}. This spectral signature strongly indicates an upconverted lossy source (${estimatedSource}).`;
  } else if (
    (bestCliffKhz !== null &&
      bestCliffKhz >= 20.0 &&
      bestCliffKhz <= 20.65 &&
      bestCliffDropDb >= 12 &&
      hasDeadZone) ||
    has16KhzShelf ||
    spectralHolePercent >= 7.5 ||
    nearNyquistP95Db < -86
  ) {
    verdict = 'SUSPICIOUS';
    cutoffKhz =
      bestCliffKhz !== null && bestCliffDropDb >= 10
        ? Number(bestCliffKhz.toFixed(2))
        : null;
    confidence = 58;
    estimatedSource = has16KhzShelf
      ? 'Possible MP3 320 kbps / V0 or Filtered Master'
      : 'Borderline Cutoff or Gentle Master Roll-Off';
    subLabel = metadata.isFake24Bit
      ? 'Zero-Padded 24-bit WAV'
      : has16KhzShelf
        ? '16 kHz Spectral Shelf Detected'
        : 'Borderline Upper-Spectrum Roll-Off';
    reasoning =
      cutoffKhz !== null
        ? `Upper-spectrum energy drops near ${cutoffKhz.toFixed(1)} kHz (${bestCliffSlopeDbPerKhz.toFixed(1)} dB/kHz), which is borderline between a high-bitrate lossy encoder and a gentle mastering low-pass filter. Review the P95 curve and spectrogram to confirm.`
        : `High-frequency energy near Nyquist is unusually weak (${nearNyquistP95Db.toFixed(1)} dBFS) without a definitive brickwall cliff. Manual spectrogram inspection is recommended.`;
  } else {
    verdict = 'GENUINE_LOSSLESS';
    cutoffKhz = null;
    subLabel = metadata.isFake24Bit ? 'Padded 16-bit in 24-bit WAV' : null;
    let conf = 86;
    if (nearNyquistP95Db > -65) conf += 7;
    if (spectralHolePercent < 2.0) conf += 3;
    if (!has16KhzShelf) conf += 2;
    confidence = Math.round(clamp(conf, 80, 98));
    estimatedSource = `Authentic ${(effectiveSampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz Lossless Master`;
    reasoning =
      `Active high-frequency transients extend naturally toward the ${effectiveNyquistKhz.toFixed(1)} kHz Nyquist ceiling (P95 ${nearNyquistP95Db.toFixed(1)} dBFS) with no brickwall cutoff or psychoacoustic spectral holes.` +
      (metadata.isFake24Bit
        ? ' Note: raw PCM inspection found the lower 8 bits are zero-padded (effective 16-bit resolution).'
        : '');
  }

  const metrics: ForensicMetrics = {
    cliffSlopeDbPerKhz: Number(bestCliffSlopeDbPerKhz.toFixed(2)),
    deadZoneFloorDb: Number(deadZoneFloorDb.toFixed(1)),
    temporalVarianceDropDb: Number(temporalVarianceDropDb.toFixed(2)),
    aboveCutoffStdDb: Number(aboveCutoffStdDb.toFixed(2)),
    referenceBand8To13KhzDb: Number(refBand8To13KhzDb.toFixed(1)),
    coreBand1To5KhzDb: Number(coreBand1To5KhzDb.toFixed(1)),
    spectralHolePercent: Number(spectralHolePercent.toFixed(2)),
    shelf16KhzDropDb: Number(shelf16KhzDropDb.toFixed(2)),
    has16KhzShelf,
    hfStereoCollapseDb:
      hfStereoCollapseDb !== null ? Number(hfStereoCollapseDb.toFixed(2)) : null,
    trueBitDepthNote: metadata.trueBitDepthNote ?? null,
    isFake24Bit: Boolean(metadata.isFake24Bit),
    browserResampled,
    decodedSampleRate,
    effectiveSampleRate,
    effectiveNyquist,
    analyzedSegments,
    analyzedDurationSec: Number(analyzedDurationSec.toFixed(2)),
    fftSize,
  };

  const spectrogram = buildDisplaySpectrogram(
    frameDbCols,
    freqsKhz,
    new Float32Array(frameTimes),
  );
  const psdCurve = buildDisplayPsdCurve(freqsKhz, meanDb, medianDb, p95Db);

  return {
    verdict,
    subLabel,
    confidence,
    cutoffKhz,
    estimatedSource,
    reasoning,
    metadata,
    metrics,
    securityChecks,
    spectrogram,
    psdCurve,
  };
}
