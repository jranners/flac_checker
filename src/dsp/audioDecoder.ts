import { SECURITY_LIMITS } from '../security/fileValidator';
import type { HeaderMetadata } from './types';

export interface SelectedAudioSegments {
  /** Left channel (stereo) or mono/downmix PCM packed segment-by-segment. */
  leftSamples: Float32Array;
  /** Right channel for stereo tracks (null for mono/multichannel), packed identically. */
  rightSamples: Float32Array | null;
  /** Exact sample length of each individual segment so STFT never crosses a splice boundary. */
  segmentLengthSamples: number;
  analyzedSegments: number;
  analyzedDurationSec: number;
  segmentStartsSec: number[];
}

export interface DecodedTrackPayload extends SelectedAudioSegments {
  decodedSampleRate: number;
  updatedMetadata: HeaderMetadata;
}

/**
 * Adaptive Transient-Guided Frame Extraction (pure, deterministic).
 *
 * - Preserves separate Left and Right channels for stereo tracks so downstream STFT
 *   can use max(power_L, power_R) without wide-stereo phase cancellation and compute
 *   exact Mid/Side ratios.
 * - For tracks <= 35 s: analyzes the entire track as 1 contiguous segment.
 * - For tracks > 35 s: excludes outer 5% fades, divides into 1-second blocks,
 *   filters out silent or severely hard-clipped bursts (|s| >= 0.999, > 25%),
 *   scores blocks by stereo-aware second-order HF transient energy, and selects
 *   up to 8 highest-scoring non-overlapping 4-second windows (32 s).
 */
