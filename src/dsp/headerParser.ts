import type { HeaderMetadata } from './types';

export interface Wav24BitCheckResult {
  isFake24Bit: boolean;
  trueBitDepthNote: string | null;
  sampledValues: number;
  zeroLsbFraction: number;
}

/**
 * Pure raw-PCM 24-bit zero-padding inspector.
 * Examines 24-bit little-endian PCM frames: if the least-significant byte (byte 0)
 * is zero across >= 99.9% of active samples, the file is a 16-bit master padded to 24-bit.
 */
export function checkRaw24BitPcmPadding(
  pcmBytes: Uint8Array,
): Wav24BitCheckResult {
  const sampleCount = Math.floor(pcmBytes.length / 3);
  if (sampleCount < 64) {
    return {
      isFake24Bit: false,
      trueBitDepthNote: null,
      sampledValues: sampleCount,
      zeroLsbFraction: 0,
    };
  }

  let activeSamples = 0;
  let zeroLsbCount = 0;

  for (let i = 0; i < sampleCount; i++) {
    const off = i * 3;
    const b0 = pcmBytes[off];
    const b1 = pcmBytes[off + 1];
    const b2 = pcmBytes[off + 2];

    // Skip exact digital silence so quiet intros don't skew LSB statistics
    if (b0 === 0 && b1 === 0 && b2 === 0) continue;

    activeSamples++;
    if (b0 === 0) {
      zeroLsbCount++;
    }
  }

  if (activeSamples < 64) {
    return {
      isFake24Bit: false,
      trueBitDepthNote: null,
      sampledValues: activeSamples,
      zeroLsbFraction: 0,
    };
  }

  const zeroLsbFraction = zeroLsbCount / activeSamples;
  const isFake24Bit = zeroLsbFraction >= 0.999;

  return {
    isFake24Bit,
    trueBitDepthNote: isFake24Bit
      ? 'Zero-padded 16-bit PCM in 24-bit container'
      : 'Verified active 24-bit LSB resolution',
    sampledValues: activeSamples,
    zeroLsbFraction,
  };
}

/**
 * Inspect raw PCM frames from the middle of a 24-bit WAV data chunk before Web Audio float conversion.
 */
export async function enrichHeaderMetadata(
  file: File,
  metadata: HeaderMetadata,
): Promise<HeaderMetadata> {
  if (
    metadata.container !== 'WAV' ||
    metadata.bitDepth !== 24 ||
    metadata.rawPcmDataOffset === undefined ||
    metadata.rawPcmDataSize === undefined ||
    metadata.rawPcmDataSize < 300
  ) {
    return metadata;
  }

  const frameSize = 3 * metadata.channels;
  const totalFrames = Math.floor(metadata.rawPcmDataSize / frameSize);
  const midFrame = Math.floor(totalFrames * 0.45);
  const startByte = metadata.rawPcmDataOffset + midFrame * frameSize;
  const inspectBytes = Math.min(
    65532 - (65532 % frameSize),
    metadata.rawPcmDataOffset + metadata.rawPcmDataSize - startByte,
  );

  if (inspectBytes < 192 || startByte + inspectBytes > file.size) {
    return metadata;
  }

  const sliceBuf = await file.slice(startByte, startByte + inspectBytes).arrayBuffer();
  const check = checkRaw24BitPcmPadding(new Uint8Array(sliceBuf));

  return {
    ...metadata,
    isFake24Bit: check.isFake24Bit,
    trueBitDepthNote: check.trueBitDepthNote,
  };
}
