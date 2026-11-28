import type { AudioContainerFormat, HeaderMetadata } from '../dsp/types';
import { sanitizeFilename } from './sanitize';

export const SECURITY_LIMITS = {
  MAX_FILE_SIZE_BYTES: 350 * 1024 * 1024, // 350 MB
  MAX_BATCH_FILES: 50,
  HEADER_SLICE_BYTES: 65536, // 64 KB
  MAX_ESTIMATED_PCM_BYTES: 450 * 1024 * 1024, // 450 MB uncompressed Float32 PCM cap
  MAX_CONTAINER_BLOCKS: 128,
  PER_FILE_TIMEOUT_MS: 25_000,
  MIN_SAMPLE_RATE: 8_000,
  MAX_SAMPLE_RATE: 384_000,
  MIN_CHANNELS: 1,
  MAX_CHANNELS: 8,
  MIN_BIT_DEPTH: 8,
  MAX_BIT_DEPTH: 32,
  MIN_DURATION_SEC: 0.5,
  MAX_DURATION_SEC: 4 * 3600, // 4 hours
  MIN_FLAC_BLOCK_SIZE: 16,
} as const;

export class SecurityValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SecurityValidationError';
    this.code = code;
  }
}

/**
 * Hardened bounds-checked binary reader over an ArrayBuffer / Uint8Array.
 * Prevents unchecked DataView offsets, negative indices, and 32-bit integer overflows.
 */
export class SafeReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  readonly length: number;

  constructor(buffer: ArrayBuffer | Uint8Array) {
    if (buffer instanceof Uint8Array) {
      this.bytes = buffer;
      this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      this.length = buffer.byteLength;
    } else {
      this.bytes = new Uint8Array(buffer);
      this.view = new DataView(buffer);
      this.length = buffer.byteLength;
    }
  }

  private assertRange(offset: number, size: number): void {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset + size > this.length
    ) {
      throw new SecurityValidationError(
        'OUT_OF_BOUNDS',
        'Malformed binary header: unexpected end of data or out-of-bounds offset.',
      );
    }
  }

  has(offset: number, size: number): boolean {
    return (
      Number.isSafeInteger(offset) &&
      Number.isSafeInteger(size) &&
      offset >= 0 &&
      size >= 0 &&
      offset + size <= this.length
    );
  }

  u8(offset: number): number {
    this.assertRange(offset, 1);
    return this.view.getUint8(offset);
  }

  u16be(offset: number): number {
    this.assertRange(offset, 2);
    return this.view.getUint16(offset, false);
  }

  u16le(offset: number): number {
    this.assertRange(offset, 2);
    return this.view.getUint16(offset, true);
  }

  u24be(offset: number): number {
    this.assertRange(offset, 3);
    return (
      (this.bytes[offset] << 16) |
      (this.bytes[offset + 1] << 8) |
      this.bytes[offset + 2]
    );
  }

  u32be(offset: number): number {
    this.assertRange(offset, 4);
    return this.view.getUint32(offset, false);
  }

  u32le(offset: number): number {
    this.assertRange(offset, 4);
    return this.view.getUint32(offset, true);
  }

  ascii(offset: number, length: number): string {
    this.assertRange(offset, length);
    let out = '';
    for (let i = 0; i < length; i++) {
      out += String.fromCharCode(this.bytes[offset + i]);
    }
    return out;
  }

  sliceBytes(offset: number, length: number): Uint8Array {
    this.assertRange(offset, length);
    return this.bytes.subarray(offset, offset + length);
  }
}

export interface ValidatedAudioHeader {
  displayName: string;
  container: AudioContainerFormat;
  metadata: HeaderMetadata;
  estimatedPcmBytes: number;
  securityChecks: string[];
}

const ALLOWED_MP4_AUDIO_BRANDS = new Set([
  'M4A ',
  'M4B ',
  'mp42',
  'isom',
  'f4a ',
]);

const REJECTED_MP4_VIDEO_ONLY_BRANDS = new Set([
  'av01',
  'heic',
  'heix',
  'mif1',
  'msf1',
  'avif',
  'qt  ',
]);

// MPEG Audio header lookup tables
const MPEG1_BITRATES_L3 = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const MPEG2_BITRATES_L3 = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];
const MPEG1_SAMPLE_RATES = [44100, 48000, 32000, 0];
const MPEG2_SAMPLE_RATES = [22050, 24000, 16000, 0];
const MPEG25_SAMPLE_RATES = [11025, 12000, 8000, 0];

/**
 * Explicitly reject well-known non-audio / executable / markup / archive signatures
 * to block polyglot payloads disguised with audio extensions.
 */
