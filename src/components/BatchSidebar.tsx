import {
  ChevronDown,
  ChevronUp,
  Download,
  Loader2,
  Plus,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { VERDICT_META, type QueueItem } from '../dsp/types';

interface BatchSidebarProps {
  items: QueueItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddFiles: () => void;
  onExportCsv: () => void;
  onClearAll: () => void;
}

function formatSubline(item: QueueItem): string {
  if (item.state === 'done' && item.result) {
    const { metadata, cutoffKhz, metrics } = item.result;
    const sr = `${(metadata.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`;
    const bd = metadata.bitDepth ? `${metadata.bitDepth}-bit` : metadata.container;
    const ceiling =
      cutoffKhz !== null
        ? `${cutoffKhz.toFixed(1)} kHz`
        : `${(metrics.effectiveNyquist / 1000).toFixed(1)} kHz`;
    return `${sr} · ${bd} · ${ceiling}`;
  }
  if (item.state === 'rejected') {
    return item.error ?? 'Blocked by security validation';
  }
  if (item.state === 'error') {
    return item.error ?? 'Analysis failed';
  }
  return item.stageLabel ?? 'Queued…';
}

export function BatchSidebar({
  items,
  selectedId,
  onSelect,
  onAddFiles,
  onExportCsv,
  onClearAll,
}: BatchSidebarProps) {
  const [mobileExpanded, setMobileExpanded] = useState(true);
  const completedCount = items.filter(
    (i) => i.state === 'done' || i.state === 'rejected' || i.state === 'error',
  ).length;

  return (
    <aside
      aria-label="Track queue"
      className="glass-panel flex w-full flex-col rounded-3xl lg:sticky lg:top-[72px] lg:max-h-[calc(100vh-92px)] lg:w-[320px] xl:w-[344px] lg:shrink-0"
    >
      {/* Sidebar Toolbar */}
      <div className="flex items-center justify-between gap-2 border-b border-black/[0.06] px-4 py-3 dark:border-white/[0.08]">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-[13px] font-semibold tracking-tight text-[#1D1D1F] dark:text-[#F5F5F7] whitespace-nowrap">
            Queue
          </h2>
          <span className="text-[12px] text-[#86868B] dark:text-[#8E8E93] tabular-nums">
            {items.length}
          </span>
          <button
            type="button"
            onClick={() => setMobileExpanded((prev) => !prev)}
            aria-expanded={mobileExpanded}
            aria-label={mobileExpanded ? 'Collapse queue list' : 'Expand queue list'}
            className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-full text-[#6E6E73] hover:bg-black/[0.05] dark:text-[#98989D] dark:hover:bg-white/[0.08] lg:hidden"
          >
            {mobileExpanded ? (
              <ChevronUp className="h-4 w-4" strokeWidth={1.5} />
            ) : (
              <ChevronDown className="h-4 w-4" strokeWidth={1.5} />
            )}
          </button>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onAddFiles}
            className="inline-flex h-8 items-center gap-1 rounded-full bg-[#1D1D1F] px-3 text-[12px] font-medium text-white transition-all duration-200 hover:bg-[#323236] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0A84FF] dark:bg-[#F5F5F7] dark:text-[#0B0B0E] dark:hover:bg-white whitespace-nowrap"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
            <span>Add</span>
          </button>

          <button
            type="button"
            onClick={onExportCsv}
            disabled={completedCount === 0}
            aria-label="Export CSV report"
            className="inline-flex h-8 items-center gap-1 rounded-full border border-black/[0.08] bg-white/60 px-2.5 text-[12px] font-medium text-[#1D1D1F] transition-all duration-200 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0A84FF] dark:border-white/[0.1] dark:bg-white/[0.06] dark:text-[#F5F5F7] dark:hover:bg-white/[0.12] whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
            <span>Export CSV</span>
          </button>

          <button
            type="button"
            onClick={onClearAll}
            aria-label="Clear queue"
            title="Clear queue"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[#6E6E73] transition-colors duration-200 hover:bg-black/[0.05] hover:text-[#FF453A] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0A84FF] dark:text-[#8E8E93] dark:hover:bg-white/[0.08] dark:hover:text-[#FF453A]"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* Queue List */}
      <div
        className={`${
          mobileExpanded ? 'block' : 'hidden lg:block'
        } max-h-[260px] overflow-y-auto p-2 lg:max-h-none lg:flex-1`}
      >
        <ul className="space-y-1" role="listbox" aria-label="Analyzed audio files">
          {items.map((item) => {
            const isSelected = item.id === selectedId;
            const verdictMeta =
              item.state === 'done' && item.result
                ? VERDICT_META[item.result.verdict]
                : null;

            return (
              <li key={item.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => onSelect(item.id)}
                  className={`group flex w-full flex-col gap-1 rounded-2xl px-3 py-2.5 text-left transition-all duration-200 ease-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0A84FF] ${
                    isSelected
                      ? 'bg-[#0A84FF]/[0.12] ring-1 ring-[#0A84FF]/30 dark:bg-white/[0.11] dark:ring-white/[0.16]'
                      : 'hover:bg-black/[0.035] dark:hover:bg-white/[0.05]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className="truncate text-[13px] font-medium text-[#1D1D1F] dark:text-[#F5F5F7]"
                      title={item.displayName}
                    >
                      {item.displayName}
                    </span>

                    {item.state === 'done' && verdictMeta ? (
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap shrink-0 ${verdictMeta.badgeClass}`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${verdictMeta.dotClass}`}
                          aria-hidden="true"
                        />
                        {verdictMeta.shortLabel}
                      </span>
                    ) : item.state === 'rejected' ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-[#FF453A]/25 bg-[#FF453A]/12 px-2 py-0.5 text-[11px] font-medium text-[#C92A22] dark:text-[#FF453A] whitespace-nowrap shrink-0">
                        <ShieldAlert className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
                        Rejected
                      </span>
                    ) : item.state === 'error' ? (
                      <span className="inline-flex items-center rounded-full border border-[#FF453A]/25 bg-[#FF453A]/12 px-2 py-0.5 text-[11px] font-medium text-[#C92A22] dark:text-[#FF453A] whitespace-nowrap shrink-0">
                        Error
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#6E6E73] dark:text-[#98989D] whitespace-nowrap shrink-0">
                        <Loader2 className="h-3 w-3 animate-spin" strokeWidth={1.5} aria-hidden="true" />
                        Working
                      </span>
                    )}
                  </div>

                  <p className="truncate text-[12px] text-[#6E6E73] dark:text-[#8E8E93] tabular-nums">
                    {formatSubline(item)}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
