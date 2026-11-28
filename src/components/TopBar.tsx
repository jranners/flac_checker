import { Download, Moon, Plus, Sun, Trash2 } from 'lucide-react';

export type ThemeMode = 'light' | 'dark';

interface TopBarProps {
  theme: ThemeMode;
  onThemeChange: (next: ThemeMode) => void;
  hasFiles: boolean;
  hasExportable: boolean;
  onAddFiles: () => void;
  onExportCsv: () => void;
  onClearAll: () => void;
}

export function TopBar({
  theme,
  onThemeChange,
  hasFiles,
  hasExportable,
  onAddFiles,
  onExportCsv,
  onClearAll,
}: TopBarProps) {
  const isDark = theme === 'dark';

  return (
    <header className="sticky top-0 z-30 h-11 w-full border-b border-black/[0.08] bg-white/80 backdrop-blur-md dark:border-white/[0.08] dark:bg-[#111113]/80">
      <div className="mx-auto flex h-full max-w-[1440px] items-center justify-between gap-3 px-4 sm:px-5">
        {/* Left: Minimal geometric waveform mark + wordmark */}
        <div className="flex items-center gap-2">
          <svg
            width="15"
            height="15"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            className="text-zinc-900 dark:text-zinc-100"
          >
            <rect x="1" y="6" width="1.75" height="4" rx="0.75" fill="currentColor" opacity="0.55" />
            <rect x="4.25" y="3.5" width="1.75" height="9" rx="0.75" fill="currentColor" opacity="0.8" />
            <rect x="7.5" y="1.5" width="1.75" height="13" rx="0.75" fill="currentColor" />
            <rect x="10.75" y="4.5" width="1.75" height="7" rx="0.75" fill="currentColor" opacity="0.8" />
            <rect x="14" y="6.5" width="1.5" height="3" rx="0.75" fill="currentColor" opacity="0.55" />
          </svg>
          <span className="text-[13.5px] font-semibold tracking-[-0.02em] text-zinc-900 dark:text-zinc-100">
            TrueFLAC
          </span>
        </div>

        {/* Right: Dense 44px toolbar actions + inline privacy label + theme icon */}
        <div className="flex items-center gap-1.5">
          {hasFiles ? (
            <>
              <button
                type="button"
                onClick={onAddFiles}
                className="inline-flex h-7 items-center gap-1 rounded-lg bg-zinc-900 px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                <span>Add</span>
              </button>

              <button
                type="button"
                onClick={onExportCsv}
                disabled={!hasExportable}
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-black/[0.08] bg-transparent px-2.5 text-[12px] font-medium text-zinc-700 transition-colors hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/[0.08] dark:text-zinc-300 dark:hover:bg-white/[0.06] cursor-pointer"
              >
                <Download className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
                <span className="hidden sm:inline">Export CSV</span>
              </button>

              <button
                type="button"
                onClick={onClearAll}
                aria-label="Clear queue"
                title="Clear queue"
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-black/[0.08] text-zinc-500 transition-colors hover:bg-black/[0.04] hover:text-zinc-900 dark:border-white/[0.08] dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100 cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
              </button>

              <span
                className="mx-1 hidden h-3.5 w-px bg-black/[0.08] md:inline-block dark:bg-white/[0.08]"
                aria-hidden="true"
              />
            </>
          ) : null}

          <span className="hidden pr-1 font-mono text-[11px] text-zinc-500 md:inline">
            Local Engine · Zero Uploads
          </span>

          <button
            type="button"
            onClick={() => onThemeChange(isDark ? 'light' : 'dark')}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-black/[0.08] text-zinc-600 transition-colors hover:bg-black/[0.04] hover:text-zinc-900 dark:border-white/[0.08] dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100 cursor-pointer"
          >
            {isDark ? (
              <Sun className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
            ) : (
              <Moon className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