function assertNotDisguisedPolyglot(reader: SafeReader): void {
  if (reader.length < 4) {
    throw new SecurityValidationError(
      'TOO_SMALL',
      'Rejected: file is empty or too small to be a valid audio container.',
    );
  }

  const b0 = reader.u8(0);
  const b1 = reader.u8(1);
  const b2 = reader.u8(2);
  const b3 = reader.u8(3);

  // Executables: ELF, PE/MZ, Mach-O, Shebang
  if (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c && b3 === 0x46) {
    throw new SecurityValidationError('POLYGLOT_BLOCKED', 'Rejected: executable binary (ELF) disguised as audio.');
  }
  if (b0 === 0x4d && b1 === 0x5a) {
    throw new SecurityValidationError('POLYGLOT_BLOCKED', 'Rejected: Windows executable (PE/MZ) disguised as audio.');
  }
  if (
    (b0 === 0xcf && b1 === 0xfa && b2 === 0xed && b3 === 0xfe) ||
    (b0 === 0xfe && b1 === 0xed && b2 === 0xfa && b3 === 0xcf) ||
    (b0 === 0xca && b1 === 0xfe && b2 === 0xba && b3 === 0xbe)
  ) {
    throw new SecurityValidationError('POLYGLOT_BLOCKED', 'Rejected: Mach-O executable disguised as audio.');
  }
  if (b0 === 0x23 && b1 === 0x21) {
    throw new SecurityValidationError('POLYGLOT_BLOCKED', 'Rejected: script file disguised as audio.');
  }

  // Archives & Documents: ZIP, PDF, PNG, JPEG, GIF, RAR, GZIP
  if (b0 === 0x50 && b1 === 0x4b && (b2 === 0x03 || b2 === 0x05 || b2 === 0x07)) {
    throw new SecurityValidationError('POLYGLOT_BLOCKED', 'Rejected: ZIP archive disguised as audio.');
  }
  if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) {
    throw new SecurityValidationError('POLYGLOT_BLOCKED', 'Rejected: PDF document disguised as audio.');
  }
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) {
    throw new SecurityValidationError('POLYGLOT_BLOCKED', 'Rejected: PNG image disguised as audio.');
  }
  if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) {
    throw new SecurityValidationError('POLYGLOT_BLOCKED', 'Rejected: JPEG image disguised as audio.');
  }
  if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) {
    throw new SecurityValidationError('POLYGLOT_BLOCKED', 'Rejected: GIF image disguised as audio.');
  }
  if (b0 === 0x1f && b1 === 0x8b) {
    throw new SecurityValidationError('POLYGLOT_BLOCKED', 'Rejected: GZIP archive disguised as audio.');
  }

  // Markup / HTML / SVG / XML (checking leading ASCII after optional UTF-8 BOM & whitespace)
  let probeOffset = 0;
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) {
    probeOffset = 3;
  }
  while (probeOffset < Math.min(reader.length, 64)) {
    const ch = reader.u8(probeOffset);
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
      probeOffset++;
    } else {
      break;
    }
  }
  if (reader.has(probeOffset, 1) && reader.u8(probeOffset) === 0x3c) {
    const snippet = reader
      .ascii(probeOffset, Math.min(16, reader.length - probeOffset))
      .toLowerCase();
    if (
      snippet.startsWith('<!doctype') ||
      snippet.startsWith('<html') ||
      snippet.startsWith('<svg') ||
      snippet.startsWith('<?xml') ||
      snippet.startsWith('<script')
    ) {
      throw new SecurityValidationError(
        'POLYGLOT_BLOCKED',
        'Rejected: HTML/SVG/XML document disguised as an audio file.',
      );
    }
  }
}

/**
 * Decode 80-bit IEEE 754 extended precision float used in AIFF COMM sampleRate.
 */
function readFloat80Be(reader: SafeReader, offset: number): number {
  const exponSign = reader.u16be(offset);
  const hiMant = reader.u32be(offset + 2);
  const loMant = reader.u32be(offset + 6);
  const sign = (exponSign & 0x8000) !== 0 ? -1 : 1;
  const expon = exponSign & 0x7fff;

  if (expon === 0 && hiMant === 0 && loMant === 0) return 0;
  if (expon === 0x7fff) return NaN;

  const shift = expon - 16383;
  const val = hiMant * Math.pow(2, shift - 31) + loMant * Math.pow(2, shift - 63);
  return sign * val;
}

export function estimateDecodedPcmBytes(
  sampleRate: number,
  channels: number,
  durationSec: number,
): number {
  if (
    !Number.isFinite(sampleRate) ||
    !Number.isFinite(channels) ||
    !Number.isFinite(durationSec) ||
    sampleRate <= 0 ||
    channels <= 0 ||
    durationSec <= 0
  ) {
    return 0;
  }
  return Math.ceil(sampleRate * channels * durationSec * 4);
}

function validateMetadataSanity(
  meta: HeaderMetadata,
  requireDuration: boolean,
): number {
  if (
    !Number.isFinite(meta.sampleRate) ||
    meta.sampleRate < SECURITY_LIMITS.MIN_SAMPLE_RATE ||
    meta.sampleRate > SECURITY_LIMITS.MAX_SAMPLE_RATE
  ) {
    throw new SecurityValidationError(
      'INVALID_SAMPLE_RATE',
      `Rejected: sample rate ${meta.sampleRate} Hz is outside the safe range (${SECURITY_LIMITS.MIN_SAMPLE_RATE}–${SECURITY_LIMITS.MAX_SAMPLE_RATE} Hz).`,
    );
  }

  if (
    !Number.isInteger(meta.channels) ||
    meta.channels < SECURITY_LIMITS.MIN_CHANNELS ||
    meta.channels > SECURITY_LIMITS.MAX_CHANNELS
  ) {
    throw new SecurityValidationError(
      'INVALID_CHANNELS',
      `Rejected: channel count ${meta.channels} is outside the safe range (${SECURITY_LIMITS.MIN_CHANNELS}–${SECURITY_LIMITS.MAX_CHANNELS}).`,
    );
  }

  if (
    meta.bitDepth !== null &&
    (!Number.isInteger(meta.bitDepth) ||
      meta.bitDepth < SECURITY_LIMITS.MIN_BIT_DEPTH ||
      meta.bitDepth > SECURITY_LIMITS.MAX_BIT_DEPTH)
  ) {
    throw new SecurityValidationError(
      'INVALID_BIT_DEPTH',
      `Rejected: bit depth ${meta.bitDepth}-bit is outside the safe range (${SECURITY_LIMITS.MIN_BIT_DEPTH}–${SECURITY_LIMITS.MAX_BIT_DEPTH}).`,
    );
  }

  if (requireDuration || meta.duration > 0) {
    if (
      !Number.isFinite(meta.duration) ||
      meta.duration < SECURITY_LIMITS.MIN_DURATION_SEC ||
      meta.duration > SECURITY_LIMITS.MAX_DURATION_SEC
    ) {
      throw new SecurityValidationError(
        'INVALID_DURATION',
        `Rejected: duration (${meta.duration.toFixed(2)} s) must be between ${SECURITY_LIMITS.MIN_DURATION_SEC} s and 4 hours.`,
      );
    }
  }

  const estimatedBytes = estimateDecodedPcmBytes(
    meta.sampleRate,
    meta.channels,
    meta.duration,
  );
  if (estimatedBytes > SECURITY_LIMITS.MAX_ESTIMATED_PCM_BYTES) {
    const estMb = (estimatedBytes / (1024 * 1024)).toFixed(0);
    throw new SecurityValidationError(
      'MEMORY_BOMB',
      `Rejected: estimated uncompressed PCM buffer (${estMb} MB) exceeds the 450 MB memory safety limit.`,
    );
  }

  return estimatedBytes;
}

