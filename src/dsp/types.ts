export type Verdict =
  | 'GENUINE_LOSSLESS'
  | 'UPSAMPLED_LOSSLESS'
  | 'INCONCLUSIVE'
  | 'FAKE_TRANSCODE'
  | 'LOSSY_FORMAT';

export type ForensicImpact = 'positive' | 'negative' | 'neutral';

export interface ForensicFactor {
  id: string;
  signal: string;
  measuredValue: string;
  detail: string;
  impact: ForensicImpact;
  weight: number;
}

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
  naturalSlopeDbPerKhz: number;
  excessResidualDb: number;
  cliffSlopeDbPerKhz: number;
  frameCutoffMedianKhz: number | null;
  cutoffIQRHz: number | null;
  deadZoneFloorDb: number;
  aboveCutoffStdDb: number;
  ditherDetected: boolean;
  ditherNote: string;
  referenceBand8To13KhzDb: number;
  coreBand1To5KhzDb: number;
  spectralHolePercent: number;
  broadBandZeroingPercent: number;
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
  evidenceScore: number;
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
  expectedDb: Float32Array;
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
  evidenceFactors: ForensicFactor[];
  securityChecks: string[];
  spectrogram: SpectrogramData;
  psdCurve: PsdCurveData;
}

export type QueueItemState =
  | 'queued'
  | 'validating'
  | 'analyzing'
  | 'done'
  | 'rejected'
  | 'error';

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
  dotClass: string;
  textClass: string;
}

export const VERDICT_META: Record<Verdict, VerdictDisplayMeta> = {
  GENUINE_LOSSLESS: {
    title: 'Genuine Lossless',
    shortLabel: 'Genuine',
    accentHex: '#22C55E',
    dotClass: 'bg-emerald-500',
    textClass: 'text-emerald-600 dark:text-emerald-400',
  },
  UPSAMPLED_LOSSLESS: {
    title: 'Upsampled Lossless',
    shortLabel: 'Upsampled',
    accentHex: '#0EA5E9',
    dotClass: 'bg-sky-500',
    textClass: 'text-sky-600 dark:text-sky-400',
  },
  INCONCLUSIVE: {
    title: 'Inconclusive',
    shortLabel: 'Inconclusive',
    accentHex: '#F59E0B',
    dotClass: 'bg-amber-500',
    textClass: 'text-amber-600 dark:text-amber-400',
  },
  FAKE_TRANSCODE: {
    title: 'Fake Transcode',
    shortLabel: 'Transcode',
    accentHex: '#EF4444',
    dotClass: 'bg-red-500',
    textClass: 'text-red-600 dark:text-red-400',
  },
  LOSSY_FORMAT: {
    title: 'Lossy Format',
    shortLabel: 'Lossy',
    accentHex: '#71717A',
    dotClass: 'bg-zinc-500',
    textClass: 'text-zinc-600 dark:text-zinc-400',
  },
};
