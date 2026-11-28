import { SECURITY_LIMITS } from '../security/fileValidator';
import type { HeaderMetadata } from './types';

export interface SelectedAudioSegments {
  monoSamples: Float32Array;
  diffSamples: Float32Array | null;
  analyzedSegments: number;
  analyzedDurationSec: number;
  segmentStartsSec: number[];
}

export interface DecodedTrackPayload extends SelectedAudioSegments {
  decodedSampleRate: number;
  updatedMetadata: HeaderMetadata;
}

/**
 * Adaptive Transient-Guided Segment Selection (pure, deterministic).
 *
 * - For tracks <= 30 s: analyzes the entire track.
 * - For tracks > 30 s: excludes the first/last 5%, scores 1-second windows by
 *   second-order high-pass transient energy (x[n] - 2x[n-1] + x[n-2]) combined
 *   with RMS loudness (ignoring silent or heavily clipped windows), and selects
 *   6 to 8 highest-scoring non-overlapping 4-second segments.
 */
export function selectAdaptiveTransientSegments(
  mono: Float32Array,
  diff: Float32Array | null,
  sampleRate: number,
): SelectedAudioSegments {
  const totalSamples = mono.length;
  const totalSec = totalSamples / sampleRate;

  if (totalSec <= 30.5) {
    return {
      monoSamples: mono,
      diffSamples: diff,
      analyzedSegments: 1,
      analyzedDurationSec: totalSec,
      segmentStartsSec: [0],
    };
  }

  const segDurationSec = 4;
  const segSamples = Math.floor(segDurationSec * sampleRate);
  const oneSecSamples = Math.max(256, Math.floor(sampleRate));

  // Exclude first and last 5% on tracks > 30 s
  const trimStart = Math.floor(totalSamples * 0.05);
  const trimEnd = Math.max(trimStart + segSamples, Math.floor(totalSamples * 0.95));

  interface CandidateWindow {
    startSample: number;
    score: number;
  }

  const candidates: CandidateWindow[] = [];

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
      const s = mono[i];
      sumSq += s * s;
      if (Math.abs(s) >= 0.995) clippedCount++;
      if (i >= start + 2) {
        const hp = s - 2 * mono[i - 1] + mono[i - 2];
        hfDiffSq += hp * hp;
      }
    }

    const rms = Math.sqrt(sumSq / oneSecSamples);
    const rmsDb = rms > 1e-7 ? 20 * Math.log10(rms) : -140;
    const clipRatio = clippedCount / oneSecSamples;

    // Ignore near-silent passages and severely clipped bursts
    if (rmsDb < -55 || clipRatio > 0.05) {
      continue;
    }

    const hfRms = Math.sqrt(hfDiffSq / Math.max(1, oneSecSamples - 2));
    const hfDb = hfRms > 1e-8 ? 20 * Math.log10(hfRms) : -160;
    // Combine HF transient strength (primary) with healthy loudness (secondary)
    const score = hfDb * 0.72 + rmsDb * 0.28;
    candidates.push({ startSample: start, score });
  }

  const targetCount = totalSec >= 120 ? 8 : 6;
  const chosenStarts: number[] = [];

  // Sort candidates descending by transient score and pick non-overlapping 4s windows
  candidates.sort((a, b) => b.score - a.score);
  for (const cand of candidates) {
    if (chosenStarts.length >= targetCount) break;
    // Center the 4-second segment around the high-transient 1s window
    const segStart = Math.max(
      0,
      Math.min(totalSamples - segSamples, cand.startSample - Math.floor(sampleRate * 1.5)),
    );
    const overlaps = chosenStarts.some(
      (existing) => Math.abs(existing - segStart) < segSamples,
    );
    if (!overlaps) {
      chosenStarts.push(segStart);
    }
  }

  // Fallback if entire track is extremely quiet: evenly spaced segments
  if (chosenStarts.length === 0) {
    const count = Math.min(targetCount, Math.max(1, Math.floor((trimEnd - trimStart) / segSamples)));
    const span = Math.max(1, trimEnd - trimStart - segSamples);
    for (let i = 0; i < count; i++) {
      const frac = count === 1 ? 0.5 : i / (count - 1);
      chosenStarts.push(Math.floor(trimStart + span * frac));
    }
  }

  chosenStarts.sort((a, b) => a - b);

  const packedLength = chosenStarts.length * segSamples;
  const monoOut = new Float32Array(packedLength);
  const diffOut = diff ? new Float32Array(packedLength) : null;

  for (let i = 0; i < chosenStarts.length; i++) {
    const srcStart = chosenStarts[i];
    const dstStart = i * segSamples;
    monoOut.set(mono.subarray(srcStart, srcStart + segSamples), dstStart);
    if (diff && diffOut) {
      diffOut.set(diff.subarray(srcStart, srcStart + segSamples), dstStart);
    }
  }

  return {
    monoSamples: monoOut,
    diffSamples: diffOut,
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
 * Decode validated audio file with resampling awareness and immediate AudioBuffer release.
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

  // Clamp requested context sample rate to typical browser bounds (8 kHz - 96 kHz)
  const targetSr = Math.max(8000, Math.min(96000, metadata.sampleRate || 44100));

  let audioBuffer: AudioBuffer | null = null;
  try {
    const offline = new OfflineAudioContext(1, 1, targetSr);
    audioBuffer = await withTimeout(
      offline.decodeAudioData(rawBuffer.slice(0)),
      timeoutMs,
      'Audio decoding',
    );
  } catch {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new AudioCtx();
    try {
      audioBuffer = await withTimeout(
        ctx.decodeAudioData(rawBuffer.slice(0)),
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

  // Compute mono mix and lightweight stereo difference (L - R) immediately
  let mono: Float32Array;
  let diff: Float32Array | null = null;

  if (decodedChannels === 1) {
    mono = new Float32Array(audioBuffer.getChannelData(0));
  } else if (decodedChannels === 2) {
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.getChannelData(1);
    mono = new Float32Array(decodedLength);
    diff = new Float32Array(decodedLength);
    for (let i = 0; i < decodedLength; i++) {
      mono[i] = (ch0[i] + ch1[i]) * 0.5;
      diff[i] = (ch0[i] - ch1[i]) * 0.5;
    }
  } else {
    mono = new Float32Array(decodedLength);
    const inv = 1 / decodedChannels;
    for (let ch = 0; ch < decodedChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < decodedLength; i++) {
        mono[i] += data[i] * inv;
      }
    }
  }

  // Aggressively release AudioBuffer reference immediately so GC can reclaim full-track memory
  audioBuffer = null;

  const selected = selectAdaptiveTransientSegments(mono, diff, decodedSampleRate);

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
