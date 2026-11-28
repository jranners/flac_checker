import { useCallback, useEffect, useRef, useState } from 'react';
import { BatchSidebar } from './components/BatchSidebar';
import { DetailPane } from './components/DetailPane';
import { HeroDropzone } from './components/HeroDropzone';
import { TopBar, type ThemeMode } from './components/TopBar';
import { analyzeAudioFile, collectDroppedFiles } from './dsp/analyzeTrack';
import type { QueueItem } from './dsp/types';
import {
  SECURITY_LIMITS,
  SecurityValidationError,
} from './security/fileValidator';
import { exportQueueToCsv, sanitizeFilename } from './security/sanitize';

function getInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function App() {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [batchNotice, setBatchNotice] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const activeRunIdRef = useRef(0);

  // Sync Tailwind v4 `.dark` class on <html>
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
  }, [theme]);

  // Global keyboard shortcuts: Cmd/Ctrl+O to open files, ArrowUp/ArrowDown to step queue
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        fileInputRef.current?.click();
        return;
      }
      if (queue.length <= 1) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          target.closest('[role="listbox"]'))
      ) {
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const idx = queue.findIndex((item) => item.id === selectedId);
      const current = idx >= 0 ? idx : 0;
      const nextIdx =
        event.key === 'ArrowDown'
          ? (current + 1) % queue.length
          : (current - 1 + queue.length) % queue.length;
      const nextItem = queue[nextIdx];
      if (nextItem) setSelectedId(nextItem.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [queue, selectedId]);

  const updateItem = useCallback(
    (id: string, patch: Partial<QueueItem>) => {
      setQueue((prev) =>
        prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      );
    },
    [],
  );

  const enqueueFiles = useCallback(
    (incomingFiles: File[]) => {
      if (incomingFiles.length === 0) return;

      setBatchNotice(null);
      let filesToProcess = incomingFiles;

      if (filesToProcess.length > SECURITY_LIMITS.MAX_BATCH_FILES) {
        setBatchNotice(
          `Batch capped at ${SECURITY_LIMITS.MAX_BATCH_FILES} files for memory safety (${filesToProcess.length - SECURITY_LIMITS.MAX_BATCH_FILES} skipped).`,
        );
        filesToProcess = filesToProcess.slice(0, SECURITY_LIMITS.MAX_BATCH_FILES);
      }

      const runToken = activeRunIdRef.current;
      const newItems: Array<{ id: string; file: File; entry: QueueItem }> =
        filesToProcess.map((file, index) => {
          const id = `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
          return {
            id,
            file,
            entry: {
              id,
              displayName: sanitizeFilename(file.name),
              fileSize: file.size,
              state: 'queued',
              stageLabel: 'Queued…',
            },
          };
        });

      setQueue((prev) => {
        const remainingSlots = Math.max(
          0,
          SECURITY_LIMITS.MAX_BATCH_FILES - prev.length,
        );
        if (remainingSlots === 0) {
          setBatchNotice(
            `Queue limit reached (${SECURITY_LIMITS.MAX_BATCH_FILES} files max). Clear the queue to analyze more tracks.`,
          );
          return prev;
        }
        const accepted = newItems.slice(0, remainingSlots);
        if (accepted.length < newItems.length) {
          setBatchNotice(
            `Added ${accepted.length} file(s); queue is capped at ${SECURITY_LIMITS.MAX_BATCH_FILES} files.`,
          );
        }
        return [...prev, ...accepted.map((a) => a.entry)];
      });

      setSelectedId((prev) => prev ?? newItems[0]?.id ?? null);

      // Process with bounded concurrency (2 files at a time)
      const pending = [...newItems];
      const concurrency = 2;

      const runNext = async (): Promise<void> => {
        while (pending.length > 0) {
          if (activeRunIdRef.current !== runToken) return;
          const next = pending.shift();
          if (!next) return;

          updateItem(next.id, {
            state: 'validating',
            stageLabel: 'Validating header…',
          });

          try {
            const result = await analyzeAudioFile(next.file, {
              onStage: (stageLabel) => {
                if (activeRunIdRef.current !== runToken) return;
                updateItem(next.id, {
                  state: stageLabel.startsWith('Validating')
                    ? 'validating'
                    : 'analyzing',
                  stageLabel,
                });
              },
              onValidated: (securityChecks) => {
                if (activeRunIdRef.current !== runToken) return;
                updateItem(next.id, { securityChecks });
              },
            });

            if (activeRunIdRef.current !== runToken) return;
            updateItem(next.id, {
              state: 'done',
              stageLabel: undefined,
              result,
              error: undefined,
            });
          } catch (err) {
            if (activeRunIdRef.current !== runToken) return;
            const isSecurity = err instanceof SecurityValidationError;
            updateItem(next.id, {
              state: isSecurity ? 'rejected' : 'error',
              stageLabel: undefined,
              error:
                err instanceof Error
                  ? err.message
                  : 'Unable to validate or decode audio file.',
            });
          }
        }
      };

      for (let w = 0; w < Math.min(concurrency, newItems.length); w++) {
        void runNext();
      }
    },
    [updateItem],
  );

  const handleChooseFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const list = event.target.files;
      if (list && list.length > 0) {
        enqueueFiles(Array.from(list));
      }
      event.target.value = '';
    },
    [enqueueFiles],
  );

  const handleClearAll = useCallback(() => {
    activeRunIdRef.current += 1;
    setQueue([]);
    setSelectedId(null);
    setBatchNotice(null);
  }, []);

  const handleExportCsv = useCallback(() => {
    const csv = exportQueueToCsv(queue);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `trueflac-report-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [queue]);

  // Global window drag-and-drop handlers
  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current += 1;
    if (event.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragging(false);
    try {
      const files = await collectDroppedFiles(event.dataTransfer);
      enqueueFiles(files);
    } catch {
      setBatchNotice('Could not read dropped files or folder.');
    }
  };

  const selectedItem =
    queue.find((item) => item.id === selectedId) ?? queue[0] ?? null;
  const hasExportable = queue.some(
    (item) =>
      item.state === 'done' ||
      item.state === 'rejected' ||
      item.state === 'error',
  );

  return (
    <div
      className="relative flex min-h-screen flex-col bg-[#F5F5F7] text-[#111113] dark:bg-[#09090B] dark:text-[#F4F4F5]"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <TopBar
        theme={theme}
        onThemeChange={setTheme}
        hasFiles={queue.length > 0}
        hasExportable={hasExportable}
        onAddFiles={handleChooseFiles}
        onExportCsv={handleExportCsv}
        onClearAll={handleClearAll}
      />

      {/* Hidden native file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".flac,.wav,.aiff,.aif,.aifc,.mp3,.m4a,.mp4,.ogg,.opus,audio/*"
        onChange={handleFileInputChange}
        className="sr-only"
        aria-label="Choose audio files to analyze"
        data-testid="audio-file-input"
      />

      {batchNotice && (
        <div className="mx-auto w-full max-w-[1440px] px-4 pt-3 sm:px-5">
          <div
            role="status"
            className="flex items-center justify-between gap-3 rounded-xl border border-black/[0.08] bg-white px-3.5 py-2 text-[12.5px] text-zinc-700 dark:border-white/[0.08] dark:bg-[#111113] dark:text-zinc-300"
          >
            <span>{batchNotice}</span>
            <button
              type="button"
              onClick={() => setBatchNotice(null)}
              className="text-[12px] font-medium text-zinc-900 underline-offset-2 hover:underline dark:text-zinc-100 whitespace-nowrap cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <main className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col">
        {queue.length === 0 ? (
          <HeroDropzone
            isDragging={isDragging}
            onChooseFiles={handleChooseFiles}
          />
        ) : (
          <div className="flex flex-1 flex-col gap-3 px-4 py-3.5 sm:px-5 lg:flex-row lg:items-start">
            <BatchSidebar
              items={queue}
              selectedId={selectedItem?.id ?? null}
              onSelect={setSelectedId}
            />
            <DetailPane item={selectedItem} theme={theme} />
          </div>
        )}
      </main>

      {/* Drag-and-drop overlay when workspace already has files */}
      {isDragging && queue.length > 0 && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-xs dark:bg-black/55">
          <div className="rounded-xl border border-black/[0.12] bg-white px-7 py-5 text-center dark:border-white/[0.14] dark:bg-[#111113]">
            <p className="text-[14px] font-medium text-zinc-900 dark:text-zinc-100">
              Drop audio files to add to queue
            </p>
            <p className="mt-1 font-mono text-[11px] text-zinc-500">
              Verified locally via magic-byte header inspection
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
