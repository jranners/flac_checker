import type { QueueItem } from './types';

export interface QueueProgressSummary {
  total: number;
  completed: number;
  inProgress: number;
  percent: number;
  isComplete: boolean;
}

function itemProgressWeight(item: QueueItem): number {
  switch (item.state) {
    case 'done':
    case 'rejected':
    case 'error':
      return 1;
    case 'analyzing': {
      const stage = item.stageLabel ?? '';
      if (stage.startsWith('Running spectral')) return 0.75;
      if (stage.startsWith('Decoding')) return 0.45;
      if (stage.startsWith('Inspecting')) return 0.3;
      return 0.5;
    }
    case 'validating':
      return 0.2;
    case 'queued':
    default:
      return 0;
  }
}

/**
 * Compute aggregate completion percentage (0–100) across the current processing queue.
 * Caps intermediate progress at 99% until every item has reached a terminal state.
 */
export function computeQueueProgress(items: ReadonlyArray<QueueItem>): QueueProgressSummary {
  const total = items.length;
  if (total === 0) {
    return {
      total: 0,
      completed: 0,
      inProgress: 0,
      percent: 0,
      isComplete: false,
    };
  }

  let completed = 0;
  let weightSum = 0;

  for (const item of items) {
    const w = itemProgressWeight(item);
    weightSum += w;
    if (w === 1) completed++;
  }

  const inProgress = total - completed;
  const isComplete = completed === total;
  const percent = isComplete
    ? 100
    : Math.min(99, Math.max(0, Math.round((weightSum / total) * 100)));

  return {
    total,
    completed,
    inProgress,
    percent,
    isComplete,
  };
}
