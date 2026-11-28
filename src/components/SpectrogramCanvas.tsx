import { useEffect, useRef, useState } from 'react';
import { SPECTROGRAM_LUT } from '../dsp/magmaColormap';
import type { SpectrogramData } from '../dsp/types';
import type { ThemeMode } from './TopBar';

interface SpectrogramCanvasProps {
  spectrogram: SpectrogramData;
  effectiveNyquistKhz: number;
  cutoffKhz: number | null;
  theme: ThemeMode;
  zoomHf: boolean;
  compact?: boolean;
}

interface HoverReadout {
  x: number;
  y: number;
  freqKhz: number;
  timeSec: number;
  db: number;
}

const PAD_LEFT = 46;
const PAD_RIGHT = 52;
const PAD_TOP = 14;
const PAD_BOTTOM = 28;

function getFreqRange(effectiveNyquistKhz: number, zoomHf: boolean): { minKhz: number; maxKhz: number } {
  if (!zoomHf) {
    return { minKhz: 0, maxKhz: effectiveNyquistKhz };
  }
  const maxKhz = Math.min(24, effectiveNyquistKhz);
  const minKhz = Math.min(12, Math.max(0, maxKhz - 6));
  return { minKhz, maxKhz };
}

export function SpectrogramCanvas({
  spectrogram,
  effectiveNyquistKhz,
  cutoffKhz,
  theme,
  zoomHf,
  compact = false,
}: SpectrogramCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const heatmapRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 780, height: compact ? 240 : 390 });
  const [hover, setHover] = useState<HoverReadout | null>(null);

  // Build full-range offscreen bitmap once per spectrogram result
  useEffect(() => {
    const { nFreq, nTime, dbMatrix, maxDb } = spectrogram;
    const offscreen = document.createElement('canvas');
    offscreen.width = Math.max(1, nTime);
    offscreen.height = Math.max(1, nFreq);
    const ctx = offscreen.getContext('2d');
    if (!ctx) return;

    const img = ctx.createImageData(offscreen.width, offscreen.height);
    const data = img.data;
    const vmax = Math.max(-20, maxDb);
    const vmin = vmax - 96;
    const invSpan = 255 / Math.max(1, vmax - vmin);

    for (let f = 0; f < nFreq; f++) {
      // Invert Y so 0 kHz is at bottom and Nyquist at top
      const rowY = nFreq - 1 - f;
      const srcRowOffset = f * nTime;
      const dstRowOffset = rowY * nTime * 4;
      for (let t = 0; t < nTime; t++) {
        const db = dbMatrix[srcRowOffset + t];
        const lutIdx = Math.max(
          0,
          Math.min(255, Math.round((db - vmin) * invSpan)),
        );
        const lutOff = lutIdx * 3;
        const p = dstRowOffset + t * 4;
        data[p] = SPECTROGRAM_LUT[lutOff];
        data[p + 1] = SPECTROGRAM_LUT[lutOff + 1];
        data[p + 2] = SPECTROGRAM_LUT[lutOff + 2];
        data[p + 3] = 255;
      }
    }

    ctx.putImageData(img, 0, 0);
    heatmapRef.current = offscreen;
  }, [spectrogram]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(280, Math.floor(entry.contentRect.width));
        const h = compact
          ? w < 520
            ? 200
            : 240
          : w < 520
            ? 280
            : 390;
        setSize({ width: w, height: h });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [compact]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const heatmap = heatmapRef.current;
    if (!canvas || !heatmap) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(size.width * dpr);
    canvas.height = Math.floor(size.height * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);

    const plotW = Math.max(40, size.width - PAD_LEFT - PAD_RIGHT);
    const plotH = Math.max(40, size.height - PAD_TOP - PAD_BOTTOM);
    const { minKhz, maxKhz } = getFreqRange(effectiveNyquistKhz, zoomHf);
    const freqSpan = Math.max(0.5, maxKhz - minKhz);

    const isDark = theme === 'dark';
    const labelColor = isDark ? 'rgba(161, 161, 170, 0.85)' : 'rgba(82, 82, 91, 0.85)';
    const borderColor = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    const monoFont = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace';

    ctx.clearRect(0, 0, size.width, size.height);

    // Map frequency range to source pixel slice on offscreen heatmap
    const topFrac = Math.max(0, Math.min(1, 1 - maxKhz / effectiveNyquistKhz));
    const botFrac = Math.max(0, Math.min(1, 1 - minKhz / effectiveNyquistKhz));
    const srcY = topFrac * heatmap.height;
    const srcH = Math.max(1, (botFrac - topFrac) * heatmap.height);

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(PAD_LEFT, PAD_TOP, plotW, plotH, 6);
    ctx.clip();
    ctx.fillStyle = '#070709';
    ctx.fillRect(PAD_LEFT, PAD_TOP, plotW, plotH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      heatmap,
      0,
      srcY,
      heatmap.width,
      srcH,
      PAD_LEFT,
      PAD_TOP,
      plotW,
      plotH,
    );

    const freqToY = (f: number) => PAD_TOP + plotH * (1 - (f - minKhz) / freqSpan);

    // Subtle horizontal frequency reference gridlines
    const freqStep = zoomHf ? 2 : effectiveNyquistKhz > 30 ? 8 : effectiveNyquistKhz > 24 ? 6 : 4;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    const firstGrid = Math.ceil(minKhz / freqStep) * freqStep;
    for (let f = firstGrid; f < maxKhz; f += freqStep) {
      if (Math.abs(f - minKhz) < 0.25) continue;
      const y = freqToY(f);
      ctx.beginPath();
      ctx.moveTo(PAD_LEFT, y);
      ctx.lineTo(PAD_LEFT + plotW, y);
      ctx.stroke();
    }

    // Crisp hairline cutoff indicator
    if (cutoffKhz !== null && cutoffKhz > minKhz && cutoffKhz < maxKhz) {
      const cutoffY = freqToY(cutoffKhz);
      ctx.save();
      ctx.strokeStyle = '#F59E0B';
      ctx.lineWidth = 1.25;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(PAD_LEFT, cutoffY);
      ctx.lineTo(PAD_LEFT + plotW, cutoffY);
      ctx.stroke();
      ctx.restore();

      const tagText = `CUTOFF ${cutoffKhz.toFixed(1)} kHz`;
      ctx.font = monoFont;
      const tw = ctx.measureText(tagText).width + 12;
      const tx = PAD_LEFT + plotW - tw - 8;
      const ty = Math.max(PAD_TOP + 6, cutoffY - 22);
      ctx.fillStyle = 'rgba(11, 11, 13, 0.86)';
      ctx.beginPath();
      ctx.roundRect(tx, ty, tw, 18, 4);
      ctx.fill();
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#FCD34D';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tagText, tx + tw / 2, ty + 9.5);
    }

    // Crosshair lines
    if (hover) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(hover.x, PAD_TOP);
      ctx.lineTo(hover.x, PAD_TOP + plotH);
      ctx.moveTo(PAD_LEFT, hover.y);
      ctx.lineTo(PAD_LEFT + plotW, hover.y);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    // Outer hairline border
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(PAD_LEFT, PAD_TOP, plotW, plotH, 6);
    ctx.stroke();

    // Y-axis kHz ticks
    ctx.font = monoFont;
    ctx.fillStyle = labelColor;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const yTicks: number[] = [minKhz];
    for (let f = firstGrid; f < maxKhz - freqStep * 0.45; f += freqStep) {
      if (f > minKhz + freqStep * 0.4) yTicks.push(f);
    }
    yTicks.push(maxKhz);

    for (const f of yTicks) {
      const y = freqToY(f);
      const label = Math.abs(f - Math.round(f)) > 0.05 ? `${f.toFixed(1)}k` : `${Math.round(f)}k`;
      ctx.fillText(label, PAD_LEFT - 7, y);
    }

    // X-axis analyzed time ticks
    const maxTime = spectrogram.timesSec[spectrogram.nTime - 1] ?? 0;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTickCount = Math.min(6, Math.max(3, Math.floor(plotW / 120)));
    for (let i = 0; i <= xTickCount; i++) {
      const frac = i / xTickCount;
      const x = PAD_LEFT + frac * plotW;
      const sec = frac * maxTime;
      ctx.fillText(`${sec.toFixed(1)}s`, x, PAD_TOP + plotH + 8);
    }

    // Vertical dBFS colorbar
    const barX = PAD_LEFT + plotW + 10;
    const barW = 7;
    const grad = ctx.createLinearGradient(0, PAD_TOP + plotH, 0, PAD_TOP);
    for (let i = 0; i <= 10; i++) {
      const lutIdx = Math.round((i / 10) * 255) * 3;
      grad.addColorStop(
        i / 10,
        `rgb(${SPECTROGRAM_LUT[lutIdx]},${SPECTROGRAM_LUT[lutIdx + 1]},${SPECTROGRAM_LUT[lutIdx + 2]})`,
      );
    }
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(barX, PAD_TOP, barW, plotH, 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    const vmax = Math.max(-20, spectrogram.maxDb);
    const vmin = vmax - 96;
    ctx.fillStyle = labelColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('dB', barX, PAD_TOP - 7);
    ctx.fillText(`${Math.round(vmax)}`, barX + barW + 5, PAD_TOP + 5);
    ctx.fillText(`${Math.round((vmax + vmin) / 2)}`, barX + barW + 5, PAD_TOP + plotH / 2);
    ctx.fillText(`${Math.round(vmin)}`, barX + barW + 5, PAD_TOP + plotH - 5);

    ctx.restore();
  }, [size, spectrogram, effectiveNyquistKhz, cutoffKhz, theme, zoomHf, hover]);

  const handlePointerMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const plotW = Math.max(40, size.width - PAD_LEFT - PAD_RIGHT);
    const plotH = Math.max(40, size.height - PAD_TOP - PAD_BOTTOM);

    if (x < PAD_LEFT || x > PAD_LEFT + plotW || y < PAD_TOP || y > PAD_TOP + plotH) {
      setHover(null);
      return;
    }

    const { minKhz, maxKhz } = getFreqRange(effectiveNyquistKhz, zoomHf);
    const tFrac = (x - PAD_LEFT) / plotW;
    const yFrac = 1 - (y - PAD_TOP) / plotH;
    const freqKhz = minKhz + yFrac * (maxKhz - minKhz);
    const fFracFull = Math.max(0, Math.min(1, freqKhz / effectiveNyquistKhz));

    const tIdx = Math.min(
      spectrogram.nTime - 1,
      Math.max(0, Math.round(tFrac * (spectrogram.nTime - 1))),
    );
    const fIdx = Math.min(
      spectrogram.nFreq - 1,
      Math.max(0, Math.round(fFracFull * (spectrogram.nFreq - 1))),
    );

    setHover({
      x,
      y,
      freqKhz,
      timeSec: spectrogram.timesSec[tIdx] ?? 0,
      db: spectrogram.dbMatrix[fIdx * spectrogram.nTime + tIdx] ?? -145,
    });
  };

  return (
    <div ref={containerRef} className="relative w-full select-none">
      <canvas
        ref={canvasRef}
        data-testid="spectrogram-canvas"
        style={{ width: size.width, height: size.height }}
        onMouseMove={handlePointerMove}
        onMouseLeave={() => setHover(null)}
        className="block w-full cursor-crosshair"
        aria-label="Audio frequency spectrogram"
      />

      {hover && (
        <div className="pointer-events-none absolute top-4 left-14 z-10 inline-flex items-center gap-2 rounded-md border border-white/[0.1] bg-[#111113]/85 px-2.5 py-1 font-mono text-[11px] text-zinc-100 backdrop-blur-md tabular-nums">
          <span>{hover.freqKhz.toFixed(2)} kHz</span>
          <span className="text-zinc-500" aria-hidden="true">·</span>
          <span>{hover.timeSec.toFixed(2)} s</span>
          <span className="text-zinc-500" aria-hidden="true">·</span>
          <span>{hover.db.toFixed(1)} dBFS</span>
        </div>
      )}
    </div>
  );
}
