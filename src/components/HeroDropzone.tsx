import { Activity, AudioWaveform, Shield, Upload } from 'lucide-react';

interface HeroDropzoneProps {
  isDragging: boolean;
  onChooseFiles: () => void;
}

export function HeroDropzone({ isDragging, onChooseFiles }: HeroDropzoneProps) {
  return (
    <section className="mx-auto flex w-full max-w-[980px] flex-1 flex-col justify-center px-4 py-8 sm:px-6 sm:py-12">
      {/* Primary Centered Glass Drop Canvas */}
      <div
        className={`glass-panel rounded-3xl p-4 sm:p-5 transition-all duration-200 ease-out ${
          isDragging
            ? 'ring-2 ring-[#0A84FF]/60 scale-[1.005]'
            : ''
        }`}
      >
        <div
          className={`flex flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-16 text-center transition-colors duration-200 sm:px-12 sm:py-20 ${
            isDragging
              ? 'border-[#0A84FF] bg-[#0A84FF]/[0.06]'
              : 'border-black/[0.12] bg-black/[0.015] dark:border-white/[0.14] dark:bg-white/[0.02]'
          }`}
        >
          <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl border border-black/[0.06] bg-white/80 text-[#1D1D1F] shadow-sm dark:border-white/[0.1] dark:bg-white/[0.08] dark:text-[#F5F5F7]">
            <Upload className="h-6 w-6" strokeWidth={1.5} aria-hidden="true" />
          </div>

          <h1 className="max-w-lg text-[26px] font-semibold tracking-tight text-[#1D1D1F] dark:text-[#F5F5F7] sm:text-[32px] [text-wrap:balance]">
            Drop audio files to verify
          </h1>

          <p className="mt-2.5 max-w-md text-[14px] leading-relaxed text-[#6E6E73] dark:text-[#98989D]">
            Inspect lossless integrity, spectral cutoffs, and transcode fingerprints directly in your browser.
          </p>

          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={onChooseFiles}
              className="inline-flex items-center gap-2 rounded-full bg-[#1D1D1F] px-6 py-2.5 text-[14px] font-medium text-white shadow-sm transition-all duration-200 ease-out hover:bg-[#323236] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0A84FF] dark:bg-[#F5F5F7] dark:text-[#0B0B0E] dark:hover:bg-white whitespace-nowrap"
            >
              Choose Files
            </button>
          </div>

          <p className="mt-5 text-[12px] font-medium tracking-wide text-[#86868B] dark:text-[#8E8E93] tabular-nums">
            .flac · .wav · .aiff · .mp3 · .m4a · .ogg
          </p>
        </div>
      </div>

      {/* Three Restrained Minimal Info Cards Below the Fold */}
      <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
        <article className="glass-panel rounded-2xl p-5">
          <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-xl bg-black/[0.04] text-[#1D1D1F] dark:bg-white/[0.07] dark:text-[#F5F5F7]">
            <Activity className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
          </div>
          <h2 className="text-[14px] font-semibold tracking-tight text-[#1D1D1F] dark:text-[#F5F5F7]">
            P95 Spectral Forensics
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[#6E6E73] dark:text-[#98989D]">
            Transient-guided sampling and 95th-percentile PSD envelopes capture fleeting cymbals and room air so quiet acoustic recordings aren&apos;t falsely flagged.
          </p>
        </article>

        <article className="glass-panel rounded-2xl p-5">
          <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-xl bg-black/[0.04] text-[#1D1D1F] dark:bg-white/[0.07] dark:text-[#F5F5F7]">
            <AudioWaveform className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
          </div>
          <h2 className="text-[14px] font-semibold tracking-tight text-[#1D1D1F] dark:text-[#F5F5F7]">
            Transcode Cutoffs
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[#6E6E73] dark:text-[#98989D]">
            Detects brickwall cliffs at 16–20.5 kHz, LAME 16 kHz shelves, psychoacoustic spectral holes, padded 24-bit WAVs, and Hi-Res upsamples.
          </p>
        </article>

        <article className="glass-panel rounded-2xl p-5">
          <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-xl bg-black/[0.04] text-[#1D1D1F] dark:bg-white/[0.07] dark:text-[#F5F5F7]">
            <Shield className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
          </div>
          <h2 className="text-[14px] font-semibold tracking-tight text-[#1D1D1F] dark:text-[#F5F5F7]">
            Client-Side Security
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[#6E6E73] dark:text-[#98989D]">
            Magic-byte header inspection, bounds-checked parsing, and decoded memory limits reject disguised or malformed files before decoding.
          </p>
        </article>
      </div>
    </section>
  );
}
