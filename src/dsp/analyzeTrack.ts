import {
  SECURITY_LIMITS,
  validateFileBeforeDecode,
} from '../security/fileValidator';
import { decodeAudioAndSelectSegments } from './audioDecoder';
import { runForensicAnalysis, type ForensicDspInput } from './cutoffDetector';
import { enrichHeaderMetadata } from './headerParser';
import type { DspWorkerRequest, DspWorkerResponse } from './analyzer.worker';
import type { AnalysisResult } from './types';

class ForensicWorkerManager {
  private worker: Worker | null = null;
  private workerUnavailable = false;
  private pending = new Map<
    string,
    {
      resolve: (res: AnalysisResult) => void;
      reject: (err: Error) => void;
      timer: number;
    }
  >();

  private resetWorker(reason: string): void {
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // ignore termination error
      }
      this.worker = null;
    }
    for (const [, job] of this.pending) {
      window.clearTimeout(job.timer);
      job.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private ensureWorker(): Worker | null {
    if (this.workerUnavailable || typeof Worker === 'undefined') {
      return null;
    }
    if (this.worker) return this.worker;

    try {
      const worker = new Worker(
        new URL('./analyzer.worker.ts', import.meta.url),
        { type: 'module' },
      );
      worker.onmessage = (event: MessageEvent<DspWorkerResponse>) => {
        const { id, result, error } = event.data;
        const job = this.pending.get(id);
        if (!job) return;
        window.clearTimeout(job.timer);
        this.pending.delete(id);
        if (error || !result) {
          job.reject(new Error(error ?? 'DSP worker failed without details.'));
        } else {
          job.resolve(result);
        }
      };
      worker.onerror = () => {
        this.workerUnavailable = true;
        this.resetWorker('Worker sandbox error — switching to main-thread analyzer.');
      };
      this.worker = worker;
      return worker;
    } catch {
      this.workerUnavailable = true;
      return null;
    }
  }

  /**
   * Execute DSP inside the Web Worker with strict timeout & auto-recreation,
   * or yield cleanly on the main thread if Web Workers are blocked in a preview sandbox.
   */
  async execute(
    input: ForensicDspInput,
    timeoutMs: number = SECURITY_LIMITS.PER_FILE_TIMEOUT_MS,
  ): Promise<AnalysisResult> {
    const worker = this.ensureWorker();
    if (!worker) {
      return this.executeMainThreadChunked(input);
    }

    const id = `job-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Clone input buffers before transferring so we can seamlessly retry on main thread if sandbox blocks worker startup
    const leftCopy = new Float32Array(input.leftSamples);
    const rightCopy = input.rightSamples ? new Float32Array(input.rightSamples) : null;

    try {
      return await new Promise<AnalysisResult>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          this.pending.delete(id);
          this.resetWorker(
            `Analysis timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
          );
          reject(
            new Error(
              `Spectral analysis timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
            ),
          );
        }, timeoutMs);

        this.pending.set(id, { resolve, reject, timer });

        const transferables: Transferable[] = [input.leftSamples.buffer];
        if (input.rightSamples) {
          transferables.push(input.rightSamples.buffer);
        }

        const request: DspWorkerRequest = { id, payload: input };
        worker.postMessage(request, transferables);
      });
    } catch (err) {
      if (this.workerUnavailable) {
        return this.executeMainThreadChunked({
          ...input,
          leftSamples: leftCopy,
          rightSamples: rightCopy,
        });
      }
      throw err;
    }
  }

  private async executeMainThreadChunked(
    input: ForensicDspInput,
  ): Promise<AnalysisResult> {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    const result = runForensicAnalysis(input);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    return result;
  }
}

const workerManager = new ForensicWorkerManager();

export interface TrackProgressCallbacks {
  onStage?: (stageLabel: string) => void;
  onValidated?: (checks: string[]) => void;
}

/**
 * Full end-to-end client-side forensic pipeline for a single untrusted File:
 * 1. Zero-trust 64 KB header magic-byte, bounds & RAM-bomb validation
 * 2. Raw PCM 24-bit zero-padding verification (WAV)
 * 3. Resampling-aware Web Audio decode + segment-isolated stereo transient extraction
 * 4. Multi-feature spectral forensics in Web Worker (with automatic main-thread fallback)
 */
export async function analyzeAudioFile(
  file: File,
  callbacks: TrackProgressCallbacks = {},
): Promise<AnalysisResult> {
  callbacks.onStage?.('Validating header…');
  const validated = await validateFileBeforeDecode(file);
  callbacks.onValidated?.(validated.securityChecks);

  callbacks.onStage?.('Inspecting PCM header…');
  const enrichedMetadata = await enrichHeaderMetadata(file, validated.metadata);

  callbacks.onStage?.('Decoding & selecting transients…');
  const decoded = await decodeAudioAndSelectSegments(
    file,
    enrichedMetadata,
    SECURITY_LIMITS.PER_FILE_TIMEOUT_MS,
  );

  callbacks.onStage?.('Running spectral forensics…');
  return workerManager.execute(
    {
      leftSamples: decoded.leftSamples,
      rightSamples: decoded.rightSamples,
      segmentLengthSamples: decoded.segmentLengthSamples,
      decodedSampleRate: decoded.decodedSampleRate,
      metadata: decoded.updatedMetadata,
      securityChecks: validated.securityChecks,
      analyzedSegments: decoded.analyzedSegments,
      analyzedDurationSec: decoded.analyzedDurationSec,
    },
    SECURITY_LIMITS.PER_FILE_TIMEOUT_MS,
  );
}

interface WebkitEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (cb: (file: File) => void, err?: (e: Error) => void) => void;
  createReader?: () => {
    readEntries: (cb: (entries: WebkitEntry[]) => void, err?: (e: Error) => void) => void;
  };
}

function readAllEntries(
  createReader: NonNullable<WebkitEntry['createReader']>,
): Promise<WebkitEntry[]> {
  const reader = createReader();
  return new Promise((resolve, reject) => {
    const results: WebkitEntry[] = [];
    const next = () => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) resolve(results);
          else {
            results.push(...batch);
            next();
          }
        },
        (e) => reject(e),
      );
    };
    next();
  });
}

async function walkEntry(
  entry: WebkitEntry,
  out: File[],
  maxFiles: number,
): Promise<void> {
  if (out.length >= maxFiles) return;
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => {
      entry.file!(resolve, reject);
    });
    out.push(file);
  } else if (entry.isDirectory && entry.createReader) {
    const children = await readAllEntries(entry.createReader.bind(entry));
    for (const child of children) {
      if (out.length >= maxFiles) break;
      await walkEntry(child, out, maxFiles);
    }
  }
}

/**
 * Recursively collect dropped files (including nested directories) up to the batch safety cap.
 * Does NOT filter by extension — all files are passed to the zero-trust magic-byte validator
 * so disguised or unsupported files surface clear security rejections.
 */
export async function collectDroppedFiles(
  dataTransfer: DataTransfer,
  maxFiles: number = SECURITY_LIMITS.MAX_BATCH_FILES + 1,
): Promise<File[]> {
  const items = Array.from(dataTransfer.items || []);
  const entries: WebkitEntry[] = [];
  for (const item of items) {
    const getEntry = (
      item as DataTransferItem & { webkitGetAsEntry?: () => WebkitEntry | null }
    ).webkitGetAsEntry;
    if (typeof getEntry === 'function') {
      const entry = getEntry.call(item);
      if (entry) entries.push(entry);
    }
  }

  if (entries.length > 0) {
    const out: File[] = [];
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      await walkEntry(entry, out, maxFiles);
    }
    return out;
  }

  return Array.from(dataTransfer.files || []).slice(0, maxFiles);
}
