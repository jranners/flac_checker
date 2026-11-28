import { Loader2 } from 'lucide-react';
import { computeQueueProgress } from '../dsp/queueProgress';
import { VERDICT_META, type QueueItem } from '../dsp/types';

interface BatchSidebarProps {
  items: QueueItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function formatCompactSubline(item: QueueItem): string {
  if (item.state === 'done' && item.result) {
    const { metadata, metrics, cutoffKhz } = item.result;
    const srKhz = (metadata.sampleRate / 1000).toFixed(1).replace(/\.0$/, '');
    const depth = metadata.bitDepth ? `${metadata.bitDepth}b` : metadata.container;
    const bw =
      cutoffKhz !== null
        ? `${cutoffKhz.toFixed(1)} kHz`
        : metrics.frameCutoffMedianKhz !== null
          ? `${metrics.frameCutoffMedianKhz.toFixed(1)} kHz`
          : `${(metrics.effectiveNyquist / 1000).toFixed(1)} kHz`;
    return `${srKhz}k · ${depth} · ${bw}`;
  }
  if (item.state === 'rejected') return 'Rejected · Security check';
  if (item.state === 'error') return 'Decode error';
  return item.stageLabel ?? 'Queued…';
}

export function BatchSidebar({ items, selectedId, onSelect }: BatchSidebarProps) {
  const progress = computeQueueProgress(items);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (items.length <= 1) return;
    const currentIdx = items.findIndex((i) => i.id === selectedId);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = items[(currentIdx + 1) % items.length];
      if (next) onSelect(next.id);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const prev = items[(currentIdx - 1 + items.length) % items.length];
      if (prev) onSelect(prev.id);
    }
  };

  return (
    <aside
      aria-label="Audio inspection queue"
      onKeyDown={handleKeyDown}
      className="flex w-full shrink-0 flex-col overflow-hidden rounded-xl border border-black/[0.08] bg-white lg:sticky lg:top-14 lg:max-h-[calc(100vh-4.5rem)] lg:w-[268px] dark:border-white/[0.08] dark:bg-[#111113]"
    >
      {/* Global aggregate queue progress bar */}
      <div
        className="border-b border-black/[0.07] px-3 py-2.5 dark:border-white/[0.07]"
        data-testid="batch-global-progress"
      >
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-zinc-500">
            Queue
          </span>
          <span className="font-mono text-[11px] text-zinc-500 tabular-nums">
            {progress.completed}/{progress.total} · {progress.percent}%
          </span>
        </div>

        <div
          role="progressbar"
          aria-label="Queue analysis progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress.percent}
          className="h-[3px] w-full overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.08]"
        >
          <div
            className={`h-full rounded-full transition-[width,background-color] duration-300 ease-out ${
              progress.isComplete
                ? 'bg-emerald-500'
                : 'bg-zinc-900 dark:bg-zinc-100'
            }`}
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      </div>

      {/* Dense macOS source list */}
      <div
        role="listbox"
        aria-label="Files"
        className="flex-1 space-y-0.5 overflow-y-auto p-1.5"
      >
        {items.map((item) => {
          const isSelected = item.id === selectedId;
          const isActive =
            item.state === 'queued' ||
            item.state === 'validating' ||
            item.state === 'analyzing';

          let dotClass = 'bg-zinc-400';
          if (item.state === 'done' && item.result) {
            dotClass = VERDICT_META[item.result.verdict].dotClass;
          } else if (item.state === 'rejected' || item.state === 'error') {
            dotClass = 'bg-red-500';
          }

          return (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={isSelected}
              onClick={() => onSelect(item.id)}
              className={`group flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors cursor-pointer ${
                isSelected
                  ? 'bg-black/[0.06] dark:bg-white/[0.07]'
                  : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.035]'
              }`}
            >
              <span className="mt-[5px] flex h-2 w-2 shrink-0 items-center justify-center">
                {isActive ? (
                  <Loader2
                    className="h-3 w-3 animate-spin text-zinc-400"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                ) : (
                  <span
                    className={`h-[7px] w-[7px] rounded-full ${dotClass}`}
                    aria-hidden="true"
                  />
                )}
              </span>

              <span className="min-w-0 flex-1">
                <span
                  className={`block truncate text-[12.5px] leading-snug ${
                    isSelected
                      ? 'font-medium text-zinc-950 dark:text-zinc-50'
                      : 'font-normal text-zinc-800 dark:text-zinc-300'
                  }`}
                  title={item.displayName}
                >
                  {item.displayName}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[10.5px] text-zinc-500 tabular-nums">
                  {formatCompactSubline(item)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
