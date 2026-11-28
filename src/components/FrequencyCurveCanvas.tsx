import { useEffect, useRef, useState } from 'react';
import type { PsdCurveData } from '../dsp/types';
import type { ThemeMode } from './TopBar';

interface FrequencyCurveCanvasProps {
  psdCurve: PsdCurveData;
  effectiveNyquistKhz: number;
  cutoffKhz: number | null;
  theme: ThemeMode;
}

interface CurveHover {
  x: number;
  freqKhz: number;
  p95Db: number;
  meanDb: number;
}

const PAD_LEFT = 48;
const PAD_RIGHT = 20;
const PAD_TOP = 18;
const PAD_BOTTOM = 32;
const MIN_DB = -125;
const MAX_DB = -5;

export function FrequencyCurveCanvas({
  psdCurve,
  effectiveNyquistKhz,
  cutoffKhz,
  theme,
}: FrequencyCurveCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 760, height: 340 });
  const [hover, setHover] = useState<CurveHover | null>(null);

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
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

    const bgFill = isDark ? 'rgba(0, 0, 0, 0.36)' : 'rgba(255, 255, 255, 0.65)';
    const gridColor = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.07)';
    const borderColor = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.1)';
    const labelColor = isDark ? 'rgba(245, 245, 247, 0.56)' : 'rgba(29, 29, 31, 0.58)';
    const p95Stroke = isDark ? '#64D2FF' : '#0071E3';
    const meanStroke = isDark ? 'rgba(245, 245, 247, 0.38)' : 'rgba(29, 29, 31, 0.32)';

    ctx.clearRect(0, 0, size.width, size.height);

    const mapX = (khz: number) =>
      PAD_LEFT + Math.max(0, Math.min(1, khz / effectiveNyquistKhz)) * plotW;
    const mapY = (db: number) =>
      PAD_TOP +
      (1 - Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)))) * plotH;

    // Clipped plot surface
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(PAD_LEFT, PAD_TOP, plotW, plotH, 10);
    ctx.fillStyle = bgFill;
    ctx.fill();
    ctx.clip();

    // Horizontal dBFS gridlines
    const dbTicks = [-20, -40, -60, -80, -100, -120];
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    for (const db of dbTicks) {
      const y = mapY(db);
      ctx.beginPath();
      ctx.moveTo(PAD_LEFT, y);
      ctx.lineTo(PAD_LEFT + plotW, y);
      ctx.stroke();
    }

    // Vertical kHz gridlines
    const freqStep = effectiveNyquistKhz > 30 ? 8 : effectiveNyquistKhz > 24 ? 6 : 4;
    for (let f = freqStep; f < effectiveNyquistKhz; f += freqStep) {
      const x = mapX(f);
      ctx.beginPath();
      ctx.moveTo(x, PAD_TOP);
      ctx.lineTo(x, PAD_TOP + plotH);
      ctx.stroke();
    }

    const { frequenciesKhz, p95Db, meanDb } = psdCurve;
    const n = frequenciesKhz.length;

    if (n > 1) {
      // Subtle area under P95 curve
      const areaGrad = ctx.createLinearGradient(0, PAD_TOP, 0, PAD_TOP + plotH);
      if (isDark) {
        areaGrad.addColorStop(0, 'rgba(100, 210, 255, 0.20)');
        areaGrad.addColorStop(1, 'rgba(100, 210, 255, 0.01)');
      } else {
        areaGrad.addColorStop(0, 'rgba(0, 113, 227, 0.14)');
        areaGrad.addColorStop(1, 'rgba(0, 113, 227, 0.01)');
      }

      ctx.beginPath();
      ctx.moveTo(mapX(frequenciesKhz[0]), PAD_TOP + plotH);
      for (let i = 0; i < n; i++) {
        ctx.lineTo(mapX(frequenciesKhz[i]), mapY(p95Db[i]));
      }
      ctx.lineTo(mapX(frequenciesKhz[n - 1]), PAD_TOP + plotH);
      ctx.closePath();
      ctx.fillStyle = areaGrad;
      ctx.fill();

      // Mean PSD curve (subtle)
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = mapX(frequenciesKhz[i]);
        const y = mapY(meanDb[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = meanStroke;
      ctx.lineWidth = 1.25;
      ctx.stroke();

      // P95 PSD curve (prominent)
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = mapX(frequenciesKhz[i]);
        const y = mapY(p95Db[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = p95Stroke;
      ctx.lineWidth = 1.85;
      ctx.stroke();
    }

    // Annotated cutoff vertical marker
    if (cutoffKhz !== null && cutoffKhz > 0 && cutoffKhz < effectiveNyquistKhz) {
      const cx = mapX(cutoffKhz);
      ctx.save();
      ctx.strokeStyle = '#FF9F0A';
      ctx.lineWidth = 1.35;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(cx, PAD_TOP);
      ctx.lineTo(cx, PAD_TOP + plotH);
      ctx.stroke();
      ctx.restore();

      const label = `Cutoff ${cutoffKhz.toFixed(1)} kHz`;
      ctx.font = '500 11px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
      const tw = ctx.measureText(label).width + 14;
      const lx = Math.max(PAD_LEFT + 8, Math.min(PAD_LEFT + plotW - tw - 8, cx - tw / 2));
      ctx.fillStyle = isDark ? 'rgba(20, 20, 24, 0.85)' : 'rgba(255, 255, 255, 0.92)';
      ctx.beginPath();
      ctx.roundRect(lx, PAD_TOP + 10, tw, 20, 10);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 159, 10, 0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = isDark ? '#FFD180' : '#B26A00';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, lx + tw / 2, PAD_TOP + 20.5);
    }

    // Hover crosshair + dots
    if (hover) {
      ctx.save();
      ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.32)' : 'rgba(0,0,0,0.24)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(hover.x, PAD_TOP);
      ctx.lineTo(hover.x, PAD_TOP + plotH);
      ctx.stroke();
      ctx.restore();

      // P95 dot
      ctx.beginPath();
      ctx.arc(hover.x, mapY(hover.p95Db), 4, 0, Math.PI * 2);
      ctx.fillStyle = p95Stroke;
      ctx.fill();
      ctx.strokeStyle = isDark ? '#0B0B0E' : '#FFFFFF';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Mean dot
      ctx.beginPath();
      ctx.arc(hover.x, mapY(hover.meanDb), 3, 0, Math.PI * 2);
      ctx.fillStyle = meanStroke;
      ctx.fill();
    }

    ctx.restore();

    // Outer frame
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(PAD_LEFT, PAD_TOP, plotW, plotH, 10);
    ctx.stroke();

    // Y-axis dBFS labels
    ctx.font = '500 10px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
    ctx.fillStyle = labelColor;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('dBFS', PAD_LEFT - 8, PAD_TOP - 8);
    ctx.font = '500 11px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
    for (const db of dbTicks) {
      ctx.fillText(`${db}`, PAD_LEFT - 8, mapY(db));
    }

    // X-axis kHz labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTicks: number[] = [0];
    for (let f = freqStep; f < effectiveNyquistKhz - freqStep * 0.65; f += freqStep) {
      xTicks.push(f);
    }
    xTicks.push(effectiveNyquistKhz);
    for (const f of xTicks) {
      const text = f === effectiveNyquistKhz ? `${f.toFixed(1)}k` : `${Math.round(f)}k`;
      ctx.fillText(text, mapX(f), PAD_TOP + plotH + 9);
    }

    ctx.restore();
  }, [size, psdCurve, effectiveNyquistKhz, cutoffKhz, theme, hover]);

  const handlePointerMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const plotW = Math.max(40, size.width - PAD_LEFT - PAD_RIGHT);
    if (x < PAD_LEFT || x > PAD_LEFT + plotW) {
      setHover(null);
      return;
    }

    const freqKhz = ((x - PAD_LEFT) / plotW) * effectiveNyquistKhz;
    const { frequenciesKhz, p95Db, meanDb } = psdCurve;
    if (frequenciesKhz.length === 0) return;

    // Binary search nearest frequency bin
    let lo = 0;
    let hi = frequenciesKhz.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (frequenciesKhz[mid] < freqKhz) lo = mid + 1;
      else hi = mid;
    }

    setHover({
      x,
      freqKhz: frequenciesKhz[lo],
      p95Db: p95Db[lo],
      meanDb: meanDb[lo],
    });
  };

  return (
    <div ref={containerRef} className="relative w-full select-none">
      {/* Compact inline legend */}
      <div className="mb-2 flex items-center justify-end gap-4 px-2 text-[11px] font-medium text-[#6E6E73] dark:text-[#98989D]">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-[2px] w-3.5 rounded-full bg-[#0071E3] dark:bg-[#64D2FF]" aria-hidden="true" />
          P95 Envelope
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-[2px] w-3.5 rounded-full bg-[#1D1D1F]/35 dark:bg-[#F5F5F7]/40" aria-hidden="true" />
          Mean PSD
        </span>
      </div>

      <canvas
        ref={canvasRef}
        data-testid="frequency-curve-canvas"
        style={{ width: size.width, height: size.height }}
        onMouseMove={handlePointerMove}
        onMouseLeave={() => setHover(null)}
        className="block w-full cursor-crosshair"
        aria-label="P95 and Mean power spectral density curve"
      />

      {hover && (
        <div className="pointer-events-none absolute top-9 left-14 z-10 inline-flex items-center gap-2 rounded-full border border-black/[0.08] bg-white/88 px-3 py-1 text-[11px] font-medium text-[#1D1D1F] shadow-md backdrop-blur-xl dark:border-white/15 dark:bg-[#141418]/86 dark:text-[#F5F5F7] tabular-nums">
          <span>{hover.freqKhz.toFixed(2)} kHz</span>
          <span className="opacity-40" aria-hidden="true">·</span>
          <span className="text-[#0071E3] dark:text-[#64D2FF]">
            P95 {hover.p95Db.toFixed(1)} dB
          </span>
          <span className="opacity-40" aria-hidden="true">·</span>
          <span className="opacity-75">Mean {hover.meanDb.toFixed(1)} dB</span>
        </div>
      )}
    </div>
  );
}