function parseFlacSafe(reader: SafeReader, fileSize: number): HeaderMetadata {
  if (!reader.has(0, 42)) {
    throw new SecurityValidationError(
      'MALFORMED_FLAC',
      'Rejected: FLAC header is truncated before STREAMINFO.',
    );
  }

  const firstHeader = reader.u8(4);
  const isLastInitial = (firstHeader & 0x80) !== 0;
  const blockType = firstHeader & 0x7f;
  const blockLength = reader.u24be(5);

  if (blockType !== 0 || blockLength !== 34) {
    throw new SecurityValidationError(
      'MALFORMED_FLAC',
      'Rejected: FLAC file missing mandatory 34-byte STREAMINFO metadata block.',
    );
  }

  const infoOffset = 8;
  const minBlockSize = reader.u16be(infoOffset);
  const maxBlockSize = reader.u16be(infoOffset + 2);
  if (
    minBlockSize < SECURITY_LIMITS.MIN_FLAC_BLOCK_SIZE ||
    maxBlockSize < minBlockSize
  ) {
    throw new SecurityValidationError(
      'MALFORMED_FLAC',
      `Rejected: invalid FLAC block sizes (min=${minBlockSize}, max=${maxBlockSize}).`,
    );
  }

  const b10 = reader.u8(infoOffset + 10);
  const b11 = reader.u8(infoOffset + 11);
  const b12 = reader.u8(infoOffset + 12);
  const b13 = reader.u8(infoOffset + 13);
  const b14 = reader.u8(infoOffset + 14);
  const b15 = reader.u8(infoOffset + 15);
  const b16 = reader.u8(infoOffset + 16);
  const b17 = reader.u8(infoOffset + 17);

  const sampleRate = (b10 << 12) | (b11 << 4) | (b12 >>> 4);
  const channels = ((b12 >>> 1) & 0x07) + 1;
  const bitDepth = (((b12 & 0x01) << 4) | (b13 >>> 4)) + 1;
  const totalSamplesHigh = b13 & 0x0f;
  const totalSamplesLow =
    ((b14 << 24) >>> 0) + (b15 << 16) + (b16 << 8) + b17;
  const totalSamples = totalSamplesHigh * 4294967296 + totalSamplesLow;

  const md5Bytes = reader.sliceBytes(infoOffset + 18, 16);
  let md5Hex = '';
  for (let i = 0; i < 16; i++) {
    md5Hex += md5Bytes[i].toString(16).padStart(2, '0');
  }

  // Walk remaining metadata blocks inside header slice with strict iteration cap
  let cursor = infoOffset + 34;
  let isLast = isLastInitial;
  let blocksSeen = 1;
  while (!isLast && reader.has(cursor, 4)) {
    if (blocksSeen >= SECURITY_LIMITS.MAX_CONTAINER_BLOCKS) {
      throw new SecurityValidationError(
        'TOO_MANY_BLOCKS',
        'Rejected: FLAC metadata block count exceeds maximum limit (128).',
      );
    }
    const hdr = reader.u8(cursor);
    const type = hdr & 0x7f;
    if (type === 127) {
      throw new SecurityValidationError(
        'MALFORMED_FLAC',
        'Rejected: invalid FLAC metadata block type (127).',
      );
    }
    const len = reader.u24be(cursor + 1);
    if (cursor + 4 + len > fileSize) {
      throw new SecurityValidationError(
        'INVALID_SIZE',
        'Rejected: FLAC metadata block length exceeds file size.',
      );
    }
    isLast = (hdr & 0x80) !== 0;
    cursor += 4 + len;
    blocksSeen++;
  }

  const duration = totalSamples > 0 && sampleRate > 0 ? totalSamples / sampleRate : 0;
  const bitrate = duration > 0 ? Math.floor((fileSize * 8) / duration) : 0;

  return {
    container: 'FLAC',
    codecHint: 'FLAC Lossless',
    isLossyContainer: false,
    sampleRate,
    bitDepth,
    channels,
    totalSamples: totalSamples > 0 ? totalSamples : null,
    duration,
    bitrate,
    md5Hash: md5Hex,
  };
}

