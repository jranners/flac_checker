import type { AudioMetadata } from './types'

const text = (view: DataView, offset: number, length: number) =>
  String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset, length))

const emptyMetadata = (format: string): AudioMetadata => ({
  format,
  sampleRate: 0,
  bitDepth: null,
  channels: 0,
  duration: 0,
  totalSamples: null,
  md5: null,
  fileBitrate: 0,
})

export async function parseHeader(file: File): Promise<AudioMetadata> {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  const format = extension.toUpperCase()
  const metadata = emptyMetadata(format)
  const header = await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer()
  const view = new DataView(header)

  if (extension === 'flac') {
    if (view.byteLength < 42 || text(view, 0, 4) !== 'fLaC') {
      throw new Error('Ungültiger FLAC-Header: fLaC-Signatur oder STREAMINFO fehlt.')
    }
    let offset = 4
    let streamInfo: number | null = null
    for (let block = 0; block < 128 && offset + 4 <= view.byteLength; block += 1) {
      const descriptor = view.getUint8(offset)
      const type = descriptor & 0x7f
      const length = (view.getUint8(offset + 1) << 16) | (view.getUint8(offset + 2) << 8) | view.getUint8(offset + 3)
      offset += 4
      if (offset + length > view.byteLength) break
      if (type === 0) {
        if (length !== 34) throw new Error('FLAC STREAMINFO hat eine ungültige Länge.')
        streamInfo = offset
        break
      }
      offset += length
      if (descriptor & 0x80) break
    }
    if (streamInfo === null) throw new Error('FLAC STREAMINFO-Block wurde nicht gefunden.')

    const position = streamInfo
    const packed = view.getBigUint64(position + 10, false)
    const sampleRate = Number((packed >> 44n) & 0xfffffn)
    const channels = Number((packed >> 41n) & 0x7n) + 1
    const bitDepth = Number((packed >> 36n) & 0x1fn) + 1
    const totalSamples = Number(packed & 0xfffffffffn)
    const md5Bytes = new Uint8Array(header, position + 18, 16)
    const md5 = [...md5Bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    if (!sampleRate || !totalSamples) throw new Error('FLAC-STREAMINFO enthält keine gültige Samplerate oder Sample-Anzahl.')
    Object.assign(metadata, {
      sampleRate,
      bitDepth,
      channels,
      totalSamples,
      duration: totalSamples / sampleRate,
      md5: /^0+$/.test(md5) ? null : md5,
    })
  } else if (extension === 'wav' || extension === 'wave') {
    if (view.byteLength < 44 || text(view, 0, 4) !== 'RIFF' || text(view, 8, 4) !== 'WAVE') {
      throw new Error('Ungültiger WAV-Header: RIFF/WAVE-Signatur fehlt.')
    }
    const littleEndian = true
    let offset = 12
    let formatChunk: number | null = null
    let dataSize: number | null = null
    while (offset + 8 <= view.byteLength) {
      const id = text(view, offset, 4)
      const size = view.getUint32(offset + 4, littleEndian)
      const body = offset + 8
      if (id === 'fmt ') formatChunk = body
      if (id === 'data') dataSize = size
      if (formatChunk !== null && dataSize !== null) break
      offset = body + size + (size & 1)
    }
    if (formatChunk === null || formatChunk + 16 > view.byteLength) throw new Error('WAV-Format-Chunk fehlt oder ist unvollständig.')
    const encoding = view.getUint16(formatChunk, littleEndian)
    const channels = view.getUint16(formatChunk + 2, littleEndian)
    const sampleRate = view.getUint32(formatChunk + 4, littleEndian)
    const bits = view.getUint16(formatChunk + 14, littleEndian)
    const bitDepth = encoding === 0xfffe && formatChunk + 40 <= view.byteLength
      ? view.getUint16(formatChunk + 20, littleEndian)
      : bits
    Object.assign(metadata, {
      sampleRate,
      bitDepth,
      channels,
      totalSamples: dataSize === null ? null : Math.floor((dataSize * 8) / Math.max(1, channels * bits)),
      duration: dataSize === null ? 0 : dataSize / Math.max(1, sampleRate * channels * (bits / 8)),
    })
  }

  if (metadata.duration > 0) metadata.fileBitrate = Math.round((file.size * 8) / metadata.duration)
  return metadata
}
