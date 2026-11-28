import { fftInPlace, getFftPlan, largestPow2Leq } from './fft';
import type {
  AnalysisResult,
  ForensicFactor,
  ForensicMetrics,
  HeaderMetadata,
  PsdCurveData,
  SpectrogramData,
  Verdict,
} from './types';

const FLOOR_DB = -145;
const MIN_LINEAR_POWER = 3.16227766e-15; // 10^(-14.5) -> -145 dBFS

export interface ForensicDspInput {
  /** Left channel (stereo) or mono/downmix samples, packed segment-by-segment. */
  leftSamples: Float32Array;
  /** Right channel for stereo tracks (null for mono/multichannel), packed identically. */
  rightSamples: Float32Array | null;
  /** Sample length of each segment so STFT never crosses segment boundaries. */
  segmentLengthSamples: number;
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
 * Ordinary/weighted linear regression slope (dB/kHz) over a frequency interval.
 */
function fitLinearSlope(
  freqsKhz: Float32Array,
  curveDb: Float32Array,
  minKhz: number,
  maxKhz: number,
  weightActive = true,
): { slope: number; intercept: number; validCount: number } {
  let sumW = 0;
  let sumWX = 0;
  let sumWY = 0;
  let sumWXX = 0;
  let sumWXY = 0;
  let validCount = 0;

  for (let i = 0; i < freqsKhz.length; i++) {
    const x = freqsKhz[i];
    if (x < minKhz || x > maxKhz) continue;
    const y = curveDb[i];
    if (weightActive && y <= FLOOR_DB + 2) continue;
    const w = weightActive ? clamp((y + 115) / 60, 0.15, 2.0) : 1.0;
    sumW += w;
    sumWX += w * x;
    sumWY += w * y;
    sumWXX += w * x * x;
    sumWXY += w * x * y;
    validCount++;
  }

  if (sumW <= 0 || validCount < 2) {
    return { slope: -1.5, intercept: -40, validCount };
  }

  const denom = sumW * sumWXX - sumWX * sumWX;
  if (Math.abs(denom) <= 1e-9) {
    return { slope: 0, intercept: sumWY / sumW, validCount };
  }

  const slope = (sumW * sumWXY - sumWX * sumWY) / denom;
  const intercept = (sumWY / sumW) - slope * (sumWX / sumW);
  return { slope, intercept, validCount };
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
  expectedDb: Float32Array,
  targetBins = 512,
): PsdCurveData {
  const n = rawFreqsKhz.length;
  if (n <= targetBins) {
    return {
      frequenciesKhz: new Float32Array(rawFreqsKhz),
      meanDb: new Float32Array(meanDb),
      medianDb: new Float32Array(medianDb),
      p95Db: new Float32Array(p95Db),
      expectedDb: new Float32Array(expectedDb),
    };
  }

  const outFreq = new Float32Array(targetBins);
  const outMean = new Float32Array(targetBins);
  const outMed = new Float32Array(targetBins);
  const outP95 = new Float32Array(targetBins);
  const outExp = new Float32Array(targetBins);

  for (let i = 0; i < targetBins; i++) {
    const start = Math.floor((i * n) / targetBins);
    const end = Math.max(start + 1, Math.floor(((i + 1) * n) / targetBins));
    let sumF = 0;
    let sumMean = 0;
    let sumMed = 0;
    let sumExp = 0;
    let maxP95 = FLOOR_DB;
    const count = end - start;
    for (let k = start; k < end; k++) {
      sumF += rawFreqsKhz[k];
      sumMean += meanDb[k];
      sumMed += medianDb[k];
      sumExp += expectedDb[k];
      if (p95Db[k] > maxP95) maxP95 = p95Db[k];
    }
    outFreq[i] = sumF / count;
    outMean[i] = sumMean / count;
    outMed[i] = sumMed / count;
    outP95[i] = maxP95;
    outExp[i] = sumExp / count;
  }

  return {
    frequenciesKhz: outFreq,
    meanDb: outMean,
    medianDb: outMed,
    p95Db: outP95,
    expectedDb: outExp,
  };
}

/**
 * Core synchronous multi-feature forensic DSP pipeline.
 * Runs deterministically in the Web Worker or via main-thread fallback.
 */
export function runForensicAnalysis(input: ForensicDspInput): AnalysisResult {
  const {
    leftSamples,
    rightSamples,
    segmentLengthSamples,
    decodedSampleRate,
    metadata,
    securityChecks,
    analyzedSegments,
    analyzedDurationSec,
  } = input;

  if (leftSamples.length < 512 || decodedSampleRate <= 0) {
    throw new Error('Insufficient decoded PCM audio samples for spectral forensics.');
  }

  const headerSampleRate = metadata.sampleRate || decodedSampleRate;
  const browserResampled =
    headerSampleRate > 0 && Math.abs(decodedSampleRate - headerSampleRate) > 10;
  const effectiveSampleRate = Math.min(headerSampleRate, decodedSampleRate);
  const effectiveNyquist = effectiveSampleRate / 2;
  const effectiveNyquistKhz = effectiveNyquist / 1000;

  const hasStereo =
    rightSamples !== null && rightSamples.length >= leftSamples.length;

  // Segment-boundary isolation: STFT windows NEVER cross segment splices
  const segLen = Math.max(
    512,
    Math.min(
      leftSamples.length,
      segmentLengthSamples > 0 ? segmentLengthSamples : leftSamples.length,
    ),
  );
  const numSegs = Math.max(1, Math.floor(leftSamples.length / segLen));

  // FFT size: 4096 for <= 48 kHz, 8192 for > 48 kHz (clamped to individual segment length)
  const targetFft = decodedSampleRate > 48_000 ? 8192 : 4096;
  const fftSize = Math.max(256, largestPow2Leq(Math.min(targetFft, segLen)));
  const hop = fftSize >>> 1;
  const plan = getFftPlan(fftSize);
  const { hann, hannSum } = plan;
  const scaleFactor = 2.0 / Math.max(1, hannSum); // Full-scale sine -> 0 dBFS
  const sf2 = scaleFactor * scaleFactor;

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

  const framesPerSeg = Math.max(1, Math.floor((segLen - fftSize) / hop) + 1);
  const totalPossibleFrames = framesPerSeg * numSegs;
  const frameStride = Math.max(1, Math.ceil(totalPossibleFrames / 680));

  const frameDbCols: Float32Array[] = [];
  const frameTimes: number[] = [];

  // Compact per-frame stereo Mid/Side sub-band energy storage (250 Hz resolution)
  // so Signal 6 can evaluate strictly inside the passband below terminalCutoffKhz
  const stereoSubWidthKhz = 0.25;
  const stereoSubCount = hasStereo
    ? Math.max(1, Math.ceil(effectiveNyquistKhz / stereoSubWidthKhz))
    : 0;
  const frameMidSubPow: Float32Array[] = [];
  const frameSideSubPow: Float32Array[] = [];
  const stereoSubBinCounts = hasStereo ? new Uint16Array(stereoSubCount) : null;
  if (hasStereo && stereoSubBinCounts) {
    for (let b = 0; b < activeBins; b++) {
      const sb = Math.min(stereoSubCount - 1, Math.floor(freqsKhz[b] / stereoSubWidthKhz));
      stereoSubBinCounts[sb]++;
    }
  }

  const reL = new Float64Array(fftSize);
  const imL = new Float64Array(fftSize);
  const reR = hasStereo ? new Float64Array(fftSize) : null;
  const imR = hasStereo ? new Float64Array(fftSize) : null;

  // Run STFT strictly inside each segment boundary
  for (let seg = 0; seg < numSegs; seg++) {
    const segOffset = seg * segLen;
    for (let localFrame = 0; localFrame < framesPerSeg; localFrame += frameStride) {
      const start = segOffset + localFrame * hop;
      if (start + fftSize > segOffset + segLen) break;

      for (let i = 0; i < fftSize; i++) {
        reL[i] = leftSamples[start + i] * hann[i];
        imL[i] = 0;
      }
      fftInPlace(reL, imL);

      const colDb = new Float32Array(activeBins);

      if (hasStereo && rightSamples && reR && imR) {
        for (let i = 0; i < fftSize; i++) {
          reR[i] = rightSamples[start + i] * hann[i];
          imR[i] = 0;
        }
        fftInPlace(reR, imR);

        const midSub = new Float32Array(stereoSubCount);
        const sideSub = new Float32Array(stereoSubCount);

        for (let b = 0; b < activeBins; b++) {
          const rL = reL[b];
          const iL = imL[b];
          const rR = reR[b];
          const iR = imR[b];

          const powL = (rL * rL + iL * iL) * sf2;
          const powR = (rR * rR + iR * iR) * sf2;
          // Use max(power_L, power_R) to avoid phase cancellation of wide stereo HF transients
          const maxPow = powL > powR ? powL : powR;
          colDb[b] =
            maxPow > MIN_LINEAR_POWER
              ? Math.max(FLOOR_DB, 10 * Math.log10(maxPow))
              : FLOOR_DB;

          // Mid = (L + R)/2, Side = (L - R)/2 via FFT linearity
          const mR = 0.5 * (rL + rR);
          const mI = 0.5 * (iL + iR);
          const sR = 0.5 * (rL - rR);
          const sI = 0.5 * (iL - iR);
          const sb = Math.min(
            stereoSubCount - 1,
            Math.floor(freqsKhz[b] / stereoSubWidthKhz),
          );
          midSub[sb] += (mR * mR + mI * mI) * sf2;
          sideSub[sb] += (sR * sR + sI * sI) * sf2;
        }

        frameMidSubPow.push(midSub);
        frameSideSubPow.push(sideSub);
      } else {
        for (let b = 0; b < activeBins; b++) {
          const powL = (reL[b] * reL[b] + imL[b] * imL[b]) * sf2;
          colDb[b] =
            powL > MIN_LINEAR_POWER
              ? Math.max(FLOOR_DB, 10 * Math.log10(powL))
              : FLOOR_DB;
        }
      }

      frameDbCols.push(colDb);
      frameTimes.push((start + fftSize * 0.5) / decodedSampleRate);
    }
  }

  const numFrames = frameDbCols.length;

  // Identify active frames (excluding near-silent passages)
  const activeFrameIndices: number[] = [];
  const coreStartBin = Math.max(1, Math.round(500 / df));
  const coreEndBin = Math.min(activeBins - 1, Math.round(5000 / df));
  for (let t = 0; t < numFrames; t++) {
    const col = frameDbCols[t];
    let peakCore = FLOOR_DB;
    for (let b = coreStartBin; b <= coreEndBin; b++) {
      if (col[b] > peakCore) peakCore = col[b];
    }
    if (peakCore > -78) {
      activeFrameIndices.push(t);
    }
  }
  const evalFrames =
    activeFrameIndices.length >= 4
      ? activeFrameIndices
      : Array.from({ length: numFrames }, (_, i) => i);
  const evalCount = evalFrames.length;

  // Per-bin Mean, Median (P50), P95, linear mean power, and temporal std
  const meanDb = new Float32Array(activeBins);
  const medianDb = new Float32Array(activeBins);
  const p95Db = new Float32Array(activeBins);
  const binStdDb = new Float32Array(activeBins);
  const meanLinearPower = new Float64Array(activeBins);
  const scratch = new Float32Array(evalCount);

  for (let b = 0; b < activeBins; b++) {
    let sum = 0;
    let linSum = 0;
    for (let i = 0; i < evalCount; i++) {
      const v = frameDbCols[evalFrames[i]][b];
      scratch[i] = v;
      sum += v;
      linSum += Math.pow(10, v / 10);
    }
    const mean = sum / evalCount;
    meanDb[b] = mean;
    meanLinearPower[b] = linSum / evalCount;

    let varSum = 0;
    for (let i = 0; i < evalCount; i++) {
      const d = scratch[i] - mean;
      varSum += d * d;
    }
    binStdDb[b] = Math.sqrt(varSum / evalCount);

    scratch.sort();
    medianDb[b] = percentileSorted(scratch, 0.5);
    p95Db[b] = percentileSorted(scratch, 0.95);
  }

  const smoothedP95 = medianSmooth(p95Db, 5);

  // High-Frequency Content Gate (8–13 kHz vs 1–5 kHz core)
  const coreBand1To5KhzDb = bandPercentile(freqsKhz, smoothedP95, 1.0, 5.0, 0.75);
  const refBand8To13KhzDb = bandPercentile(freqsKhz, smoothedP95, 8.0, 13.0, 0.75);
  const hfDeficitDb = coreBand1To5KhzDb - refBand8To13KhzDb;
  const lowHfSourceMaterial =
    effectiveNyquistKhz >= 15.5 &&
    (refBand8To13KhzDb < -72.0 || hfDeficitDb > 44.0);

  // Hi-Res Upsample Gate: allow whenever effectiveSampleRate >= 88.2 kHz
  // (even when 176.4/192 kHz was clamped to 96 kHz by OfflineAudioContext, since 22.05/24 kHz remain below 48 kHz Nyquist)
  let upsampledMasterRate: 44100 | 48000 | null = null;
  if (
    !metadata.isLossyContainer &&
    effectiveSampleRate >= 88_200 &&
    !lowHfSourceMaterial
  ) {
    const pre21 = bandPercentile(freqsKhz, smoothedP95, 18.5, 21.2, 0.75);
    const band22to238 = bandPercentile(freqsKhz, smoothedP95, 22.3, 23.8, 0.75);
    const above25 = bandPercentile(
      freqsKhz,
      smoothedP95,
      25.0,
      Math.min(34.0, effectiveNyquistKhz - 0.5),
      0.75,
    );
    const above25Std = bandMean(
      freqsKhz,
      binStdDb,
      25.0,
      Math.min(34.0, effectiveNyquistKhz - 0.5),
    );

    if (pre21 > -75 && above25 < -80 && pre21 - above25 > 22 && above25Std < 7.5) {
      if (band22to238 < -80 && pre21 - band22to238 > 20) {
        upsampledMasterRate = 44100;
      } else if (band22to238 > -76 && band22to238 - above25 > 18) {
        upsampledMasterRate = 48000;
      }
    }
  }

  // =========================================================================
  // SIGNAL 1: Track-Self-Calibrated Spectral Residual & Downward Terminal Cutoff
  // =========================================================================
  const naturalFit = fitLinearSlope(freqsKhz, smoothedP95, 4.0, 13.0, true);
  const naturalSlopeDbPerKhz = clamp(naturalFit.slope, -10.0, 1.5);
  const expectedDb = new Float32Array(activeBins);
  for (let i = 0; i < activeBins; i++) {
    expectedDb[i] = clamp(
      naturalFit.intercept + naturalSlopeDbPerKhz * freqsKhz[i],
      FLOOR_DB,
      0,
    );
  }

  // Reference deep stopband near Nyquist so downward scan finds the TERMINAL cutoff
  // (never hijacked by a 16 kHz sfb21 shelf when energy still extends to 20.2 kHz)
  const nyqStopStart = Math.max(14.5, effectiveNyquistKhz - 1.2);
  const nyqStopEnd = effectiveNyquistKhz - 0.15;
  const nyqStopFloorDb =
    nyqStopEnd > nyqStopStart
      ? bandPercentile(freqsKhz, smoothedP95, nyqStopStart, nyqStopEnd, 0.25)
      : FLOOR_DB;

  const scanMaxKhz = Math.min(
    effectiveNyquistKhz - 0.35,
    effectiveSampleRate >= 88_200 ? 25.0 : effectiveNyquistKhz - 0.35,
  );

  let terminalCutoffKhz: number | null = null;
  let terminalCliffSlopeDbPerKhz = 0;
  let terminalExcessStepDropDb = 0;

  if (scanMaxKhz > 13.8) {
    // Scan DOWNWARD from effectiveNyquist - 0.35 kHz to 13.5 kHz
    const sustainedSignalFloor = Math.max(-96, nyqStopFloorDb + 15.0);
    for (let f = scanMaxKhz; f >= 13.5; f -= 0.1) {
      const preLevel = bandPercentile(freqsKhz, smoothedP95, f - 0.75, f - 0.1, 0.5);
      const postLevel = bandPercentile(
        freqsKhz,
        smoothedP95,
        f + 0.1,
        Math.min(f + 0.75, effectiveNyquistKhz - 0.1),
        0.5,
      );
      const rawDrop = preLevel - postLevel;
      const expectedStepDrop = Math.max(0, -naturalSlopeDbPerKhz * 0.65);
      const excessStepDrop = rawDrop - expectedStepDrop;
      const rawSlope = rawDrop / 0.65;

      // Verify energy does NOT rebound strongly above this point (confirms terminal boundary, not a mid-band shelf)
      const aboveStart = Math.min(effectiveNyquistKhz - 0.35, f + 0.55);
      const aboveEnd = effectiveNyquistKhz - 0.15;
      const aboveBandP75 =
        aboveEnd > aboveStart
          ? bandPercentile(freqsKhz, smoothedP95, aboveStart, aboveEnd, 0.75)
          : postLevel;
      const staysDeadAbove = aboveBandP75 <= nyqStopFloorDb + 12.0 || aboveBandP75 <= preLevel - 14.0;

      if (
        preLevel >= sustainedSignalFloor &&
        preLevel > -86 &&
        excessStepDrop >= 9.0 &&
        staysDeadAbove
      ) {
        // Refine peak slope within +/- 0.4 kHz around the first detected terminal edge
        let refinedF = f;
        let refinedSlope = rawSlope;
        let refinedExcess = excessStepDrop;
        for (
          let rf = Math.min(scanMaxKhz, f + 0.35);
          rf >= Math.max(13.5, f - 0.4);
          rf -= 0.05
        ) {
          const rPre = bandPercentile(freqsKhz, smoothedP95, rf - 0.7, rf - 0.1, 0.5);
          const rPost = bandPercentile(
            freqsKhz,
            smoothedP95,
            rf + 0.1,
            Math.min(rf + 0.7, effectiveNyquistKhz - 0.1),
            0.5,
          );
          const rDrop = rPre - rPost;
          const rExcess = rDrop - Math.max(0, -naturalSlopeDbPerKhz * 0.65);
          if (rPre >= sustainedSignalFloor && rExcess > refinedExcess) {
            refinedF = rf;
            refinedSlope = rDrop / 0.65;
            refinedExcess = rExcess;
          }
        }
        terminalCutoffKhz = refinedF;
        terminalCliffSlopeDbPerKhz = refinedSlope;
        terminalExcessStepDropDb = refinedExcess;
        break;
      }
    }
  }

  // Sustained excess residual below the extrapolated 4–13 kHz natural trajectory
  const residualStartKhz =
    terminalCutoffKhz !== null
      ? Math.min(effectiveNyquistKhz - 0.4, terminalCutoffKhz + 0.45)
      : Math.min(effectiveNyquistKhz - 0.5, 16.0);
  const residualEndKhz =
    terminalCutoffKhz !== null
      ? Math.min(effectiveNyquistKhz - 0.15, terminalCutoffKhz + 3.0)
      : effectiveNyquistKhz - 0.2;

  const expectedPostDb =
    residualEndKhz > residualStartKhz
      ? bandPercentile(freqsKhz, expectedDb, residualStartKhz, residualEndKhz, 0.5)
      : FLOOR_DB;
  const actualPostDb =
    residualEndKhz > residualStartKhz
      ? bandPercentile(freqsKhz, smoothedP95, residualStartKhz, residualEndKhz, 0.5)
      : FLOOR_DB;
  const excessResidualDb = Math.max(0, expectedPostDb - actualPostDb);

  // =========================================================================
  // SIGNAL 2: Frame-by-Frame Cutoff Lock Analysis (5-bin smoothed + 5 contiguous bins)
  // =========================================================================
  const bin8kLock = Math.min(activeBins - 1, Math.round(8000 / df));
  const bin14kLock = Math.min(activeBins - 1, Math.round(14000 / df));
  const bin10kLock = Math.min(activeBins - 1, Math.round(10000 / df));
  const binUpperMax = Math.max(
    bin14kLock + 5,
    Math.min(activeBins - 1, Math.round(((effectiveNyquistKhz - 0.12) * 1000) / df)),
  );

  let frameCutoffMedianKhz: number | null = null;
  let cutoffIQRHz: number | null = null;

  if (effectiveNyquistKhz >= 15.0 && binUpperMax > bin14kLock + 6) {
    const scoredFrames: Array<{ frameIdx: number; energy8to14: number }> = [];
    for (let i = 0; i < evalCount; i++) {
      const fIdx = evalFrames[i];
      const col = frameDbCols[fIdx];
      let sumE = 0;
      let cnt = 0;
      for (let b = bin8kLock; b <= bin14kLock; b++) {
        sumE += col[b];
        cnt++;
      }
      scoredFrames.push({
        frameIdx: fIdx,
        energy8to14: cnt > 0 ? sumE / cnt : FLOOR_DB,
      });
    }

    scoredFrames.sort((a, b) => b.energy8to14 - a.energy8to14);
    const topCount = Math.min(
      scoredFrames.length,
      Math.max(6, Math.ceil(scoredFrames.length * 0.3)),
    );

    const frameCutoffsHz: number[] = [];
    const smoothedUpper = new Float32Array(activeBins);
    const upperBuf: number[] = [];

    for (let i = 0; i < topCount; i++) {
      const col = frameDbCols[scoredFrames[i].frameIdx];

      // 5-bin moving average over upper bins to suppress narrowband tonal whine & noise spikes
      for (let b = bin10kLock; b <= binUpperMax; b++) {
        const b0 = Math.max(0, b - 2);
        const b1 = Math.min(activeBins - 1, b + 2);
        let acc = 0;
        for (let k = b0; k <= b1; k++) acc += col[k];
        smoothedUpper[b] = acc / (b1 - b0 + 1);
      }

      upperBuf.length = 0;
      for (let b = bin14kLock; b <= binUpperMax; b++) {
        upperBuf.push(smoothedUpper[b]);
      }
      upperBuf.sort((a, b) => a - b);

      // Anchor local floor inside [-108, -88] dBFS so 16-bit quantization/dither noise
      // (typically -126 to -118 dBFS per bin) cannot masquerade as music signal
      const p25Upper = percentileSorted(upperBuf, 0.25);
      const localFloor = clamp(p25Upper, -108, -88);
      const threshold = localFloor + 12.0; // sits in [-96, -76] dBFS

      // Require 5 contiguous smoothed bins above threshold (immune to CRT/switching whine)
      let cutoffBin = bin10kLock;
      let consecutive = 0;
      for (let b = binUpperMax; b >= bin10kLock; b--) {
        if (smoothedUpper[b] >= threshold) {
          consecutive++;
          if (consecutive >= 5) {
            cutoffBin = b + 4;
            break;
          }
        } else {
          consecutive = 0;
        }
      }
      frameCutoffsHz.push(cutoffBin * df);
    }

    if (frameCutoffsHz.length >= 4) {
      frameCutoffsHz.sort((a, b) => a - b);
      const medHz = percentileSorted(frameCutoffsHz, 0.5);
      const p25Hz = percentileSorted(frameCutoffsHz, 0.25);
      const p75Hz = percentileSorted(frameCutoffsHz, 0.75);
      frameCutoffMedianKhz = medHz / 1000;
      cutoffIQRHz = Math.max(0, p75Hz - p25Hz);
    }
  }

  // Reconcile effective terminal cutoff (if P95 missed a subtle edge that Signal 2 locked cleanly)
  const lockBelowNyquist =
    frameCutoffMedianKhz !== null &&
    frameCutoffMedianKhz <= Math.min(20.75, effectiveNyquistKhz - 1.0);

  const effectiveTerminalCutoffKhz =
    terminalCutoffKhz !== null
      ? terminalCutoffKhz
      : lockBelowNyquist && frameCutoffMedianKhz !== null && cutoffIQRHz !== null && cutoffIQRHz < 400
        ? frameCutoffMedianKhz
        : null;

  // =========================================================================
  // SIGNAL 3: Stopband Floor, Re-Dithered Brickwall & Dither Integrity
  // =========================================================================
  const hasCandidateCutoff =
    effectiveTerminalCutoffKhz !== null &&
    effectiveTerminalCutoffKhz <= effectiveNyquistKhz - 1.0;

  const stopStartKhz =
    hasCandidateCutoff && effectiveTerminalCutoffKhz !== null
      ? Math.min(effectiveNyquistKhz - 0.5, effectiveTerminalCutoffKhz + 0.7)
      : Math.max(14.5, effectiveNyquistKhz - 2.2);
  const stopEndKhz = effectiveNyquistKhz - 0.3;

  const deadZoneFloorDb =
    stopEndKhz > stopStartKhz + 0.15
      ? bandPercentile(freqsKhz, smoothedP95, stopStartKhz, stopEndKhz, 0.5)
      : bandPercentile(
          freqsKhz,
          smoothedP95,
          Math.max(14.0, effectiveNyquistKhz - 1.5),
          effectiveNyquistKhz - 0.15,
          0.5,
        );

  const aboveCutoffStdDb =
    stopEndKhz > stopStartKhz + 0.15
      ? bandMean(freqsKhz, binStdDb, stopStartKhz, stopEndKhz)
      : bandMean(
          freqsKhz,
          binStdDb,
          Math.max(14.0, effectiveNyquistKhz - 1.5),
          effectiveNyquistKhz - 0.15,
        );

  // Broadband-equivalent stopband RMS (maps 16-bit TPDF white dither to ~-96 dBFS)
  let stopLinPowerSum = 0;
  let stopBinCount = 0;
  for (let b = 0; b < activeBins; b++) {
    const f = freqsKhz[b];
    if (f >= stopStartKhz && f <= Math.max(stopStartKhz + 0.2, stopEndKhz)) {
      stopLinPowerSum += meanLinearPower[b];
      stopBinCount++;
    }
  }
  const meanStopBinPower =
    stopBinCount > 0 ? stopLinPowerSum / stopBinCount : MIN_LINEAR_POWER;
  const broadbandStopbandDb =
    10 * Math.log10(Math.max(MIN_LINEAR_POWER, meanStopBinPower * (fftSize / 6)));

  // Fit stopband spectral flatness across the dead zone to detect flat re-dithered 16-bit floors
  const stopbandSlopeFit =
    stopEndKhz > stopStartKhz + 0.4
      ? fitLinearSlope(freqsKhz, smoothedP95, stopStartKhz, stopEndKhz, false)
      : { slope: 0, intercept: deadZoneFloorDb, validCount: 0 };
  const isFlatStopband =
    stopbandSlopeFit.validCount >= 6 && Math.abs(stopbandSlopeFit.slope) < 1.5;

  const nearNyquistStart =
    effectiveSampleRate >= 47_500 ? 21.2 : Math.min(20.6, effectiveNyquistKhz - 1.2);
  const nearNyquistEnd = effectiveNyquistKhz - 0.25;
  const nearNyquistP95Db =
    nearNyquistEnd > nearNyquistStart
      ? bandPercentile(freqsKhz, smoothedP95, nearNyquistStart, nearNyquistEnd, 0.75)
      : FLOOR_DB;

  const band17to18_5Med = bandPercentile(freqsKhz, medianDb, 17.0, 18.5, 0.5);
  const band19_5toNyqMed =
    effectiveNyquistKhz > 20.2
      ? bandPercentile(freqsKhz, medianDb, 19.5, effectiveNyquistKhz - 0.25, 0.5)
      : FLOOR_DB;
  const hasNoiseShapedRise =
    effectiveNyquistKhz > 20.5 &&
    band19_5toNyqMed > -112 &&
    band19_5toNyqMed - band17to18_5Med >= 3.0 &&
    aboveCutoffStdDb >= 2.2;

  const hasLiveTpdfDither =
    aboveCutoffStdDb >= 2.2 &&
    ((broadbandStopbandDb >= -100 && broadbandStopbandDb <= -72) ||
      (deadZoneFloorDb >= -100 && deadZoneFloorDb <= -76));

  const isDeadEncoderSilence =
    deadZoneFloorDb < -108 &&
    broadbandStopbandDb < -108 &&
    aboveCutoffStdDb < 2.4;

  const isExcessBrickwall =
    terminalCutoffKhz !== null &&
    terminalCutoffKhz <= 20.75 &&
    excessResidualDb >= 18.0 &&
    terminalExcessStepDropDb >= 9.0 &&
    terminalCliffSlopeDbPerKhz >= 14.0;

  // A tight frame-cutoff IQR only indicates a brickwall when accompanied by an actual
  // spectral cliff / excess residual above the track's own natural 4-13 kHz roll-off
  const hasSpectralCliffCorroboration =
    isExcessBrickwall ||
    excessResidualDb >= 10.0 ||
    terminalCliffSlopeDbPerKhz >= 12.0;

  const isRigidSubNyquistLock =
    lockBelowNyquist &&
    cutoffIQRHz !== null &&
    cutoffIQRHz < 350 &&
    hasSpectralCliffCorroboration;

  const hasAnyHardBrickwall = isExcessBrickwall || isRigidSubNyquistLock;

  const hasHardSub19_5Brickwall =
    (isExcessBrickwall && terminalCutoffKhz !== null && terminalCutoffKhz <= 19.5) ||
    (isRigidSubNyquistLock &&
      frameCutoffMedianKhz !== null &&
      frameCutoffMedianKhz <= 19.5);

  const isReDitheredBrickwallFloor =
    hasAnyHardBrickwall &&
    hasCandidateCutoff &&
    broadbandStopbandDb >= -101 &&
    broadbandStopbandDb <= -86 &&
    isFlatStopband &&
    aboveCutoffStdDb >= 2.2;

  const ditherDetected =
    !hasAnyHardBrickwall && (hasNoiseShapedRise || hasLiveTpdfDither) && !isDeadEncoderSilence;

  const ditherNote = isDeadEncoderSilence
    ? `Mathematically dead stopband (${deadZoneFloorDb.toFixed(0)} dBFS, σ=${aboveCutoffStdDb.toFixed(1)} dB)`
    : isReDitheredBrickwallFloor
      ? `Hard brickwall onto re-dithered 16-bit floor (${broadbandStopbandDb.toFixed(0)} dBFS eq, flat ${stopbandSlopeFit.slope.toFixed(1)} dB/kHz)`
      : hasNoiseShapedRise && !hasAnyHardBrickwall
        ? `Noise-shaped HF dither floor detected (>19.5 kHz, σ=${aboveCutoffStdDb.toFixed(1)} dB)`
        : ditherDetected
          ? `Live TPDF / analog noise floor (${broadbandStopbandDb.toFixed(0)} dBFS eq, σ=${aboveCutoffStdDb.toFixed(1)} dB)`
          : `Upper-band floor ${deadZoneFloorDb.toFixed(0)} dBFS (σ=${aboveCutoffStdDb.toFixed(1)} dB)`;

  // =========================================================================
  // SIGNAL 4: Sub-Band Scalefactor Dropout Detection (~350 Hz MDCT sub-bands)
  // =========================================================================
  // Use 50%-overlapping 350 Hz windows (175 Hz stride) with 2-bin edge guard trim so
  // arbitrary codec scalefactor band offsets never leak active neighbor edges into a hole.
  const mdctBandWidthKhz = 0.35;
  const mdctStrideKhz = 0.175;
  const mdctStartKhz = 10.0;
  const mdctUpperKhz = Math.min(
    effectiveTerminalCutoffKhz !== null
      ? effectiveTerminalCutoffKhz - 0.5
      : effectiveNyquistKhz - 0.5,
    effectiveNyquistKhz - 0.5,
  );

  let spectralHolePercent = 0; // 350 Hz MDCT sub-band dropout %
  let broadBandZeroingPercent = 0; // Time-frequency checkerboard gating %

  if (mdctUpperKhz >= 14.4) {
    const nSubBands = Math.floor(
      (mdctUpperKhz - mdctStartKhz - mdctBandWidthKhz) / mdctStrideKhz,
    ) + 1;
    if (nSubBands >= 16) {
      const sbStartBin = new Int32Array(nSubBands);
      const sbEndBin = new Int32Array(nSubBands);
      const sbCenterKhz = new Float32Array(nSubBands);
      for (let sb = 0; sb < nSubBands; sb++) {
        const f0 = mdctStartKhz + sb * mdctStrideKhz;
        const f1 = f0 + mdctBandWidthKhz;
        sbCenterKhz[sb] = f0 + mdctBandWidthKhz * 0.5;
        const rawB0 = clamp(Math.floor((f0 * 1000) / df), 1, activeBins - 1);
        const rawB1 = clamp(Math.ceil((f1 * 1000) / df), rawB0 + 1, activeBins);
        // Trim 2 guard bins from each edge when band has >= 10 bins (suppresses Hann skirt leakage)
        const trim = rawB1 - rawB0 >= 10 ? 2 : 0;
        sbStartBin[sb] = rawB0 + trim;
        sbEndBin[sb] = Math.max(sbStartBin[sb] + 1, rawB1 - trim);
      }

      const frameSubDb: Float32Array[] = new Array(evalCount);
      for (let i = 0; i < evalCount; i++) {
        const col = frameDbCols[evalFrames[i]];
        const row = new Float32Array(nSubBands);
        for (let sb = 0; sb < nSubBands; sb++) {
          let linSum = 0;
          const b0 = sbStartBin[sb];
          const b1 = sbEndBin[sb];
          for (let b = b0; b < b1; b++) {
            linSum += Math.pow(10, col[b] / 10);
          }
          const avgPow = linSum / Math.max(1, b1 - b0);
          row[sb] =
            avgPow > MIN_LINEAR_POWER
              ? Math.max(FLOOR_DB, 10 * Math.log10(avgPow))
              : FLOOR_DB;
        }
        frameSubDb[i] = row;
      }

      const subBandP95 = new Float32Array(nSubBands);
      const sbScratch = new Float32Array(evalCount);
      for (let sb = 0; sb < nSubBands; sb++) {
        for (let i = 0; i < evalCount; i++) {
          sbScratch[i] = frameSubDb[i][sb];
        }
        sbScratch.sort();
        subBandP95[sb] = percentileSorted(sbScratch, 0.95);
      }

      // Active HF frames: >= 3 non-overlapping 350 Hz bands in 10-14 kHz exceeding -65 dBFS
      const activeHfFrameFlags = new Uint8Array(evalCount);
      for (let i = 0; i < evalCount; i++) {
        const row = frameSubDb[i];
        let activeRefBands = 0;
        for (let sb = 0; sb < nSubBands; sb += 2) {
          if (sbCenterKhz[sb] >= 10.0 && sbCenterKhz[sb] <= 14.0 && row[sb] > -65) {
            activeRefBands++;
          }
        }
        if (activeRefBands >= 3) {
          activeHfFrameFlags[i] = 1;
        }
      }

      let dropoutCandidates = 0;
      let dropoutHits = 0;
      let checkerCandidates = 0;
      let checkerHits = 0;

      for (let i = 0; i < evalCount; i++) {
        if (!activeHfFrameFlags[i]) continue;
        const row = frameSubDb[i];

        // Compare each 350 Hz sub-band against its immediate non-overlapping +/-350 Hz neighbors (sb-2, sb+2)
        for (let sb = 2; sb < nSubBands - 2; sb++) {
          const fc = sbCenterKhz[sb];
          if (fc < 13.0) continue;

          const leftDb = row[sb - 2];
          const rightDb = row[sb + 2];
          const valDb = row[sb];
          const neighborInterp = 0.5 * (leftDb + rightDb);

          if (neighborInterp > -72 && Math.min(leftDb, rightDb) > -82) {
            dropoutCandidates++;
            const dropVsNeighbors = neighborInterp - valDb;
            const dropVsOwnP95 = subBandP95[sb] - valDb;
            if (dropVsNeighbors >= 26.0 && (dropVsOwnP95 >= 22.0 || valDb < -98.0)) {
              dropoutHits++;
            }
          }

          // Time-frequency checkerboard variance (> 14 kHz frame-to-frame on/off gating)
          if (fc >= 14.0 && i > 0 && activeHfFrameFlags[i - 1]) {
            const prevDb = frameSubDb[i - 1][sb];
            const highSide = Math.max(valDb, prevDb);
            const lowSide = Math.min(valDb, prevDb);
            if (highSide > -72) {
              checkerCandidates++;
              if (highSide - lowSide >= 22.0 && lowSide < -88.0) {
                checkerHits++;
              }
            }
          }
        }
      }

      spectralHolePercent =
        dropoutCandidates >= 15 ? (dropoutHits / dropoutCandidates) * 100 : 0;
      broadBandZeroingPercent =
        checkerCandidates >= 15 ? (checkerHits / checkerCandidates) * 100 : 0;
    }
  }

  const hasMdctDropouts =
    spectralHolePercent >= 2.0 ||
    broadBandZeroingPercent >= 3.5 ||
    (spectralHolePercent >= 1.2 && broadBandZeroingPercent >= 2.0);

  // =========================================================================
  // SIGNAL 5: Independent LAME sfb21 16 kHz Shelf Detector (15.3–16.7 kHz)
  // =========================================================================
  const shelfPreDb = bandPercentile(freqsKhz, smoothedP95, 14.2, 15.3, 0.5);
  const shelfPostDb = bandPercentile(freqsKhz, smoothedP95, 16.7, 18.0, 0.5);
  const rawShelfDropDb =
    effectiveNyquistKhz > 18.8 && shelfPreDb > -76
      ? Math.max(0, shelfPreDb - shelfPostDb)
      : 0;
  const expectedShelfDropDb = Math.max(0, -naturalSlopeDbPerKhz * 2.4);
  const excessShelfDropDb = Math.max(0, rawShelfDropDb - expectedShelfDropDb);
  const shelf16KhzDropDb = rawShelfDropDb;

  // True sfb21 shelf: step drop across 15.3-16.7 kHz where signal CONTINUES above 16.7 kHz (not already dead stopband)
  const isTerminalAt16k =
    effectiveTerminalCutoffKhz !== null &&
    effectiveTerminalCutoffKhz >= 15.0 &&
    effectiveTerminalCutoffKhz <= 16.8;
  const has16KhzShelf =
    !isTerminalAt16k &&
    shelf16KhzDropDb > 8.0 &&
    excessShelfDropDb > 5.5 &&
    shelfPostDb > -102;

  const hasSecondaryBrickwall19to20_7 =
    effectiveTerminalCutoffKhz !== null &&
    effectiveTerminalCutoffKhz >= 19.2 &&
    effectiveTerminalCutoffKhz <= 20.75;

  // =========================================================================
  // SIGNAL 6: HF Stereo Side-Channel Collapse (Strictly Inside Active Passband)
  // =========================================================================
  let hfStereoCollapseDb: number | null = null;
  let hfStereoBandLabel = '15.0–19.0 kHz';

  if (hasStereo && stereoSubBinCounts && frameMidSubPow.length === numFrames) {
    const passbandCeilingKhz =
      effectiveTerminalCutoffKhz !== null &&
      effectiveTerminalCutoffKhz < effectiveNyquistKhz - 0.8
        ? effectiveTerminalCutoffKhz
        : effectiveNyquistKhz;

    const hfHiKhz = Math.min(19.0, passbandCeilingKhz - 0.6);
    const hfLoKhz = Math.max(11.5, Math.min(15.0, passbandCeilingKhz - 2.5));
    hfStereoBandLabel = `${hfLoKhz.toFixed(1)}–${hfHiKhz.toFixed(1)} kHz`;

    if (hfHiKhz > hfLoKhz + 0.5) {
      const midBandStartSb = Math.floor(2.0 / stereoSubWidthKhz);
      const midBandEndSb = Math.min(stereoSubCount - 1, Math.floor(8.0 / stereoSubWidthKhz));
      const hfStartSb = Math.floor(hfLoKhz / stereoSubWidthKhz);
      const hfEndSb = Math.min(stereoSubCount - 1, Math.floor(hfHiKhz / stereoSubWidthKhz));

      let midBandBinTotal = 0;
      for (let sb = midBandStartSb; sb <= midBandEndSb; sb++) {
        midBandBinTotal += stereoSubBinCounts[sb];
      }
      let hfBandBinTotal = 0;
      for (let sb = hfStartSb; sb <= hfEndSb; sb++) {
        hfBandBinTotal += stereoSubBinCounts[sb];
      }

      let midEnergyMidBand = 0;
      let sideEnergyMidBand = 0;
      let midEnergyHfBand = 0;
      let sideEnergyHfBand = 0;
      let qualifyingHfFrames = 0;

      for (let i = 0; i < evalCount; i++) {
        const fIdx = evalFrames[i];
        const mSub = frameMidSubPow[fIdx];
        const sSub = frameSideSubPow[fIdx];

        let fMid2to8 = 0;
        let fSide2to8 = 0;
        for (let sb = midBandStartSb; sb <= midBandEndSb; sb++) {
          fMid2to8 += mSub[sb];
          fSide2to8 += sSub[sb];
        }
        midEnergyMidBand += fMid2to8;
        sideEnergyMidBand += fSide2to8;

        let fMidHf = 0;
        let fSideHf = 0;
        for (let sb = hfStartSb; sb <= hfEndSb; sb++) {
          fMidHf += mSub[sb];
          fSideHf += sSub[sb];
        }

        // Only evaluate HF stereo ratio on frames where Mid energy is clearly above noise floor (> -75 dBFS)
        const meanMidHfPerBin = fMidHf / Math.max(1, hfBandBinTotal);
        const meanMidHfDb =
          meanMidHfPerBin > MIN_LINEAR_POWER
            ? 10 * Math.log10(meanMidHfPerBin)
            : FLOOR_DB;

        if (meanMidHfDb > -75.0) {
          midEnergyHfBand += fMidHf;
          sideEnergyHfBand += fSideHf;
          qualifyingHfFrames++;
        }
      }

      if (
        qualifyingHfFrames >= 4 &&
        midBandBinTotal > 0 &&
        midEnergyMidBand > 1e-10 &&
        midEnergyHfBand > 1e-11
      ) {
        const midBandRatioDb =
          10 * Math.log10(Math.max(sideEnergyMidBand, 1e-14) / midEnergyMidBand);
        const hfBandRatioDb =
          10 * Math.log10(Math.max(sideEnergyHfBand, 1e-14) / midEnergyHfBand);
        if (midBandRatioDb > -24) {
          hfStereoCollapseDb = Math.max(0, midBandRatioDb - hfBandRatioDb);
        }
      }
    }
  }

  // =========================================================================
  // CALIBRATED EVIDENCE LOG & WEIGHTED CLASSIFIER
  // =========================================================================
  const evidenceFactors: ForensicFactor[] = [];

  // Factor 1: Track-Self-Calibrated Spectral Residual
  if (isExcessBrickwall && terminalCutoffKhz !== null) {
    const severe = excessResidualDb >= 28.0 && terminalCliffSlopeDbPerKhz >= 22.0;
    evidenceFactors.push({
      id: 'spectral-residual',
      signal: 'Spectral Residual',
      measuredValue: `-${excessResidualDb.toFixed(1)} dB (${terminalCliffSlopeDbPerKhz.toFixed(0)} dB/kHz)`,
      detail: `Terminal drop below ${naturalSlopeDbPerKhz.toFixed(1)} dB/kHz natural 4–13 kHz model near ${terminalCutoffKhz.toFixed(1)} kHz`,
      impact: 'negative',
      weight: severe ? -34 : -26,
    });
  } else if (
    terminalCutoffKhz !== null &&
    terminalCutoffKhz <= 20.75 &&
    excessResidualDb >= 11.0
  ) {
    evidenceFactors.push({
      id: 'spectral-residual',
      signal: 'Spectral Residual',
      measuredValue: `-${excessResidualDb.toFixed(1)} dB (${terminalCliffSlopeDbPerKhz.toFixed(0)} dB/kHz)`,
      detail: `Moderate attenuation below ${naturalSlopeDbPerKhz.toFixed(1)} dB/kHz trajectory near ${terminalCutoffKhz.toFixed(1)} kHz`,
      impact: 'negative',
      weight: -14,
    });
  } else if (excessResidualDb <= 8.0 && nearNyquistP95Db > -86) {
    evidenceFactors.push({
      id: 'spectral-residual',
      signal: 'Spectral Residual',
      measuredValue: `${excessResidualDb.toFixed(1)} dB · ${naturalSlopeDbPerKhz.toFixed(1)} dB/kHz`,
      detail: 'Upper spectrum tracks natural 4–13 kHz roll-off trajectory without excess cliff',
      impact: 'positive',
      weight: nearNyquistP95Db > -74 ? 22 : 14,
    });
  } else if (excessResidualDb <= 8.5) {
    evidenceFactors.push({
      id: 'spectral-residual',
      signal: 'Spectral Residual',
      measuredValue: `${excessResidualDb.toFixed(1)} dB · ${naturalSlopeDbPerKhz.toFixed(1)} dB/kHz`,
      detail: 'Smooth natural roll-off consistent with extrapolated 4–13 kHz envelope',
      impact: 'positive',
      weight: 12,
    });
  } else {
    evidenceFactors.push({
      id: 'spectral-residual',
      signal: 'Spectral Residual',
      measuredValue: `-${excessResidualDb.toFixed(1)} dB`,
      detail: `Mild upper-band attenuation relative to ${naturalSlopeDbPerKhz.toFixed(1)} dB/kHz slope`,
      impact: 'neutral',
      weight: 0,
    });
  }

  // Factor 2: Frame-by-Frame Cutoff Lock Analysis
  if (isRigidSubNyquistLock && frameCutoffMedianKhz !== null && cutoffIQRHz !== null) {
    evidenceFactors.push({
      id: 'cutoff-lock',
      signal: 'Frame Cutoff Lock',
      measuredValue: `${frameCutoffMedianKhz.toFixed(2)} kHz · IQR ${Math.round(cutoffIQRHz)} Hz`,
      detail: 'Rigid frame-to-frame brickwall lock (<350 Hz IQR) across 5-bin smoothed HF frames',
      impact: 'negative',
      weight: -28,
    });
  } else if (
    lockBelowNyquist &&
    hasSpectralCliffCorroboration &&
    cutoffIQRHz !== null &&
    cutoffIQRHz < 650
  ) {
    evidenceFactors.push({
      id: 'cutoff-lock',
      signal: 'Frame Cutoff Lock',
      measuredValue: `${frameCutoffMedianKhz!.toFixed(2)} kHz · IQR ${Math.round(cutoffIQRHz)} Hz`,
      detail: 'Moderately constrained upper cutoff boundary across peak HF frames',
      impact: 'negative',
      weight: -10,
    });
  } else if (
    lockBelowNyquist &&
    !hasSpectralCliffCorroboration &&
    frameCutoffMedianKhz !== null &&
    cutoffIQRHz !== null
  ) {
    evidenceFactors.push({
      id: 'cutoff-lock',
      signal: 'Frame Cutoff Lock',
      measuredValue: `${frameCutoffMedianKhz.toFixed(2)} kHz · IQR ${Math.round(cutoffIQRHz)} Hz`,
      detail: 'Smooth natural roll-off meeting noise floor without a brickwall discontinuity',
      impact: 'positive',
      weight: 10,
    });
  } else if (lockBelowNyquist && cutoffIQRHz !== null && cutoffIQRHz >= 800) {
    evidenceFactors.push({
      id: 'cutoff-lock',
      signal: 'Frame Cutoff Lock',
      measuredValue: `${frameCutoffMedianKhz!.toFixed(2)} kHz · IQR ${Math.round(cutoffIQRHz)} Hz`,
      detail: 'Organic frame-to-frame fluctuation (>800 Hz IQR) consistent with natural acoustic roll-off',
      impact: 'positive',
      weight: 18,
    });
  } else if (
    frameCutoffMedianKhz !== null &&
    frameCutoffMedianKhz >= effectiveNyquistKhz - 1.0
  ) {
    evidenceFactors.push({
      id: 'cutoff-lock',
      signal: 'Frame Cutoff Lock',
      measuredValue: `${frameCutoffMedianKhz.toFixed(2)} kHz (Nyquist)`,
      detail: 'Peak HF frames extend directly to container Nyquist ceiling',
      impact: 'positive',
      weight: 22,
    });
  } else {
    evidenceFactors.push({
      id: 'cutoff-lock',
      signal: 'Frame Cutoff Lock',
      measuredValue:
        frameCutoffMedianKhz !== null && cutoffIQRHz !== null
          ? `${frameCutoffMedianKhz.toFixed(2)} kHz · IQR ${Math.round(cutoffIQRHz)} Hz`
          : 'N/A',
      detail: 'No rigid sub-Nyquist frame lock observed',
      impact: 'neutral',
      weight: 0,
    });
  }

  // Factor 3: Stopband Floor & Dither Integrity (with Re-Dithered Brickwall Trap Fixed)
  if (isDeadEncoderSilence && (hasCandidateCutoff || lockBelowNyquist)) {
    evidenceFactors.push({
      id: 'dead-zone-dither',
      signal: 'Stopband & Dither',
      measuredValue: `${deadZoneFloorDb.toFixed(0)} dBFS · σ ${aboveCutoffStdDb.toFixed(1)} dB`,
      detail: 'Mathematically dead stopband (<-108 dBFS, near-zero variance) with no CD dither',
      impact: 'negative',
      weight: -24,
    });
  } else if (isReDitheredBrickwallFloor) {
    evidenceFactors.push({
      id: 'dead-zone-dither',
      signal: 'Stopband & Dither',
      measuredValue: `${broadbandStopbandDb.toFixed(0)} dBFS eq · flat`,
      detail: 'Hard brickwall onto re-dithered 16-bit floor',
      impact: 'negative',
      weight: -18,
    });
  } else if (hasHardSub19_5Brickwall) {
    // NEVER award positive lossless points for dither when a rigid sub-19.5 kHz brickwall exists
    const depressed = deadZoneFloorDb < -104;
    evidenceFactors.push({
      id: 'dead-zone-dither',
      signal: 'Stopband & Dither',
      measuredValue: `${deadZoneFloorDb.toFixed(0)} dBFS · σ ${aboveCutoffStdDb.toFixed(1)} dB`,
      detail: depressed
        ? 'Severely depressed stopband above rigid brickwall cutoff'
        : 'Stationary floor above rigid brickwall (not counted as lossless dither)',
      impact: depressed ? 'negative' : 'neutral',
      weight: depressed ? -14 : 0,
    });
  } else if (
    !hasAnyHardBrickwall &&
    (ditherDetected || (nearNyquistP95Db > -78 && aboveCutoffStdDb >= 2.2))
  ) {
    evidenceFactors.push({
      id: 'dead-zone-dither',
      signal: 'Stopband & Dither',
      measuredValue: hasNoiseShapedRise
        ? `Noise-shaped · σ ${aboveCutoffStdDb.toFixed(1)} dB`
        : `${broadbandStopbandDb.toFixed(0)} dBFS eq · σ ${aboveCutoffStdDb.toFixed(1)} dB`,
      detail: ditherNote,
      impact: 'positive',
      weight: 18,
    });
  } else {
    evidenceFactors.push({
      id: 'dead-zone-dither',
      signal: 'Stopband & Dither',
      measuredValue: `${deadZoneFloorDb.toFixed(0)} dBFS · σ ${aboveCutoffStdDb.toFixed(1)} dB`,
      detail: ditherNote,
      impact: 'neutral',
      weight: 0,
    });
  }

  // Factor 4: Sub-Band Scalefactor Dropout Detection (~350 Hz MDCT sub-bands)
  if (hasMdctDropouts) {
    const severeMdct = spectralHolePercent >= 5.0 || broadBandZeroingPercent >= 8.0;
    evidenceFactors.push({
      id: 'mdct-holes',
      signal: 'MDCT Sub-Band Dropouts',
      measuredValue: `${spectralHolePercent.toFixed(1)}% bands · ${broadBandZeroingPercent.toFixed(1)}% gate`,
      detail: '350 Hz scalefactor band zeroing & checkerboard gating above 13 kHz (AAC / Opus / VBR MP3)',
      impact: 'negative',
      weight: severeMdct ? -34 : -24,
    });
  } else if (spectralHolePercent >= 0.8 || broadBandZeroingPercent >= 1.8) {
    evidenceFactors.push({
      id: 'mdct-holes',
      signal: 'MDCT Sub-Band Dropouts',
      measuredValue: `${spectralHolePercent.toFixed(1)}% bands · ${broadBandZeroingPercent.toFixed(1)}% gate`,
      detail: 'Moderate 350 Hz sub-band notching above 13 kHz',
      impact: 'negative',
      weight: -10,
    });
  } else if (!hasAnyHardBrickwall && spectralHolePercent < 0.8 && broadBandZeroingPercent < 1.5) {
    evidenceFactors.push({
      id: 'mdct-holes',
      signal: 'MDCT Sub-Band Dropouts',
      measuredValue: `${spectralHolePercent.toFixed(1)}% bands · ${broadBandZeroingPercent.toFixed(1)}% gate`,
      detail: 'Continuous 350 Hz upper sub-bands with zero MDCT scalefactor dropouts',
      impact: 'positive',
      weight: 8,
    });
  } else {
    evidenceFactors.push({
      id: 'mdct-holes',
      signal: 'MDCT Sub-Band Dropouts',
      measuredValue: `${spectralHolePercent.toFixed(1)}% bands · ${broadBandZeroingPercent.toFixed(1)}% gate`,
      detail: 'No 350 Hz MDCT scalefactor dropouts detected inside passband',
      impact: 'neutral',
      weight: 0,
    });
  }

  // Factor 5: Independent LAME sfb21 16 kHz Shelf Detector
  if (has16KhzShelf && hasSecondaryBrickwall19to20_7) {
    evidenceFactors.push({
      id: 'lame-sfb21',
      signal: 'LAME sfb21 Shelf',
      measuredValue: `-${shelf16KhzDropDb.toFixed(1)} dB @ 16 kHz + wall`,
      detail: '15.3–16.7 kHz sfb21 shelf paired with terminal 19.2–20.7 kHz brickwall (MP3 320 / V0)',
      impact: 'negative',
      weight: -24,
    });
  } else if (has16KhzShelf) {
    evidenceFactors.push({
      id: 'lame-sfb21',
      signal: 'LAME sfb21 Shelf',
      measuredValue: `-${shelf16KhzDropDb.toFixed(1)} dB @ 16 kHz`,
      detail: 'Step drop across 15.3–16.7 kHz exceeding natural slope',
      impact: 'negative',
      weight: -12,
    });
  } else {
    evidenceFactors.push({
      id: 'lame-sfb21',
      signal: 'LAME sfb21 Shelf',
      measuredValue: isTerminalAt16k
        ? 'Terminal wall @ 16 kHz'
        : shelf16KhzDropDb > 0.1
          ? `-${shelf16KhzDropDb.toFixed(1)} dB (natural)`
          : 'None',
      detail: isTerminalAt16k
        ? '16 kHz is the terminal cutoff boundary (evaluated under Spectral Residual)'
        : 'No abrupt 15.3–16.7 kHz LAME sfb21 step discontinuity detected',
      impact: 'neutral',
      weight: 0,
    });
  }

  // Factor 6: High-Frequency Stereo Side-Channel Collapse (Strictly Inside Active Passband)
  if (hfStereoCollapseDb !== null && hfStereoCollapseDb > 14.0) {
    evidenceFactors.push({
      id: 'stereo-hf-collapse',
      signal: 'HF Stereo Side Collapse',
      measuredValue: `-${hfStereoCollapseDb.toFixed(1)} dB (${hfStereoBandLabel})`,
      detail: 'Abrupt passband side-channel collapse corroborating Joint / Parametric Stereo',
      impact: 'negative',
      weight: -18,
    });
  } else if (hfStereoCollapseDb !== null && hfStereoCollapseDb > 10.0) {
    evidenceFactors.push({
      id: 'stereo-hf-collapse',
      signal: 'HF Stereo Side Collapse',
      measuredValue: `-${hfStereoCollapseDb.toFixed(1)} dB (${hfStereoBandLabel})`,
      detail: 'Moderate narrowing of stereo side channel in upper passband',
      impact: 'negative',
      weight: -8,
    });
  } else if (hfStereoCollapseDb !== null) {
    evidenceFactors.push({
      id: 'stereo-hf-collapse',
      signal: 'HF Stereo Side Collapse',
      measuredValue: `-${hfStereoCollapseDb.toFixed(1)} dB (${hfStereoBandLabel})`,
      detail: 'Active passband stereo side-channel width remains intact',
      impact: hfStereoCollapseDb <= 6.0 && !hasAnyHardBrickwall ? 'positive' : 'neutral',
      weight: hfStereoCollapseDb <= 6.0 && !hasAnyHardBrickwall ? 6 : 0,
    });
  } else {
    evidenceFactors.push({
      id: 'stereo-hf-collapse',
      signal: 'HF Stereo Side Collapse',
      measuredValue: !hasStereo ? 'Mono track' : 'Insufficient HF Mid',
      detail: !hasStereo
        ? 'Stereo Mid/Side collapse comparison applies to 2-channel stereo tracks'
        : 'Passband Mid energy below -75 dBFS or narrow 2–8 kHz stereo width',
      impact: 'neutral',
      weight: 0,
    });
  }

  const evidenceScore = evidenceFactors.reduce((acc, f) => acc + f.weight, 0);
  const negativeFactorCount = evidenceFactors.filter((f) => f.impact === 'negative').length;
  const strongNegativeCount = evidenceFactors.filter((f) => f.weight <= -18).length;

  let verdict: Verdict;
  let subLabel: string | null = null;
  let confidence: number;
  let cutoffKhz: number | null = null;
  let estimatedSource: string;
  let reasoning: string;

  const detectedBoundaryKhz =
    effectiveTerminalCutoffKhz !== null && effectiveTerminalCutoffKhz <= 20.75
      ? Number(effectiveTerminalCutoffKhz.toFixed(2))
      : null;

  // 20 kHz Mastering-LPF protection:
  // Clean brickwall in 19.3-20.7 kHz with ZERO corroborating lossy artifacts -> INCONCLUSIVE
  const isAmbiguous20kCleanLpf =
    detectedBoundaryKhz !== null &&
    detectedBoundaryKhz >= 19.3 &&
    detectedBoundaryKhz <= 20.7 &&
    !has16KhzShelf &&
    !hasMdctDropouts &&
    !(hfStereoCollapseDb !== null && hfStereoCollapseDb > 12.0);

  // Strong standalone MDCT dropout transcode (e.g. AAC/Opus full-ish bandwidth with heavy 350 Hz zeroing)
  const isSevereMdctTranscode =
    (spectralHolePercent >= 6.0 && broadBandZeroingPercent >= 4.0) ||
    spectralHolePercent >= 10.0;

  if (metadata.isLossyContainer) {
    verdict = 'LOSSY_FORMAT';
    cutoffKhz = detectedBoundaryKhz;
    confidence = 99;
    estimatedSource = `${metadata.codecHint}${metadata.bitrate > 0 ? ` · ~${Math.round(metadata.bitrate / 1000)} kbps` : ''}`;
    reasoning =
      cutoffKhz !== null
        ? `Inherently lossy ${metadata.container} container (${metadata.codecHint}) with an encoder low-pass ceiling near ${cutoffKhz.toFixed(1)} kHz.`
        : `Inherently lossy ${metadata.container} container (${metadata.codecHint}); full P95 spectral envelope and spectrogram computed for inspection.`;
  } else if (upsampledMasterRate !== null) {
    verdict = 'UPSAMPLED_LOSSLESS';
    subLabel =
      upsampledMasterRate === 44100
        ? '44.1 kHz CD Master in Hi-Res Container'
        : '48 kHz Master in Hi-Res Container';
    cutoffKhz = upsampledMasterRate === 44100 ? 22.05 : 24.0;
    confidence = 92;
    estimatedSource = `Genuine ${upsampledMasterRate / 1000} kHz Lossless Master (Upsampled)`;
    reasoning =
      `Intact lossless spectrum extends cleanly to the ${upsampledMasterRate / 1000} kHz Nyquist limit (~${cutoffKhz.toFixed(1)} kHz) above a clean anti-aliasing stopband—genuine standard-rate master upsampled to ${(headerSampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz.`;
  } else if (lowHfSourceMaterial) {
    verdict = 'INCONCLUSIVE';
    subLabel = 'Low High-Frequency Source Material';
    cutoffKhz = detectedBoundaryKhz;
    confidence = 40;
    estimatedSource = 'Bandwidth-Limited / Acoustic / Vintage Recording';
    reasoning =
      `Reference 8–13 kHz band is naturally depleted (${refBand8To13KhzDb.toFixed(1)} dBFS, ${hfDeficitDb.toFixed(1)} dB below 1–5 kHz). Insufficient high-frequency energy to classify as a lossy transcode.`;
  } else if (isAmbiguous20kCleanLpf) {
    verdict = 'INCONCLUSIVE';
    subLabel = 'Clean ~20 kHz Low-Pass Filter — Mastering LPF or High-Bitrate Transcode';
    cutoffKhz = detectedBoundaryKhz;
    confidence = 54;
    estimatedSource = 'Mastering 20 kHz LPF or Clean High-Bitrate Lossy';
    reasoning =
      `Detected a clean low-pass cutoff near ${detectedBoundaryKhz!.toFixed(1)} kHz with zero MDCT sub-band dropouts, no 16 kHz sfb21 shelf, and no HF stereo collapse. Cannot safely rule out a mastering low-pass filter—inspect the zoomed 12–24 kHz spectrogram.`;
  } else if (
    (evidenceScore <= -30 && negativeFactorCount >= 2 && strongNegativeCount >= 1) ||
    isSevereMdctTranscode
  ) {
    verdict = 'FAKE_TRANSCODE';
    cutoffKhz =
      detectedBoundaryKhz ??
      (lockBelowNyquist && frameCutoffMedianKhz !== null
        ? Number(frameCutoffMedianKhz.toFixed(2))
        : null);

    if (cutoffKhz !== null && cutoffKhz <= 16.8) {
      estimatedSource = 'MP3 ~128 kbps / Low-Bitrate Lossy';
    } else if (cutoffKhz !== null && cutoffKhz <= 19.1) {
      estimatedSource = 'MP3 192–256 kbps / AAC 128–192 kbps';
    } else if (hasMdctDropouts) {
      estimatedSource = 'AAC 192–256 kbps / Opus / VBR MP3 (MDCT dropouts)';
    } else {
      estimatedSource = has16KhzShelf
        ? 'MP3 320 kbps / LAME V0 (sfb21 shelf)'
        : 'MP3 320 kbps / V0 / AAC 256 / Opus';
    }

    const baseConf = isSevereMdctTranscode ? 78 : 70;
    confidence = Math.round(clamp(baseConf + Math.abs(evidenceScore) * 0.34, 74, 98));
    const negSummary = evidenceFactors
      .filter((f) => f.impact === 'negative')
      .slice(0, 3)
      .map((f) => `${f.signal.toLowerCase()} (${f.measuredValue})`)
      .join(', ');
    reasoning = `Converging transcode evidence across ${negativeFactorCount} independent signal${negativeFactorCount === 1 ? '' : 's'}: ${negSummary}. Likely upconverted from ${estimatedSource}.`;
  } else if (evidenceScore >= 14) {
    verdict = 'GENUINE_LOSSLESS';
    cutoffKhz = null;
    subLabel = metadata.isFake24Bit
      ? 'Zero-Padded 24-bit WAV (16-bit Effective)'
      : naturalSlopeDbPerKhz <= -3.8
        ? 'Warm Natural Roll-Off'
        : null;
    confidence = Math.round(clamp(78 + evidenceScore * 0.28, 80, 98));
    estimatedSource = `Authentic ${(headerSampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz Lossless Master`;
    reasoning =
      naturalSlopeDbPerKhz <= -3.8
        ? `High frequencies follow a smooth natural ${naturalSlopeDbPerKhz.toFixed(1)} dB/kHz roll-off with organic frame variance and no encoder brickwall or MDCT band-zeroing.`
        : `Active upper-spectrum energy extends naturally to ${effectiveNyquistKhz.toFixed(1)} kHz Nyquist with intact noise floor and no brickwall cutoff or MDCT dropouts.`;
  } else {
    verdict = 'INCONCLUSIVE';
    cutoffKhz = detectedBoundaryKhz;
    subLabel = metadata.isFake24Bit
      ? 'Zero-Padded 24-bit WAV'
      : has16KhzShelf
        ? '16 kHz Spectral Shelf Observed'
        : 'Mixed / Borderline Spectral Evidence';
    confidence = Math.round(clamp(55 - Math.abs(evidenceScore) * 0.3, 42, 68));
    estimatedSource =
      cutoffKhz !== null
        ? 'Borderline Mastering Filter or High-Bitrate Lossy'
        : 'Gentle Master Roll-Off / Unconfirmed Bandwidth';
    reasoning =
      cutoffKhz !== null
        ? `Borderline attenuation near ${cutoffKhz.toFixed(1)} kHz without sufficient converging lossy signatures (score ${evidenceScore}). Inspect the zoomed 12–24 kHz spectrogram manually.`
        : `Upper-band evidence is mixed (score ${evidenceScore}) without a definitive brickwall or converging MDCT artifacts. Manual spectrogram inspection recommended.`;
  }

  const metrics: ForensicMetrics = {
    naturalSlopeDbPerKhz: Number(naturalSlopeDbPerKhz.toFixed(2)),
    excessResidualDb: Number(excessResidualDb.toFixed(1)),
    cliffSlopeDbPerKhz: Number(terminalCliffSlopeDbPerKhz.toFixed(1)),
    frameCutoffMedianKhz:
      frameCutoffMedianKhz !== null ? Number(frameCutoffMedianKhz.toFixed(2)) : null,
    cutoffIQRHz: cutoffIQRHz !== null ? Math.round(cutoffIQRHz) : null,
    deadZoneFloorDb: Number(deadZoneFloorDb.toFixed(1)),
    aboveCutoffStdDb: Number(aboveCutoffStdDb.toFixed(2)),
    ditherDetected,
    ditherNote,
    referenceBand8To13KhzDb: Number(refBand8To13KhzDb.toFixed(1)),
    coreBand1To5KhzDb: Number(coreBand1To5KhzDb.toFixed(1)),
    spectralHolePercent: Number(spectralHolePercent.toFixed(2)),
    broadBandZeroingPercent: Number(broadBandZeroingPercent.toFixed(2)),
    shelf16KhzDropDb: Number(shelf16KhzDropDb.toFixed(1)),
    has16KhzShelf,
    hfStereoCollapseDb:
      hfStereoCollapseDb !== null ? Number(hfStereoCollapseDb.toFixed(1)) : null,
    trueBitDepthNote: metadata.trueBitDepthNote ?? null,
    isFake24Bit: Boolean(metadata.isFake24Bit),
    browserResampled,
    decodedSampleRate,
    effectiveSampleRate,
    effectiveNyquist,
    analyzedSegments,
    analyzedDurationSec: Number(analyzedDurationSec.toFixed(2)),
    fftSize,
    evidenceScore,
  };

  const spectrogram = buildDisplaySpectrogram(
    frameDbCols,
    freqsKhz,
    new Float32Array(frameTimes),
  );
  const psdCurve = buildDisplayPsdCurve(
    freqsKhz,
    meanDb,
    medianDb,
    p95Db,
    expectedDb,
  );

  return {
    verdict,
    subLabel,
    confidence,
    cutoffKhz,
    estimatedSource,
    reasoning,
    metadata,
    metrics,
    evidenceFactors,
    securityChecks,
    spectrogram,
    psdCurve,
  };
}