function parseWavSafe(reader: SafeReader, fileSize: number): HeaderMetadata {
  if (!reader.has(0, 12)) {
    throw new SecurityValidationError('MALFORMED_WAV', 'Rejected: truncated WAV header.');
  }
  const riffSize = reader.u32le(4);
  const waveId = reader.ascii(8, 4);
  if (waveId !== 'WAVE') {
    throw new SecurityValidationError(
      'MALFORMED_WAV',
      'Rejected: RIFF container is not a WAVE audio file.',
    );
  }
  if (riffSize < 28 || riffSize > fileSize + 8) {
    throw new SecurityValidationError(
      'INVALID_SIZE',
      'Rejected: WAV RIFF chunk size does not match actual file size.',
    );
  }

  let cursor = 12;
  let chunks = 0;
  let foundFmt = false;
  let foundData = false;
  let audioFormat = 1;
  let channels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let dataOffset = 0;
  let dataSize = 0;

  while (reader.has(cursor, 8)) {
    if (chunks >= SECURITY_LIMITS.MAX_CONTAINER_BLOCKS) {
      throw new SecurityValidationError(
        'TOO_MANY_BLOCKS',
        'Rejected: WAV chunk count exceeds maximum safety limit (128).',
      );
    }
    const id = reader.ascii(cursor, 4);
    const size = reader.u32le(cursor + 4);
    const payloadStart = cursor + 8;

    if (size === 0 && id === 'data') {
      throw new SecurityValidationError(
        'MALFORMED_WAV',
        'Rejected: WAV data chunk has zero length.',
      );
    }
    if (payloadStart + size > fileSize + 1) {
      throw new SecurityValidationError(
        'INVALID_SIZE',
        `Rejected: WAV chunk "${id}" extends past the end of the file.`,
      );
    }

    if (id === 'fmt ') {
      if (size < 16 || !reader.has(payloadStart, 16)) {
        throw new SecurityValidationError(
          'MALFORMED_WAV',
          'Rejected: WAV fmt chunk is truncated or malformed.',
        );
      }
      audioFormat = reader.u16le(payloadStart);
      channels = reader.u16le(payloadStart + 2);
      sampleRate = reader.u32le(payloadStart + 4);
      byteRate = reader.u32le(payloadStart + 8);
      blockAlign = reader.u16le(payloadStart + 12);
      bitDepth = reader.u16le(payloadStart + 14);
      foundFmt = true;
    } else if (id === 'data') {
      dataOffset = payloadStart;
      dataSize = size;
      foundData = true;
      break;
    }

    const paddedSize = size + (size % 2);
    const nextCursor = payloadStart + paddedSize;
    if (nextCursor <= cursor) {
      throw new SecurityValidationError(
        'CIRCULAR_CHUNK',
        'Rejected: invalid or circular WAV chunk offset.',
      );
    }
    cursor = nextCursor;
    chunks++;
  }

  if (!foundFmt || !foundData) {
    throw new SecurityValidationError(
      'MALFORMED_WAV',
      'Rejected: WAV file is missing required fmt or data chunks within the header.',
    );
  }

  // Supported WAV audio formats: 1 = PCM, 3 = IEEE Float, 0xFFFE = WAVE_FORMAT_EXTENSIBLE
  const isLossyWav = audioFormat !== 1 && audioFormat !== 3 && audioFormat !== 0xfffe;
  const codecHint =
    audioFormat === 3
      ? 'WAV IEEE Float'
      : audioFormat === 1 || audioFormat === 0xfffe
        ? 'WAV Uncompressed PCM'
        : `WAV Compressed (0x${audioFormat.toString(16)})`;

  const totalSamples =
    blockAlign > 0 ? Math.floor(dataSize / blockAlign) : null;
  const duration =
    totalSamples !== null && sampleRate > 0
      ? totalSamples / sampleRate
      : byteRate > 0
        ? dataSize / byteRate
        : 0;
  const bitrate = duration > 0 ? Math.floor((fileSize * 8) / duration) : byteRate * 8;

  return {
    container: 'WAV',
    codecHint,
    isLossyContainer: isLossyWav,
    sampleRate,
    bitDepth,
    channels,
    totalSamples,
    duration,
    bitrate,
    md5Hash: null,
    rawPcmDataOffset: audioFormat === 1 ? dataOffset : undefined,
    rawPcmDataSize: audioFormat === 1 ? dataSize : undefined,
  };
}

