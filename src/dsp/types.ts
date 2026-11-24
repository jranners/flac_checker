export type Verdict = 'GENUINE_LOSSLESS' | 'SUSPICIOUS' | 'FAKE_TRANSCODE'

export interface AudioMetadata {
  format: string
  sampleRate: number
  bitDepth: number | null
  channels: number
  duration: number
  totalSamples: number | null
  md5: string | null
  fileBitrate: number
}

export interface AnalysisResult {
  verdict: Verdict
  confidence: number
  cutoffKhz: number | null
  estimatedSourceBitrate: number | null
  explanation: string
  metadata: AudioMetadata
  spectrogram: Float32Array
  frequencyBins: number
  timeBins: number
  nyquist: number
  segmentDuration: number
}

export interface AudioSegment {
  samples: Float32Array
  startSeconds: number
}

export interface AnalyzeWorkerRequest {
  type: 'analyze'
  sampleRate: number
  segments: AudioSegment[]
  metadata: AudioMetadata
}

export interface AnalyzeWorkerResponse {
  result?: AnalysisResult
  error?: string
}
