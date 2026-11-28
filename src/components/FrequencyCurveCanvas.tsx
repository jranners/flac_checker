import { useEffect, useRef, useState } from 'react';
import type { PsdCurveData } from '../dsp/types';
import type { ThemeMode } from './TopBar';

interface FrequencyCurveCanvasProps {
  psdCurve: PsdCurveData;
  effectiveNyquistKhz: number;
  cutoffKhz: number | null;
  theme: ThemeMode;
  zoomHf: boolean;
  compact?: boolean;
}

interface CurveHover {
  x: number;
  freqKhz: number;
  p95Db: number;
  meanDb: number;
  expectedDb: number;
}

const PAD_LEFT = 46;
const PAD_RIGHT = 18;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;
const MIN_DB = -135;
const MAX_DB = -5;

function getFreqRange(effectiveNyquistKhz: number, zoomHf: boolean): { minKhz: number; maxKhz: number } {
  if (!zoomHf) {
    return { minKhz: 0, maxKhz: effectiveNyquistKhz };
  }
  const maxKhz = Math.min(24, effectiveNyquistKhz);
  const minKhz = Math.min(12, Math.max(0, maxKhz - 6));
  return { minKhz, maxKhz };
}

export function FrequencyCurveCanvas({
  psdCurve,
  effectiveNyquistKhz,
  cutoffKhz,
  theme,
  zoomHf,
  compact = false,
}: FrequencyCurveCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 780, height: compact ? 240 : 390 });
  const [hover, setHover] = useState<CurveHover | null>(null);

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
    const { minKhz, maxKhz } = getFreqRange(effectiveNyquistKhz, zoomHf);
    const freqSpan = Math.max(0.5, maxKhz - minKhz);
    const isDark = theme === 'dark';

    const bgFill = isDark ? '#0B0B0D' : '#FAFAFB';
    const gridColor = isDark ? 'rgba(255, 255, 255, 0.065)' : 'rgba(0, 0, 0, 0.06)';
    const borderColor = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    const labelColor = isDark ? 'rgba(161, 161, 170, 0.85)' : 'rgba(82, 82, 91, 0.85)';
    const p95Stroke = isDark ? '#F4F4F5' : '#18181B';
    const meanStroke = isDark ? 'rgba(161, 161, 170, 0.42)' : 'rgba(113, 113, 122, 0.4)';
    const expectedStroke = isDark ? 'rgba(161, 161, 170, 0.55)' : 'rgba(82, 82, 91, 0.48)';
    const monoFont = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace';

    ctx.clearRect(0, 0, size.width, size.height);

    const mapX = (khz: number) => PAD_LEFT + ((khz - minKhz) / freqSpan) * plotW;
    const mapY = (db: number) =>
      PAD_TOP +
      (1 - Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)))) * plotH;

    // Clipped plot surface
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(PAD_LEFT, PAD_TOP, plotW, plotH, 6);
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
    const freqStep = zoomHf ? 2 : effectiveNyquistKhz > 30 ? 8 : effectiveNyquistKhz > 24 ? 6 : 4;
    const firstGrid = Math.ceil(minKhz / freqStep) * freqStep;
    for (let f = firstGrid; f < maxKhz; f += freqStep) {
      if (Math.abs(f - minKhz) < 0.25) continue;
      const x = mapX(f);
      ctx.beginPath();
      ctx.moveTo(x, PAD_TOP);
      ctx.lineTo(x, PAD_TOP + plotH);
      ctx.stroke();
    }

    const { frequenciesKhz, p95Db, meanDb, expectedDb } = psdCurve;
    const n = frequenciesKhz.length;

    if (n > 1) {
      // Subtle monochrome fill under P95 curve
      const areaGrad = ctx.createLinearGradient(0, PAD_TOP, 0, PAD_TOP + plotH);
      if (isDark) {
        areaGrad.addColorStop(0, 'rgba(244, 244, 245, 0.12)');
        areaGrad.addColorStop(1, 'rgba(244, 244, 245, 0.01)');
      } else {
        areaGrad.addColorStop(0, 'rgba(24, 24, 27, 0.09)');
        areaGrad.addColorStop(1, 'rgba(24, 24, 27, 0.01)');
      }

      ctx.beginPath();
      let started = false;
      let lastX = PAD_LEFT;
      for (let i = 0; i < n; i++) {
        const f = frequenciesKhz[i];
        if (f < minKhz - 0.5 || f > maxKhz + 0.5) continue;
        const x = mapX(f);
        const y = mapY(p95Db[i]);
        if (!started) {
          ctx.moveTo(x, PAD_TOP + plotH);
          ctx.lineTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
        lastX = x;
      }
      if (started) {
        ctx.lineTo(lastX, PAD_TOP + plotH);
        ctx.closePath();
        ctx.fillStyle = areaGrad;
        ctx.fill();
      }

      // Extrapolated 4-13 kHz natural slope model (dashed)
      if (expectedDb && expectedDb.length === n) {
        ctx.save();
        ctx.beginPath();
        let expStarted = false;
        for (let i = 0; i < n; i++) {
          const f = frequenciesKhz[i];
          if (f < Math.max(4.0, minKhz - 0.5) || f > maxKhz + 0.5) continue;
          const x = mapX(f);
          const y = mapY(expectedDb[i]);
          if (!expStarted) {
            ctx.moveTo(x, y);
            expStarted = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.strokeStyle = expectedStroke;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.restore();
      }

      // Mean PSD curve
      ctx.beginPath();
      let meanStarted = false;
      for (let i = 0; i < n; i++) {
        const f = frequenciesKhz[i];
        if (f < minKhz - 0.5 || f > maxKhz + 0.5) continue;
        const x = mapX(f);
        const y = mapY(meanDb[i]);
        if (!meanStarted) {
          ctx.moveTo(x, y);
          meanStarted = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = meanStroke;
      ctx.lineWidth = 1.15;
      ctx.stroke();

      // P95 PSD envelope (primary crisp line)
      ctx.beginPath();
      let p95Started = false;
      for (let i = 0; i < n; i++) {
        const f = frequenciesKhz[i];
        if (f < minKhz - 0.5 || f > maxKhz + 0.5) continue;
        const x = mapX(f);
        const y = mapY(p95Db[i]);
        if (!p95Started) {
          ctx.moveTo(x, y);
          p95Started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = p95Stroke;
      ctx.lineWidth = 1.65;
      ctx.stroke();
    }

    // Annotated cutoff hairline marker
    if (cutoffKhz !== null && cutoffKhz > minKhz && cutoffKhz < maxKhz) {
      const cx = mapX(cutoffKhz);
      ctx.save();
      ctx.strokeStyle = '#F59E0B';
      ctx.lineWidth = 1.25;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, PAD_TOP);
      ctx.lineTo(cx, PAD_TOP + plotH);
      ctx.stroke();
      ctx.restore();

      const label = `CUTOFF ${cutoffKhz.toFixed(1)} kHz`;
      ctx.font = monoFont;
      const tw = ctx.measureText(label).width + 12;
      const lx = Math.max(PAD_LEFT + 6, Math.min(PAD_LEFT + plotW - tw - 6, cx - tw / 2));
      ctx.fillStyle = isDark ? 'rgba(18, 18, 21, 0.9)' : 'rgba(255, 255, 255, 0.94)';
      ctx.beginPath();
      ctx.roundRect(lx, PAD_TOP + 8, tw, 18, 4);
      ctx.fill();
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = isDark ? '#FCD34D' : '#B45309';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, lx + tw / 2, PAD_TOP + 17.5);
    }

    // Hover crosshair + sample points
    if (hover) {
      ctx.save();
      ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(hover.x, PAD_TOP);
      ctx.lineTo(hover.x, PAD_TOP + plotH);
      ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(hover.x, mapY(hover.p95Db), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = p95Stroke;
      ctx.fill();
      ctx.strokeStyle = isDark ? '#0B0B0D' : '#FFFFFF';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(hover.x, mapY(hover.meanDb), 2.5, 0, Math.PI * 2);
      ctx.fillStyle = meanStroke;
      ctx.fill();
    }

    ctx.restore();

    // Outer hairline border
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(PAD_LEFT, PAD_TOP, plotW, plotH, 6);
    ctx.stroke();

    // Y-axis dBFS labels
    ctx.font = monoFont;
    ctx.fillStyle = labelColor;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('dB', PAD_LEFT - 7, PAD_TOP - 7);
    for (const db of dbTicks) {
      ctx.fillText(`${db}`, PAD_LEFT - 7, mapY(db));
    }

    // X-axis kHz labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTicks: number[] = [minKhz];
    for (let f = firstGrid; f < maxKhz - freqStep * 0.45; f += freqStep) {
      if (f > minKhz + freqStep * 0.4) xTicks.push(f);
    }
    xTicks.push(maxKhz);
    for (const f of xTicks) {
      const text = Math.abs(f - Math.round(f)) > 0.05 ? `${f.toFixed(1)}k` : `${Math.round(f)}k`;
      ctx.fillText(text, mapX(f), PAD_TOP + plotH + 8);
    }

    ctx.restore();
  }, [size, psdCurve, effectiveNyquistKhz, cutoffKhz, theme, zoomHf, hover]);

  const handlePointerMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const plotW = Math.max(40, size.width - PAD_LEFT - PAD_RIGHT);
    if (x < PAD_LEFT || x > PAD_LEFT + plotW) {
      setHover(null);
      return;
    }

    const { minKhz, maxKhz } = getFreqRange(effectiveNyquistKhz, zoomHf);
    const freqKhz = minKhz + ((x - PAD_LEFT) / plotW) * (maxKhz - minKhz);
    const { frequenciesKhz, p95Db, meanDb, expectedDb } = psdCurve;
    if (frequenciesKhz.length === 0) return;

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
      expectedDb: expectedDb?.[lo] ?? p95Db[lo],
    });
  };

  return (
    <div ref={containerRef} className="relative w-full select-none">
      {/* Quiet inline legend */}
      <div className="mb-1.5 flex items-center justify-end gap-4 px-2 font-mono text-[10px] text-zinc-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-[2px] w-3 bg-zinc-900 dark:bg-zinc-100" aria-hidden="true" />
          P95
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-[1.5px] w-3 bg-zinc-400/60" aria-hidden="true" />
          Mean
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 border-t border-dashed border-zinc-500" aria-hidden="true" />
          4–13k Model
        </span>
      </div>

      <canvas
        ref={canvasRef}
        data-testid="frequency-curve-canvas"
        style={{ width: size.width, height: size.height }}
        onMouseMove={handlePointerMove}
        onMouseLeave={() => setHover(null)}
        className="block w-full cursor-crosshair"
        aria-label="P95, Mean, and extrapolated natural slope power spectral density curves"
      />

      {hover && (
        <div className="pointer-events-none absolute top-8 left-14 z-10 inline-flex items-center gap-2 rounded-md border border-black/[0.08] bg-white/88 px-2.5 py-1 font-mono text-[11px] text-zinc-900 backdrop-blur-md dark:border-white/[0.1] dark:bg-[#111113]/85 dark:text-zinc-100 tabular-nums">
          <span>{hover.freqKhz.toFixed(2)} kHz</span>
          <span className="text-zinc-400" aria-hidden="true">·</span>
          <span>P95 {hover.p95Db.toFixed(1)} dB</span>
          <span className="text-zinc-400" aria-hidden="true">·</span>
          <span className="text-zinc-500 dark:text-zinc-400">Mean {hover.meanDb.toFixed(1)} dB</span>
          {hover.freqKhz >= 4.0 && (
            <>
              <span className="text-zinc-400" aria-hidden="true">·</span>
              <span className="text-zinc-500 dark:text-zinc-400">Exp {hover.expectedDb.toFixed(1)} dB</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