function parseAiffSafe(reader: SafeReader, fileSize: number): HeaderMetadata {
  if (!reader.has(0, 12)) {
    throw new SecurityValidationError('MALFORMED_AIFF', 'Rejected: truncated AIFF header.');
  }
  const formSize = reader.u32be(4);
  const formType = reader.ascii(8, 4);
  if (formType !== 'AIFF' && formType !== 'AIFC') {
    throw new SecurityValidationError(
      'MALFORMED_AIFF',
      'Rejected: IFF FORM container is not AIFF or AIFC.',
    );
  }
  if (formSize < 26 || formSize > fileSize + 8) {
    throw new SecurityValidationError(
      'INVALID_SIZE',
      'Rejected: AIFF FORM size does not match actual file size.',
    );
  }

  let cursor = 12;
  let chunks = 0;
  let foundComm = false;
  let foundSsnd = false;
  let channels = 0;
  let totalSamples = 0;
  let bitDepth = 0;
  let sampleRate = 0;
  let codecHint = formType === 'AIFC' ? 'AIFF-C' : 'AIFF Uncompressed PCM';
  let isLossy = false;

  while (reader.has(cursor, 8)) {
    if (chunks >= SECURITY_LIMITS.MAX_CONTAINER_BLOCKS) {
      throw new SecurityValidationError(
        'TOO_MANY_BLOCKS',
        'Rejected: AIFF chunk count exceeds maximum limit (128).',
      );
    }
    const id = reader.ascii(cursor, 4);
    const size = reader.u32be(cursor + 4);
    const payloadStart = cursor + 8;

    if (payloadStart + size > fileSize + 1) {
      throw new SecurityValidationError(
        'INVALID_SIZE',
        `Rejected: AIFF chunk "${id}" extends past the end of the file.`,
      );
    }

    if (id === 'COMM') {
      if (size < 18 || !reader.has(payloadStart, 18)) {
        throw new SecurityValidationError(
          'MALFORMED_AIFF',
          'Rejected: AIFF COMM chunk is truncated.',
        );
      }
      channels = reader.u16be(payloadStart);
      totalSamples = reader.u32be(payloadStart + 2);
      bitDepth = reader.u16be(payloadStart + 6);
      sampleRate = Math.round(readFloat80Be(reader, payloadStart + 8));
      if (formType === 'AIFC' && size >= 22 && reader.has(payloadStart + 18, 4)) {
        const compType = reader.ascii(payloadStart + 18, 4);
        if (compType === 'NONE' || compType === 'sowt' || compType === 'fl32') {
          codecHint = `AIFF-C (${compType.trim()})`;
        } else {
          codecHint = `AIFF-C Compressed (${compType.trim()})`;
          isLossy = true;
        }
      }
      foundComm = true;
    } else if (id === 'SSND') {
      if (size === 0) {
        throw new SecurityValidationError('MALFORMED_AIFF', 'Rejected: empty AIFF SSND chunk.');
      }
      foundSsnd = true;
      if (foundComm) break;
    }

    const paddedSize = size + (size % 2);
    const nextCursor = payloadStart + paddedSize;
    if (nextCursor <= cursor) {
      throw new SecurityValidationError(
        'CIRCULAR_CHUNK',
        'Rejected: circular or zero-advance AIFF chunk.',
      );
    }
    cursor = nextCursor;
    chunks++;
  }

  if (!foundComm) {
    throw new SecurityValidationError(
      'MALFORMED_AIFF',
      'Rejected: AIFF file is missing mandatory COMM chunk.',
    );
  }
  if (!foundSsnd && cursor < reader.length) {
    throw new SecurityValidationError(
      'MALFORMED_AIFF',
      'Rejected: AIFF file is missing audio SSND chunk.',
    );
  }

  const duration = sampleRate > 0 ? totalSamples / sampleRate : 0;
  const bitrate = duration > 0 ? Math.floor((fileSize * 8) / duration) : 0;

  return {
    container: 'AIFF',
    codecHint,
    isLossyContainer: isLossy,
    sampleRate,
    bitDepth,
    channels,
    totalSamples,
    duration,
    bitrate,
    md5Hash: null,
  };
}

interface ParsedMpegFrame {
  sampleRate: number;
  bitrateKbps: number;
  channels: number;
  frameLength: number;
  versionLabel: string;
}

function tryParseMpegFrameHeader(
  reader: SafeReader,
  offset: number,
): ParsedMpegFrame | null {
  if (!reader.has(offset, 4)) return null;
  const b0 = reader.u8(offset);
  const b1 = reader.u8(offset + 1);
  const b2 = reader.u8(offset + 2);
  const b3 = reader.u8(offset + 3);

  // Sync word 11 bits: 0xFF and top 3 bits of b1 === 0xE0, explicitly disallow 0xFF 0xFF
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0 || b1 === 0xff) return null;

  const versionBits = (b1 >>> 3) & 0x03; // 00=2.5, 01=reserved, 10=2, 11=1
  const layerBits = (b1 >>> 1) & 0x03; // 00=reserved, 01=Layer III, 10=Layer II, 11=Layer I
  if (versionBits === 1 || layerBits === 0) return null;

  const bitrateIdx = (b2 >>> 4) & 0x0f;
  const srIdx = (b2 >>> 2) & 0x03;
  const padding = (b2 >>> 1) & 0x01;
  if (bitrateIdx === 0 || bitrateIdx === 0x0f || srIdx === 0x03) return null;

  const sampleRate =
    versionBits === 3
      ? MPEG1_SAMPLE_RATES[srIdx]
      : versionBits === 2
        ? MPEG2_SAMPLE_RATES[srIdx]
        : MPEG25_SAMPLE_RATES[srIdx];

  const bitrateKbps =
    versionBits === 3
      ? MPEG1_BITRATES_L3[bitrateIdx]
      : MPEG2_BITRATES_L3[bitrateIdx];

  if (sampleRate <= 0 || bitrateKbps <= 0) return null;

  const channelMode = (b3 >>> 6) & 0x03;
  const channels = channelMode === 3 ? 1 : 2;
  const samplesPerFrame = versionBits === 3 ? 1152 : 576;
  const frameLength = Math.floor(
    ((samplesPerFrame / 8) * bitrateKbps * 1000) / sampleRate + padding,
  );
  if (frameLength < 24) return null;

  const versionLabel =
    versionBits === 3 ? 'MPEG-1' : versionBits === 2 ? 'MPEG-2' : 'MPEG-2.5';

  return { sampleRate, bitrateKbps, channels, frameLength, versionLabel };
}

