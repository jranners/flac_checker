import { parseHeader } from './headerParser'
import type { AnalysisResult, AudioMetadata, AudioSegment, AnalyzeWorkerRequest, AnalyzeWorkerResponse } from './types'

export const SUPPORTED_AUDIO = ['flac', 'wav', 'wave', 'aiff', 'aif', 'mp3', 'm4a', 'ogg']

function getSegments(samples: Float32Array, sampleRate: number): AudioSegment[] {
  if (!samples.length) throw new Error('Die Datei enthält keine dekodierbaren Audiodaten.')
  const segmentLength = Math.min(samples.length, sampleRate * 10)
  const maxStart = samples.length - segmentLength
  const starts = maxStart === 0 ? [0] : [...new Set([0.2, 0.5, 0.8].map((fraction) => Math.floor(maxStart * fraction)))]
  return starts.map((start) => ({ samples: samples.slice(start, start + segmentLength), startSeconds: start / sampleRate }))
}

function metadataFromDecode(metadata: AudioMetadata, sampleRate: number, channels: number, duration: number): AudioMetadata {
  return {
    ...metadata,
    sampleRate: metadata.sampleRate || sampleRate,
    channels: metadata.channels || channels,
    duration: metadata.duration || duration,
    totalSamples: metadata.totalSamples ?? Math.round(duration * sampleRate),
  }
}

export async function analyzeFile(file: File): Promise<AnalysisResult> {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!SUPPORTED_AUDIO.includes(extension)) throw new Error('Nicht unterstütztes Format. Erlaubt sind FLAC, WAV, AIFF, MP3, M4A und OGG.')
  let metadata = await parseHeader(file)
  const bytes = await file.arrayBuffer()
  const targetRate = Math.max(8000, Math.min(metadata.sampleRate || 44100, 96000))
  const audioContext = new AudioContext({ sampleRate: targetRate })
  try {
    const decoded = await audioContext.decodeAudioData(bytes)
    metadata = metadataFromDecode(metadata, decoded.sampleRate, decoded.numberOfChannels, decoded.duration)
    if (!metadata.bitDepth) metadata.bitDepth = null
    const mono = new Float32Array(decoded.length)
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const channelData = decoded.getChannelData(channel)
      for (let index = 0; index < mono.length; index += 1) mono[index] += channelData[index] / decoded.numberOfChannels
    }
    const samples = getSegments(mono, decoded.sampleRate)
    const worker = new Worker(new URL('./analyzer.worker.ts', import.meta.url), { type: 'module' })
    const request: AnalyzeWorkerRequest = { type: 'analyze', sampleRate: decoded.sampleRate, segments: samples, metadata }
    const transfers = samples.map((segment) => segment.samples.buffer as ArrayBuffer)
    return await new Promise<AnalysisResult>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<AnalyzeWorkerResponse>) => {
        worker.terminate()
        if (event.data.error) reject(new Error(event.data.error))
        else if (event.data.result) resolve(event.data.result)
        else reject(new Error('Der Audio-Worker lieferte kein Analyseergebnis.'))
      }
      worker.onerror = (event) => {
        worker.terminate()
        reject(new Error(event.message || 'Der Audio-Worker ist fehlgeschlagen.'))
      }
      worker.postMessage(request, transfers)
    })
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Die Audiodatei konnte nicht analysiert werden.')
  } finally {
    await audioContext.close()
  }
}
