import { useEffect, useRef, useState } from 'react'
import type { AnalysisResult } from '../dsp/types'

const plot = { left: 58, right: 18, top: 20, bottom: 36 }
const paletteStops: [number, number, number, number][] = [
  [0, 10, 8, 28],
  [0.18, 57, 15, 110],
  [0.36, 137, 27, 128],
  [0.56, 203, 54, 91],
  [0.75, 244, 120, 45],
  [0.9, 252, 190, 75],
  [1, 252, 250, 190],
]

function colorAt(value: number): [number, number, number] {
  const index = paletteStops.findIndex(([stop]) => stop >= value)
  const next = index < 0 ? paletteStops.length - 1 : index
  const previous = Math.max(0, next - 1)
  const from = paletteStops[previous]
  const to = paletteStops[next]
  const fraction = to[0] === from[0] ? 0 : (value - from[0]) / (to[0] - from[0])
  return [
    Math.round(from[1] + (to[1] - from[1]) * fraction),
    Math.round(from[2] + (to[2] - from[2]) * fraction),
    Math.round(from[3] + (to[3] - from[3]) * fraction),
  ]
}

interface Props {
  result: AnalysisResult
}

export default function Spectrogram({ result }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number; width: number; height: number; frequency: number; time: number } | null>(null)
  const [resizeVersion, setResizeVersion] = useState(0)

  useEffect(() => {
    const canvas = canvasRef.current
    const container = canvas?.parentElement
    if (!container) return
    const observer = new ResizeObserver(() => setResizeVersion((version) => version + 1))
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const bounds = canvas.getBoundingClientRect()
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(bounds.width * ratio))
    canvas.height = Math.max(1, Math.round(bounds.height * ratio))
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    const width = bounds.width
    const height = bounds.height
    const plotWidth = width - plot.left - plot.right
    const plotHeight = height - plot.top - plot.bottom
    context.fillStyle = '#0d1016'
    context.fillRect(0, 0, width, height)

    const imageCanvas = document.createElement('canvas')
    imageCanvas.width = result.timeBins
    imageCanvas.height = result.frequencyBins
    const imageContext = imageCanvas.getContext('2d')
    if (!imageContext) return
    const image = imageContext.createImageData(result.timeBins, result.frequencyBins)
    for (let row = 0; row < result.frequencyBins; row += 1) {
      for (let column = 0; column < result.timeBins; column += 1) {
        const [red, green, blue] = colorAt(result.spectrogram[row * result.timeBins + column])
        const y = result.frequencyBins - 1 - row
        const pixel = (y * result.timeBins + column) * 4
        image.data[pixel] = red
        image.data[pixel + 1] = green
        image.data[pixel + 2] = blue
        image.data[pixel + 3] = 255
      }
    }
    imageContext.putImageData(image, 0, 0)
    context.imageSmoothingEnabled = false
    context.drawImage(imageCanvas, plot.left, plot.top, plotWidth, plotHeight)

    context.font = '11px Inter, ui-sans-serif, sans-serif'
    context.lineWidth = 1
    context.strokeStyle = '#252b36'
    context.fillStyle = '#818a9b'
    context.textAlign = 'right'
    const frequencyTicks = new Set<number>([0, result.nyquist])
    for (let tick = 5000; tick < result.nyquist; tick += 5000) frequencyTicks.add(tick)
    for (const tick of frequencyTicks) {
      const y = plot.top + plotHeight * (1 - tick / result.nyquist)
      context.beginPath()
      context.moveTo(plot.left, y)
      context.lineTo(width - plot.right, y)
      context.stroke()
      context.fillText(`${(tick / 1000).toFixed(0)} kHz`, plot.left - 10, y + 4)
    }
    context.textAlign = 'center'
    const timeTicks = 4
    for (let tick = 0; tick <= timeTicks; tick += 1) {
      const x = plot.left + (plotWidth * tick) / timeTicks
      context.fillText(`${((result.segmentDuration * tick) / timeTicks).toFixed(1)} s`, x, height - 11)
    }
    context.save()
    context.beginPath()
    context.rect(plot.left, plot.top, plotWidth, plotHeight)
    context.clip()
    if (result.cutoffKhz !== null) {
      const y = plot.top + plotHeight * (1 - result.cutoffKhz * 1000 / result.nyquist)
      context.strokeStyle = '#f2c46d'
      context.setLineDash([6, 5])
      context.beginPath()
      context.moveTo(plot.left, y)
      context.lineTo(width - plot.right, y)
      context.stroke()
      context.setLineDash([])
    }
    if (cursor) {
      context.strokeStyle = 'rgba(255,255,255,.72)'
      context.setLineDash([3, 4])
      context.beginPath()
      context.moveTo(cursor.x, plot.top)
      context.lineTo(cursor.x, plot.top + plotHeight)
      context.moveTo(plot.left, cursor.y)
      context.lineTo(width - plot.right, cursor.y)
      context.stroke()
    }
    context.restore()
  }, [result, resizeVersion])

  function updateCursor(event: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return
    const bounds = canvas.getBoundingClientRect()
    const x = event.clientX - bounds.left
    const y = event.clientY - bounds.top
    const plotWidth = bounds.width - plot.left - plot.right
    const plotHeight = bounds.height - plot.top - plot.bottom
    if (x < plot.left || x > plot.left + plotWidth || y < plot.top || y > plot.top + plotHeight) {
      setCursor(null)
      return
    }
    setCursor({
      x,
      y,
      width: bounds.width,
      height: bounds.height,
      frequency: (1 - (y - plot.top) / plotHeight) * result.nyquist,
      time: ((x - plot.left) / plotWidth) * result.segmentDuration,
    })
  }

  return (
    <div className="spectrogram-wrap">
      <canvas
        ref={canvasRef}
        className="spectrogram-canvas"
        onMouseMove={updateCursor}
        onMouseLeave={() => setCursor(null)}
        aria-label="Frequenz-Zeit-Spektrogramm. Bewege den Mauszeiger für Messwerte."
      />
      {cursor && (
        <svg
          className="crosshair-overlay"
          viewBox={`0 0 ${cursor.width} ${cursor.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line x1={cursor.x} y1={plot.top} x2={cursor.x} y2={cursor.height - plot.bottom} />
          <line x1={plot.left} y1={cursor.y} x2={cursor.width - plot.right} y2={cursor.y} />
        </svg>
      )}
      {cursor && (
        <div className="chart-readout" style={{ left: Math.min(cursor.x + 24, cursor.width - 92), top: Math.max(cursor.y - 34, 8) }}>
          <strong>{(cursor.frequency / 1000).toFixed(2)} kHz</strong>
          <span>{cursor.time.toFixed(2)} s</span>
        </div>
      )}
      <div className="chart-scale"><span>−80 dB</span><i /><span>0 dB</span></div>
    </div>
  )
}