function parseMp3Safe(reader: SafeReader, fileSize: number): HeaderMetadata {
  let audioStart = 0;
  let hasValidId3 = false;

  if (reader.has(0, 10) && reader.ascii(0, 3) === 'ID3') {
    const majorVer = reader.u8(3);
    const revVer = reader.u8(4);
    const s0 = reader.u8(6);
    const s1 = reader.u8(7);
    const s2 = reader.u8(8);
    const s3 = reader.u8(9);

    if (
      majorVer > 4 ||
      revVer === 0xff ||
      (s0 & 0x80) !== 0 ||
      (s1 & 0x80) !== 0 ||
      (s2 & 0x80) !== 0 ||
      (s3 & 0x80) !== 0
    ) {
      throw new SecurityValidationError(
        'MALFORMED_MP3',
        'Rejected: malformed ID3v2 header or invalid synchsafe tag size.',
      );
    }

    const tagSize = (s0 << 21) | (s1 << 14) | (s2 << 7) | s3;
    const footerSize = (reader.u8(5) & 0x10) !== 0 ? 10 : 0;
    audioStart = 10 + tagSize + footerSize;

    if (audioStart >= fileSize) {
      throw new SecurityValidationError(
        'INVALID_SIZE',
        'Rejected: ID3v2 header length exceeds actual file size.',
      );
    }
    hasValidId3 = true;
  }

  let frame: ParsedMpegFrame | null = null;
  const scanLimit = Math.min(reader.length - 4, audioStart + 4096);
  for (let pos = audioStart; pos <= scanLimit; pos++) {
    const candidate = tryParseMpegFrameHeader(reader, pos);
    if (candidate) {
      // If next frame lies inside our slice, confirm second sync to prevent false-positive sync matches
      if (reader.has(pos + candidate.frameLength, 4)) {
        const nextFrame = tryParseMpegFrameHeader(
          reader,
          pos + candidate.frameLength,
        );
        if (!nextFrame) continue;
      }
      frame = candidate;
      break;
    }
  }

  if (!frame && !hasValidId3) {
    throw new SecurityValidationError(
      'MALFORMED_MP3',
      'Rejected: no valid ID3 tag or MPEG audio frame sync header found.',
    );
  }

  // If ID3v2 tag is larger than the 64 KB header slice (e.g., large embedded cover art),
  // we still validated ID3v2 synchsafe bounds; estimate conservative defaults until decodeAudioData returns exact rate.
  const sampleRate = frame?.sampleRate ?? 44100;
  const channels = frame?.channels ?? 2;
  const bitrateBps = frame ? frame.bitrateKbps * 1000 : 192000;
  const audioPayloadBytes = Math.max(1, fileSize - audioStart);
  const estimatedDuration = (audioPayloadBytes * 8) / bitrateBps;

  return {
    container: 'MP3',
    codecHint: frame ? `MP3 (${frame.versionLabel} Layer III)` : 'MP3 Audio',
    isLossyContainer: true,
    sampleRate,
    bitDepth: null,
    channels,
    totalSamples: null,
    duration: estimatedDuration,
    bitrate: bitrateBps,
    md5Hash: null,
  };
}

