import { useEffect, useRef, useState } from 'react';
import { SPECTROGRAM_LUT } from '../dsp/magmaColormap';
import type { SpectrogramData } from '../dsp/types';
import type { ThemeMode } from './TopBar';

interface SpectrogramCanvasProps {
  spectrogram: SpectrogramData;
  effectiveNyquistKhz: number;
  cutoffKhz: number | null;
  theme: ThemeMode;
}

interface HoverReadout {
  x: number;
  y: number;
  freqKhz: number;
  timeSec: number;
  db: number;
}

const PAD_LEFT = 48;
const PAD_RIGHT = 54;
const PAD_TOP = 16;
const PAD_BOTTOM = 32;

export function SpectrogramCanvas({
  spectrogram,
  effectiveNyquistKhz,
  cutoffKhz,
  theme,
}: SpectrogramCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const heatmapRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 760, height: 340 });
  const [hover, setHover] = useState<HoverReadout | null>(null);

  // Build offscreen bitmap once per spectrogram result
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
    const vmin = vmax - 92;
    const invSpan = 255 / Math.max(1, vmax - vmin);

    for (let f = 0; f < nFreq; f++) {
      // Invert Y so 0 kHz sits at bottom and Nyquist at top
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

  // Track responsive container width via ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(280, Math.floor(entry.contentRect.width));
        const h = w < 520 ? 270 : 340;
        setSize({ width: w, height: h });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Draw HiDPI spectrogram, axes, dB legend, cutoff line, and crosshair
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

    const isDark = theme === 'dark';
    const labelColor = isDark ? 'rgba(245,245,247,0.58)' : 'rgba(29,29,31,0.62)';
    const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    const borderColor = isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)';

    ctx.clearRect(0, 0, size.width, size.height);

    // Draw spectrogram image inside rounded clip
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(PAD_LEFT, PAD_TOP, plotW, plotH, 10);
    ctx.clip();
    ctx.fillStyle = '#020205';
    ctx.fillRect(PAD_LEFT, PAD_TOP, plotW, plotH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(heatmap, PAD_LEFT, PAD_TOP, plotW, plotH);

    // Subtle frequency reference gridlines
    const freqStep = effectiveNyquistKhz > 30 ? 8 : effectiveNyquistKhz > 24 ? 6 : 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let f = freqStep; f < effectiveNyquistKhz; f += freqStep) {
      const y = PAD_TOP + plotH * (1 - f / effectiveNyquistKhz);
      ctx.beginPath();
      ctx.moveTo(PAD_LEFT, y);
      ctx.lineTo(PAD_LEFT + plotW, y);
      ctx.stroke();
    }

    // Hairline dashed cutoff indicator
    if (cutoffKhz !== null && cutoffKhz > 0 && cutoffKhz < effectiveNyquistKhz) {
      const cutoffY = PAD_TOP + plotH * (1 - cutoffKhz / effectiveNyquistKhz);
      ctx.save();
      ctx.strokeStyle = '#FF9F0A';
      ctx.lineWidth = 1.25;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(PAD_LEFT, cutoffY);
      ctx.lineTo(PAD_LEFT + plotW, cutoffY);
      ctx.stroke();
      ctx.restore();

      const tagText = `Cutoff ${cutoffKhz.toFixed(1)} kHz`;
      ctx.font = '500 11px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
      const tw = ctx.measureText(tagText).width + 14;
      const tx = PAD_LEFT + plotW - tw - 8;
      const ty = Math.max(PAD_TOP + 8, cutoffY - 24);
      ctx.fillStyle = 'rgba(12, 12, 16, 0.78)';
      ctx.beginPath();
      ctx.roundRect(tx, ty, tw, 20, 10);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 159, 10, 0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#FFD180';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tagText, tx + tw / 2, ty + 10.5);
    }

    // Interactive crosshair lines
    if (hover) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
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

    // Plot crisp outer frame
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(PAD_LEFT, PAD_TOP, plotW, plotH, 10);
    ctx.stroke();

    // Y-Axis frequency ticks (0 kHz to Nyquist)
    ctx.font = '500 11px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
    ctx.fillStyle = labelColor;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const yTicks: number[] = [0];
    for (let f = freqStep; f < effectiveNyquistKhz - freqStep * 0.65; f += freqStep) {
      yTicks.push(f);
    }
    yTicks.push(effectiveNyquistKhz);

    for (const f of yTicks) {
      const y = PAD_TOP + plotH * (1 - f / effectiveNyquistKhz);
      const label = f === effectiveNyquistKhz ? `${f.toFixed(1)}` : `${Math.round(f)}`;
      ctx.fillText(`${label}k`, PAD_LEFT - 8, y);
    }

    // X-Axis analyzed time ticks
    const maxTime = spectrogram.timesSec[spectrogram.nTime - 1] ?? 0;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTickCount = Math.min(6, Math.max(3, Math.floor(plotW / 120)));
    for (let i = 0; i <= xTickCount; i++) {
      const frac = i / xTickCount;
      const x = PAD_LEFT + frac * plotW;
      const sec = frac * maxTime;
      ctx.fillText(`${sec.toFixed(1)}s`, x, PAD_TOP + plotH + 9);
    }

    // Compact vertical dB colorbar on the right
    const barX = PAD_LEFT + plotW + 12;
    const barW = 8;
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
    ctx.roundRect(barX, PAD_TOP, barW, plotH, 4);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    const vmax = Math.max(-20, spectrogram.maxDb);
    const vmin = vmax - 92;
    ctx.fillStyle = labelColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '500 10px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
    ctx.fillText('dBFS', barX - 2, PAD_TOP - 8);
    ctx.fillText(`${Math.round(vmax)}`, barX + barW + 5, PAD_TOP + 6);
    ctx.fillText(`${Math.round((vmax + vmin) / 2)}`, barX + barW + 5, PAD_TOP + plotH / 2);
    ctx.fillText(`${Math.round(vmin)}`, barX + barW + 5, PAD_TOP + plotH - 6);

    ctx.restore();
  }, [size, spectrogram, effectiveNyquistKhz, cutoffKhz, theme, hover]);

  const handlePointerMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const plotW = Math.max(40, size.width - PAD_LEFT - PAD_RIGHT);
    const plotH = Math.max(40, size.height - PAD_TOP - PAD_BOTTOM);

    if (
      x < PAD_LEFT ||
      x > PAD_LEFT + plotW ||
      y < PAD_TOP ||
      y > PAD_TOP + plotH
    ) {
      setHover(null);
      return;
    }

    const tFrac = (x - PAD_LEFT) / plotW;
    const fFrac = 1 - (y - PAD_TOP) / plotH;
    const tIdx = Math.min(
      spectrogram.nTime - 1,
      Math.max(0, Math.round(tFrac * (spectrogram.nTime - 1))),
    );
    const fIdx = Math.min(
      spectrogram.nFreq - 1,
      Math.max(0, Math.round(fFrac * (spectrogram.nFreq - 1))),
    );

    setHover({
      x,
      y,
      freqKhz: fFrac * effectiveNyquistKhz,
      timeSec: spectrogram.timesSec[tIdx] ?? 0,
      db: spectrogram.dbMatrix[fIdx * spectrogram.nTime + tIdx] ?? -130,
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
        <div
          className="pointer-events-none absolute top-3 left-14 z-10 inline-flex items-center gap-2 rounded-full border border-white/15 bg-[#111114]/82 px-3 py-1 text-[11px] font-medium text-[#F5F5F7] shadow-md backdrop-blur-xl tabular-nums"
        >
          <span>{hover.freqKhz.toFixed(2)} kHz</span>
          <span className="opacity-40" aria-hidden="true">·</span>
          <span>{hover.timeSec.toFixed(2)} s</span>
          <span className="opacity-40" aria-hidden="true">·</span>
          <span>{hover.db.toFixed(1)} dBFS</span>
        </div>
      )}
    </div>
  );
}
