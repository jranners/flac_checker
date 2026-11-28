import { useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  ShieldAlert,
} from 'lucide-react';
import { VERDICT_META, type ForensicImpact, type QueueItem } from '../dsp/types';
import { FrequencyCurveCanvas } from './FrequencyCurveCanvas';
import { SpectrogramCanvas } from './SpectrogramCanvas';
import type { ThemeMode } from './TopBar';

interface DetailPaneProps {
  item: QueueItem | null;
  theme: ThemeMode;
}

type InstrumentView = 'spectrogram' | 'spectrum' | 'split';

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const total = Math.round(sec);
  const mins = Math.floor(total / 60);
  const rem = total % 60;
  return `${mins.toString().padStart(2, '0')}:${rem.toString().padStart(2, '0')}`;
}

function formatImpactLabel(impact: ForensicImpact): { text: string; className: string } {
  if (impact === 'positive') {
    return {
      text: '+ Lossless',
      className: 'text-emerald-600 dark:text-emerald-400',
    };
  }
  if (impact === 'negative') {
    return {
      text: '- Transcode',
      className: 'text-red-600 dark:text-red-400',
    };
  }
  return {
    text: '· Neutral',
    className: 'text-zinc-500',
  };
}

export function DetailPane({ item, theme }: DetailPaneProps) {
  const [view, setView] = useState<InstrumentView>('spectrogram');
  const [zoomHf, setZoomHf] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(true);
  const [copiedMd5, setCopiedMd5] = useState(false);

  if (!item) {
    return (
      <section className="flex flex-1 items-center justify-center rounded-xl border border-black/[0.08] bg-white p-12 text-center text-[13px] text-zinc-500 dark:border-white/[0.08] dark:bg-[#111113]">
        Select an audio file from the queue to inspect its spectrum.
      </section>
    );
  }

  if (
    item.state === 'queued' ||
    item.state === 'validating' ||
    item.state === 'analyzing'
  ) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center rounded-xl border border-black/[0.08] bg-white px-6 py-20 text-center dark:border-white/[0.08] dark:bg-[#111113]">
        <Loader2
          className="h-5 w-5 animate-spin text-zinc-500"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <h2 className="mt-3 max-w-md truncate text-[14px] font-medium text-zinc-900 dark:text-zinc-100">
          {item.displayName}
        </h2>
        <p className="mt-1 font-mono text-[12px] text-zinc-500">
          {item.stageLabel ?? 'Preparing forensic DSP pipeline…'}
        </p>
      </section>
    );
  }

  if (item.state === 'rejected' || item.state === 'error' || !item.result) {
    return (
      <section className="flex flex-1 flex-col rounded-xl border border-black/[0.08] bg-white p-5 dark:border-white/[0.08] dark:bg-[#111113]">
        <div className="flex items-start gap-3">
          <ShieldAlert
            className="mt-0.5 h-4 w-4 shrink-0 text-red-500"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="h-[7px] w-[7px] rounded-full bg-red-500" aria-hidden="true" />
              <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-red-600 dark:text-red-400">
                {item.state === 'rejected' ? 'Rejected by Pre-Validation' : 'Analysis Error'}
              </span>
            </div>
            <h2 className="mt-1 truncate text-[14.5px] font-semibold tracking-[-0.01em] text-zinc-900 dark:text-zinc-100">
              {item.displayName}
            </h2>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              {item.error ?? 'Unable to validate or decode this file.'}
            </p>
          </div>
        </div>
      </section>
    );
  }

  const { result } = item;
  const meta = VERDICT_META[result.verdict];
  const effectiveNyquistKhz = result.metrics.effectiveNyquist / 1000;
  const canZoomHf = effectiveNyquistKhz > 13.0;
  const activeZoomHf = zoomHf && canZoomHf;

  const handleCopyMd5 = async () => {
    if (!result.metadata.md5Hash) return;
    try {
      await navigator.clipboard.writeText(result.metadata.md5Hash);
      setCopiedMd5(true);
      window.setTimeout(() => setCopiedMd5(false), 1600);
    } catch {
      // Clipboard unavailable in restricted context
    }
  };

  const iqrDisplay =
    result.metrics.cutoffIQRHz !== null
      ? result.metrics.frameCutoffMedianKhz !== null &&
        result.metrics.frameCutoffMedianKhz >= effectiveNyquistKhz - 1.0
        ? 'Nyquist'
        : `${result.metrics.cutoffIQRHz} Hz`
      : '—';

  const scorePrefix = result.metrics.evidenceScore > 0 ? '+' : '';

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-3">
      {/* 1. Compact Verdict Bar */}
      <div
        data-testid="verdict-bar"
        className="flex flex-col gap-3 rounded-xl border border-black/[0.08] bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-white/[0.08] dark:bg-[#111113]"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="inline-flex items-center gap-2">
              <span className={`h-[7px] w-[7px] rounded-full ${meta.dotClass}`} aria-hidden="true" />
              <h2 className="text-[14.5px] font-semibold tracking-[-0.015em] text-zinc-950 dark:text-zinc-50">
                {meta.title}
              </h2>
            </span>
            {result.subLabel && (
              <span className="font-mono text-[11px] text-zinc-500">
                · {result.subLabel}
              </span>
            )}
            <span className="hidden font-mono text-[11px] text-zinc-400 sm:inline">
              · {item.displayName}
            </span>
          </div>
          <p className="mt-1 text-[12.5px] leading-snug text-zinc-600 dark:text-zinc-400">
            {result.reasoning}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-4 border-t border-black/[0.07] pt-2.5 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-4 dark:border-white/[0.07]">
          <div>
            <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-zinc-500">
              Cutoff
            </div>
            <div className={`mt-0.5 font-mono text-[13.5px] font-semibold tabular-nums ${meta.textClass}`}>
              {result.cutoffKhz !== null ? `${result.cutoffKhz.toFixed(1)} kHz` : 'Full Band'}
            </div>
          </div>

          <div className="h-7 w-px bg-black/[0.07] dark:bg-white/[0.07]" aria-hidden="true" />

          <div>
            <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-zinc-500">
              Confidence
            </div>
            <div className="mt-0.5 font-mono text-[13.5px] font-semibold text-zinc-900 dark:text-zinc-100 tabular-nums">
              {result.confidence}%
            </div>
          </div>
        </div>
      </div>

      {/* 2. Primary Spectral Instrument Stage */}
      <div className="overflow-hidden rounded-xl border border-black/[0.08] bg-white dark:border-white/[0.08] dark:bg-[#111113]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/[0.07] px-3 py-2 dark:border-white/[0.07]">
          <div
            role="tablist"
            aria-label="Spectral view mode"
            className="inline-flex rounded-lg border border-black/[0.08] bg-[#F5F5F7] p-0.5 dark:border-white/[0.08] dark:bg-[#09090B]"
          >
            {(
              [
                { id: 'spectrogram', label: 'Spectrogram' },
                { id: 'spectrum', label: 'P95 Curve' },
                { id: 'split', label: 'Split' },
              ] as const
            ).map((tab) => {
              const active = view === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setView(tab.id)}
                  className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors cursor-pointer ${
                    active
                      ? 'bg-white text-zinc-950 shadow-xs dark:bg-[#18181B] dark:text-zinc-100'
                      : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2.5">
            <span className="hidden font-mono text-[11px] text-zinc-500 md:inline">
              FFT {result.metrics.fftSize} · {result.metrics.analyzedDurationSec.toFixed(0)}s ({result.metrics.analyzedSegments} seg)
            </span>

            {/* Built-in Full Band / HF Zoom (12–24 kHz) segmented toggle */}
            <div
              role="group"
              aria-label="Frequency band zoom"
              className="inline-flex rounded-lg border border-black/[0.08] bg-[#F5F5F7] p-0.5 dark:border-white/[0.08] dark:bg-[#09090B]"
            >
              <button
                type="button"
                aria-pressed={!activeZoomHf}
                onClick={() => setZoomHf(false)}
                className={`rounded-md px-2 py-1 font-mono text-[11px] font-medium transition-colors cursor-pointer ${
                  !activeZoomHf
                    ? 'bg-white text-zinc-950 shadow-xs dark:bg-[#18181B] dark:text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                }`}
              >
                Full Band
              </button>
              <button
                type="button"
                disabled={!canZoomHf}
                aria-pressed={activeZoomHf}
                onClick={() => setZoomHf(true)}
                className={`rounded-md px-2 py-1 font-mono text-[11px] font-medium transition-colors disabled:opacity-40 cursor-pointer ${
                  activeZoomHf
                    ? 'bg-white text-zinc-950 shadow-xs dark:bg-[#18181B] dark:text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                }`}
              >
                HF Zoom (12–24 kHz)
              </button>
            </div>
          </div>
        </div>

        <div className="p-3">
          {view === 'spectrogram' && (
            <SpectrogramCanvas
              spectrogram={result.spectrogram}
              effectiveNyquistKhz={effectiveNyquistKhz}
              cutoffKhz={result.cutoffKhz}
              theme={theme}
              zoomHf={activeZoomHf}
            />
          )}

          {view === 'spectrum' && (
            <FrequencyCurveCanvas
              psdCurve={result.psdCurve}
              effectiveNyquistKhz={effectiveNyquistKhz}
              cutoffKhz={result.cutoffKhz}
              theme={theme}
              zoomHf={activeZoomHf}
            />
          )}

          {view === 'split' && (
            <div className="flex flex-col gap-3">
              <SpectrogramCanvas
                spectrogram={result.spectrogram}
                effectiveNyquistKhz={effectiveNyquistKhz}
                cutoffKhz={result.cutoffKhz}
                theme={theme}
                zoomHf={activeZoomHf}
                compact
              />
              <div className="border-t border-black/[0.06] pt-3 dark:border-white/[0.06]">
                <FrequencyCurveCanvas
                  psdCurve={result.psdCurve}
                  effectiveNyquistKhz={effectiveNyquistKhz}
                  cutoffKhz={result.cutoffKhz}
                  theme={theme}
                  zoomHf={activeZoomHf}
                  compact
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 3. Tabular Monospace Studio Telemetry Strip */}
      <div className="grid grid-cols-2 divide-y divide-black/[0.07] overflow-hidden rounded-xl border border-black/[0.08] bg-white sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-6 lg:divide-x dark:divide-white/[0.07] dark:border-white/[0.08] dark:bg-[#111113]">
        <div className="px-3.5 py-2.5">
          <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-zinc-500">
            Sample Rate
          </div>
          <div className="mt-0.5 font-mono text-[13px] font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">
            {(result.metadata.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz
          </div>
          {result.metrics.browserResampled && (
            <div className="font-mono text-[10px] text-zinc-500 tabular-nums">
              Eff. {(result.metrics.effectiveSampleRate / 1000).toFixed(1)}k
            </div>
          )}
        </div>

        <div className="px-3.5 py-2.5">
          <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-zinc-500">
            Bit Depth
          </div>
          <div className="mt-0.5 font-mono text-[13px] font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">
            {result.metadata.bitDepth ? `${result.metadata.bitDepth}-bit` : result.metadata.container}
          </div>
          {result.metrics.isFake24Bit && (
            <div className="font-mono text-[10px] text-amber-600 dark:text-amber-400">
              16-bit padded
            </div>
          )}
        </div>

        <div className="px-3.5 py-2.5">
          <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-zinc-500">
            Channels
          </div>
          <div className="mt-0.5 font-mono text-[13px] font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">
            {result.metadata.channels} ch
          </div>
        </div>

        <div className="px-3.5 py-2.5">
          <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-zinc-500">
            Duration
          </div>
          <div className="mt-0.5 font-mono text-[13px] font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">
            {formatDuration(result.metadata.duration)}
          </div>
        </div>

        <div className="px-3.5 py-2.5">
          <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-zinc-500">
            Cutoff Lock IQR
          </div>
          <div className="mt-0.5 font-mono text-[13px] font-medium text-zinc-900 dark:text-zinc-100 tabular-nums">
            {iqrDisplay}
          </div>
        </div>

        <div className="px-3.5 py-2.5">
          <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-zinc-500">
            MD5
          </div>
          {result.metadata.md5Hash ? (
            <button
              type="button"
              onClick={handleCopyMd5}
              title={`Copy MD5: ${result.metadata.md5Hash}`}
              className="mt-0.5 inline-flex items-center gap-1.5 font-mono text-[12px] font-medium text-zinc-900 transition-colors hover:text-zinc-600 dark:text-zinc-100 dark:hover:text-zinc-300 cursor-pointer"
            >
              <span>{result.metadata.md5Hash.slice(0, 10)}…</span>
              {copiedMd5 ? (
                <Check className="h-3 w-3 text-emerald-500" strokeWidth={2} aria-hidden="true" />
              ) : (
                <Copy className="h-3 w-3 text-zinc-400" strokeWidth={1.5} aria-hidden="true" />
              )}
            </button>
          ) : (
            <div className="mt-0.5 font-mono text-[13px] text-zinc-500">N/A</div>
          )}
        </div>
      </div>

      {/* 4. Collapsible 6-Signal Forensic Evidence Breakdown */}
      <div className="overflow-hidden rounded-xl border border-black/[0.08] bg-white dark:border-white/[0.08] dark:bg-[#111113]">
        <button
          type="button"
          aria-expanded={evidenceOpen}
          onClick={() => setEvidenceOpen((open) => !open)}
          className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.02] cursor-pointer"
        >
          <div className="flex items-center gap-2.5">
            <span className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-zinc-500">
              Evidence Breakdown
            </span>
            <span className="font-mono text-[11px] text-zinc-500 tabular-nums">
              {result.evidenceFactors.length} signals · score {scorePrefix}{result.metrics.evidenceScore}
            </span>
          </div>
          {evidenceOpen ? (
            <ChevronUp className="h-4 w-4 text-zinc-400" strokeWidth={1.5} aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4 text-zinc-400" strokeWidth={1.5} aria-hidden="true" />
          )}
        </button>

        {evidenceOpen && (
          <div className="border-t border-black/[0.07] dark:border-white/[0.07]">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-black/[0.06] text-[10px] font-medium uppercase tracking-[0.06em] text-zinc-500 dark:border-white/[0.06]">
                    <th className="px-4 py-2 font-medium">Signal</th>
                    <th className="px-4 py-2 font-medium">Measured Value</th>
                    <th className="px-4 py-2 text-right font-medium">Impact</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/[0.05] dark:divide-white/[0.05]">
                  {result.evidenceFactors.map((factor) => {
                    const impactMeta = formatImpactLabel(factor.impact);
                    return (
                      <tr key={factor.id} className="align-top">
                        <td className="px-4 py-2">
                          <div className="text-[12.5px] font-medium text-zinc-900 dark:text-zinc-100">
                            {factor.signal}
                          </div>
                          <div className="mt-0.5 text-[11.5px] text-zinc-500">
                            {factor.detail}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 font-mono text-[12px] text-zinc-800 dark:text-zinc-200 tabular-nums">
                          {factor.measuredValue}
                        </td>
                        <td
                          className={`whitespace-nowrap px-4 py-2 text-right font-mono text-[11.5px] font-medium tabular-nums ${impactMeta.className}`}
                        >
                          {impactMeta.text}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {result.securityChecks.length > 0 && (
              <div className="border-t border-black/[0.06] px-4 py-2 font-mono text-[10.5px] text-zinc-500 dark:border-white/[0.06]">
                Security: {result.securityChecks.join(' · ')}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