function parseM4aSafe(reader: SafeReader, fileSize: number): HeaderMetadata {
  if (!reader.has(0, 16)) {
    throw new SecurityValidationError('MALFORMED_MP4', 'Rejected: truncated ISO BMFF header.');
  }
  const ftypSize = reader.u32be(0);
  const ftypType = reader.ascii(4, 4);
  if (ftypType !== 'ftyp' || ftypSize < 16 || ftypSize > fileSize || !reader.has(0, Math.min(ftypSize, reader.length))) {
    throw new SecurityValidationError(
      'MALFORMED_MP4',
      'Rejected: invalid ISO BMFF ftyp box size or structure.',
    );
  }

  const majorBrand = reader.ascii(8, 4);
  const compatibleBrands: string[] = [majorBrand];
  const brandsEnd = Math.min(ftypSize, reader.length);
  for (let off = 16; off + 4 <= brandsEnd && compatibleBrands.length < 32; off += 4) {
    compatibleBrands.push(reader.ascii(off, 4));
  }

  if (REJECTED_MP4_VIDEO_ONLY_BRANDS.has(majorBrand)) {
    throw new SecurityValidationError(
      'POLYGLOT_BLOCKED',
      `Rejected: ISO BMFF brand "${majorBrand.trim()}" is not a supported audio container.`,
    );
  }

  const hasAudioBrand = compatibleBrands.some((b) =>
    ALLOWED_MP4_AUDIO_BRANDS.has(b),
  );
  if (!hasAudioBrand) {
    throw new SecurityValidationError(
      'UNSUPPORTED_BRAND',
      `Rejected: MP4 major/compatible brands (${compatibleBrands.map((b) => b.trim()).join(', ')}) are not in the allowed audio brand list.`,
    );
  }

  // Walk top-level boxes inside the header slice with strict 128-box limit
  let cursor = ftypSize;
  let boxes = 1;
  let detectedAlac = false;
  let detectedSampleRate = 44100;
  let detectedChannels = 2;
  let detectedBitDepth: number | null = null;
  let detectedDuration = 0;

  while (reader.has(cursor, 8)) {
    if (boxes >= SECURITY_LIMITS.MAX_CONTAINER_BLOCKS) {
      throw new SecurityValidationError(
        'TOO_MANY_BLOCKS',
        'Rejected: ISO BMFF atom count exceeds safety limit (128).',
      );
    }
    const size = reader.u32be(cursor);
    const type = reader.ascii(cursor + 4, 4);

    if (size === 0) {
      // Box extends to EOF (allowed for final box only)
      break;
    }
    if (size < 8 && size !== 1) {
      throw new SecurityValidationError(
        'MALFORMED_MP4',
        `Rejected: invalid MP4 atom "${type}" with size ${size}.`,
      );
    }
    if (size !== 1 && cursor + size > fileSize) {
      throw new SecurityValidationError(
        'INVALID_SIZE',
        `Rejected: MP4 atom "${type}" extends past EOF.`,
      );
    }

    if (type === 'moov') {
      // Bounded scan within header slice for 'alac', 'mvhd', or 'mp4a' markers
      const moovEnd = Math.min(reader.length, cursor + (size === 1 ? reader.length - cursor : size));
      const scanBytes = reader.sliceBytes(cursor, moovEnd - cursor);
      for (let i = 0; i + 4 <= scanBytes.length; i++) {
        if (
          scanBytes[i] === 0x61 && // 'a'
          scanBytes[i + 1] === 0x6c && // 'l'
          scanBytes[i + 2] === 0x61 && // 'a'
          scanBytes[i + 3] === 0x63 // 'c'
        ) {
          detectedAlac = true;
          // Standard ALAC magic cookie (after 4-byte size + 'alac' + 4-byte version/flags):
          // sampleSize at +9 (byte), channels at +13 (byte), sampleRate at +24 (u32be)
          const cookieStart = cursor + i + 8;
          if (reader.has(cookieStart, 24)) {
            const sr = reader.u32be(cookieStart + 20);
            const ch = reader.u8(cookieStart + 9);
            const bd = reader.u8(cookieStart + 5);
            if (sr >= SECURITY_LIMITS.MIN_SAMPLE_RATE && sr <= SECURITY_LIMITS.MAX_SAMPLE_RATE) {
              detectedSampleRate = sr;
            }
            if (ch >= 1 && ch <= 8) detectedChannels = ch;
            if (bd === 16 || bd === 24 || bd === 32) detectedBitDepth = bd;
          }
        } else if (
          scanBytes[i] === 0x6d && // 'm'
          scanBytes[i + 1] === 0x76 && // 'v'
          scanBytes[i + 2] === 0x68 && // 'h'
          scanBytes[i + 3] === 0x64 // 'd'
        ) {
          const mvhdStart = cursor + i + 4;
          if (reader.has(mvhdStart, 20)) {
            const version = reader.u8(mvhdStart);
            if (version === 0 && reader.has(mvhdStart, 20)) {
              const timescale = reader.u32be(mvhdStart + 12);
              const dur = reader.u32be(mvhdStart + 16);
              if (timescale > 0 && dur > 0) {
                detectedDuration = dur / timescale;
              }
            }
          }
        }
      }
    }

    if (size === 1) {
      // 64-bit extended size box (typically mdat)
      if (!reader.has(cursor, 16)) break;
      const hi = reader.u32be(cursor + 8);
      const lo = reader.u32be(cursor + 12);
      const extSize = hi * 4294967296 + lo;
      if (extSize < 16 || cursor + extSize > fileSize) {
        throw new SecurityValidationError(
          'INVALID_SIZE',
          'Rejected: MP4 64-bit box size exceeds file bounds.',
        );
      }
      cursor += extSize;
    } else {
      cursor += size;
    }
    boxes++;
  }

  // Fallback duration estimate when moov atom sits at end of file
  const fallbackBitrate = detectedAlac ? 900_000 : 256_000;
  const duration =
    detectedDuration > 0 ? detectedDuration : (fileSize * 8) / fallbackBitrate;
  const bitrate = duration > 0 ? Math.floor((fileSize * 8) / duration) : fallbackBitrate;

  return {
    container: 'M4A',
    codecHint: detectedAlac ? 'ALAC (Apple Lossless)' : 'AAC / M4A Audio',
    isLossyContainer: !detectedAlac,
    sampleRate: detectedSampleRate,
    bitDepth: detectedAlac ? (detectedBitDepth ?? 16) : null,
    channels: detectedChannels,
    totalSamples: null,
    duration,
    bitrate,
    md5Hash: null,
  };
}

