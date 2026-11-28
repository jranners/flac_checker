import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECURITY_LIMITS,
  SecurityValidationError,
  estimateDecodedPcmBytes,
  validateAudioHeaderBytes,
} from './fileValidator';
import { sanitizeCsvCell, sanitizeFilename } from './sanitize';

function buildMinimalFlacHeader(opts?: {
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
  totalSamples?: number;
  minBlockSize?: number;
  md5Fill?: number;
}): Uint8Array {
  const sr = opts?.sampleRate ?? 44100;
  const ch = opts?.channels ?? 2;
  const bd = opts?.bitDepth ?? 16;
  const totalSamples = opts?.totalSamples ?? 44100 * 10;
  const minBlock = opts?.minBlockSize ?? 4096;
  const buf = new Uint8Array(64);
  const view = new DataView(buf.buffer);

  // "fLaC"
  buf.set([0x66, 0x4c, 0x61, 0x43], 0);
  // Last metadata block (0x80) | STREAMINFO (0), length 34
  buf[4] = 0x80;
  buf[5] = 0x00;
  buf[6] = 0x00;
  buf[7] = 34;

  const off = 8;
  view.setUint16(off, minBlock, false);
  view.setUint16(off + 2, 4096, false);

  // Pack 20-bit sampleRate, 3-bit (ch-1), 5-bit (bd-1), 36-bit totalSamples
  buf[off + 10] = (sr >>> 12) & 0xff;
  buf[off + 11] = (sr >>> 4) & 0xff;
  buf[off + 12] =
    ((sr & 0x0f) << 4) | (((ch - 1) & 0x07) << 1) | (((bd - 1) >>> 4) & 0x01);
  const highSamples = Math.floor(totalSamples / 4294967296) & 0x0f;
  const lowSamples = totalSamples >>> 0;
  buf[off + 13] = (((bd - 1) & 0x0f) << 4) | highSamples;
  view.setUint32(off + 14, lowSamples, false);

  buf.fill(opts?.md5Fill ?? 0xab, off + 18, off + 34);
  return buf;
}

function buildMinimalWavHeader(opts?: {
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
  dataBytes?: number;
}): { bytes: Uint8Array; fileSize: number } {
  const sr = opts?.sampleRate ?? 44100;
  const ch = opts?.channels ?? 2;
  const bd = opts?.bitDepth ?? 16;
  const dataBytes = opts?.dataBytes ?? sr * ch * (bd / 8) * 5;
  const fileSize = 44 + dataBytes;

  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  view.setUint32(4, fileSize - 8, true);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  bytes.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, ch, true);
  view.setUint32(24, sr, true);
  const blockAlign = ch * (bd / 8);
  view.setUint32(28, sr * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bd, true);
  bytes.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, dataBytes, true);
  return { bytes, fileSize };
}

test('accepts valid FLAC STREAMINFO header and extracts exact metadata + MD5', () => {
  const flac = buildMinimalFlacHeader({
    sampleRate: 44100,
    channels: 2,
    bitDepth: 16,
    totalSamples: 44100 * 12,
    md5Fill: 0x0f,
  });
  const res = validateAudioHeaderBytes(flac, 1_500_000, 'master.flac');
  assert.equal(res.container, 'FLAC');
  assert.equal(res.metadata.sampleRate, 44100);
  assert.equal(res.metadata.channels, 2);
  assert.equal(res.metadata.bitDepth, 16);
  assert.equal(res.metadata.duration, 12);
  assert.equal(res.metadata.md5Hash, '0f'.repeat(16));
  assert.equal(res.metadata.isLossyContainer, false);
});

test('accepts valid WAV RIFF/WAVE header with fmt and data chunks', () => {
  const { bytes, fileSize } = buildMinimalWavHeader({
    sampleRate: 48000,
    channels: 2,
    bitDepth: 24,
  });
  const res = validateAudioHeaderBytes(bytes, fileSize, 'studio_24bit.wav');
  assert.equal(res.container, 'WAV');
  assert.equal(res.metadata.sampleRate, 48000);
  assert.equal(res.metadata.bitDepth, 24);
  assert.equal(res.metadata.rawPcmDataOffset, 44);
});

test('rejects disguised HTML, SVG, ZIP, ELF, PE, and PDF polyglots renamed to .flac', () => {
  const payloads: Array<[string, Uint8Array]> = [
    ['html', new TextEncoder().encode('<!DOCTYPE html><html><script>alert(1)</script></html>')],
    ['svg', new TextEncoder().encode('  <svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0])],
    ['elf', new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0])],
    ['pe', new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0, 0, 0, 0, 0, 0, 0])],
    ['pdf', new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n')],
  ];

  for (const [label, bytes] of payloads) {
    assert.throws(
      () => validateAudioHeaderBytes(bytes, bytes.length, `${label}.flac`),
      (err: unknown) =>
        err instanceof SecurityValidationError && err.code === 'POLYGLOT_BLOCKED',
      `Expected ${label} payload to be rejected as polyglot`,
    );
  }
});

