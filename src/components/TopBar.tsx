import { Moon, ShieldCheck, Sun } from 'lucide-react';

export type ThemeMode = 'light' | 'dark';

interface TopBarProps {
  theme: ThemeMode;
  onThemeChange: (next: ThemeMode) => void;
}

export function TopBar({ theme, onThemeChange }: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 px-4 pt-3 pb-2 sm:px-6">
      <div className="glass-bar mx-auto flex max-w-[1360px] items-center justify-between gap-4 rounded-full px-4 py-2 sm:px-5">
        {/* Brand Wordmark + Minimalist Waveform Mark */}
        <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
          <span
            className="flex h-7 w-7 items-center justify-center rounded-full bg-[#1D1D1F] text-white dark:bg-white dark:text-[#0B0B0E]"
            aria-hidden="true"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M2.25 8.75V7.25M5.125 11.25V4.75M8 13V3M10.875 10.5V5.5M13.75 8.75V7.25"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-[#1D1D1F] dark:text-[#F5F5F7]">
            TrueFLAC
          </span>
        </div>

        {/* Right: Subtle Privacy Pill + Apple Segmented Theme Toggle */}
        <div className="flex items-center gap-2.5 shrink-0">
          <div
            className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-black/[0.06] bg-black/[0.03] px-3 py-1 text-[12px] font-medium text-[#515154] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#A1A1A6] whitespace-nowrap"
            title="All audio decoding and spectral analysis run locally inside your browser. No files are ever uploaded."
          >
            <ShieldCheck
              className="h-3.5 w-3.5 text-[#30D158] shrink-0"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <span>100% Local · Zero Uploads</span>
          </div>

          <div
            role="group"
            aria-label="Appearance"
            className="inline-flex items-center rounded-full border border-black/[0.06] bg-black/[0.045] p-0.5 dark:border-white/[0.09] dark:bg-white/[0.06]"
          >
            <button
              type="button"
              onClick={() => onThemeChange('light')}
              aria-label="Light mode"
              aria-pressed={theme === 'light'}
              className={`inline-flex h-7 w-8 items-center justify-center rounded-full transition-all duration-200 ease-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0A84FF] ${
                theme === 'light'
                  ? 'bg-white text-[#1D1D1F] shadow-sm'
                  : 'text-[#6E6E73] hover:text-[#1D1D1F] dark:text-[#8E8E93] dark:hover:text-[#F5F5F7]'
              }`}
            >
              <Sun className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
            <button
              type="button"
              onClick={() => onThemeChange('dark')}
              aria-label="Dark mode"
              aria-pressed={theme === 'dark'}
              className={`inline-flex h-7 w-8 items-center justify-center rounded-full transition-all duration-200 ease-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0A84FF] ${
                theme === 'dark'
                  ? 'bg-[#2C2C2E] text-[#F5F5F7] shadow-sm'
                  : 'text-[#6E6E73] hover:text-[#1D1D1F] dark:text-[#8E8E93] dark:hover:text-[#F5F5F7]'
              }`}
            >
              <Moon className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
