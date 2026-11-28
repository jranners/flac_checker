export type Verdict =
  | 'GENUINE_LOSSLESS'
  | 'UPSAMPLED_LOSSLESS'
  | 'SUSPICIOUS'
  | 'FAKE_TRANSCODE'
  | 'LOSSY_FORMAT';

export type AudioContainerFormat = 'FLAC' | 'WAV' | 'AIFF' | 'MP3' | 'M4A' | 'OGG';

export interface HeaderMetadata {
  container: AudioContainerFormat;
  codecHint: string;
  isLossyContainer: boolean;
  sampleRate: number;
  bitDepth: number | null;
  channels: number;
  totalSamples: number | null;
  duration: number;
  bitrate: number;
  md5Hash: string | null;
  rawPcmDataOffset?: number;
  rawPcmDataSize?: number;
  isFake24Bit?: boolean;
  trueBitDepthNote?: string | null;
}

export interface ForensicMetrics {
  cliffSlopeDbPerKhz: number;
  deadZoneFloorDb: number;
  temporalVarianceDropDb: number;
  aboveCutoffStdDb: number;
  referenceBand8To13KhzDb: number;
  coreBand1To5KhzDb: number;
  spectralHolePercent: number;
  shelf16KhzDropDb: number;
  has16KhzShelf: boolean;
  hfStereoCollapseDb: number | null;
  trueBitDepthNote: string | null;
  isFake24Bit: boolean;
  browserResampled: boolean;
  decodedSampleRate: number;
  effectiveSampleRate: number;
  effectiveNyquist: number;
  analyzedSegments: number;
  analyzedDurationSec: number;
  fftSize: number;
}

export interface SpectrogramData {
  frequenciesKhz: Float32Array;
  timesSec: Float32Array;
  dbMatrix: Float32Array;
  nFreq: number;
  nTime: number;
  maxDb: number;
  minDb: number;
}

export interface PsdCurveData {
  frequenciesKhz: Float32Array;
  meanDb: Float32Array;
  medianDb: Float32Array;
  p95Db: Float32Array;
}

export interface AnalysisResult {
  verdict: Verdict;
  subLabel: string | null;
  confidence: number;
  cutoffKhz: number | null;
  estimatedSource: string;
  reasoning: string;
  metadata: HeaderMetadata;
  metrics: ForensicMetrics;
  securityChecks: string[];
  spectrogram: SpectrogramData;
  psdCurve: PsdCurveData;
}

export type QueueItemState = 'queued' | 'validating' | 'analyzing' | 'done' | 'rejected' | 'error';

export interface QueueItem {
  id: string;
  displayName: string;
  fileSize: number;
  state: QueueItemState;
  stageLabel?: string;
  result?: AnalysisResult;
  error?: string;
  securityChecks?: string[];
}

export interface VerdictDisplayMeta {
  title: string;
  shortLabel: string;
  accentHex: string;
  badgeClass: string;
  dotClass: string;
}

export const VERDICT_META: Record<Verdict, VerdictDisplayMeta> = {
  GENUINE_LOSSLESS: {
    title: 'Genuine Lossless',
    shortLabel: 'Genuine',
    accentHex: '#30D158',
    badgeClass:
      'bg-[#30D158]/14 text-[#1E8E3E] dark:text-[#30D158] border border-[#30D158]/25',
    dotClass: 'bg-[#30D158]',
  },
  UPSAMPLED_LOSSLESS: {
    title: 'Upsampled Lossless',
    shortLabel: 'Upsampled',
    accentHex: '#0A84FF',
    badgeClass:
      'bg-[#0A84FF]/14 text-[#0066CC] dark:text-[#64D2FF] border border-[#0A84FF]/25',
    dotClass: 'bg-[#0A84FF] dark:bg-[#64D2FF]',
  },
  SUSPICIOUS: {
    title: 'Suspicious',
    shortLabel: 'Suspicious',
    accentHex: '#FF9F0A',
    badgeClass:
      'bg-[#FF9F0A]/15 text-[#B26A00] dark:text-[#FF9F0A] border border-[#FF9F0A]/25',
    dotClass: 'bg-[#FF9F0A]',
  },
  FAKE_TRANSCODE: {
    title: 'Fake Transcode',
    shortLabel: 'Transcode',
    accentHex: '#FF453A',
    badgeClass:
      'bg-[#FF453A]/14 text-[#C92A22] dark:text-[#FF453A] border border-[#FF453A]/25',
    dotClass: 'bg-[#FF453A]',
  },
  LOSSY_FORMAT: {
    title: 'Lossy Format',
    shortLabel: 'Lossy',
    accentHex: '#8E8E93',
    badgeClass:
      'bg-[#8E8E93]/16 text-[#55555B] dark:text-[#AEAEB2] border border-[#8E8E93]/25',
    dotClass: 'bg-[#8E8E93]',
  },
};
