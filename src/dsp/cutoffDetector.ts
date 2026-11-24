import type { Verdict } from './types'

export interface CutoffDetection {
  verdict: Verdict
  confidence: number
  cutoffHz: number | null
  estimatedSourceBitrate: number | null
  explanation: string
}

const median = (values: number[]): number => {
  if (!values.length) return -120
  values.sort((a, b) => a - b)
  return values[Math.floor(values.length / 2)]
}

export function detectCutoff(power: Float64Array, sampleRate: number): CutoffDetection {
  const nyquist = sampleRate / 2
  const binHz = sampleRate / ((power.length - 1) * 2)
  const db = Array.from(power, (value) => 10 * Math.log10(Math.max(value, 1e-20)))
  const smoothed = db.map((_, index) =>
    median(db.slice(Math.max(0, index - 2), Math.min(db.length, index + 3))),
  )
  const candidates = [
    { hz: 16000, bitrate: 128 },
    { hz: 18500, bitrate: 224 },
    { hz: 20200, bitrate: 320 },
  ]
  let strongest: { drop: number; hz: number; bitrate: number; level: number } | null = null
  for (const candidate of candidates) {
    if (candidate.hz >= nyquist - 1500) continue
    const before = smoothed.filter((_, index) => {
      const hz = index * binHz
      return hz >= candidate.hz - 1000 && hz <= candidate.hz - 250
    })
    const after = smoothed.filter((_, index) => {
      const hz = index * binHz
      return hz >= candidate.hz + 250 && hz <= Math.min(candidate.hz + 1300, nyquist - 100)
    })
    if (before.length < 4 || after.length < 4) continue
    const beforeLevel = median(before)
    const drop = beforeLevel - median(after)
    if (beforeLevel < -65 || drop < 17) continue
    if (!strongest || drop > strongest.drop) strongest = { drop, hz: candidate.hz, bitrate: candidate.bitrate, level: beforeLevel }
  }
  if (strongest) {
    const confidence = Math.max(68, Math.min(98, Math.round(68 + (strongest.drop - 17) * 1.4)))
    const severeCutoff = strongest.hz < 20000
    return {
      verdict: severeCutoff ? 'FAKE_TRANSCODE' : 'SUSPICIOUS',
      confidence,
      cutoffHz: strongest.hz,
      estimatedSourceBitrate: strongest.bitrate,
      explanation: `Ein abrupter spektraler Abfall bei etwa ${(strongest.hz / 1000).toFixed(1)} kHz ist mit einem verlustbehafteten Encoder-Filter um ${strongest.bitrate} kbps vereinbar.`,
    }
  }

  const start = Math.max(0, Math.ceil(Math.min(18000, sampleRate * 0.4) / binHz))
  const end = Math.min(power.length, Math.floor((nyquist * 0.98) / binHz))
  const peak = Math.max(...power)
  const topBand = end > start ? power.slice(start, end) : new Float64Array()
  const highBandDb = topBand.length
    ? 10 * Math.log10(Math.max(topBand.reduce((sum, value) => sum + value, 0) / topBand.length / Math.max(peak, 1e-20), 1e-20))
    : -120
  if (highBandDb < -58) {
    return {
      verdict: 'SUSPICIOUS',
      confidence: 55,
      cutoffHz: null,
      estimatedSourceBitrate: null,
      explanation: 'Im oberen Frequenzbereich ist wenig Energie vorhanden. Das kann am Audiomaterial liegen; bitte das Spektrogramm manuell prüfen.',
    }
  }
  return {
    verdict: 'GENUINE_LOSSLESS',
    confidence: 82,
    cutoffHz: null,
    estimatedSourceBitrate: null,
    explanation: 'Es wurde kein typischer harter Lossy-Encoder-Cutoff gefunden. Die Analyse ist eine spektrale Heuristik und kein Herkunftsnachweis.',
  }
}
