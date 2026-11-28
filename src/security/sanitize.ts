import type { QueueItem } from '../dsp/types';

/**
 * Strip ASCII control characters, Unicode BiDi override/isolate spoofing chars,
 * and path traversal prefixes, clamping display length while preserving extension.
 */
export function sanitizeFilename(rawName: string, maxLength = 120): string {
  // Remove path directory components if someone crafts a weird name
  const base = rawName.split(/[\\/]/).pop() ?? rawName;

  // Strip ASCII control characters (0x00-0x1F, 0x7F) and Unicode BiDi controls:
  // U+061C, U+200E, U+200F, U+202A..U+202E (LRE/RLE/PDF/LRO/RLO), U+2066..U+2069 (LRI/RLI/FSI/PDI)
  const cleaned = base
    .replace(/[\u0000-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return 'unnamed-audio';
  }

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  const lastDot = cleaned.lastIndexOf('.');
  if (lastDot > 0 && cleaned.length - lastDot <= 12) {
    const ext = cleaned.slice(lastDot);
    const keep = Math.max(1, maxLength - ext.length - 1);
    return `${cleaned.slice(0, keep)}…${ext}`;
  }

  return `${cleaned.slice(0, Math.max(1, maxLength - 1))}…`;
}

/**
 * Neutralize CSV formula injection (CWE-1236) and apply RFC-4180 quoting.
 * Any value starting with =, +, -, @, tab, or carriage return (including after leading spaces)
 * is prefixed with a single quote inside quoted CSV fields.
 */
export function sanitizeCsvCell(
  value: string | number | boolean | null | undefined,
): string {
  if (value === null || value === undefined) {
    return '""';
  }

  let str = String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');

  const trimmedLead = str.replace(/^ +/, '');
  if (/^[=+\-@\t\r]/.test(str) || /^[=+\-@]/.test(trimmedLead)) {
    str = `'${str}`;
  }

  const escaped = str.replace(/"/g, '""');
  return `"${escaped}"`;
}

export function exportQueueToCsv(items: QueueItem[]): string {
  const headers = [
    'Filename',
    'Status',
    'Verdict',
    'Sub-Label',
    'Confidence (%)',
    'Cutoff (kHz)',
    'Estimated Source',
    'Container',
    'Codec',
    'Sample Rate (Hz)',
    'Effective Sample Rate (Hz)',
    'Bit Depth',
    'Channels',
    'Duration (s)',
    'File Size (bytes)',
    'FLAC MD5',
    'Cliff Slope (dB/kHz)',
    'Dead-Zone Floor (dBFS)',
    'Spectral Holes (%)',
    '16 kHz Shelf Drop (dB)',
    'HF Stereo Collapse (dB)',
    'Reasoning / Rejection Reason',
  ];

  const rows: string[] = [headers.map((h) => sanitizeCsvCell(h)).join(',')];

  for (const item of items) {
    if (item.state === 'done' && item.result) {
      const r = item.result;
      const m = r.metadata;
      const f = r.metrics;
      rows.push(
        [
          item.displayName,
          'Analyzed',
          r.verdict,
          r.subLabel ?? '',
          r.confidence,
          r.cutoffKhz !== null ? r.cutoffKhz.toFixed(2) : '',
          r.estimatedSource,
          m.container,
          m.codecHint,
          m.sampleRate,
          f.effectiveSampleRate,
          m.bitDepth ?? '',
          m.channels,
          m.duration.toFixed(2),
          item.fileSize,
          m.md5Hash ?? '',
          f.cliffSlopeDbPerKhz.toFixed(2),
          f.deadZoneFloorDb.toFixed(1),
          f.spectralHolePercent.toFixed(2),
          f.shelf16KhzDropDb.toFixed(2),
          f.hfStereoCollapseDb !== null ? f.hfStereoCollapseDb.toFixed(2) : '',
          r.reasoning,
        ]
          .map((cell) => sanitizeCsvCell(cell))
          .join(','),
      );
    } else if (item.state === 'rejected' || item.state === 'error') {
      rows.push(
        [
          item.displayName,
          item.state === 'rejected' ? 'Rejected (Security)' : 'Error',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          item.fileSize,
          '',
          '',
          '',
          '',
          '',
          '',
          item.error ?? 'Unknown error',
        ]
          .map((cell) => sanitizeCsvCell(cell))
          .join(','),
      );
    }
  }

  return rows.join('\r\n');
}