test('rejects malformed FLAC minBlockSize < 16 and pre-decode PCM memory bombs (> 450 MB)', () => {
  const badBlock = buildMinimalFlacHeader({ minBlockSize: 8 });
  assert.throws(
    () => validateAudioHeaderBytes(badBlock, 100_000, 'tiny_block.flac'),
    (err: unknown) => err instanceof SecurityValidationError && err.code === 'MALFORMED_FLAC',
  );

  // 192 kHz * 8 channels * 120 seconds * 4 bytes = ~737 MB > 450 MB memory cap
  const bombFlac = buildMinimalFlacHeader({
    sampleRate: 192000,
    channels: 8,
    bitDepth: 24,
    totalSamples: 192000 * 120,
  });
  assert.ok(
    estimateDecodedPcmBytes(192000, 8, 120) > SECURITY_LIMITS.MAX_ESTIMATED_PCM_BYTES,
  );
  assert.throws(
    () => validateAudioHeaderBytes(bombFlac, 20_000_000, 'ram_bomb.flac'),
    (err: unknown) => err instanceof SecurityValidationError && err.code === 'MEMORY_BOMB',
  );
});

test('rejects zero-byte and oversized (> 350 MB) files', () => {
  const valid = buildMinimalFlacHeader();
  assert.throws(
    () => validateAudioHeaderBytes(valid, 0, 'empty.flac'),
    (err: unknown) => err instanceof SecurityValidationError && err.code === 'EMPTY_FILE',
  );
  assert.throws(
    () =>
      validateAudioHeaderBytes(
        valid,
        SECURITY_LIMITS.MAX_FILE_SIZE_BYTES + 1,
        'huge.flac',
      ),
    (err: unknown) => err instanceof SecurityValidationError && err.code === 'FILE_TOO_LARGE',
  );
});

test('validates OGG Opus and M4A ftyp audio containers and rejects video-only MP4 brands', () => {
  // OggS + OpusHead
  const ogg = new Uint8Array(64);
  ogg.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
  ogg[4] = 0x00; // version
  ogg[26] = 1; // 1 segment
  ogg[27] = 19; // segment size
  ogg.set(new TextEncoder().encode('OpusHead'), 28);
  ogg[37] = 2; // stereo
  const oggRes = validateAudioHeaderBytes(ogg, 200_000, 'podcast.opus');
  assert.equal(oggRes.container, 'OGG');
  assert.equal(oggRes.metadata.isLossyContainer, true);

  // M4A valid ftyp
  const m4a = new Uint8Array(32);
  const view = new DataView(m4a.buffer);
  view.setUint32(0, 24, false);
  m4a.set(new TextEncoder().encode('ftypM4A '), 4);
  m4a.set(new TextEncoder().encode('isomM4A '), 16);
  const m4aRes = validateAudioHeaderBytes(m4a, 400_000, 'track.m4a');
  assert.equal(m4aRes.container, 'M4A');

  // Disguised HEIC image inside ISO BMFF ftyp
  const heic = new Uint8Array(32);
  new DataView(heic.buffer).setUint32(0, 24, false);
  heic.set(new TextEncoder().encode('ftypheic'), 4);
  assert.throws(
    () => validateAudioHeaderBytes(heic, 400_000, 'photo.m4a'),
    (err: unknown) => err instanceof SecurityValidationError && err.code === 'POLYGLOT_BLOCKED',
  );
});

test('sanitizeFilename strips BiDi override spoofing and ASCII control chars', () => {
  const spoofed = 'track_\u202Egpj.flac\u0007\n';
  const safe = sanitizeFilename(spoofed);
  assert.equal(safe, 'track_gpj.flac');
  assert.ok(!safe.includes('\u202E'));

  const longName = `${'a'.repeat(160)}.flac`;
  const clamped = sanitizeFilename(longName, 64);
  assert.ok(clamped.length <= 64);
  assert.ok(clamped.endsWith('.flac'));
});

test('sanitizeCsvCell neutralizes CWE-1236 formula injection payloads', () => {
  assert.equal(sanitizeCsvCell('=CMD("calc")'), '"\'=CMD(""calc"")"');
  assert.equal(sanitizeCsvCell('+1+2'), '"\'+1+2"');
  assert.equal(sanitizeCsvCell('-SUM(A1:A5)'), '"\'-SUM(A1:A5)"');
  assert.equal(sanitizeCsvCell('@HYPERLINK("http://evil")'), '"\'@HYPERLINK(""http://evil"")"');
  assert.equal(sanitizeCsvCell('\t=1+1'), '"\'\t=1+1"');
  assert.equal(sanitizeCsvCell('Normal Track.flac'), '"Normal Track.flac"');
});
