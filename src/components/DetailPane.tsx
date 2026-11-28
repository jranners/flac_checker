import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  Loader2,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { useState } from 'react';
import { VERDICT_META, type QueueItem } from '../dsp/types';
import { FrequencyCurveCanvas } from './FrequencyCurveCanvas';
import { SpectrogramCanvas } from './SpectrogramCanvas';
import type { ThemeMode } from './TopBar';

interface DetailPaneProps {
  item: QueueItem | null;
  theme: ThemeMode;
}

type VizMode = 'spectrogram' | 'curve';

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DetailPane({ item, theme }: DetailPaneProps) {
  const [vizMode, setVizMode] = useState<VizMode>('spectrogram');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [copiedMd5, setCopiedMd5] = useState(false);

  if (!item) {
    return (
      <section className="glass-panel flex flex-1 flex-col items-center justify-center rounded-3xl p-10 text-center">
        <p className="text-[15px] font-medium text-[#6E6E73] dark:text-[#98989D]">
          Select a track from the queue to inspect its forensic report.
        </p>
      </section>
    );
  }

  // Loading / Validating / Analyzing state
  if (
    item.state === 'queued' ||
    item.state === 'validating' ||
    item.state === 'analyzing'
  ) {
    return (
      <section className="glass-panel flex min-h-[460px] flex-1 flex-col items-center justify-center rounded-3xl p-10 text-center">
        <Loader2
          className="mb-4 h-7 w-7 animate-spin text-[#0A84FF]"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <h2 className="max-w-md truncate text-[17px] font-semibold tracking-tight text-[#1D1D1F] dark:text-[#F5F5F7]">
          {item.displayName}
        </h2>
        <p className="mt-1.5 text-[13px] text-[#6E6E73] dark:text-[#98989D]">
          {item.stageLabel ?? 'Preparing local forensic analysis…'}
        </p>
      </section>
    );
  }

  // Security Rejected or Processing Error state
  if (item.state === 'rejected' || item.state === 'error' || !item.result) {
    const isSecurityRejection = item.state === 'rejected';
    return (
      <section className="glass-panel flex min-h-[420px] flex-1 flex-col justify-between rounded-3xl p-6 sm:p-8">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-[#FF453A]/25 bg-[#FF453A]/12 text-[#FF453A]">
              {isSecurityRejection ? (
                <ShieldAlert className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />
              ) : (
                <AlertTriangle className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-[#C92A22] dark:text-[#FF453A]">
                {isSecurityRejection
                  ? 'Blocked by Pre-Decode Security Gate'
                  : 'Analysis Error'}
              </p>
              <h2 className="truncate text-[20px] font-semibold tracking-tight text-[#1D1D1F] dark:text-[#F5F5F7]">
                {item.displayName}
              </h2>
            </div>
          </div>

          <p className="mt-5 max-w-2xl text-[14px] leading-relaxed text-[#424245] dark:text-[#D1D1D6]">
            {item.error ?? 'The file could not be safely decoded or analyzed.'}
          </p>

          <div className="mt-6 rounded-2xl border border-black/[0.06] bg-black/[0.025] px-4 py-3 text-[12px] text-[#6E6E73] dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#98989D]">
            {isSecurityRejection
              ? 'This file was rejected during zero-trust binary header inspection before being passed to the browser audio decoder.'
              : 'The file passed header inspection, but browser decoding failed or exceeded safety timeouts.'}
            <span className="ml-2 tabular-nums">
              ({formatFileSize(item.fileSize)})
            </span>
          </div>
        </div>
      </section>
    );
  }

  const { result } = item;
  const meta = VERDICT_META[result.verdict];
  const { metadata, metrics, securityChecks } = result;
  const effectiveNyquistKhz = metrics.effectiveNyquist / 1000;

  const handleCopyMd5 = async () => {
    if (!metadata.md5Hash) return;
    try {
      await navigator.clipboard.writeText(metadata.md5Hash);
      setCopiedMd5(true);
      window.setTimeout(() => setCopiedMd5(false), 1800);
    } catch {
      // Clipboard API unavailable in restricted frame
    }
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-4">
      {/* 1. Verdict Header Card */}
      <div className="glass-panel rounded-3xl p-6 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium whitespace-nowrap ${meta.badgeClass}`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${meta.dotClass}`}
                  aria-hidden="true"
                />
                {meta.title}
              </span>

              {result.subLabel && (
                <span className="text-[12px] font-medium text-[#6E6E73] dark:text-[#98989D]">
                  {result.subLabel}
                </span>
              )}
            </div>

            <h1
              className="mt-3 truncate text-[22px] font-semibold tracking-tight text-[#1D1D1F] dark:text-[#F5F5F7] sm:text-[26px]"
              title={item.displayName}
            >
              {item.displayName}
            </h1>

            <p className="mt-2 max-w-3xl text-[14px] leading-relaxed text-[#515154] dark:text-[#AEAEB2]">
              {result.reasoning}
            </p>
          </div>

          {/* Right Key Figures: Confidence & Detected Cutoff */}
          <div className="flex items-center gap-5 rounded-2xl border border-black/[0.06] bg-black/[0.025] px-4 py-3 dark:border-white/[0.08] dark:bg-white/[0.03] shrink-0">
            <div>
              <div className="text-[11px] font-medium text-[#86868B] dark:text-[#8E8E93]">
                Confidence
              </div>
              <div className="mt-0.5 text-[20px] font-semibold tracking-tight text-[#1D1D1F] dark:text-[#F5F5F7] tabular-nums">
                {result.confidence}%
              </div>
            </div>

            <div className="h-8 w-px bg-black/[0.08] dark:bg-white/[0.1]" aria-hidden="true" />

            <div>
              <div className="text-[11px] font-medium text-[#86868B] dark:text-[#8E8E93]">
                Spectral Ceiling
              </div>
              <div className="mt-0.5 text-[20px] font-semibold tracking-tight text-[#1D1D1F] dark:text-[#F5F5F7] tabular-nums">
                {result.cutoffKhz !== null
                  ? `${result.cutoffKhz.toFixed(1)} kHz`
                  : `${effectiveNyquistKhz.toFixed(1)} kHz`}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-black/[0.06] pt-3.5 text-[12px] text-[#6E6E73] dark:border-white/[0.08] dark:text-[#98989D]">
          <span>
            Estimated source:{' '}
            <strong className="font-medium text-[#1D1D1F] dark:text-[#F5F5F7]">
              {result.estimatedSource}
            </strong>
          </span>
          {result.cutoffKhz !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">
                Detected cutoff at {result.cutoffKhz.toFixed(2)} kHz
              </span>
            </>
          )}
        </div>
      </div>

      {/* 2. Unified Metadata Strip */}
      <div className="glass-panel rounded-2xl">
        <div className="grid grid-cols-2 divide-y divide-black/[0.06] dark:divide-white/[0.08] sm:grid-cols-4 sm:divide-x sm:divide-y-0">
          {/* Sample Rate */}
          <div className="px-4 py-3.5">
            <div className="text-[11px] font-medium text-[#86868B] dark:text-[#8E8E93]">
              Sample Rate
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-1.5">
              <span className="text-[14px] font-semibold text-[#1D1D1F] dark:text-[#F5F5F7] tabular-nums">
                {(metadata.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz
              </span>
              {metrics.browserResampled && (
                <span
                  className="text-[11px] font-medium text-[#B26A00] dark:text-[#FF9F0A]"
                  title={`Browser decoded at ${(metrics.decodedSampleRate / 1000).toFixed(1)} kHz; effective Nyquist clamped to ${effectiveNyquistKhz.toFixed(1)} kHz.`}
                >
                  Resampled
                </span>
              )}
            </div>
          </div>

          {/* Bit Depth */}
          <div className="px-4 py-3.5">
            <div className="text-[11px] font-medium text-[#86868B] dark:text-[#8E8E93]">
              Bit Depth
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-1.5">
              <span className="text-[14px] font-semibold text-[#1D1D1F] dark:text-[#F5F5F7] tabular-nums">
                {metadata.bitDepth ? `${metadata.bitDepth}-bit` : 'Lossy Float'}
              </span>
              {metrics.isFake24Bit && (
                <span
                  className="text-[11px] font-medium text-[#B26A00] dark:text-[#FF9F0A]"
                  title={metrics.trueBitDepthNote ?? undefined}
                >
                  16-bit padded
                </span>
              )}
            </div>
          </div>

          {/* Duration & Channels */}
          <div className="px-4 py-3.5">
            <div className="text-[11px] font-medium text-[#86868B] dark:text-[#8E8E93]">
              Duration &amp; Channels
            </div>
            <div className="mt-1 text-[14px] font-semibold text-[#1D1D1F] dark:text-[#F5F5F7] tabular-nums">
              {formatDuration(metadata.duration)} · {metadata.channels} ch
            </div>
          </div>

          {/* Format & File Size */}
          <div className="px-4 py-3.5">
            <div className="text-[11px] font-medium text-[#86868B] dark:text-[#8E8E93]">
              Format &amp; Size
            </div>
            <div className="mt-1 truncate text-[14px] font-semibold text-[#1D1D1F] dark:text-[#F5F5F7] tabular-nums">
              {metadata.container} · {formatFileSize(item.fileSize)}
            </div>
          </div>
        </div>

        {/* FLAC MD5 Strip (when present) */}
        {metadata.md5Hash && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-black/[0.06] px-4 py-2.5 dark:border-white/[0.08]">
            <div className="flex min-w-0 items-center gap-2 text-[12px]">
              <span className="font-medium text-[#86868B] dark:text-[#8E8E93] whitespace-nowrap">
                FLAC MD5
              </span>
              <code className="truncate font-mono text-[12px] text-[#424245] dark:text-[#AEAEB2] tabular-nums">
                {metadata.md5Hash}
              </code>
            </div>
            <button
              type="button"
              onClick={handleCopyMd5}
              aria-label="Copy FLAC MD5 signature"
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium text-[#515154] transition-colors hover:bg-black/[0.05] hover:text-[#1D1D1F] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0A84FF] dark:text-[#AEAEB2] dark:hover:bg-white/[0.08] dark:hover:text-[#F5F5F7] whitespace-nowrap"
            >
              {copiedMd5 ? (
                <>
                  <Check className="h-3 w-3 text-[#30D158]" strokeWidth={1.5} aria-hidden="true" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
                  <span>Copy MD5</span>
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {/* 3. Visualization Card with Apple Segmented Control */}
      <div className="glass-panel rounded-3xl p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight text-[#1D1D1F] dark:text-[#F5F5F7]">
              {vizMode === 'spectrogram'
                ? 'Spectral Time-Frequency Map'
                : 'P95 vs. Mean Power Spectral Density'}
            </h2>
            <p className="mt-0.5 text-[12px] text-[#86868B] dark:text-[#8E8E93] tabular-nums">
              {metrics.analyzedSegments}{' '}
              {metrics.analyzedSegments === 1 ? 'segment' : 'transient-guided segments'}{' '}
              · {metrics.analyzedDurationSec.toFixed(1)} s analyzed · N={metrics.fftSize} FFT
            </p>
          </div>

          <div
            role="tablist"
            aria-label="Visualization mode"
            className="inline-flex items-center rounded-full border border-black/[0.06] bg-black/[0.045] p-0.5 dark:border-white/[0.09] dark:bg-white/[0.06]"
          >
            <button
              type="button"
              role="tab"
              aria-selected={vizMode === 'spectrogram'}
              onClick={() => setVizMode('spectrogram')}
              className={`rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-all duration-200 ease-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0A84FF] whitespace-nowrap ${
                vizMode === 'spectrogram'
                  ? 'bg-white text-[#1D1D1F] shadow-sm dark:bg-[#2C2C2E] dark:text-[#F5F5F7]'
                  : 'text-[#6E6E73] hover:text-[#1D1D1F] dark:text-[#98989D] dark:hover:text-[#F5F5F7]'
              }`}
            >
              Spectrogram
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={vizMode === 'curve'}
              onClick={() => setVizMode('curve')}
              className={`rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-all duration-200 ease-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0A84FF] whitespace-nowrap ${
                vizMode === 'curve'
                  ? 'bg-white text-[#1D1D1F] shadow-sm dark:bg-[#2C2C2E] dark:text-[#F5F5F7]'
                  : 'text-[#6E6E73] hover:text-[#1D1D1F] dark:text-[#98989D] dark:hover:text-[#F5F5F7]'
              }`}
            >
              Frequency Curve
            </button>
          </div>
        </div>

        {vizMode === 'spectrogram' ? (
          <SpectrogramCanvas
            spectrogram={result.spectrogram}
            effectiveNyquistKhz={effectiveNyquistKhz}
            cutoffKhz={result.cutoffKhz}
            theme={theme}
          />
        ) : (
          <FrequencyCurveCanvas
            psdCurve={result.psdCurve}
            effectiveNyquistKhz={effectiveNyquistKhz}
            cutoffKhz={result.cutoffKhz}
            theme={theme}
          />
        )}
      </div>

      {/* 4. Collapsible Forensic Diagnostics Disclosure (Collapsed by default) */}
      <div className="glass-panel scroll-mt-24 rounded-2xl">
        <button
          type="button"
          onClick={() => setDiagnosticsOpen((prev) => !prev)}
          aria-expanded={diagnosticsOpen}
          className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03] rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0A84FF]"
        >
          <div className="flex items-center gap-2">
            <ChevronRight
              className={`h-4 w-4 text-[#6E6E73] transition-transform duration-200 ease-out dark:text-[#98989D] ${
                diagnosticsOpen ? 'rotate-90' : ''
              }`}
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <span className="text-[13px] font-semibold tracking-tight text-[#1D1D1F] dark:text-[#F5F5F7]">
              Forensic Diagnostics
            </span>
          </div>

          <span className="inline-flex items-center gap-1.5 text-[12px] text-[#6E6E73] dark:text-[#98989D]">
            <ShieldCheck className="h-3.5 w-3.5 text-[#30D158]" strokeWidth={1.5} aria-hidden="true" />
            <span className="hidden sm:inline">Magic bytes verified · Bounds checked</span>
            <span className="sm:hidden">Verified</span>
          </span>
        </button>

        {diagnosticsOpen && (
          <div className="border-t border-black/[0.06] px-5 pt-4 pb-5 dark:border-white/[0.08]">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
              <div>
                <dt className="text-[11px] font-medium text-[#86868B] dark:text-[#8E8E93]">
                  Cliff Slope
                </dt>
                <dd className="mt-0.5 text-[13px] font-semibold text-[#1D1D1F] dark:text-[#F5F5F7] tabular-nums">
                  {metrics.cliffSlopeDbPerKhz.toFixed(1)} dB/kHz
                </dd>
              </div>

              <div>
                <dt className="text-[11px] font-medium text-[#86868B] dark:text-[#8E8E93]">
                  Dead-Zone Floor
                </dt>
                <dd className="mt-0.5 text-[13px] font-semibold text-[#1D1D1F] dark:text-[#F5F5F7] tabular-nums">
                  {metrics.deadZoneFloorDb.toFixed(1)} dBFS
                </dd>
              </div>

              <div>
                <dt className="text-[11px] font-medium text-[#86868B] dark:text-[#8E8E93]">
                  Temporal Variance Drop
                </dt>
                <dd className="mt-0.5 text-[13px] font-semibold text-[#1D1D1F] dark:text-[#F5F5F7] tabular-nums">
                  {metrics.temporalVarianceDropDb.toFixed(2)} dB (σ={metrics.aboveCutoffStdDb.toFixed(1)})
                </dd>
              </div>

              <div>
                <dt className="text-[11px] font-medium text-[#86868B] dark:text-[#8E8E93]">
                  8–13 kHz Reference
                </dt>
                <dd className="mt-0.5 text-[13px] font-semibold text-[#1D1D1F] dark:text-[#F5F5F7] tabular-nums">
                  {metrics.referenceBand8To13KhzDb.toFixed(1)} dBFS
                </dd>
              </div>

              <div>
                <dt className="text-[11px] font-medium text-[#86868B] dark:text-[#8E8E93]">
                  Spectral Holes (&gt;14 kHz)
                </dt>
                <dd className="mt-0.5 text-[13px] font-semibold text-[#1D1D1F] dark:text-[#F5F5F7] tabular-nums">
                  {metrics.spectralHolePercent.toFixed(2)}%
                </dd>
              </div>

              <div>
                <dt className="text-[11px] font-medium text-[#86868B] dark:text-[#8E8E93]">
                  16 kHz Shelf (sfb21)
                </dt>
                <dd className="mt-0.5 text-[13px] font-semibold text-[#1D1D1F] dark:text-[#F5F5F7] tabular-nums">
                  {metrics.has16KhzShelf
                    ? `Detected (${metrics.shelf16KhzDropDb.toFixed(1)} dB)`
                    : `None (${metrics.shelf16KhzDropDb.toFixed(1)} dB)`}
                </dd>
              </div>

              <div>
                <dt className="text-[11px] font-medium text-[#86868B] dark:text-[#8E8E93]">
                  HF Stereo Collapse
                </dt>
                <dd className="mt-0.5 text-[13px] font-semibold text-[#1D1D1F] dark:text-[#F5F5F7] tabular-nums">
                  {metrics.hfStereoCollapseDb !== null
                    ? `${metrics.hfStereoCollapseDb.toFixed(1)} dB`
                    : 'N/A (Mono)'}
                </dd>
              </div>

              <div>
                <dt className="text-[11px] font-medium text-[#86868B] dark:text-[#8E8E93]">
                  Resampling Guard
                </dt>
                <dd className="mt-0.5 text-[13px] font-semibold text-[#1D1D1F] dark:text-[#F5F5F7] tabular-nums">
                  {metrics.browserResampled
                    ? `Clamped (${effectiveNyquistKhz.toFixed(1)} kHz)`
                    : 'Native Rate'}
                </dd>
              </div>

              {metrics.trueBitDepthNote && (
                <div className="col-span-2">
                  <dt className="text-[11px] font-medium text-[#86868B] dark:text-[#8E8E93]">
                    Raw PCM Bit-Depth Check
                  </dt>
                  <dd className="mt-0.5 text-[13px] font-semibold text-[#1D1D1F] dark:text-[#F5F5F7]">
                    {metrics.trueBitDepthNote}
                  </dd>
                </div>
              )}
            </dl>

            {/* Security Validation Summary */}
            <div className="mt-5 border-t border-black/[0.06] pt-3.5 dark:border-white/[0.08]">
              <p className="text-[11px] font-medium text-[#86868B] dark:text-[#8E8E93]">
                Security Validation Checks
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[#515154] dark:text-[#AEAEB2]">
                {securityChecks.map((check, idx) => (
                  <span key={check} className="inline-flex items-center gap-1.5">
                    {idx > 0 && (
                      <span className="opacity-40" aria-hidden="true">
                        ·
                      </span>
                    )}
                    <span>{check}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