export function selectAdaptiveTransientSegments(
  left: Float32Array,
  right: Float32Array | null,
  sampleRate: number,
): SelectedAudioSegments {
  const totalSamples = left.length;
  const totalSec = totalSamples / sampleRate;

  if (totalSec <= 35.0) {
    return {
      leftSamples: left,
      rightSamples: right,
      segmentLengthSamples: totalSamples,
      analyzedSegments: 1,
      analyzedDurationSec: totalSec,
      segmentStartsSec: [0],
    };
  }

  const segDurationSec = 4;
  const segSamples = Math.floor(segDurationSec * sampleRate);
  const oneSecSamples = Math.max(256, Math.floor(sampleRate));

  // Exclude outer 5% fades on tracks > 30 s
  const trimStart = Math.floor(totalSamples * 0.05);
  const trimEnd = Math.max(
    trimStart + segSamples,
    Math.floor(totalSamples * 0.95),
  );

  interface CandidateBlock {
    startSample: number;
    score: number;
  }

  const candidates: CandidateBlock[] = [];
  const hasStereo = right !== null && right.length >= totalSamples;

  for (
    let start = trimStart;
    start + oneSecSamples <= trimEnd;
    start += oneSecSamples
  ) {
    let sumSq = 0;
    let hfDiffSq = 0;
    let clippedCount = 0;
    const end = start + oneSecSamples;

    for (let i = start; i < end; i++) {
      const sL = left[i];
      if (hasStereo && right) {
        const sR = right[i];
        sumSq += 0.5 * (sL * sL + sR * sR);
        if (Math.abs(sL) >= 0.999 || Math.abs(sR) >= 0.999) clippedCount++;
        if (i >= start + 2) {
          const hpL = sL - 2 * left[i - 1] + left[i - 2];
          const hpR = sR - 2 * right[i - 1] + right[i - 2];
          hfDiffSq += 0.5 * (hpL * hpL + hpR * hpR);
        }
      } else {
        sumSq += sL * sL;
        if (Math.abs(sL) >= 0.999) clippedCount++;
        if (i >= start + 2) {
          const hp = sL - 2 * left[i - 1] + left[i - 2];
          hfDiffSq += hp * hp;
        }
      }
    }

    const rms = Math.sqrt(sumSq / oneSecSamples);
    const rmsDb = rms > 1e-7 ? 20 * Math.log10(rms) : -140;
    const clipRatio = clippedCount / oneSecSamples;

    // Only reject silent passages or severely hard-clipped bursts (never clean loud masters)
    if (rmsDb < -55 || clipRatio > 0.25) {
      continue;
    }

    const hfRms = Math.sqrt(hfDiffSq / Math.max(1, oneSecSamples - 2));
    const hfDb = hfRms > 1e-8 ? 20 * Math.log10(hfRms) : -160;
    const score = hfDb * 0.78 + rmsDb * 0.22;
    candidates.push({ startSample: start, score });
  }

  const targetCount = 8;
  const chosenStarts: number[] = [];

  candidates.sort((a, b) => b.score - a.score);
  for (const cand of candidates) {
    if (chosenStarts.length >= targetCount) break;
    const segStart = Math.max(
      trimStart,
      Math.min(trimEnd - segSamples, cand.startSample - Math.floor(sampleRate * 1.5)),
    );
    const overlaps = chosenStarts.some(
      (existing) => Math.abs(existing - segStart) < segSamples,
    );
    if (!overlaps) {
      chosenStarts.push(segStart);
    }
  }

  // Fallback for very quiet tracks: evenly distributed 4-second windows
  if (chosenStarts.length === 0) {
    const maxFits = Math.max(1, Math.floor((trimEnd - trimStart) / segSamples));
    const count = Math.min(targetCount, maxFits);
    const span = Math.max(0, trimEnd - trimStart - segSamples);
    for (let i = 0; i < count; i++) {
      const frac = count === 1 ? 0.5 : i / (count - 1);
      chosenStarts.push(Math.floor(trimStart + span * frac));
    }
  }

  chosenStarts.sort((a, b) => a - b);

  const packedLength = chosenStarts.length * segSamples;
  const leftOut = new Float32Array(packedLength);
  const rightOut = hasStereo && right ? new Float32Array(packedLength) : null;

  for (let i = 0; i < chosenStarts.length; i++) {
    const srcStart = chosenStarts[i];
    const dstStart = i * segSamples;
    leftOut.set(left.subarray(srcStart, srcStart + segSamples), dstStart);
    if (hasStereo && right && rightOut) {
      rightOut.set(right.subarray(srcStart, srcStart + segSamples), dstStart);
    }
  }

  return {
    leftSamples: leftOut,
    rightSamples: rightOut,
    segmentLengthSamples: segSamples,
    analyzedSegments: chosenStarts.length,
    analyzedDurationSec: packedLength / sampleRate,
    segmentStartsSec: chosenStarts.map((s) => Number((s / sampleRate).toFixed(2))),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} seconds.`));
    }, ms);
    promise.then(
      (val) => {
        window.clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Decode validated audio file with resampling awareness, zero buffer-duplication RAM spikes,
 * preserved stereo channels, and immediate AudioBuffer release.
 */
export async function decodeAudioAndSelectSegments(
  file: File,
  metadata: HeaderMetadata,
  timeoutMs: number = SECURITY_LIMITS.PER_FILE_TIMEOUT_MS,
): Promise<DecodedTrackPayload> {
  const rawBuffer = await withTimeout(
    file.arrayBuffer(),
    timeoutMs,
    'Reading file buffer',
  );

  // Clamp requested context sample rate to safe browser bounds (8–96 kHz)
  const targetSr = Math.max(8000, Math.min(96000, metadata.sampleRate || 44100));

  let audioBuffer: AudioBuffer | null = null;
  try {
    const offline = new OfflineAudioContext(1, 1, targetSr);
    // Transfer rawBuffer directly without cloning to avoid doubling peak RAM
    audioBuffer = await withTimeout(
      offline.decodeAudioData(rawBuffer),
      timeoutMs,
      'Audio decoding',
    );
  } catch {
    // Only re-read from File inside the rare fallback path if OfflineAudioContext rejected/detached rawBuffer
    const fallbackBuffer = await withTimeout(
      file.arrayBuffer(),
      timeoutMs,
      'Reading file buffer',
    );
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new AudioCtx();
    try {
      audioBuffer = await withTimeout(
        ctx.decodeAudioData(fallbackBuffer),
        timeoutMs,
        'Audio decoding',
      );
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  if (!audioBuffer || audioBuffer.length <= 0 || audioBuffer.numberOfChannels <= 0) {
    throw new Error('Browser audio decoder returned an empty PCM buffer.');
  }

  const decodedSampleRate = audioBuffer.sampleRate;
  const decodedChannels = audioBuffer.numberOfChannels;
  const decodedLength = audioBuffer.length;
  const decodedDuration = audioBuffer.duration;

  if (decodedDuration < SECURITY_LIMITS.MIN_DURATION_SEC) {
    audioBuffer = null;
    throw new Error(
      `Decoded audio duration (${decodedDuration.toFixed(2)} s) is shorter than the 0.5 s minimum.`,
    );
  }

  // Preserve Left & Right separately for stereo; downmix multichannel (>2 ch) to mono
  let left: Float32Array;
  let right: Float32Array | null = null;

  if (decodedChannels === 1) {
    left = new Float32Array(audioBuffer.getChannelData(0));
  } else if (decodedChannels === 2) {
    left = new Float32Array(audioBuffer.getChannelData(0));
    right = new Float32Array(audioBuffer.getChannelData(1));
  } else {
    left = new Float32Array(decodedLength);
    const inv = 1 / decodedChannels;
    for (let ch = 0; ch < decodedChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < decodedLength; i++) {
        left[i] += data[i] * inv;
      }
    }
  }

  // Release AudioBuffer reference immediately to keep memory lean
  audioBuffer = null;

  const selected = selectAdaptiveTransientSegments(left, right, decodedSampleRate);

  const exactDuration =
    metadata.duration > 0 && metadata.totalSamples !== null
      ? metadata.duration
      : decodedDuration;
  const updatedMetadata: HeaderMetadata = {
    ...metadata,
    channels: metadata.channels || decodedChannels,
    duration: exactDuration,
    bitrate:
      exactDuration > 0
        ? Math.floor((file.size * 8) / exactDuration)
        : metadata.bitrate,
  };

  return {
    ...selected,
    decodedSampleRate,
    updatedMetadata,
  };
}