function parseOggSafe(reader: SafeReader, fileSize: number): HeaderMetadata {
  if (!reader.has(0, 28)) {
    throw new SecurityValidationError('MALFORMED_OGG', 'Rejected: truncated OggS page header.');
  }
  const version = reader.u8(4);
  if (version !== 0x00) {
    throw new SecurityValidationError(
      'MALFORMED_OGG',
      `Rejected: invalid Ogg stream structure version (${version}).`,
    );
  }
  const pageSegments = reader.u8(26);
  const payloadOffset = 27 + pageSegments;
  if (!reader.has(0, payloadOffset + 8)) {
    throw new SecurityValidationError(
      'MALFORMED_OGG',
      'Rejected: Ogg segment table or identification packet is truncated.',
    );
  }

  let sampleRate = 48000;
  let channels = 2;
  let bitDepth: number | null = null;
  let codecHint = 'Ogg Audio';
  let isLossyContainer = true;
  let bitrate = 160_000;

  if (reader.has(payloadOffset, 19) && reader.ascii(payloadOffset, 8) === 'OpusHead') {
    channels = reader.u8(payloadOffset + 9);
    const inputSampleRate = reader.u32le(payloadOffset + 12);
    // Opus decodes natively at 48 kHz
    sampleRate =
      inputSampleRate >= SECURITY_LIMITS.MIN_SAMPLE_RATE &&
      inputSampleRate <= SECURITY_LIMITS.MAX_SAMPLE_RATE
        ? 48000
        : 48000;
    codecHint = 'Opus (Ogg)';
    isLossyContainer = true;
    bitrate = 128_000;
  } else if (
    reader.has(payloadOffset, 30) &&
    reader.u8(payloadOffset) === 0x01 &&
    reader.ascii(payloadOffset + 1, 6) === 'vorbis'
  ) {
    channels = reader.u8(payloadOffset + 11);
    sampleRate = reader.u32le(payloadOffset + 12);
    const nominalBitrate = reader.u32le(payloadOffset + 20);
    if (nominalBitrate > 16_000 && nominalBitrate < 1_000_000) {
      bitrate = nominalBitrate;
    }
    codecHint = 'Ogg Vorbis';
    isLossyContainer = true;
  } else if (
    reader.has(payloadOffset, 5) &&
    reader.u8(payloadOffset) === 0x7f &&
    reader.ascii(payloadOffset + 1, 4) === 'FLAC'
  ) {
    codecHint = 'Ogg FLAC';
    isLossyContainer = false;
    bitDepth = 16;
    bitrate = 900_000;
    // Ogg FLAC wraps native STREAMINFO after 9-byte mapping header + 'fLaC' + 4-byte block header
    const streamInfoStart = payloadOffset + 17;
    if (reader.has(streamInfoStart, 34)) {
      const b10 = reader.u8(streamInfoStart + 10);
      const b11 = reader.u8(streamInfoStart + 11);
      const b12 = reader.u8(streamInfoStart + 12);
      const b13 = reader.u8(streamInfoStart + 13);
      sampleRate = (b10 << 12) | (b11 << 4) | (b12 >>> 4);
      channels = ((b12 >>> 1) & 0x07) + 1;
      bitDepth = (((b12 & 0x01) << 4) | (b13 >>> 4)) + 1;
    }
  } else {
    throw new SecurityValidationError(
      'UNSUPPORTED_OGG',
      'Rejected: Ogg container does not begin with a Vorbis, Opus, or FLAC identification header.',
    );
  }

  const estimatedDuration = (fileSize * 8) / bitrate;

  return {
    container: 'OGG',
    codecHint,
    isLossyContainer,
    sampleRate,
    bitDepth,
    channels,
    totalSamples: null,
    duration: estimatedDuration,
    bitrate,
    md5Hash: null,
  };
}

/**
 * Pure, zero-trust validation of an audio header slice before full file ingestion or decoding.
 */
export function validateAudioHeaderBytes(
  headerBytes: Uint8Array,
  fileSize: number,
  rawFilename: string,
): ValidatedAudioHeader {
  const displayName = sanitizeFilename(rawFilename);

  if (fileSize <= 0) {
    throw new SecurityValidationError(
      'EMPTY_FILE',
      'Rejected: zero-byte file contains no audio data.',
    );
  }
  if (fileSize > SECURITY_LIMITS.MAX_FILE_SIZE_BYTES) {
    const mb = (fileSize / (1024 * 1024)).toFixed(1);
    throw new SecurityValidationError(
      'FILE_TOO_LARGE',
      `Rejected: file size (${mb} MB) exceeds the 350 MB security limit.`,
    );
  }

  const reader = new SafeReader(headerBytes);
  assertNotDisguisedPolyglot(reader);

  let metadata: HeaderMetadata;
  let requireDuration = true;

  const sig4 = reader.ascii(0, 4);
  if (sig4 === 'fLaC') {
    metadata = parseFlacSafe(reader, fileSize);
    requireDuration = metadata.totalSamples !== null;
  } else if (sig4 === 'RIFF') {
    metadata = parseWavSafe(reader, fileSize);
  } else if (sig4 === 'FORM') {
    metadata = parseAiffSafe(reader, fileSize);
  } else if (sig4 === 'OggS') {
    metadata = parseOggSafe(reader, fileSize);
    requireDuration = false;
  } else if (reader.has(0, 12) && reader.ascii(4, 4) === 'ftyp') {
    metadata = parseM4aSafe(reader, fileSize);
    requireDuration = false;
  } else if (
    reader.ascii(0, 3) === 'ID3' ||
    tryParseMpegFrameHeader(reader, 0) !== null
  ) {
    metadata = parseMp3Safe(reader, fileSize);
    requireDuration = false;
  } else {
    throw new SecurityValidationError(
      'UNSUPPORTED_SIGNATURE',
      'Rejected: unrecognized binary signature. Only verified FLAC, WAV, AIFF, MP3, M4A, and OGG audio files are accepted.',
    );
  }

  const estimatedPcmBytes = validateMetadataSanity(metadata, requireDuration);

  return {
    displayName,
    container: metadata.container,
    metadata,
    estimatedPcmBytes,
    securityChecks: [
      `Magic bytes verified (${metadata.container})`,
      'Bounds & block limits checked',
      `Decoded RAM estimate safe (${(estimatedPcmBytes / (1024 * 1024)).toFixed(1)} MB / 450 MB cap)`,
    ],
  };
}

/**
 * Validate a browser File by reading ONLY its bounded 64 KB header slice first.
 * Rejects untrusted, disguised, polyglot, or oversized files before touching decodeAudioData.
 */
export async function validateFileBeforeDecode(
  file: File,
): Promise<ValidatedAudioHeader> {
  if (file.size <= 0) {
    throw new SecurityValidationError(
      'EMPTY_FILE',
      'Rejected: zero-byte file contains no audio data.',
    );
  }
  if (file.size > SECURITY_LIMITS.MAX_FILE_SIZE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    throw new SecurityValidationError(
      'FILE_TOO_LARGE',
      `Rejected: file size (${mb} MB) exceeds the 350 MB per-file limit.`,
    );
  }

  const sliceLen = Math.min(file.size, SECURITY_LIMITS.HEADER_SLICE_BYTES);
  const headerBuf = await file.slice(0, sliceLen).arrayBuffer();
  return validateAudioHeaderBytes(new Uint8Array(headerBuf), file.size, file.name);
}
