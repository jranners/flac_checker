/// <reference lib="webworker" />
import { detectCutoff } from './cutoffDetector'
import { fft, hann } from './fft'
import type { AnalysisResult, AnalyzeWorkerRequest, AnalyzeWorkerResponse } from './types'

const workerScope = self as DedicatedWorkerGlobalScope

function powerSpectrum(samples: Float32Array, sampleRate: number, size: number): Float64Array {
  const fftSize = 2 ** Math.floor(Math.log2(Math.min(size, samples.length)))
  if (fftSize < 2) throw new Error('Die Audiodatei ist für eine Frequenzanalyse zu kurz.')
  size = fftSize
  const window = hann(size)
  const output = new Float64Array(size / 2 + 1)
  let windows = 0
  const hop = size >> 1
  for (let start = 0; start + size <= samples.length; start += hop) {
    const real = new Float64Array(size)
    const imaginary = new Float64Array(size)
    for (let i = 0; i < size; i += 1) real[i] = samples[start + i] * window[i]
    fft(real, imaginary)
    for (let i = 0; i < output.length; i += 1) output[i] += (real[i] ** 2 + imaginary[i] ** 2) / (sampleRate * size)
    windows += 1
  }
  if (!windows) return output
  for (let i = 0; i < output.length; i += 1) output[i] /= windows
  return output
}

function createSpectrogram(samples: Float32Array): { matrix: Float32Array; rows: number; columns: number } {
  const size = 2 ** Math.floor(Math.log2(Math.min(2048, samples.length)))
  if (size < 2) throw new Error('Die Audiodatei ist für ein Spektrogramm zu kurz.')
  const hop = 512
  const rows = size / 2 + 1
  const columns = Math.max(1, Math.floor((samples.length - size) / hop) + 1)
  const window = hann(size)
  const matrix = new Float32Array(rows * columns)
  let maximum = -120
  const raw = new Float32Array(matrix.length)
  for (let column = 0; column < columns; column += 1) {
    const real = new Float64Array(size)
    const imaginary = new Float64Array(size)
    const start = column * hop
    for (let i = 0; i < size; i += 1) real[i] = samples[start + i] * window[i]
    fft(real, imaginary)
    for (let row = 0; row < rows; row += 1) {
      const db = 20 * Math.log10(Math.max(Math.hypot(real[row], imaginary[row]) / size, 1e-8))
      raw[row * columns + column] = db
      maximum = Math.max(maximum, db)
    }
  }
  for (let i = 0; i < raw.length; i += 1) matrix[i] = Math.max(0, Math.min(1, (raw[i] - (maximum - 80)) / 80))
  return { matrix, rows, columns }
}

workerScope.onmessage = (event: MessageEvent<AnalyzeWorkerRequest>) => {
  if (event.data.type !== 'analyze') return
  try {
    const { segments, metadata, sampleRate } = event.data
    if (!segments.length) throw new Error('Keine Audiodaten für die Analyse vorhanden.')
    const segmentSpectra = segments.map(({ samples }) => powerSpectrum(samples, sampleRate, 16384))
    const length = segmentSpectra[0].length
    const average = new Float64Array(length)
    for (const spectrum of segmentSpectra) {
      for (let i = 0; i < length; i += 1) average[i] += spectrum[i] / segmentSpectra.length
    }
    const detection = detectCutoff(average, sampleRate)
    const selected = segments[Math.floor(segments.length / 2)]
    const spectrogram = createSpectrogram(selected.samples)
    const result: AnalysisResult = {
      ...detection,
      cutoffKhz: detection.cutoffHz === null ? null : detection.cutoffHz / 1000,
      metadata,
      spectrogram: spectrogram.matrix,
      frequencyBins: spectrogram.rows,
      timeBins: spectrogram.columns,
      nyquist: sampleRate / 2,
      segmentDuration: selected.samples.length / sampleRate,
    }
    const response: AnalyzeWorkerResponse = { result }
    workerScope.postMessage(response, [result.spectrogram.buffer])
  } catch (error) {
    workerScope.postMessage({ error: error instanceof Error ? error.message : 'Analyse fehlgeschlagen.' } satisfies AnalyzeWorkerResponse)
  }
}
