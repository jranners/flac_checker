interface HeroDropzoneProps {
  isDragging: boolean;
  onChooseFiles: () => void;
}

const FORMATS = ['FLAC', 'WAV', 'AIFF', 'MP3', 'M4A', 'OGG'];

export function HeroDropzone({ isDragging, onChooseFiles }: HeroDropzoneProps) {
  return (
    <section className="flex flex-1 flex-col items-center justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-lg">
        <div
          className={`flex flex-col items-center justify-center rounded-xl border px-6 py-11 text-center transition-colors duration-150 ${
            isDragging
              ? 'border-zinc-900 bg-zinc-200/50 dark:border-zinc-300 dark:bg-[#18181B]'
              : 'border-dashed border-black/[0.14] bg-white hover:border-black/[0.24] dark:border-white/[0.12] dark:bg-[#111113] dark:hover:border-white/[0.22]'
          }`}
        >
          <h1 className="text-[15px] font-medium tracking-[-0.015em] text-zinc-900 dark:text-zinc-100">
            {isDragging ? 'Release to inspect audio files' : 'Drop audio files to inspect'}
          </h1>

          <p className="mt-1.5 font-mono text-[11px] tracking-[0.06em] text-zinc-500">
            {FORMATS.join(' · ')}
          </p>

          <div className="mt-5 flex items-center gap-3">
            <button
              type="button"
              onClick={onChooseFiles}
              className="inline-flex h-8 items-center justify-center rounded-lg bg-zinc-900 px-3.5 text-[12.5px] font-medium text-white transition-colors hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white cursor-pointer"
            >
              Open Files
            </button>
            <span className="font-mono text-[11px] text-zinc-500">
              ⌘O / Ctrl+O
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
