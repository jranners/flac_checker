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

      // Process with bounded concurrency (2 files at a time) to keep RAM footprint lean
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

  return (
    <div
      className="trueflac-canvas relative flex min-h-screen flex-col text-[#1D1D1F] transition-colors duration-200 dark:text-[#F5F5F7]"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <TopBar theme={theme} onThemeChange={setTheme} />

      {/* Hidden native file input (accepts any file so disguised files are caught by zero-trust magic-byte validator) */}
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
        <div className="mx-auto w-full max-w-[1360px] px-4 pt-2 sm:px-6">
          <div
            role="status"
            className="glass-panel flex items-center justify-between gap-3 rounded-2xl px-4 py-2.5 text-[13px] text-[#515154] dark:text-[#D1D1D6]"
          >
            <span>{batchNotice}</span>
            <button
              type="button"
              onClick={() => setBatchNotice(null)}
              className="text-[12px] font-medium text-[#0A84FF] hover:underline whitespace-nowrap"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <main className="mx-auto flex w-full max-w-[1360px] flex-1 flex-col">
        {queue.length === 0 ? (
          <HeroDropzone
            isDragging={isDragging}
            onChooseFiles={handleChooseFiles}
          />
        ) : (
          <div className="flex flex-1 flex-col gap-4 px-4 pt-3 pb-8 sm:px-6 lg:flex-row lg:items-start">
            <BatchSidebar
              items={queue}
              selectedId={selectedItem?.id ?? null}
              onSelect={setSelectedId}
              onAddFiles={handleChooseFiles}
              onExportCsv={handleExportCsv}
              onClearAll={handleClearAll}
            />
            <DetailPane item={selectedItem} theme={theme} />
          </div>
        )}
      </main>

      {/* Subtle full-window drag overlay when workspace already has files */}
      {isDragging && queue.length > 0 && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-black/20 backdrop-blur-sm dark:bg-black/45">
          <div className="glass-panel rounded-3xl px-8 py-6 text-center">
            <p className="text-[17px] font-semibold tracking-tight text-[#1D1D1F] dark:text-[#F5F5F7]">
              Drop audio files to add to queue
            </p>
            <p className="mt-1 text-[13px] text-[#6E6E73] dark:text-[#98989D]">
              Verified locally via zero-trust header inspection
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
